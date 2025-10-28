const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "video-normalizer",
  });
});

app.get("/diagnostics", async (req, res) => {
  try {
    const { stdout: ffmpegVersion } = await execAsync("ffmpeg -version");
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();

    res.json({
      status: "ok",
      ffmpeg: ffmpegVersion.split("\n")[0],
      memory: {
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      },
      uptime: `${Math.round(uptime)}s`,
      tmpDir: os.tmpdir(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/normalize", upload.single("video"), async (req, res) => {
  const startTime = Date.now();
  let inputPath = null;
  let outputPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }

    inputPath = req.file.path;
    outputPath = path.join("/tmp", `normalized_${Date.now()}_${req.file.originalname}`);

    console.log(`📥 Normalizando: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

    const { stdout: probeOutput } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of json "${inputPath}"`,
    );
    const videoInfo = JSON.parse(probeOutput);
    const stream = videoInfo.streams[0];

    console.log(`📊 ${stream.codec_name}, ${stream.width}x${stream.height}`);

    const targetWidth = parseInt(req.body.targetWidth) || 1080;
    const targetHeight = parseInt(req.body.targetHeight) || 1920;
    const quality = req.body.quality || "medium";

    const qualityPresets = {
      low: { crf: 28, preset: "veryfast" },
      medium: { crf: 23, preset: "medium" },
      high: { crf: 18, preset: "slow" },
    };

    const { crf, preset } = qualityPresets[quality] || qualityPresets.medium;

    // 🔧 CORREÇÃO: Parâmetros de áudio ajustados para garantir A/V sync perfeito
    const ffmpegCmd = `ffmpeg -i "${inputPath}" \
      -vf "scale='trunc(${targetWidth}/2)*2':'trunc(${targetHeight}/2)*2',setsar=1" \
      -r 30 \
      -c:v libx264 -preset ${preset} -crf ${crf} \
      -c:a aac -b:a 128k -ar 44100 -ac 2 \
      -af "loudnorm=I=-16:LRA=11:TP=-1.5,aresample=async=1:first_pts=0" \
      -movflags +faststart \
      -pix_fmt yuv420p \
      -vsync cfr \
      -start_at_zero \
      -copytb 1 \
      -avoid_negative_ts make_zero \
      -fflags +genpts \
      -y "${outputPath}"`;

    console.log(`⚙️ Normalizando (${quality})...`);
    await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });

    const normalizedVideo = await fs.readFile(outputPath);
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Completo em ${processingTime}s (${(normalizedVideo.length / 1024 / 1024).toFixed(2)}MB)`);

    res.set({
      "Content-Type": "video/mp4",
      "Content-Length": normalizedVideo.length,
      "X-Processing-Time": processingTime,
    });
    res.send(normalizedVideo);
  } catch (error) {
    console.error("❌ Erro:", error);
    res.status(500).json({
      error: "Normalization failed",
      message: error.message,
    });
  } finally {
    try {
      if (inputPath) await fs.unlink(inputPath).catch(() => {});
      if (outputPath) await fs.unlink(outputPath).catch(() => {});
    } catch (e) {}
  }
});

setInterval(
  async () => {
    try {
      const tmpFiles = await fs.readdir("/tmp");
      const now = Date.now();
      const maxAge = 60 * 60 * 1000;

      for (const file of tmpFiles) {
        if (file.startsWith("normalized_") || file.startsWith("upload_")) {
          const filePath = path.join("/tmp", file);
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            console.log(`🗑️ Removido: ${file}`);
          }
        }
      }
    } catch (error) {}
  },
  30 * 60 * 1000,
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 Video Normalizer running on port ${PORT}`);
});
