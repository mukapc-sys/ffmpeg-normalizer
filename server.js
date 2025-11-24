const express = require('express');
const multer = require('multer');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'video-normalizer'
  });
});

app.get('/diagnostics', async (req, res) => {
  try {
    const { stdout: ffmpegVersion } = await execAsync('ffmpeg -version');
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();

    res.json({
      status: 'ok',
      ffmpeg: ffmpegVersion.split('\n')[0],
      memory: {
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`
      },
      uptime: `${Math.round(uptime)}s`,
      tmpDir: os.tmpdir()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/normalize', upload.single('video'), async (req, res) => {
  const startTime = Date.now();
  let inputPath = null;
  let outputPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    inputPath = req.file.path;
    outputPath = path.join('/tmp', `normalized_${Date.now()}_${req.file.originalname}`);

    console.log(`📥 Normalizando: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

    const { stdout: probeOutput } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of json "${inputPath}"`
    );
    const videoInfo = JSON.parse(probeOutput);
    const stream = videoInfo.streams[0];

    console.log(`📊 ${stream.codec_name}, ${stream.width}x${stream.height}`);

    const targetWidth = parseInt(req.body.targetWidth) || 1080;
    const targetHeight = parseInt(req.body.targetHeight) || 1920;
    const quality = req.body.quality || 'medium';

    const qualityPresets = {
      low: { crf: 28, preset: 'veryfast' },
      medium: { crf: 23, preset: 'medium' },
      high: { crf: 18, preset: 'slow' }
    };

    const { crf, preset } = qualityPresets[quality] || qualityPresets.medium;

    // CRÍTICO: Usar vsync cfr + avoid_negative_ts + genpts para sincronização perfeita
    // Esses parâmetros garantem que o vídeo normalizado se concatene sem problemas de A/V sync
    const ffmpegCmd = `ffmpeg -i "${inputPath}" \
      -vf "scale='trunc(${targetWidth}/2)*2':'trunc(${targetHeight}/2)*2',setsar=1" \
      -r 30 \
      -c:v libx264 -preset ${preset} -crf ${crf} \
      -c:a aac -b:a 128k -ar 44100 -ac 2 \
      -af "loudnorm=I=-16:LRA=11:TP=-1.5,aresample=async=1" \
      -movflags +faststart \
      -pix_fmt yuv420p \
      -vsync cfr \
      -async 1 \
      -avoid_negative_ts make_zero \
      -fflags +genpts \
      -y "${outputPath}"`;

    console.log(`⚙️ Normalizando (${quality})...`);
    await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });

    const normalizedVideo = await fs.readFile(outputPath);
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Completo em ${processingTime}s (${(normalizedVideo.length / 1024 / 1024).toFixed(2)}MB)`);

    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': normalizedVideo.length,
      'X-Processing-Time': processingTime
    });
    res.send(normalizedVideo);

  } catch (error) {
    console.error('❌ Erro:', error);
    res.status(500).json({
      error: 'Normalization failed',
      message: error.message
    });
  } finally {
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputPath) await fs.unlink(outputPath).catch(() => {});
    } catch (e) {}
  }
});

// Endpoint para compressão de vídeos (usado antes do ZIP)
app.post('/compress', express.json({ limit: '50mb' }), async (req, res) => {
  const startTime = Date.now();
  let inputPath = null;
  let outputPath = null;

  try {
    const { videoUrl, crf, preset, supabaseUrl, supabaseKey, outputPath: targetOutputPath } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required' });
    }

    console.log(`🎬 Comprimindo vídeo de URL: ${videoUrl.substring(0, 100)}...`);

    // Download do vídeo usando streaming para economizar memória
    inputPath = path.join('/tmp', `input_${Date.now()}.mp4`);
    outputPath = path.join('/tmp', `compressed_${Date.now()}.mp4`);

    console.log('📥 Baixando vídeo via streaming...');
    
    // Download usando https nativo (sem dependências)
    await new Promise((resolve, reject) => {
      const fileStream = require('fs').createWriteStream(inputPath);
      const protocol = videoUrl.startsWith('https') ? https : http;
      
      protocol.get(videoUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }
        
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(inputPath).catch(() => {});
        reject(err);
      });
      
      fileStream.on('error', (err) => {
        fs.unlink(inputPath).catch(() => {});
        reject(err);
      });
    });

    const inputStats = await fs.stat(inputPath);
    const originalSize = inputStats.size;
    console.log(`✅ Download completo: ${(originalSize / 1024 / 1024).toFixed(2)}MB`);

    // Comprimir com CRF 23 (alta qualidade) mantendo resolução
    const compressionCrf = crf || 23;
    const compressionPreset = preset || 'medium';

    // Não redimensionar, apenas comprimir mantendo qualidade visual
    const ffmpegCmd = `ffmpeg -i "${inputPath}" \
      -c:v libx264 -preset ${compressionPreset} -crf ${compressionCrf} \
      -maxrate 5M -bufsize 10M \
      -c:a aac -b:a 128k \
      -movflags +faststart \
      -y "${outputPath}"`;

    console.log(`⚙️ Comprimindo (CRF ${compressionCrf}, preset ${compressionPreset})...`);
    await execAsync(ffmpegCmd, { maxBuffer: 100 * 1024 * 1024 });

    const outputStats = await fs.stat(outputPath);
    const compressedSize = outputStats.size;
    const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    console.log(`✅ Compressão: ${(originalSize / 1024 / 1024).toFixed(2)}MB → ${(compressedSize / 1024 / 1024).toFixed(2)}MB (${compressionRatio}% redução)`);

    // Upload para Supabase Storage se fornecido
    if (supabaseUrl && supabaseKey && targetOutputPath) {
      console.log(`📤 Fazendo upload para Supabase: ${targetOutputPath}`);
      
      const compressedVideo = await fs.readFile(outputPath);
      
      const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${targetOutputPath}`;
      
      // Upload usando https nativo
      await new Promise((resolve, reject) => {
        const url = new URL(uploadUrl);
        const options = {
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'video/mp4',
            'Content-Length': compressedVideo.length,
            'x-upsert': 'true'
          }
        };
        
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Upload failed: ${res.statusCode} - ${data}`));
            }
          });
        });
        
        req.on('error', reject);
        req.write(compressedVideo);
        req.end();
      });

      console.log('✅ Upload completo');

      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

      res.json({
        success: true,
        outputPath: targetOutputPath,
        originalSize,
        compressedSize,
        compressionRatio: parseFloat(compressionRatio),
        processingTime: parseFloat(processingTime)
      });
    } else {
      // Retornar o vídeo comprimido diretamente
      const compressedVideo = await fs.readFile(outputPath);
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

      res.set({
        'Content-Type': 'video/mp4',
        'Content-Length': compressedVideo.length,
        'X-Processing-Time': processingTime,
        'X-Original-Size': originalSize.toString(),
        'X-Compressed-Size': compressedSize.toString(),
        'X-Compression-Ratio': compressionRatio
      });
      res.send(compressedVideo);
    }

  } catch (error) {
    console.error('❌ Erro na compressão:', error);
    res.status(500).json({
      error: 'Compression failed',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputPath) await fs.unlink(outputPath).catch(() => {});
    } catch (e) {
      console.error('Erro ao limpar arquivos temporários:', e);
    }
  }
});

// ============================================
// ENDPOINT: /generate-zip
// ============================================

// Helper: Download video with timeout
async function downloadVideoWithTimeout(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const timer = setTimeout(() => reject(new Error('Download timeout')), timeoutMs);
    
    protocol.get(url, (response) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Helper: Process batch of videos in parallel
async function processBatch(videos, batchSize = 5) {
  const results = [];
  
  for (let i = 0; i < videos.length; i += batchSize) {
    const batch = videos.slice(i, i + batchSize);
    console.log(`📦 [BATCH] Processando ${batch.length} vídeos (${i + 1}-${Math.min(i + batchSize, videos.length)} de ${videos.length})`);
    
    const batchResults = await Promise.all(
      batch.map(async (video) => {
        try {
          const buffer = await downloadVideoWithTimeout(video.r2SignedUrl, 60000);
          return { success: true, video, buffer };
        } catch (error) {
          console.error(`❌ [BATCH] Erro ao baixar ${video.filename}:`, error.message);
          return { success: false, video, error: error.message };
        }
      })
    );
    
    results.push(...batchResults);
  }
  
  return results;
}

app.post('/generate-zip', express.json({ limit: '50mb' }), async (req, res) => {
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

    // Baixar vídeos em paralelo (batches de 5)
    const downloadResults = await processBatch(videos, 5);
    const successfulDownloads = downloadResults.filter(r => r.success);
    const failedDownloads = downloadResults.filter(r => !r.success);
    
    if (failedDownloads.length > 0) {
      console.warn(`⚠️ [ZIP] ${failedDownloads.length} vídeos falharam no download`);
    }
    
    if (successfulDownloads.length === 0) {
      throw new Error('Nenhum vídeo foi baixado com sucesso');
    }

    console.log(`✅ [ZIP] ${successfulDownloads.length}/${videos.length} vídeos baixados`);

    // Criar ZIP em memória SEM compressão (mais rápido)
    const JSZip = require('jszip');
    const zip = new JSZip();
    
    for (const { video, buffer } of successfulDownloads) {
      const cleanFilename = video.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      zip.file(cleanFilename, buffer);
      console.log(`✅ [ZIP] Adicionado: ${cleanFilename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    }

    console.log('🔄 [ZIP] Gerando arquivo ZIP (sem compressão)...');
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE', // Sem compressão para velocidade
      streamFiles: true
    });

    const zipSizeBytes = zipBuffer.length;
    console.log(`✅ [ZIP] ZIP gerado: ${(zipSizeBytes / 1024 / 1024).toFixed(2)} MB`);

    // Upload para R2
    const zipFilename = `${productCode}_${projectId}_${Date.now()}.zip`;
    const r2Path = `zips/${userId}/${zipFilename}`;
    
    console.log(`☁️ [ZIP] Upload para R2: ${r2Path}`);

    const crypto = require('crypto');
    
    // Gerar signed URL para R2
    const region = 'auto';
    const service = 's3';
    const host = `${r2Config.bucketName}.${r2Config.accountId}.r2.cloudflarestorage.com`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    
    const canonicalUri = `/${r2Path}`;
    const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-date';
    const payloadHash = 'UNSIGNED-PAYLOAD';
    
    const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    
    const kDate = crypto.createHmac('sha256', `AWS4${r2Config.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    
    const uploadUrl = `https://${host}${canonicalUri}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${r2Config.accessKeyId}%2F${dateStamp}%2F${region}%2F${service}%2Faws4_request&X-Amz-Date=${amzDate}&X-Amz-Expires=3600&X-Amz-SignedHeaders=${signedHeaders}&X-Amz-Signature=${signature}`;

    // Upload usando https nativo
    await new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      const options = {
        method: 'PUT',
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': zipSizeBytes
        }
      };
      
      const req = https.request(options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Upload falhou: ${res.statusCode}`));
        }
      });
      
      req.on('error', reject);
      req.write(zipBuffer);
      req.end();
    });

    const publicUrl = `https://pub-93cb8cc35ae64cf69f0ea243148ad1b2.r2.dev/${r2Path}`;
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
            videosCount: successfulDownloads.length,
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
      videosCount: successfulDownloads.length,
      processingTimeSeconds: parseFloat(processingTime)
    });

  } catch (error) {
    console.error('❌ [ZIP] Erro fatal:', error);
    
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

setInterval(async () => {
  try {
    const tmpFiles = await fs.readdir('/tmp');
    const now = Date.now();
    const maxAge = 60 * 60 * 1000;

    for (const file of tmpFiles) {
      if (file.startsWith('normalized_') || file.startsWith('upload_') || 
          file.startsWith('input_') || file.startsWith('compressed_')) {
        const filePath = path.join('/tmp', file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          console.log(`🗑️ Removido: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error('Erro na limpeza de arquivos:', error);
  }
}, 30 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Video Normalizer running on port ${PORT}`);
});
