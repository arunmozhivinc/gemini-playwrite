const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { spawn } = require("node:child_process");

const app = express();
const PORT = Number(process.env.FFMPEG_PORT || process.env.PORT || 8787);
const API_KEY = process.env.RENDER_API_KEY || "72cd0ffdd03a7aedefb6c2c5f077323e522abf70cf8e01f5d29e0b271e6892dd";
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 500);
const ROOT = path.join(__dirname, "temp");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(ROOT, "uploads")),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".bin";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 10 },
});

app.disable("x-powered-by");
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Flexible authentication middleware
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const authHeader = req.get("authorization") || "";
  const apiKeyHeader =
    req.get("x-api-key") || req.get("api-key") || req.get("x-auth-token") || "";
  const queryKey = req.query.api_key || req.query.token || "";

  let supplied = "";
  if (authHeader.startsWith("Bearer ")) {
    supplied = authHeader.slice(7);
  } else if (authHeader) {
    supplied = authHeader;
  } else if (apiKeyHeader) {
    supplied = apiKeyHeader;
  } else if (queryKey) {
    supplied = queryKey;
  }

  const a = Buffer.from(supplied.trim());
  const b = Buffer.from(API_KEY.trim());

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn(
      `[Auth Failed] Path: ${req.path}, Method: ${req.method}, Supplied length: ${a.length}, Expected length: ${b.length}`
    );
    return res.status(401).json({
      error: "Unauthorized",
      hint: "Configure Header Auth in n8n with your RENDER_API_KEY",
    });
  }

  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "local-renderer",
    queuedJobs: jobQueue.length,
    activeJobs: activeJobCount,
    timestamp: new Date().toISOString(),
  });
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let errorText = "";

    child.stderr.on("data", (chunk) => {
      errorText = (errorText + chunk.toString()).slice(-5000);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error("FFmpeg failed: " + errorText));
    });
  });
}

function getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("close", (code) => {
      const dur = parseFloat(out.trim());
      resolve(isNaN(dur) ? 4.0 : dur);
    });
    child.on("error", () => resolve(4.0));
  });
}

/* =========================================================
   ASSET DOWNLOAD & FALLBACK GENERATOR
   ========================================================= */
async function downloadAsset(url, destPath) {
  try {
    if (!url) return false;
    const localCandidate = url.replace(/^file:\/\/\/?/, '');
    if (fsSync.existsSync(localCandidate)) {
      await fs.copyFile(localCandidate, destPath);
      return true;
    }
    let targetUrl = url;
    if (url.includes("drive.google.com")) {
      const match =
        url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
        url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (match) {
        targetUrl = `https://drive.usercontent.google.com/download?id=${match[1]}&export=download&confirm=t`;
      }
    }

    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      console.warn(`[Asset Fetch Warning] HTTP ${res.status} from ${url}`);
      return false;
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      console.warn(
        `[Asset Fetch Warning] Received HTML instead of media from ${url}`
      );
      return false;
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < 50) return false;

    await fs.writeFile(destPath, Buffer.from(buffer));
    return true;
  } catch (err) {
    console.warn(`[Asset Fetch Error] ${err.message} for ${url}`);
    return false;
  }
}

async function generateFallbackImage(destPath, width, height, sceneNum, title) {
  const colors = [
    "#4338ca",
    "#0891b2",
    "#059669",
    "#d97706",
    "#dc2626",
    "#7c3aed",
  ];
  const hexColor = colors[(sceneNum - 1) % colors.length];
  const colorArg = `0x${hexColor.slice(1)}`;

  await runFFmpeg([
    "-nostdin", "-y",
    "-f", "lavfi",
    "-i", `color=c=${colorArg}:s=${width}x${height}:d=1`,
    "-frames:v", "1",
    "-update", "1",
    destPath,
  ]);
}

async function generateFallbackAudio(destPath, durationSec = 4.0) {
  await runFFmpeg([
    "-nostdin", "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${durationSec}`,
    "-codec:a", "libmp3lame",
    "-q:a", "4",
    destPath,
  ]);
}

function wrapSubtitleText(text, maxChars = 52) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines.join("\\N");
}

function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

async function generateAssFile(assPath, text, durationSec, options = {}) {
  const defaultFont =
    process.platform === "win32" ? "Nirmala UI" : "Noto Sans Tamil";
  const fontName = options.fontName || process.env.SUBTITLE_FONT || defaultFont;
  // Enforced Portrait (9:16 - 1080x1920) for YouTube Shorts
  const playResX = 1080;
  const playResY = 1920;
  const fontSize = options.fontSize || 58;
  const marginV = options.marginV || 380; // Elevated safe zone above YouTube Shorts controls
  const maxChars = 28; // Optimal line wrap for mobile portrait
  const wrappedText = wrapSubtitleText(text, maxChars);

  const startFormatted = formatAssTime(0.2);
  const endFormatted = formatAssTime(Math.max(0.5, durationSec - 0.2));

  const assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${startFormatted},${endFormatted},Default,,0,0,0,,${wrappedText}
`;

  await fs.writeFile(assPath, assContent, "utf8");
}

/* =========================================================
   STORY VIDEO PIPELINE (BILINGUAL CHILDREN'S STORY)
   ========================================================= */
async function renderStoryVideo(storyData, jobDir) {
  const storyId = storyData.story_id || crypto.randomUUID();
  const language = storyData.language || "en";
  const title = storyData.title || "Children Story";
  const outputFilename =
    storyData.output_filename || `${storyId}_${language}.mp4`;

  const videoConfig = storyData.video || {};
  // Enforced Portrait (9:16 - 1080x1920) for YouTube Shorts
  const width = 1080;
  const height = 1920;
  const fps = videoConfig.fps || 30;
  const codec = videoConfig.codec || "libx264";
  const crf = videoConfig.crf ?? 23;

  const effectsConfig = storyData.effects || {};
  const kenBurns = effectsConfig.ken_burns !== false;
  const zoomMax = Number(effectsConfig.zoom_max || 1.12);
  const scenePadding = Number(effectsConfig.scene_padding_seconds || 0.6);

  const subtitlesConfig = storyData.subtitles || {};
  const burnInSubtitles = subtitlesConfig.burn_in !== false;
  const defaultFont =
    process.platform === "win32" ? "Nirmala UI" : "Noto Sans Tamil";
  const fontName =
    subtitlesConfig.font || process.env.SUBTITLE_FONT || defaultFont;
  const fontSize = Number(subtitlesConfig.font_size || 58);

  const scenes = Array.isArray(storyData.scenes) ? storyData.scenes : [];
  if (scenes.length === 0) {
    throw new Error("Story payload contains no scenes");
  }

  await fs.mkdir(jobDir, { recursive: true });

  const sceneVideoFiles = [];

  for (let idx = 0; idx < scenes.length; idx++) {
    const scene = scenes[idx];
    const sceneNum = scene.index || idx + 1;
    const scenePrefix = path.join(jobDir, `scene_${sceneNum}`);

    console.log(
      `[Story Render] Processing Scene ${sceneNum}/${scenes.length}...`
    );

    // 1. Download or generate image
    const imgPath = `${scenePrefix}_img.png`;
    let hasImage = false;
    if (scene.image_url) {
      hasImage = await downloadAsset(scene.image_url, imgPath);
    }
    if (!hasImage) {
      await generateFallbackImage(imgPath, width, height, sceneNum, title);
    }

    // 2. Download or generate audio
    const audioPath = `${scenePrefix}_audio.mp3`;
    let hasAudio = false;
    if (scene.audio_url) {
      hasAudio = await downloadAsset(scene.audio_url, audioPath);
    }
    if (!hasAudio) {
      await generateFallbackAudio(audioPath, 4.0);
    }

    // 3. Audio duration
    let duration = await getAudioDuration(audioPath);
    if (!duration || duration < 0.5) duration = 4.0;
    const totalSceneDuration = duration + scenePadding;
    const totalFrames = Math.max(30, Math.round(totalSceneDuration * fps));

    // 4. Subtitle generation
    let assFilter = "";
    if (burnInSubtitles && scene.subtitle_text) {
      const assPath = `${scenePrefix}_sub.ass`;
      await generateAssFile(assPath, scene.subtitle_text, totalSceneDuration, {
        fontName,
        fontSize,
        width,
        height,
      });
      const escapedAss = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      assFilter = `,ass='${escapedAss}'`;
    }

    // 5. Video filter chain
    let vf = "";
    if (kenBurns) {
      const zoomStep = ((zoomMax - 1.0) / totalFrames).toFixed(6);
      if (sceneNum % 2 === 1) {
        vf = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=z='min(zoom+${zoomStep},${zoomMax})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}${assFilter}`;
      } else {
        vf = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=z='max(${zoomMax}-${zoomStep}*on,1.0)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}${assFilter}`;
      }
    } else {
      vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}${assFilter}`;
    }

    // 6. Encode individual scene video
    const sceneOut = `${scenePrefix}.mp4`;
    const sceneArgs = [
      "-nostdin", "-y",
      "-loop", "1", "-i", imgPath,
      "-i", audioPath,
      "-vf", vf,
      "-af", `apad=pad_dur=${scenePadding}`,
      "-t", totalSceneDuration.toFixed(3),
      "-c:v", codec, "-preset", "veryfast", "-crf", String(crf),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      sceneOut,
    ];

    await runFFmpeg(sceneArgs);
    sceneVideoFiles.push(sceneOut);
  }

  // 7. Concatenate all scene clips
  console.log(`[Story Render] Concatenating ${sceneVideoFiles.length} scenes...`);
  const concatListFile = path.join(jobDir, "concat_list.txt");
  const fileLines = sceneVideoFiles
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(concatListFile, fileLines, "utf8");

  const finalVideo = path.join(jobDir, outputFilename);
  await runFFmpeg([
    "-nostdin", "-y",
    "-f", "concat", "-safe", "0",
    "-i", concatListFile,
    "-c", "copy",
    "-movflags", "+faststart",
    finalVideo,
  ]);

  return {
    finalVideoPath: finalVideo,
    outputFilename,
  };
}

async function handleStoryRender(req, res) {
  let storyData = req.body;
  if (Array.isArray(storyData)) {
    storyData = storyData[0];
  }
  if (!storyData || !storyData.scenes) {
    return res.status(400).json({ error: "Invalid payload: 'scenes' array is required" });
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(ROOT, "jobs", jobId);
  console.log(
    `[Story Render Request] Job: ${jobId}, Title: "${storyData.title || storyData.story_id}", Language: ${storyData.language || "en"}`
  );

  try {
    const { finalVideoPath, outputFilename } = await renderStoryVideo(storyData, jobDir);
    console.log(`[Story Render Done] Sending download for: ${outputFilename}`);

    res.download(finalVideoPath, outputFilename, async (err) => {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      if (err && !res.headersSent) {
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (err) {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    console.error(`[Story Render Failed] ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Story rendering failed", details: err.message });
    }
  }
}

// Story Rendering Routes (Supports POST /render/story, /render, /render-story)
app.post("/render/story", handleStoryRender);
app.post("/render-story", handleStoryRender);
app.post("/render", (req, res, next) => {
  if (req.body && req.body.scenes) {
    return handleStoryRender(req, res);
  }
  next();
});

/* =========================================================
   SYNCHRONOUS RENDERING (Single File Tools)
   ========================================================= */
function getOperationConfig(operation, inputPath, options = {}) {
  const op = operation.toLowerCase();
  if (op === "extract-audio") {
    const ext = ".mp3";
    const out = path.join(ROOT, "outputs", `${crypto.randomUUID()}${ext}`);
    const args = [
      "-nostdin", "-y", "-i", inputPath,
      "-map", "0:a:0", "-vn",
      "-codec:a", "libmp3lame", "-q:a", "4",
      out,
    ];
    return { output: out, args, extension: ext };
  }

  if (op === "compress-video") {
    const ext = ".mp4";
    const out = path.join(ROOT, "outputs", `${crypto.randomUUID()}${ext}`);
    const args = [
      "-nostdin", "-y", "-i", inputPath,
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "28", "-c:a", "aac",
      "-movflags", "+faststart", out,
    ];
    return { output: out, args, extension: ext };
  }

  if (op === "convert") {
    const target = (options.to || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "");
    const ext = `.${target || "mp4"}`;
    const out = path.join(ROOT, "outputs", `${crypto.randomUUID()}${ext}`);
    const args = ["-nostdin", "-y", "-i", inputPath, out];
    return { output: out, args, extension: ext };
  }

  throw new Error(`Unsupported operation: ${operation}`);
}

async function renderSync(req, res, operation) {
  if (!req.file) {
    return res.status(400).json({ error: "Upload a file in field 'file'" });
  }

  const input = req.file.path;
  let output;

  try {
    const targetFormat = req.query.to || req.body.to;
    const config = getOperationConfig(operation, input, { to: targetFormat });
    output = config.output;

    await fs.mkdir(path.dirname(output), { recursive: true });
    await runFFmpeg(config.args);

    res.download(output, path.basename(output), async (err) => {
      await fs.rm(input, { force: true }).catch(() => {});
      await fs.rm(output, { force: true }).catch(() => {});

      if (err && !res.headersSent) {
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (err) {
    await fs.rm(input, { force: true }).catch(() => {});
    if (output) await fs.rm(output, { force: true }).catch(() => {});

    console.error(`[Sync Render Error] ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Rendering failed", details: err.message });
    }
  }
}

app.post("/render/extract-audio", upload.single("file"), (req, res) =>
  renderSync(req, res, "extract-audio")
);
app.post("/render/compress-video", upload.single("file"), (req, res) =>
  renderSync(req, res, "compress-video")
);
app.post("/render/convert", upload.single("file"), (req, res) =>
  renderSync(req, res, "convert")
);

/* =========================================================
   ASYNCHRONOUS JOB QUEUE
   ========================================================= */
const jobs = new Map();
const jobQueue = [];
let activeJobCount = 0;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);

async function processQueue() {
  if (activeJobCount >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) {
    return;
  }

  const jobId = jobQueue.shift();
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued") return;

  activeJobCount++;
  job.status = "processing";
  job.startedAt = new Date().toISOString();

  (async () => {
    try {
      if (job.operation === "story") {
        const jobDir = path.join(ROOT, "jobs", job.id);
        const { finalVideoPath, outputFilename } = await renderStoryVideo(
          job.options.storyData,
          jobDir
        );
        job.outputPath = finalVideoPath;
        job.outputFilename = outputFilename;
      } else if (job.operation === "merge") {
        const listPath = path.join(ROOT, "uploads", `${job.id}_list.txt`);
        const fileLines = job.inputs
          .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
          .join("\n");
        await fs.writeFile(listPath, fileLines, "utf8");

        const ext = ".mp4";
        const output = path.join(ROOT, "outputs", `${job.id}${ext}`);
        job.outputPath = output;
        job.outputFilename = `merged_${job.id}${ext}`;

        try {
          await runFFmpeg([
            "-nostdin", "-y", "-f", "concat", "-safe", "0",
            "-i", listPath, "-c", "copy", output,
          ]);
        } catch {
          await runFFmpeg([
            "-nostdin", "-y", "-f", "concat", "-safe", "0",
            "-i", listPath,
            "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "26", "-c:a", "aac",
            "-movflags", "+faststart", output,
          ]);
        }

        await fs.rm(listPath, { force: true }).catch(() => {});
      } else {
        const config = getOperationConfig(job.operation, job.inputs[0], job.options);
        job.outputPath = config.output;
        job.outputFilename = `output_${job.id}${config.extension}`;

        await fs.mkdir(path.dirname(config.output), { recursive: true });
        await runFFmpeg(config.args);
      }

      job.status = "completed";
      job.completedAt = new Date().toISOString();
    } catch (err) {
      console.error(`[Job ${job.id} Error] ${err.message}`);
      job.status = "failed";
      job.error = err.message;
      job.completedAt = new Date().toISOString();
    } finally {
      for (const inputPath of job.inputs || []) {
        await fs.rm(inputPath, { force: true }).catch(() => {});
      }
      activeJobCount--;
      processQueue();
    }
  })();
}

function createJob(operation, inputs, options = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    operation,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    inputs,
    options,
    outputPath: null,
    outputFilename: null,
    error: null,
  };

  jobs.set(id, job);
  jobQueue.push(id);
  processQueue();

  return job;
}

// Async story endpoint
app.post(["/jobs/story", "/render/jobs/story"], (req, res) => {
  let payload = req.body;

  // Support array of stories (e.g., both EN & TA generated together)
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return res.status(400).json({ error: "Invalid payload: array is empty" });
    }
    const createdJobs = [];
    for (const item of payload) {
      if (item && item.scenes) {
        const job = createJob("story", [], { storyData: item });
        createdJobs.push({
          jobId: job.id,
          storyId: item.story_id,
          language: item.language,
          status: job.status,
          pollUrl: `/render/jobs/${job.id}`,
          downloadUrl: `/render/jobs/${job.id}/download`,
        });
      }
    }
    if (createdJobs.length === 0) {
      return res.status(400).json({
        error: "Invalid payload: 'scenes' array is required in each story object",
      });
    }
    return res.status(202).json({
      message: `${createdJobs.length} story job(s) queued successfully`,
      jobs: createdJobs,
    });
  }

  if (!payload || !payload.scenes) {
    return res.status(400).json({ error: "Invalid payload: 'scenes' array is required" });
  }

  const job = createJob("story", [], { storyData: payload });
  res.status(202).json({
    message: "Story job queued successfully",
    jobId: job.id,
    status: job.status,
    pollUrl: `/render/jobs/${job.id}`,
    downloadUrl: `/render/jobs/${job.id}/download`,
  });
});

app.post(["/jobs/extract-audio", "/render/jobs/extract-audio"], upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a file in field 'file'" });
  const job = createJob("extract-audio", [req.file.path]);
  res.status(202).json({
    message: "Job queued successfully",
    jobId: job.id,
    status: job.status,
    pollUrl: `/render/jobs/${job.id}`,
    downloadUrl: `/render/jobs/${job.id}/download`,
  });
});

app.post(["/jobs/compress-video", "/render/jobs/compress-video"], upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a file in field 'file'" });
  const job = createJob("compress-video", [req.file.path]);
  res.status(202).json({
    message: "Job queued successfully",
    jobId: job.id,
    status: job.status,
    pollUrl: `/render/jobs/${job.id}`,
    downloadUrl: `/render/jobs/${job.id}/download`,
  });
});

// Multi-file merge job
app.post(["/jobs/merge", "/render/jobs/merge"], upload.array("files", 10), (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);
  if (!files || files.length < 2) {
    return res.status(400).json({ error: "Upload at least 2 files in field 'files'" });
  }
  const filePaths = files.map((f) => f.path);
  const job = createJob("merge", filePaths);
  res.status(202).json({
    message: "Merge job queued successfully",
    jobId: job.id,
    fileCount: filePaths.length,
    status: job.status,
    pollUrl: `/render/jobs/${job.id}`,
    downloadUrl: `/render/jobs/${job.id}/download`,
  });
});

// Check job status
app.get(["/jobs/:id", "/render/jobs/:id"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.json({
    id: job.id,
    operation: job.operation,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    downloadUrl: job.status === "completed" ? `/render/jobs/${job.id}/download` : null,
    error: job.error,
  });
});

// Download job output
app.get(["/jobs/:id/download", "/render/jobs/:id/download"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (job.status !== "completed" || !job.outputPath) {
    return res.status(400).json({ error: `Job is not ready. Status: ${job.status}` });
  }

  if (!fsSync.existsSync(job.outputPath)) {
    return res.status(410).json({ error: "Output file expired or deleted" });
  }

  res.download(job.outputPath, job.outputFilename);
});

// Delete job
app.delete(["/jobs/:id", "/render/jobs/:id"], async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (job.outputPath) {
    await fs.rm(job.outputPath, { force: true }).catch(() => {});
  }
  jobs.delete(job.id);
  res.json({ status: "deleted", id: req.params.id });
});

// Global error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.message });
  }
  console.error(`[Server Error] ${err.message}`);
  res.status(500).json({ error: "Request failed", details: err.message });
});

// Periodic cleanup of temp outputs (every 30 mins, files older than 2 hours)
setInterval(async () => {
  try {
    const outputsDir = path.join(ROOT, "outputs");
    const entries = await fs.readdir(outputsDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(outputsDir, entry.name);
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
          await fs.rm(fullPath, { force: true }).catch(() => {});
        }
      }
    }
  } catch {}
}, 30 * 60 * 1000);

// Initialize folders and listen
fs.mkdir(path.join(ROOT, "uploads"), { recursive: true })
  .then(() => fs.mkdir(path.join(ROOT, "outputs"), { recursive: true }))
  .then(() => fs.mkdir(path.join(ROOT, "jobs"), { recursive: true }))
  .then(() => {
    const HOST = process.env.HOST || "0.0.0.0";
    app.listen(PORT, HOST, () => {
      console.log(`Renderer listening on ${HOST}:${PORT}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
