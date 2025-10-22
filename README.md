# FFmpeg Normalizer Server

Video encoding normalization microservice using FFmpeg.

## Purpose

Normalizes video files to ensure compatibility for concatenation operations by standardizing:
- Video codec (H.264)
- Audio format (AAC 48kHz)
- Frame rate (30fps CFR)
- Timestamps (reset to zero)

## API Endpoints

### POST /normalize

Normalizes a video file from URL or upload.

**Request:**
```json
{
  "videoUrl": "https://example.com/video.mp4"
}
Response:


{
  "success": true,
  "videoUrl": "https://r2-url/normalized-video.mp4"
}
GET /health
Health check endpoint.

Response:


{
  "status": "ok",
  "timestamp": "2025-10-22T..."
}
Environment Variables
PORT - Server port (default: 3000)
FFMPEG_API_KEY - API authentication key
R2_ACCOUNT_ID - Cloudflare R2 account ID
R2_ACCESS_KEY_ID - R2 access key
R2_SECRET_ACCESS_KEY - R2 secret key
R2_BUCKET_NAME - R2 bucket name
Deployment
Deploy to Railway or Render using the included configuration files.

License
MIT
