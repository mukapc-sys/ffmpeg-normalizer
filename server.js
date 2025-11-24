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

    // Criar ZIP em memória
    const zip = new JSZip();
    
    // Baixar e adicionar cada vídeo ao ZIP
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      console.log(`📥 [ZIP] Baixando ${i + 1}/${videos.length}: ${video.filename}`);
      
      try {
        const protocol = video.r2SignedUrl.startsWith('https') ? https : http;
        
        const response = await new Promise((resolve, reject) => {
          protocol.get(video.r2SignedUrl, resolve).on('error', reject);
        });
        
        if (response.statusCode !== 200) {
          throw new Error(`HTTP ${response.statusCode}`);
        }
        
        const chunks = [];
        for await (const chunk of response) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        
        // Adicionar ao ZIP com nome limpo
        const cleanFilename = video.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        zip.file(cleanFilename, buffer);
        
        console.log(`✅ [ZIP] Adicionado: ${cleanFilename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
      } catch (downloadError) {
        console.error(`❌ [ZIP] Erro ao baixar ${video.filename}:`, downloadError);
        throw new Error(`Falha ao baixar vídeo: ${video.filename}`);
      }
    }

    console.log('🔄 [ZIP] Gerando arquivo ZIP...');
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    const zipSizeBytes = zipBuffer.length;
    console.log(`✅ [ZIP] ZIP gerado: ${(zipSizeBytes / 1024 / 1024).toFixed(2)} MB`);

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
