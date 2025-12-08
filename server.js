const express = require('express');
const multer = require('multer');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const crypto = require('crypto');

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
    service: 'video-normalizer',
    version: '2.0.0-streaming'
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
      tmpDir: os.tmpdir(),
      optimizations: 'streaming-enabled'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT: /normalize (STREAMING)
// ============================================
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

    // STREAMING: Enviar arquivo via stream (não carregar em RAM)
    const stats = await fs.stat(outputPath);
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Completo em ${processingTime}s (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);

    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': stats.size,
      'X-Processing-Time': processingTime
    });

    const fileStream = fsSync.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on('end', async () => {
      try {
        if (inputPath) await fs.unlink(inputPath).catch(() => {});
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
      } catch (e) {}
    });

    fileStream.on('error', async (err) => {
      console.error('❌ Erro no stream:', err);
      try {
        if (inputPath) await fs.unlink(inputPath).catch(() => {});
        if (outputPath) await fs.unlink(outputPath).catch(() => {});
      } catch (e) {}
    });

  } catch (error) {
    console.error('❌ Erro:', error);
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputPath) await fs.unlink(outputPath).catch(() => {});
    } catch (e) {}
    res.status(500).json({
      error: 'Normalization failed',
      message: error.message
    });
  }
});

// ============================================
// ENDPOINT: /compress (STREAMING)
// ============================================
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

    inputPath = path.join('/tmp', `input_${Date.now()}.mp4`);
    outputPath = path.join('/tmp', `compressed_${Date.now()}.mp4`);

    // STREAMING: Download direto para arquivo (não RAM)
    console.log('📥 Baixando vídeo via streaming...');
    await downloadToFile(videoUrl, inputPath, 300000);

    const inputStats = await fs.stat(inputPath);
    const originalSize = inputStats.size;
    console.log(`✅ Download completo: ${(originalSize / 1024 / 1024).toFixed(2)}MB`);

    const compressionCrf = crf || 23;
    const compressionPreset = preset || 'medium';

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
      
      // STREAMING: Upload via stream (não carregar em RAM)
      await uploadFileStream(
        `${supabaseUrl}/storage/v1/object/videos/${targetOutputPath}`,
        outputPath,
        {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true'
        }
      );

      console.log('✅ Upload completo');

      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

      // Cleanup
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});

      res.json({
        success: true,
        outputPath: targetOutputPath,
        originalSize,
        compressedSize,
        compressionRatio: parseFloat(compressionRatio),
        processingTime: parseFloat(processingTime)
      });
    } else {
      // STREAMING: Retornar o vídeo via stream
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

      res.set({
        'Content-Type': 'video/mp4',
        'Content-Length': compressedSize,
        'X-Processing-Time': processingTime,
        'X-Original-Size': originalSize.toString(),
        'X-Compressed-Size': compressedSize.toString(),
        'X-Compression-Ratio': compressionRatio
      });

      const fileStream = fsSync.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('end', async () => {
        await fs.unlink(inputPath).catch(() => {});
        await fs.unlink(outputPath).catch(() => {});
      });
    }

  } catch (error) {
    console.error('❌ Erro na compressão:', error);
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputPath) await fs.unlink(outputPath).catch(() => {});
    } catch (e) {}
    res.status(500).json({
      error: 'Compression failed',
      message: error.message
    });
  }
});

// ============================================
// HELPER: Download direto para arquivo (STREAMING)
// ============================================
async function downloadToFile(url, outputPath, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const fileStream = fsSync.createWriteStream(outputPath);
    
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      rejectUnauthorized: false,
      requestCert: false,
      agent: false
    };

    const req = protocol.request(options, (response) => {
      if (response.statusCode !== 200) {
        fileStream.close();
        fs.unlink(outputPath).catch(() => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      
      // STREAMING: Pipe direto para arquivo
      response.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      
      fileStream.on('error', (err) => {
        fileStream.close();
        fs.unlink(outputPath).catch(() => {});
        reject(err);
      });
    });

    req.on('error', (error) => {
      fileStream.close();
      fs.unlink(outputPath).catch(() => {});
      reject(new Error(`Erro de rede: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      fileStream.close();
      fs.unlink(outputPath).catch(() => {});
      reject(new Error('Download timeout'));
    });

    req.end();
  });
}

// ============================================
// HELPER: Upload arquivo via stream
// ============================================
async function uploadFileStream(uploadUrl, filePath, headers = {}) {
  const stats = await fs.stat(filePath);
  
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const fileStream = fsSync.createReadStream(filePath);
    
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        ...headers,
        'Content-Length': stats.size
      },
      timeout: 600000 // 10 minutos
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Upload failed: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Upload timeout'));
    });
    
    fileStream.pipe(req);
  });
}

// ============================================
// ENDPOINT: /generate-zip (STREAMING COMPLETO)
// ============================================
app.post('/generate-zip', express.json({ limit: '50mb' }), async (req, res) => {
  const startTime = Date.now();
  const tempFiles = [];
  let zipPath = null;
  
  try {
    console.log('📦 [ZIP] Iniciando geração de ZIP (modo streaming)');
    
    const { 
      jobId,
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

    console.log(`📦 [ZIP] Projeto: ${projectId}, Job: ${jobId}, Vídeos: ${videos.length}`);

    // FASE 1: Baixar vídeos para arquivos temporários (STREAMING - não RAM)
    console.log('📥 [ZIP] Fase 1: Download de vídeos via streaming...');
    const downloadResults = [];
    const batchSize = 5;
    
    for (let i = 0; i < videos.length; i += batchSize) {
      const batch = videos.slice(i, i + batchSize);
      console.log(`📦 [ZIP] Batch ${Math.floor(i/batchSize) + 1}: vídeos ${i + 1}-${Math.min(i + batchSize, videos.length)}`);
      
      const batchPromises = batch.map(async (video, idx) => {
        const tempPath = path.join('/tmp', `video_${Date.now()}_${i + idx}.mp4`);
        try {
          await downloadToFile(video.r2SignedUrl, tempPath, 300000);
          const stats = await fs.stat(tempPath);
          tempFiles.push(tempPath);
          console.log(`✅ [ZIP] ${video.filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          return { success: true, video, tempPath, size: stats.size };
        } catch (error) {
          console.error(`❌ [ZIP] ${video.filename}: ${error.message}`);
          await fs.unlink(tempPath).catch(() => {});
          return { success: false, video, error: error.message };
        }
      });
      
      const results = await Promise.all(batchPromises);
      downloadResults.push(...results);
    }
    
    const successfulDownloads = downloadResults.filter(r => r.success);
    const failedDownloads = downloadResults.filter(r => !r.success);
    
    if (failedDownloads.length > 0) {
      console.warn(`⚠️ [ZIP] ${failedDownloads.length} vídeos falharam`);
    }
    
    if (successfulDownloads.length === 0) {
      throw new Error('Nenhum vídeo foi baixado com sucesso');
    }

    console.log(`✅ [ZIP] ${successfulDownloads.length}/${videos.length} vídeos baixados`);

    // FASE 2: Criar ZIP via streaming (archiver - não carrega tudo em RAM)
    console.log('🔄 [ZIP] Fase 2: Criando arquivo ZIP via streaming...');
    
    zipPath = path.join('/tmp', `zip_${Date.now()}.zip`);
    const zipOutput = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { store: true }); // Sem compressão = mais rápido
    
    archive.pipe(zipOutput);
    
    for (const { video, tempPath } of successfulDownloads) {
      const cleanFilename = video.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      archive.file(tempPath, { name: cleanFilename });
    }
    
    await archive.finalize();
    
    // Aguardar o arquivo ser escrito completamente
    await new Promise((resolve, reject) => {
      zipOutput.on('close', resolve);
      zipOutput.on('error', reject);
    });
    
    const zipStats = await fs.stat(zipPath);
    const zipSizeBytes = zipStats.size;
    console.log(`✅ [ZIP] ZIP criado: ${(zipSizeBytes / 1024 / 1024).toFixed(2)} MB`);

    // FASE 3: Upload para R2 via streaming
    console.log('☁️ [ZIP] Fase 3: Upload para R2 via streaming...');
    
    const zipFilename = `${productCode}_${projectId}_${Date.now()}.zip`;
    const r2Path = `zips/${userId}/${zipFilename}`;
    
    // Gerar signed URL
    const region = 'auto';
    const service = 's3';
    const bucket = r2Config.bucketName;
    const host = `${r2Config.accountId}.r2.cloudflarestorage.com`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    
    const canonicalUri = `/${bucket}/${r2Path}`;
    const credential = `${r2Config.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;
    const queryParams = `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${encodeURIComponent(credential)}&X-Amz-Date=${amzDate}&X-Amz-Expires=3600&X-Amz-SignedHeaders=host`;
    
    const canonicalRequest = `PUT\n${canonicalUri}\n${queryParams}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    
    const kDate = crypto.createHmac('sha256', `AWS4${r2Config.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    
    const uploadUrl = `https://${host}${canonicalUri}?${queryParams}&X-Amz-Signature=${signature}`;

    // STREAMING: Upload do arquivo ZIP via stream com retry
    await uploadZipToR2WithRetry(uploadUrl, zipPath, zipSizeBytes);

    const publicUrl = `https://pub-93cb8cc35ae64cf69f0ea248148ad1b2.r2.dev/${bucket}/${r2Path}`;
    console.log(`✅ [ZIP] Upload R2 completo: ${r2Path}`);

    // FASE 4: Notificar webhook
    if (notificationWebhook) {
      console.log('📧 [ZIP] Fase 4: Enviando notificação...');
      try {
        await sendWebhookNotification(notificationWebhook, {
          jobId,
          projectId,
          userId,
          zipPath: r2Path,
          zipPublicUrl: publicUrl,
          zipSizeBytes,
          videosCount: successfulDownloads.length,
          processingTimeMs: Date.now() - startTime
        });
        console.log('✅ [ZIP] Notificação enviada');
      } catch (notifyError) {
        console.error('❌ [ZIP] Erro ao notificar:', notifyError.message);
      }
    }

    // FASE 5: Limpar arquivos temporários
    console.log('🧹 [ZIP] Fase 5: Limpando arquivos temporários...');
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile).catch(() => {});
    }
    await fs.unlink(zipPath).catch(() => {});

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
    
    // Limpar arquivos temporários em caso de erro
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile).catch(() => {});
    }
    if (zipPath) await fs.unlink(zipPath).catch(() => {});
    
    // Notificar falha
    if (req.body.notificationWebhook) {
      try {
        await sendWebhookNotification(req.body.notificationWebhook, {
          jobId: req.body.jobId,
          projectId: req.body.projectId,
          userId: req.body.userId,
          error: error.message
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

// ============================================
// HELPER: Upload ZIP para R2 via streaming com retry
// ============================================
async function uploadZipToR2WithRetry(uploadUrl, zipPath, zipSizeBytes, attempt = 1) {
  const maxRetries = 3;
  
  try {
    await new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      const fileStream = fsSync.createReadStream(zipPath);
      
      const options = {
        method: 'PUT',
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': zipSizeBytes
        },
        timeout: 3600000, // 60 minutos
        rejectUnauthorized: false,
        requestCert: false,
        agent: false
      };
      
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✅ [ZIP] Upload R2 sucesso: ${res.statusCode}`);
            resolve();
          } else {
            console.error(`❌ [ZIP] Upload R2 falhou: ${res.statusCode}`, responseData);
            reject(new Error(`Upload falhou: ${res.statusCode} - ${responseData}`));
          }
        });
      });
      
      req.on('error', (error) => {
        console.error(`❌ [ZIP] Erro de rede no upload (tentativa ${attempt}/${maxRetries}):`, error.message);
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        fileStream.destroy();
        reject(new Error('Timeout no upload para R2'));
      });
      
      // STREAMING: Pipe do arquivo direto para o request
      fileStream.pipe(req);
      
      fileStream.on('error', (err) => {
        req.destroy();
        reject(err);
      });
    });
  } catch (error) {
    if (attempt < maxRetries && (error.code === 'EPROTO' || error.code === 'ECONNRESET' || error.message.includes('Timeout'))) {
      console.log(`🔄 [ZIP] Tentando novamente upload (${attempt + 1}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      return uploadZipToR2WithRetry(uploadUrl, zipPath, zipSizeBytes, attempt + 1);
    }
    throw error;
  }
}

// ============================================
// HELPER: Enviar notificação webhook
// ============================================
async function sendWebhookNotification(webhookUrl, payload) {
  const url = new URL(webhookUrl);
  const body = JSON.stringify(payload);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout ao enviar notificação'));
    });

    req.write(body);
    req.end();
  });
}

// ============================================
// LIMPEZA PERIÓDICA DE ARQUIVOS TEMPORÁRIOS
// ============================================
setInterval(async () => {
  try {
    const tmpFiles = await fs.readdir('/tmp');
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hora

    for (const file of tmpFiles) {
      if (file.startsWith('normalized_') || file.startsWith('upload_') || 
          file.startsWith('input_') || file.startsWith('compressed_') ||
          file.startsWith('video_') || file.startsWith('zip_')) {
        const filePath = path.join('/tmp', file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            console.log(`🗑️ Removido: ${file}`);
          }
        } catch (e) {}
      }
    }
  } catch (error) {
    console.error('Erro na limpeza de arquivos:', error);
  }
}, 30 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Video Normalizer v2.0.0 (streaming) running on port ${PORT}`);
});
