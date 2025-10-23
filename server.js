const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Configurar multer para upload
const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'video-normalizer'
  });
});

// Diagnostics
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

// Endpoint principal de normalização
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

    console.log(`📥 Normalizando vídeo: ${req.file.originalname}`);
    console.log(`📏 Tamanho original: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`);

    // Obter informações do vídeo
    const { stdout: probeOutput } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name,r_frame_rate -of json "${inputPath}"`
    );
    const videoInfo = JSON.parse(probeOutput);
    const stream = videoInfo.streams[0];

    console.log(`📊 Codec: ${stream.codec_name}, Resolução: ${stream.width}x${stream.height}`);

    // Parâmetros de normalização
    const targetWidth = parseInt(req.body.targetWidth) || 1080;
    const targetHeight = parseInt(req.body.targetHeight) || 1920;
    const targetFormat = req.body.targetFormat || '9:16';
    const quality = req.body.quality || 'medium';

    // Configurações de qualidade otimizadas para velocidade
    const qualityPresets = {
      low: { crf: 28, preset: 'ultrafast' },
      medium: { crf: 23, preset: 'veryfast' },  // Mudou de medium para veryfast
      high: { crf: 20, preset: 'fast' }  // Mudou de slow para fast
    };

    const { crf, preset } = qualityPresets[quality] || qualityPresets.medium;

    // CRÍTICO: Usar vsync cfr + avoid_negative_ts + genpts para sincronização perfeita
    // Padronizar em 30fps para concatenação sem dessincronia A/V
    const ffmpegCmd = `ffmpeg -i "${inputPath}" \
      -vf "scale='trunc(${targetWidth}/2)*2':'trunc(${targetHeight}/2)*2',setsar=1" \
      -r 30 \
      -c:v libx264 -preset ${preset} -crf ${crf} -tune fastdecode \
      -c:a aac -b:a 128k -ar 44100 -ac 2 \
      -af "loudnorm=I=-16:LRA=11:TP=-1.5,aresample=async=1" \
      -movflags +faststart \
      -pix_fmt yuv420p \
      -vsync cfr \
      -async 1 \
      -avoid_negative_ts make_zero \
      -fflags +genpts \
      -threads 0 \
      -y "${outputPath}"`;

    console.log(`⚙️ Executando normalização (qualidade: ${quality})...`);
    await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });

    // Ler arquivo normalizado
    const normalizedVideo = await fs.readFile(outputPath);
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Normalização completa em ${processingTime}s`);
    console.log(`📏 Tamanho final: ${(normalizedVideo.length / 1024 / 1024).toFixed(2)}MB`);

    // Enviar vídeo normalizado
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': normalizedVideo.length,
      'X-Processing-Time': processingTime
    });
    res.send(normalizedVideo);

  } catch (error) {
    console.error('❌ Erro na normalização:', error);
    res.status(500).json({
      error: 'Normalization failed',
      message: error.message,
      details: error.stderr || error.stdout
    });
  } finally {
    // Limpar arquivos temporários
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputPath) await fs.unlink(outputPath).catch(() => {});
    } catch (e) {
      console.error('Erro ao limpar arquivos:', e);
    }
  }
});

// Limpeza periódica do /tmp
setInterval(async () => {
  try {
    const tmpFiles = await fs.readdir('/tmp');
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hora

    for (const file of tmpFiles) {
      if (file.startsWith('normalized_') || file.startsWith('upload_')) {
        const filePath = path.join('/tmp', file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          console.log(`🗑️ Arquivo antigo removido: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error('Erro na limpeza:', error);
  }
}, 30 * 60 * 1000); // A cada 30 minutos

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Video Normalizer Server running on port ${PORT}`);
  console.log(`📍 Endpoints disponíveis:`);
  console.log(`   GET  /health - Health check`);
  console.log(`   GET  /diagnostics - System diagnostics`);
  console.log(`   POST /normalize - Normalize video`);
});
