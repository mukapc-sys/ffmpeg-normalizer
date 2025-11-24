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
