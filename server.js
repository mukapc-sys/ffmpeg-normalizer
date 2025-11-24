const express = require('express');
const https = require('https');
const http = require('http');
const JSZip = require('jszip');
const crypto = require('crypto');

const router = express.Router();

// Função auxiliar para gerar signed URL do R2
async function generateR2SignedUrl(accountId, accessKeyId, secretAccessKey, bucketName, objectKey, method = 'PUT') {
  const region = 'auto';
  const service = 's3';
  const host = `${bucketName}.${accountId}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const canonicalUri = `/${objectKey}`;
  const canonicalQuerystring = '';
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = 'UNSIGNED-PAYLOAD';
  
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
  
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  
  return `https://${host}${canonicalUri}`;
}

// Função auxiliar para baixar vídeo com timeout
async function downloadVideoWithTimeout(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Download timeout'));
    }, timeoutMs);

    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timeout);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks));
      });
      response.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Função para processar vídeos em lotes paralelos
async function processBatch(videos, batchSize = 5) {
  const results = [];
  
  for (let i = 0; i < videos.length; i += batchSize) {
    const batch = videos.slice(i, i + batchSize);
    console.log(`📦 [ZIP] Processando lote ${Math.floor(i / batchSize) + 1}/${Math.ceil(videos.length / batchSize)} (${batch.length} vídeos)`);
    
    const batchResults = await Promise.all(
      batch.map(async (video, index) => {
        try {
          const globalIndex = i + index;
          console.log(`📥 [ZIP] Baixando ${globalIndex + 1}/${videos.length}: ${video.filename}`);
          
          const buffer = await downloadVideoWithTimeout(video.r2SignedUrl);
          const cleanFilename = video.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          
          console.log(`✅ [ZIP] Baixado: ${cleanFilename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
          
          return { filename: cleanFilename, buffer };
        } catch (error) {
          console.error(`❌ [ZIP] Erro ao baixar ${video.filename}:`, error.message);
          throw new Error(`Falha ao baixar vídeo: ${video.filename}`);
        }
      })
    );
    
    results.push(...batchResults);
  }
  
  return results;
}

router.post('/generate-zip', express.json({ limit: '10mb' }), async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('📦 [ZIP] Iniciando geração de ZIP');
    
    const { 
      projectId, 
      userId, 
      videos = [], 
      productCode,
      r2Config,
      notificationWebhook 
    } = req.body;

    if (!videos || videos.length === 0) {
      return res.status(400).json({ error: 'Nenhum vídeo fornecido' });
    }

    console.log(`📦 [ZIP] Projeto: ${projectId}, Vídeos: ${videos.length}`);

    // Baixar vídeos em lotes paralelos (5 por vez)
    const downloadedVideos = await processBatch(videos, 5);
    
    console.log('🔄 [ZIP] Criando arquivo ZIP...');
    const zip = new JSZip();
    
    // Adicionar todos os vídeos ao ZIP
    downloadedVideos.forEach(({ filename, buffer }) => {
      zip.file(filename, buffer);
    });

    // Gerar ZIP SEM COMPRESSÃO (muito mais rápido)
    console.log('🔄 [ZIP] Gerando ZIP sem compressão...');
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE', // SEM compressão = máxima velocidade
      streamFiles: false
    });

    const zipSizeBytes = zipBuffer.length;
    console.log(`✅ [ZIP] ZIP gerado: ${(zipSizeBytes / 1024 / 1024).toFixed(2)} MB em ${((Date.now() - startTime) / 1000).toFixed(2)}s`);

    // Upload para R2
    const zipFilename = `${productCode}_${projectId}_${Date.now()}.zip`;
    const r2Path = `zips/${userId}/${zipFilename}`;
    
    console.log(`☁️ [ZIP] Fazendo upload para R2: ${r2Path}`);

    // Gerar signed URL para upload
    const uploadUrl = await generateR2SignedUrl(
      r2Config.accountId,
      r2Config.accessKeyId,
      r2Config.secretAccessKey,
      r2Config.bucketName,
      r2Path,
      'PUT'
    );

    // Upload do ZIP
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: zipBuffer,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': zipSizeBytes.toString()
      }
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload falhou: ${uploadResponse.status}`);
    }

    const publicUrl = `https://${r2Config.bucketName}.${r2Config.accountId}.r2.cloudflarestorage.com/${r2Path}`;
    console.log(`✅ [ZIP] Upload completo: ${publicUrl}`);

    // Notificar via webhook
    if (notificationWebhook) {
      console.log('📧 [ZIP] Enviando notificação...');
      try {
        await fetch(notificationWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            userId,
            zipPath: r2Path,
            zipPublicUrl: publicUrl,
            zipSizeBytes,
            videosCount: videos.length,
            processingTimeMs: Date.now() - startTime
          })
        });
        console.log('✅ [ZIP] Notificação enviada');
      } catch (notifyError) {
        console.error('❌ [ZIP] Erro ao notificar:', notifyError);
      }
    }

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`🎉 [ZIP] Concluído em ${processingTime}s`);

    res.json({
      success: true,
      zipPath: r2Path,
      zipPublicUrl: publicUrl,
      zipSizeBytes,
      videosCount: videos.length,
      processingTimeSeconds: parseFloat(processingTime)
    });

  } catch (error) {
    console.error('❌ [ZIP] Erro fatal:', error);
    
    // Notificar erro via webhook
    if (req.body.notificationWebhook) {
      try {
        await fetch(req.body.notificationWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: req.body.projectId,
            userId: req.body.userId,
            error: error.message
          })
        });
      } catch (e) {
        console.error('❌ [ZIP] Erro ao notificar falha:', e);
      }
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
