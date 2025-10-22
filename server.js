const express = require('express');
const fetch = require('node-fetch');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Auth middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.FFMPEG_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// R2 Client
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Download video
async function downloadVideo(url, outputPath) {
  console.log(`📥 Downloading: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
  
  const buffer = await response.buffer();
  fs.writeFileSync(outputPath, buffer);
  console.log(`✅ Downloaded: ${outputPath}`);
  return outputPath;
}

// Upload to R2
async function uploadToR2(filePath, filename) {
  console.log(`📤 Uploading to R2: ${filename}`);
  
  const fileContent = fs.readFileSync(filePath);
  const key = `normalized/${filename}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: 'editora-de-conteudo',
      Key: key,
      Body: fileContent,
      ContentType: 'video/mp4',
    })
  );

  const publicUrl = `https://pub-4bc62c024eb4440b996ad3595b1c3d88.r2.dev/${key}`;
  console.log(`✅ Uploaded to R2: ${publicUrl}`);
  return publicUrl;
}

// Normalize video
app.post('/normalize', authenticate, async (req, res) => {
  const { videoUrl } = req.body;
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }

  const timestamp = Date.now();
  const inputPath = `/tmp/input_${timestamp}.mp4`;
  const outputPath = `/tmp/normalized_${timestamp}.mp4`;

  try {
    console.log(`🎬 Starting normalization: ${videoUrl}`);

    // Download
    await downloadVideo(videoUrl, inputPath);

    // Normalize
    const ffmpegCmd = `
      ffmpeg -i ${inputPath} \
        -af "asetpts=PTS-STARTPTS" \
        -vf "setpts=PTS-STARTPTS" \
        -r 30 \
        -c:v libx264 -preset medium -crf 23 \
        -c:a aac -b:a 128k -ar 48000 -ac 2 \
        -vsync cfr \
        -async 1 \
        -avoid_negative_ts make_zero \
        -movflags +faststart \
        -y ${outputPath}
    `.replace(/\n/g, ' ').trim();

    console.log(`🔧 Normalizing video...`);
    await execAsync(ffmpegCmd);
    console.log(`✅ Video normalized`);

    // Upload to R2
    const normalizedUrl = await uploadToR2(outputPath, `normalized_${timestamp}.mp4`);

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ success: true, videoUrl: normalizedUrl });

  } catch (error) {
    console.error('❌ Normalization error:', error);
    
    // Cleanup on error
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Normalizer Server running on port ${PORT}`);
});
