# 🚀 Antigravity Video Pipeline & Google Drive Sync

A high-performance Node.js application that bridges the **Google Antigravity CLI/Terminal**, AI Image Generation, and **Google Drive customization** to produce consistently patterned keyframes for downstream video generation pipelines (e.g., Runway, Kling, Luma, Pika, Stable Video Diffusion, or ffmpeg).

---

## 🌟 Key Features

1. **Antigravity AI Prompt Expansion Pipeline**:
   - Takes your raw prompts and sends them to the local `agy` (Antigravity CLI) engine.
   - Automatically expands and crafts photorealistic, cinematic descriptions (camera angles, volumetric lighting, motion vectors, atmosphere) tailored for consistent video frames.

2. **Custom Configurable Patterned File Naming**:
   - Fully customizable filename templates via Web UI or CLI.
   - Dynamic token replacement with zero-padding support:
     - `{index:04d}` → `0001`, `0002`...
     - `{scene:02d}` → `01`, `02`...
     - `{shot:02d}` → `01`, `02`...
     - `{prompt_slug}` → Sanitized alphanumeric slug (e.g. `cyberpunk_detective`)
     - `{timestamp}` → Formatted timestamp (`YYYYMMDD_HHmmss`)
   - Pre-configured standard presets: `frame_{index:04d}.png`, `scene_{scene:02d}_shot_{shot:02d}_{index:04d}.png`, `anim_{timestamp}_{index:03d}.png`.

3. **Direct Google Drive Integration**:
   - Leverages your connected Google Drive Antigravity customization (`gdrive` skill).
   - Zero additional OAuth friction — automatically uploads to your dedicated `Antigravity_Video_Frames` Drive folder (`16RVjmr8NplJFKOF-4o925Otli5hyMLre`).
   - Obtains Google Drive file IDs and web-shareable links automatically.

4. **Downstream Video Pipeline Manifest & Export**:
   - Maintains a structured manifest (`output/manifest.json`) linking each frame sequence, local path, Google Drive ID, web link, and prompt metadata.
   - Exportable as **JSON Manifest**, **CSV sequence list**, or **ffmpeg video assembly script**.

5. **Dual Interface**:
   - **Modern Web Dashboard**: Glassmorphic, dark theme UI with live preview, prompt inspiration chips, and real-time Google Drive sync badges.
   - **Terminal CLI**: Run single or batch prompts directly from any script or terminal.

---

## 🛠️ Project Structure

```text
gemini-playwrite/
├── server.js               # Express Web Server & REST API
├── cli.js                  # Terminal CLI runner
├── config.json             # Application & binary paths configuration
├── prompts.json            # Sample batch video prompts
├── lib/
│   ├── antigravity.js      # Antigravity CLI (agy) prompt expansion
│   ├── gdrive.js           # Google Drive customization client
│   ├── imageGenerator.js   # Image generation (Flux / Pollinations / Gemini Imagen)
│   ├── namer.js            # Patterned filename formatter & template engine
│   └── manifest.js         # Manifest manager (JSON, CSV, ffmpeg export)
├── public/
│   ├── index.html          # Web Dashboard UI
│   ├── css/style.css       # Studio-grade styling & glassmorphism
│   └── js/app.js           # Interactive client application
└── output/
    ├── frame_0001.png      # Generated image files
    └── manifest.json       # Pipeline tracking manifest
```

---

## 🚀 Getting Started

### 1. Launch the Web Dashboard
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

- Enter your prompt or click an inspiration chip.
- Click **"Preview Antigravity Expansion"** to view the AI-refined cinematic prompt.
- Click **"Generate & Sync to Drive"** — your image will generate and upload directly to Google Drive.

### 2. Using the CLI

**Check Connection Status:**
```bash
npm run status
# or
node cli.js --status
```

**Generate a Single Frame:**
```bash
node cli.js --prompt "Cyberpunk detective walking in rain" --pattern "frame_{index:04d}.png" --scene 1 --shot 1
```

**Run Batch Video Sequence:**
```bash
node cli.js --batch prompts.json
```

---

## 🔌 Downstream Video Generation Integration

Every generated frame is recorded in `output/manifest.json`:
```json
{
  "sequence": 1,
  "filename": "frame_0001.png",
  "localPath": "output/frame_0001.png",
  "originalPrompt": "A sleek futuristic sports car speeding down a wet neon cyber highway...",
  "driveFileId": "1iiG5-0m2B5f5HE07TTOTMw__s1tOftu7",
  "driveWebViewLink": "https://drive.google.com/file/d/1iiG5-0m2B5f5HE07TTOTMw__s1tOftu7/view",
  "scene": 1,
  "shot": 1,
  "timestamp": "2026-10-14T08:52:57.136Z"
}
```

### Stitched Video with ffmpeg:
In the dashboard, click **"🎞️ ffmpeg Script"** or run:
```bash
ffmpeg -framerate 24 -pattern_type glob -i "output/*.png" -c:v libx264 -pix_fmt yuv420p output.mp4
```
