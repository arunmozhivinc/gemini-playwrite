# Local FFmpeg Rendering Server + ngrok + AWS n8n

A high-performance local media processing API powered by **Node.js** and **FFmpeg** running on Windows 11, exposed securely to your AWS n8n workflows via an **ngrok** HTTPS tunnel.

---

## 1. Quick Info & Credentials

- **Local Port**: `8787` (`http://127.0.0.1:8787`)
- **Public ngrok URL**: `https://demeaning-edging-smelting.ngrok-free.dev`
- **Bearer API Key**: Configured in `.env` (`RENDER_API_KEY`)
- **Skip Ngrok Warning Header**: `ngrok-skip-browser-warning: 1` (required in HTTP requests to ngrok-free endpoints)

---

## 2. API Endpoints

### Bilingual Story Video Pipeline (n8n Ready)
*Directly accepts n8n's story JSON with scene image links, audio links, and subtitles.*

- **`POST /render/story`** (also accessible via `POST /render` and `POST /render-story`)
  - **Payload**: Full story JSON object containing:
    - `story_id`, `language` (`en` or `ta`), `title`, `output_filename`
    - `video`: `{ width: 1920, height: 1080, fps: 30, codec: "libx264", crf: 23 }`
    - `effects`: `{ ken_burns: true, zoom_max: 1.15, scene_padding_seconds: 0.6 }`
    - `subtitles`: `{ burn_in: true, font: "Noto Sans", font_size: 54 }`
    - `scenes`: Array of `{ index, image_url, audio_url, subtitle_text }`
  - **Features**:
    - **Smart Asset Loader**: Downloads images and narration audio from Google Drive/cloud links. Falls back gracefully to colored story plates and gentle audio if mock/test URLs are passed.
    - **Ken Burns Effect**: Alternating subtle slow zoom per scene.
    - **Burned-In Subtitles**: Rendered with HarfBuzz/DirectWrite and Microsoft Nirmala UI font for 100% accurate Tamil and English script shaping.
    - **Scene Concatenation**: Smoothly stitches all scenes into a final 1080p MP4.
  - **Response**: Binary MP4 video stream with `Content-Type: video/mp4` and `Content-Disposition`. Output in n8n is a File binary item ready for Google Drive / YouTube upload!

### Health Check (Public)
- **`GET /health`**  
  Checks server liveness, queue length, and active processing count.

---

### Synchronous Endpoints (Immediate Download)
*Ideal for short audio extractions and quick compression.*

- **`POST /render/extract-audio`**
  - Form-data: `file` (video file)
  - Returns: Extracted `.mp3` audio (libmp3lame, VBR quality 4).
- **`POST /render/compress-video`**
  - Form-data: `file` (video file)
  - Returns: Compressed `.mp4` video (H.264, veryfast, CRF 28, AAC).
- **`POST /render/convert?to=webm`**
  - Form-data: `file` (media file)
  - Query parameter: `to` (`webm`, `mp4`, `wav`, `mp3`, etc.)
  - Returns: Converted media file.

---

### Asynchronous Queue Endpoints (No HTTP Timeouts)
*Recommended for AWS n8n workflows handling long video renders.*

1. **Submit Job**:
   - `POST /render/jobs/extract-audio`
   - `POST /render/jobs/compress-video`
   - `POST /render/jobs/convert?to=webm`
   - `POST /render/jobs/merge` (Form-data: `files` with 2 or more video clips)
   - **Response** (HTTP 202 Accepted):
     ```json
     {
       "message": "Job queued successfully",
       "jobId": "6d1a6a62-7f63-4935-be04-6088dccf89da",
       "operation": "compress-video",
       "status": "processing",
       "pollUrl": "/render/jobs/6d1a6a62-7f63-4935-be04-6088dccf89da",
       "downloadUrl": "/render/jobs/6d1a6a62-7f63-4935-be04-6088dccf89da/download"
     }
     ```

2. **Poll Status**:
   - `GET /render/jobs/:jobId`
   - **Response**:
     ```json
     {
       "id": "6d1a6a62-7f63-4935-be04-6088dccf89da",
       "operation": "compress-video",
       "status": "completed",
       "createdAt": "2026-10-13T08:01:24.575Z",
       "completedAt": "2026-10-13T08:01:24.687Z",
       "downloadUrl": "/render/jobs/6d1a6a62-7f63-4935-be04-6088dccf89da/download",
       "error": null
     }
     ```

3. **Download Result**:
   - `GET /render/jobs/:jobId/download`
   - Downloads the rendered output file.

4. **Cancel / Delete Job**:
   - `DELETE /render/jobs/:jobId`

---

## 3. Testing with cURL

### 1. Health Check
```bash
curl.exe -H "ngrok-skip-browser-warning: 1" "https://demeaning-edging-smelting.ngrok-free.dev/health"
```

### 2. Extract Audio (Sync)
```bash
curl.exe -X POST "https://demeaning-edging-smelting.ngrok-free.dev/render/extract-audio" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "ngrok-skip-browser-warning: 1" \
  -F "file=@sample.mp4" \
  -o "sample.mp3"
```

### 3. Compress Video (Async Queue)
```bash
# 1. Submit
curl.exe -X POST "https://demeaning-edging-smelting.ngrok-free.dev/render/jobs/compress-video" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "ngrok-skip-browser-warning: 1" \
  -F "file=@sample.mp4"

# 2. Check Status
curl.exe "https://demeaning-edging-smelting.ngrok-free.dev/render/jobs/<JOB_ID>" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "ngrok-skip-browser-warning: 1"

# 3. Download
curl.exe "https://demeaning-edging-smelting.ngrok-free.dev/render/jobs/<JOB_ID>/download" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "ngrok-skip-browser-warning: 1" \
  -o "compressed.mp4"
```

### 4. Merge Multiple Video Clips (Async Queue)
```bash
curl.exe -X POST "https://demeaning-edging-smelting.ngrok-free.dev/render/jobs/merge" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "ngrok-skip-browser-warning: 1" \
  -F "files=@clip1.mp4" \
  -F "files=@clip2.mp4"
```

---

## 4. Import into AWS n8n

1. In your AWS n8n dashboard, create a new workflow.
2. Click **Workflow settings menu (three dots in top right)** -> **Import from File**.
3. Select `n8n-workflow-template.json`.
4. The workflow will populate with pre-configured HTTP Request nodes for:
   - Health check
   - Asynchronous job submission
   - Wait node (polling delay)
   - Status check
   - File download

---

## 5. Keeping Windows Awake

To ensure rendering jobs finish uninterrupted when processing large files:
- Double-click `start-service.bat` or run `./start-service.ps1`.
- The script uses Windows Kernel `SetThreadExecutionState` to prevent sleep mode while the window is active.
