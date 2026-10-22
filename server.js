require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const GDriveService = require('./lib/gdrive');
const AntigravityService = require('./lib/antigravity');
const ImageGenerator = require('./lib/imageGenerator');
const AudioNarrator = require('./lib/audioNarrator');
const VideoAssembler = require('./lib/videoAssembler');
const YouTubePublisher = require('./lib/youtubePublisher');
const StoryGenerator = require('./lib/storyGenerator');
const TopicScout = require('./lib/topicScout');
const PipelineOrchestrator = require('./lib/pipelineOrchestrator');
const Namer = require('./lib/namer');
const ManifestManager = require('./lib/manifest');

// Load config
const configPath = path.join(__dirname, 'config.json');
let config = {};
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const app = express();
const PORT = process.env.PORT || config.server?.port || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));

// Services initialization
const gdrive = new GDriveService({
  scriptPath: config.gdrive?.scriptPath,
  defaultFolderId: config.gdrive?.defaultFolderId
});

const antigravity = new AntigravityService({
  cliPath: config.antigravity?.cliPath,
  timeoutMs: config.antigravity?.timeoutMs
});

const imageGenerator = new ImageGenerator({
  provider: config.generator?.provider,
  defaultModel: config.generator?.defaultModel
});

const audioNarrator = new AudioNarrator({
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceIdEn: process.env.ELEVENLABS_VOICE_EN,
  voiceIdTa: process.env.ELEVENLABS_VOICE_TA
});

const videoAssembler = new VideoAssembler({
  backgroundMusicPath: process.env.BACKGROUND_MUSIC_PATH,
  ffmpegServiceUrl: config.ffmpegService?.url,
  ffmpegApiKey: config.ffmpegService?.apiKey
});

const youtubePublisher = new YouTubePublisher({});

const DatabaseService = require('./lib/db');
const db = new DatabaseService();

const storyGenerator = new StoryGenerator({
  cliPath: config.antigravity?.cliPath,
  timeoutMs: config.antigravity?.timeoutMs || 180000,
  outputDir: path.join(__dirname, 'output'),
  db
});

const topicScout = new TopicScout({
  newsApiKey: process.env.NEWS_API_KEY,
  db,
  cliPath: config.antigravity?.cliPath
});

const pipeline = new PipelineOrchestrator({
  outputDir: path.join(__dirname, 'output'),
  sceneCount: 6,
  languages: ['en', 'ta'],
  autoUpload: true,
  youtubeN8nFolderId: '15y4Ettt3rjbhCb_dt8PVoVqRBB5WLtX1',
  antigravityCli: config.antigravity?.cliPath,
  timeoutMs: config.antigravity?.timeoutMs || 180000,
  ffmpegService: config.ffmpegService,
  db
});

// SSE Clients for real-time background dashboard logs
const sseClients = new Set();
const recentLogs = [];

// Activity state tracking for dashboard ("Happening NOW & LATER")
const currentActivity = {
  status: 'idle', // 'idle' | 'running'
  stage: null,    // 'topic' | 'story' | 'images' | 'audio' | 'video' | 'complete'
  stageLabel: 'System Standby — Waiting for trigger or schedule',
  storyId: null,
  title: null,
  progress: 0,
  startedAt: null,
  lastCompleted: null,
  lastCompletedAt: null
};

let isPipelineBusy = false;
let pipelineBusyStartedAt = null;

function broadcastActivity() {
  const payload = {
    type: 'activity',
    timestamp: new Date().toISOString(),
    activity: { ...currentActivity }
  };
  const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(dataStr); } catch (_) { sseClients.delete(client); }
  }
}

function broadcastLog(logEntry) {
  const entry = typeof logEntry === 'string'
    ? { timestamp: new Date().toISOString(), stage: 'general', level: 'info', message: logEntry }
    : { timestamp: new Date().toISOString(), ...logEntry };

  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs.shift();

  const dataStr = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(dataStr);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

pipeline.on('log', broadcastLog);

pipeline.on('stage', (data) => {
  const stage = data.stage;
  const status = data.status;

  if (status === 'running') {
    currentActivity.status = 'running';
    currentActivity.stage = stage;
    if (!currentActivity.startedAt) currentActivity.startedAt = new Date().toISOString();

    if (stage === 'topic') {
      currentActivity.progress = 15;
      currentActivity.stageLabel = '🔍 Scouting trending kids topic from Google Trends...';
    } else if (stage === 'story') {
      currentActivity.progress = 30;
      currentActivity.stageLabel = '📖 Generating bilingual 6-scene story with Antigravity AI...';
    } else if (stage === 'images') {
      currentActivity.progress = 55;
      currentActivity.stageLabel = '🎨 Generating 9:16 watercolor scene illustrations...';
    } else if (stage === 'audio') {
      currentActivity.progress = 75;
      currentActivity.stageLabel = '🎙️ Generating English & Tamil voice narration with ElevenLabs...';
    } else if (stage === 'video') {
      currentActivity.progress = 90;
      currentActivity.stageLabel = '🎬 Assembling 9:16 subtitled vertical videos with FFmpeg...';
    }
  } else if (status === 'done') {
    if (data.story) {
      currentActivity.storyId = data.story.story_id;
      currentActivity.title = data.story.title_en;
    }
    if (data.skipped) {
      currentActivity.progress = 100;
      currentActivity.stageLabel = `🛑 Story "${data.story?.title_en || currentActivity.title || ''}" is already in database. Skipped duplicate generation.`;
      setTimeout(() => {
        if (currentActivity.status === 'running') {
          currentActivity.status = 'idle';
          currentActivity.stage = null;
          currentActivity.stageLabel = 'System Standby — Ready for execution';
          currentActivity.progress = 0;
          currentActivity.startedAt = null;
          broadcastActivity();
        }
      }, 4000);
    } else if (stage === 'video' || stage === 'done') {
      currentActivity.progress = 100;
      currentActivity.stageLabel = '✅ Complete! Saved to PostgreSQL database.';
      currentActivity.lastCompleted = currentActivity.title || currentActivity.storyId;
      currentActivity.lastCompletedAt = new Date().toISOString();
      setTimeout(() => {
        if (currentActivity.status === 'running') {
          currentActivity.status = 'idle';
          currentActivity.stage = null;
          currentActivity.stageLabel = 'System Standby — Ready for execution';
          currentActivity.progress = 0;
          currentActivity.startedAt = null;
          broadcastActivity();
        }
      }, 4000);
    }
  }

  broadcastLog({
    stage: data.stage || 'pipeline',
    level: data.status === 'done' ? (data.skipped ? 'skip' : 'success') : 'info',
    message: `Stage [${(data.stage || '').toUpperCase()}]: ${data.status}${data.skipped ? ' (Reusing existing on-disk assets)' : ''}`,
    activity: currentActivity
  });
  broadcastActivity();
});

const manifest = new ManifestManager(path.join(__dirname, 'output', 'manifest.json'));

const YOUTUBE_N8N_PARENT_ID = config.gdrive?.youtubeN8nFolderId || '15y4Ettt3rjbhCb_dt8PVoVqRBB5WLtX1';

/**
 * Resolve or locate the exact story folder inside youtube-n8n.
 * If folder_id is supplied, validates/uses it.
 * If story_id is supplied, searches inside youtube-n8n for matching folder.
 */
async function resolveStoryFolder(storyId, explicitFolderId) {
  if (explicitFolderId) {
    return { folderId: explicitFolderId };
  }

  if (storyId) {
    try {
      // 1. Search inside the youtube-n8n parent folder
      const files = await gdrive.listFiles(YOUTUBE_N8N_PARENT_ID, 100);
      const matched = files.find(f => f.name === storyId || f.name.includes(storyId));
      if (matched) {
        return { folderId: matched.id, folderName: matched.name };
      }

      // 2. Global search in Drive
      const globalSearch = await gdrive.search(storyId);
      if (globalSearch && globalSearch.length > 0) {
        return { folderId: globalSearch[0].id, folderName: globalSearch[0].name };
      }

      // 3. Auto-create the story subfolder inside youtube-n8n
      console.log(`[Drive] Creating story folder "${storyId}" inside youtube-n8n...`);
      const created = await gdrive.createFolder(storyId, YOUTUBE_N8N_PARENT_ID);
      return { folderId: created.folderId, folderName: storyId };
    } catch (e) {
      console.warn('[Drive] Error resolving story folder:', e.message);
    }
  }

  return {
    folderId: config.gdrive?.defaultFolderId || YOUTUBE_N8N_PARENT_ID,
    folderName: config.gdrive?.defaultFolderName || 'youtube-n8n'
  };
}

// --- API Endpoints ---

/**
 * List all story folders inside youtube-n8n
 */
app.get('/api/drive/story-folders', async (req, res) => {
  try {
    const folders = await gdrive.listFiles(YOUTUBE_N8N_PARENT_ID, 100);
    res.json({
      success: true,
      parentFolderId: YOUTUBE_N8N_PARENT_ID,
      folders: folders.map(f => ({
        id: f.id,
        name: f.name,
        modifiedTime: f.modifiedTime,
        webViewLink: `https://drive.google.com/drive/folders/${f.id}`
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * System Status (Antigravity CLI, Google Drive auth, config)
 */
app.get('/api/status', async (req, res) => {
  try {
    const [driveStatus, agyStatus] = await Promise.all([
      gdrive.getAuthStatus(),
      antigravity.checkStatus()
    ]);

    let ffmpegAvailable = false;
    try {
      const ffmpegUrl = config.ffmpegService?.url || process.env.FFMPEG_SERVICE_URL || 'http://localhost:8787';
      const fRes = await fetch(`${ffmpegUrl}/health`, { signal: AbortSignal.timeout(1200) });
      ffmpegAvailable = fRes.ok;
    } catch (_) {}

    const nextIndex = manifest.getNextIndex();

    res.json({
      success: true,
      gdrive: {
        authenticated: driveStatus.authenticated,
        email: driveStatus.email || 'Connected Account',
        folderId: config.gdrive?.defaultFolderId,
        folderName: config.gdrive?.defaultFolderName || 'Antigravity_Video_Frames'
      },
      antigravity: {
        available: agyStatus.available,
        cliPath: agyStatus.path || config.antigravity?.cliPath
      },
      ffmpeg: {
        available: ffmpegAvailable,
        url: config.ffmpegService?.url || 'http://localhost:8787'
      },
      db: {
        connected: Boolean(db && db.connected)
      },
      elevenlabs: {
        configured: Boolean(process.env.ELEVENLABS_API_KEY)
      },
      settings: {
        pattern: config.naming?.defaultPattern || 'frame_{index:04d}.png',
        aspectRatio: config.generator?.defaultAspectRatio || '16:9',
        nextIndex
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Preview filename pattern
 */
app.post('/api/pattern/preview', (req, res) => {
  const { pattern, prompt, index, scene, shot } = req.body;
  const sample = Namer.preview(pattern || 'frame_{index:04d}.png', {
    prompt: prompt || 'sample scene keyframe',
    index: index || 1,
    scene: scene || 1,
    shot: shot || 1
  });
  res.json({ success: true, preview: sample });
});

/**
 * Expand prompt using Antigravity AI
 */
app.post('/api/expand-prompt', async (req, res) => {
  const { prompt, scene = 1, shot = 1, style = 'cinematic', aspectRatio = '16:9' } = req.body;
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }

  try {
    const result = await antigravity.expandPrompt(prompt, { scene, shot, style, aspectRatio });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Single image generation and upload pipeline
 */
app.post('/api/generate', async (req, res) => {
  try {
    const {
      prompt,
      pattern = config.naming?.defaultPattern || 'frame_{index:04d}.png',
      scene = 1,
      shot = 1,
      index = manifest.getNextIndex(),
      width = 1280,
      height = 720,
      aspectRatio = '16:9',
      autoUpload = true,
      folderId = config.gdrive?.defaultFolderId,
      expandWithAgy = true
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    // 1. Antigravity Prompt Expansion
    let expandedPrompt = prompt;
    let expansionSource = 'raw';
    if (expandWithAgy) {
      const expRes = await antigravity.expandPrompt(prompt, { scene, shot, aspectRatio });
      expandedPrompt = expRes.expandedPrompt;
      expansionSource = expRes.source;
    }

    // 2. Format Patterned Filename
    const filename = Namer.format(pattern, {
      index,
      scene,
      shot,
      prompt
    });

    const localOutputPath = path.join(__dirname, 'output', filename);

    // 3. Generate Image
    const genResult = await imageGenerator.generate({
      prompt: expandedPrompt,
      outputPath: localOutputPath,
      width,
      height
    });

    // 4. Upload to Google Drive if enabled
    let driveResult = null;
    if (autoUpload) {
      try {
        driveResult = await gdrive.uploadFile(localOutputPath, folderId, 'image/png');
      } catch (uploadErr) {
        console.error('Google Drive upload error:', uploadErr.message);
      }
    }

    // 5. Record to Manifest
    const frameRecord = {
      sequence: Number(index),
      filename,
      localPath: `output/${filename}`,
      originalPrompt: prompt,
      expandedPrompt,
      expansionSource,
      scene: Number(scene),
      shot: Number(shot),
      dimensions: { width, height },
      driveFolderId: folderId,
      driveFileId: driveResult?.fileId || null,
      driveWebViewLink: driveResult?.webViewLink || null,
      driveDownloadLink: driveResult?.downloadLink || null,
      timestamp: new Date().toISOString()
    };

    manifest.addFrame(frameRecord);

    res.json({
      success: true,
      frame: frameRecord,
      localUrl: `/output/${filename}`
    });
  } catch (err) {
    console.error('Generation pipeline error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Batch generation endpoint
 */
app.post('/api/batch', async (req, res) => {
  const { prompts = [], pattern = 'frame_{index:04d}.png', autoUpload = true, folderId } = req.body;
  if (!Array.isArray(prompts) || prompts.length === 0) {
    return res.status(400).json({ success: false, error: 'prompts array is required' });
  }

  const results = [];
  let currentIndex = manifest.getNextIndex();

  for (let i = 0; i < prompts.length; i++) {
    const item = typeof prompts[i] === 'string' ? { prompt: prompts[i] } : prompts[i];
    const seq = item.index || currentIndex++;

    try {
      const expRes = await antigravity.expandPrompt(item.prompt, {
        scene: item.scene || 1,
        shot: item.shot || 1
      });

      const filename = Namer.format(pattern, {
        index: seq,
        scene: item.scene || 1,
        shot: item.shot || 1,
        prompt: item.prompt
      });

      const localOutputPath = path.join(__dirname, 'output', filename);

      await imageGenerator.generate({
        prompt: expRes.expandedPrompt,
        outputPath: localOutputPath,
        width: item.width || 1280,
        height: item.height || 720
      });

      let driveResult = null;
      if (autoUpload) {
        try {
          driveResult = await gdrive.uploadFile(localOutputPath, folderId || config.gdrive?.defaultFolderId);
        } catch (e) {
          console.error(`Upload failed for ${filename}:`, e.message);
        }
      }

      const record = {
        sequence: seq,
        filename,
        localPath: `output/${filename}`,
        originalPrompt: item.prompt,
        expandedPrompt: expRes.expandedPrompt,
        scene: item.scene || 1,
        shot: item.shot || 1,
        driveFileId: driveResult?.fileId || null,
        driveWebViewLink: driveResult?.webViewLink || null,
        timestamp: new Date().toISOString()
      };

      manifest.addFrame(record);
      results.push({ success: true, frame: record });
    } catch (err) {
      results.push({ success: false, prompt: item.prompt, error: err.message });
    }
  }

  res.json({ success: true, processed: results.length, results });
});

/**
 * Get all frames from manifest
 */
app.get('/api/frames', (req, res) => {
  const frames = manifest.getFrames();
  res.json({ success: true, frames });
});

/**
 * Download JSON Manifest
 */
app.get('/api/manifest/json', (req, res) => {
  const data = manifest.read();
  res.setHeader('Content-Disposition', 'attachment; filename=manifest.json');
  res.json(data);
});

/**
 * Download CSV Manifest
 */
app.get('/api/manifest/csv', (req, res) => {
  const csv = manifest.exportCSV();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=video_frames.csv');
  res.send(csv);
});

/**
 * Download Video Assembly Script
 */
/**
 * N8N Integration: Drop-in replacement for OpenAI Image Generation & Drive Upload Nodes
 */
app.post('/api/n8n/scene', async (req, res) => {
  try {
    const {
      story_id,
      folder_id,
      scene_index = 1,
      image_prompt = '',
      naming_pattern
    } = req.body;

    const padSeq = String(scene_index).padStart(2, '0');
    const targetFilename = naming_pattern || `scene_${padSeq}.png`;

    // Automatically resolve the story folder inside youtube-n8n
    const resolved = await resolveStoryFolder(story_id, folder_id);
    const targetFolderId = resolved.folderId;
    const targetFolderName = resolved.folderName;

    console.log(`[n8n] Request for Scene ${scene_index} -> Folder: "${targetFolderName}" (${targetFolderId})`);

    // 1. Check if the scene file already exists in the target story folder
    if (targetFolderId) {
      const existingFiles = await gdrive.listFiles(targetFolderId);
      const matchedExisting = existingFiles.find(f => 
        f.name === targetFilename || 
        f.name === `scene_${padSeq}.jpg` ||
        f.name.startsWith(`Scene_${scene_index}_`)
      );

      if (matchedExisting) {
        console.log(`[n8n] Scene ${scene_index} already present in folder: ${matchedExisting.name} (${matchedExisting.id})`);
        return res.json({
          id: matchedExisting.id,
          name: matchedExisting.name,
          mimeType: matchedExisting.mimeType,
          webViewLink: `https://drive.google.com/file/d/${matchedExisting.id}/view`,
          scene_index: Number(scene_index),
          folderId: targetFolderId,
          folderName: targetFolderName,
          status: 'already_exists'
        });
      }
    }

    // 2. Search if Antigravity already generated this scene in another Drive folder
    const candidates = await gdrive.search(`Scene_${scene_index}_`);
    let preGenerated = (candidates && candidates.length > 0) ? candidates[0] : null;

    // If pre-generated Antigravity illustration found, copy it into target story folder
    if (preGenerated && targetFolderId) {
      console.log(`[n8n] Found existing Antigravity illustration: ${preGenerated.name} (${preGenerated.id}). Copying to ${targetFilename}...`);
      const copied = await gdrive.copyFile(preGenerated.id, targetFilename, targetFolderId);
      return res.json({
        id: copied.fileId,
        name: targetFilename,
        mimeType: 'image/jpeg',
        webViewLink: copied.webViewLink,
        scene_index: Number(scene_index),
        folderId: targetFolderId,
        folderName: targetFolderName,
        status: 'synced_from_antigravity'
      });
    }

    // 3. Otherwise generate dynamically using Antigravity Prompt Expansion & Drive Upload
    console.log(`[n8n] Generating dynamic illustration for Scene ${scene_index}...`);
    const expRes = await antigravity.expandPrompt(image_prompt, {
      scene: Number(scene_index),
      shot: 1,
      aspectRatio: '9:16',
      style: 'soft 2D watercolor storybook'
    });

    const storySubdir = story_id ? path.join(__dirname, 'output', story_id) : path.join(__dirname, 'output');
    if (!fs.existsSync(storySubdir)) fs.mkdirSync(storySubdir, { recursive: true });

    const localOutputPath = path.join(storySubdir, targetFilename);
    const rootOutputPath = path.join(__dirname, 'output', targetFilename);

    await imageGenerator.generate({
      prompt: expRes.expandedPrompt,
      outputPath: localOutputPath,
      width: 1080,
      height: 1920,
      storyId: story_id,
      sceneIndex: Number(scene_index)
    });

    // Mirror to root output as well for convenience
    try {
      if (localOutputPath !== rootOutputPath) {
        fs.copyFileSync(localOutputPath, rootOutputPath);
      }
    } catch (_) {}

    let uploaded = null;
    if (targetFolderId) {
      uploaded = await gdrive.uploadFile(localOutputPath, targetFolderId, 'image/png');
    }

    res.json({
      id: uploaded?.fileId || null,
      name: targetFilename,
      mimeType: 'image/png',
      webViewLink: uploaded?.webViewLink || null,
      scene_index: Number(scene_index),
      folderId: targetFolderId,
      folderName: targetFolderName,
      status: 'generated_fresh'
    });

  } catch (err) {
    console.error('[n8n] Scene processing error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * N8N Full Story Sync Endpoint: Copies/syncs all scenes at once
 */
app.post('/api/n8n/sync-story', async (req, res) => {
  try {
    const { story_id, folder_id, source_folder_id } = req.body;
    let sourceId = source_folder_id;

    if (!sourceId && story_id) {
      // Find source folder by story_id or title
      const folders = await gdrive.search(story_id);
      if (folders.length > 0) sourceId = folders[0].id;
    }

    if (!sourceId) {
      // Default fallback search for Village shorts folder
      const folders = await gdrive.search('The New Friend in the Village');
      if (folders.length > 0) sourceId = folders[0].id;
    }

    if (!sourceId) {
      return res.status(404).json({ error: 'Source Antigravity illustration folder not found' });
    }

    const sourceFiles = await gdrive.listFiles(sourceId);
    const results = [];

    for (const file of sourceFiles) {
      const match = file.name.match(/Scene_(\d+)_/i);
      if (match) {
        const sceneNum = parseInt(match[1], 10);
        const padSeq = String(sceneNum).padStart(2, '0');
        const targetName = `scene_${padSeq}.png`;

        console.log(`Copying ${file.name} -> ${targetName} into ${folder_id}...`);
        const copied = await gdrive.copyFile(file.id, targetName, folder_id);
        results.push({
          scene_index: sceneNum,
          name: targetName,
          id: copied.fileId,
          webViewLink: copied.webViewLink
        });
      }
    }

    res.json({ success: true, count: results.length, files: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Process Full Story JSON Locally: Generates / copies all scenes to a local directory with patterned names.
 */
app.post('/api/story/process', async (req, res) => {
  try {
    const { story, output_folder, naming_pattern = 'scene_{index:02d}.png', upload_to_drive = false, drive_folder_id } = req.body;
    if (!story || !story.scenes || !Array.isArray(story.scenes)) {
      return res.status(400).json({ error: 'Valid story object with scenes array is required' });
    }

    const storyId = story.story_id || `story_${Date.now()}`;
    const destinationDir = output_folder ? path.resolve(output_folder) : path.join(__dirname, 'output', storyId);

    if (!fs.existsSync(destinationDir)) {
      fs.mkdirSync(destinationDir, { recursive: true });
    }

    // Save story script JSON into the destination directory
    fs.writeFileSync(path.join(destinationDir, 'story_script.json'), JSON.stringify(story, null, 2), 'utf8');

    const results = [];
    let targetDriveFolderId = drive_folder_id;
    if (upload_to_drive && !targetDriveFolderId) {
      const resolved = await resolveStoryFolder(storyId);
      targetDriveFolderId = resolved.folderId;
    }

    for (let i = 0; i < story.scenes.length; i++) {
      const scene = story.scenes[i];
      const sceneIndex = scene.scene_index || (i + 1);
      const filename = Namer.format(naming_pattern, {
        index: sceneIndex,
        scene: sceneIndex,
        shot: 1,
        prompt: scene.text_en || scene.image_prompt || ''
      });

      const localPath = path.join(destinationDir, filename);

      // Generate or copy from local Antigravity pool
      const genResult = await imageGenerator.generate({
        prompt: scene.image_prompt,
        outputPath: localPath,
        width: 1080,
        height: 1920,
        storyId,
        sceneIndex
      });

      let driveUploaded = null;
      if (upload_to_drive && targetDriveFolderId) {
        driveUploaded = await gdrive.uploadFile(localPath, targetDriveFolderId, 'image/png');
      }

      results.push({
        scene_index: sceneIndex,
        filename,
        localPath,
        fileSize: genResult.fileSize,
        provider: genResult.provider,
        driveId: driveUploaded?.fileId || null,
        driveUrl: driveUploaded?.webViewLink || null
      });
    }

    res.json({
      success: true,
      story_id: storyId,
      destination_dir: destinationDir,
      total_scenes: results.length,
      scenes: results
    });
  } catch (err) {
    console.error('[Story Process] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Export Local Story Folder to Another Local Folder
 */
app.post('/api/story/export-to-folder', async (req, res) => {
  try {
    const { story_id, target_dir } = req.body;
    if (!story_id || !target_dir) {
      return res.status(400).json({ error: 'story_id and target_dir are required' });
    }

    const sourceDir = path.join(__dirname, 'output', story_id);
    if (!fs.existsSync(sourceDir)) {
      return res.status(404).json({ error: `Source story directory not found: ${sourceDir}` });
    }

    const destDir = path.resolve(target_dir);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const files = fs.readdirSync(sourceDir);
    const copiedFiles = [];

    for (const file of files) {
      const srcFile = path.join(sourceDir, file);
      const destFile = path.join(destDir, file);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, destFile);
        copiedFiles.push(file);
      }
    }

    res.json({
      success: true,
      story_id,
      source_dir: sourceDir,
      target_dir: destDir,
      copied_files: copiedFiles
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * List all local story folders
 */
app.get('/api/story/local-list', (req, res) => {
  try {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      return res.json({ success: true, stories: [] });
    }

    const items = fs.readdirSync(outputDir, { withFileTypes: true });
    const stories = [];

    for (const item of items) {
      if (item.isDirectory()) {
        const storyPath = path.join(outputDir, item.name);
        const files = fs.readdirSync(storyPath);
        const sceneFiles = files.filter(f => f.match(/^scene_\d+\.(png|jpg)$/i));
        stories.push({
          story_id: item.name,
          local_path: storyPath,
          scene_count: sceneFiles.length,
          files: files
        });
      }
    }

    res.json({ success: true, stories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
//  ENTERPRISE PIPELINE REST API ENDPOINTS
// =============================================================================

/**
 * Run the complete pipeline for one story (topic → story → images → audio → video → upload).
 * Body: { topic?, story_id?, skip_upload? }
 */
app.post('/api/pipeline/run', async (req, res) => {
  const { topic, story_id, skip_upload } = req.body;
  try {
    const result = await pipeline.run({
      topic: topic || undefined,
      storyId: story_id || undefined,
      skipUpload: skip_upload === true
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Auto-discover today's topic and run the full pipeline.
 */
app.post('/api/pipeline/run-from-topic', async (req, res) => {
  try {
    const topic = await topicScout.getTodayPrimaryTopic();
    res.json({ success: true, message: `Pipeline started for: "${topic}"`, topic });
    // Run asynchronously (non-blocking)
    pipeline.run({ topic }).catch(err => {
      console.error('[Pipeline] Background run failed:', err.message);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get pipeline status for a story.
 */
app.get('/api/pipeline/status/:storyId', (req, res) => {
  const storyDir = path.join(__dirname, 'output', req.params.storyId);
  if (!fs.existsSync(storyDir)) {
    return res.status(404).json({ error: 'Story folder not found' });
  }
  const status = pipeline.readPipelineStatus(storyDir);
  const files = fs.readdirSync(storyDir);
  res.json({ success: true, story_id: req.params.storyId, status, files });
});

/**
 * List all stories and their pipeline status.
 */
app.get('/api/pipeline/list', (req, res) => {
  try {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) return res.json({ stories: [] });

    const items = fs.readdirSync(outputDir, { withFileTypes: true })
      .filter(i => i.isDirectory());

    const stories = items.map(item => {
      const storyDir = path.join(outputDir, item.name);
      const status = pipeline.readPipelineStatus(storyDir);
      const files = fs.readdirSync(storyDir);
      const hasVideos = files.some(f => f.endsWith('_video.mp4'));
      const hasAudio = files.some(f => f.endsWith('.mp3'));
      const hasImages = files.some(f => f.match(/^scene_\d+\.png$/));

      return {
        story_id: item.name,
        overall: status.overall || 'unknown',
        stages: status.stages || {},
        has_images: hasImages,
        has_audio: hasAudio,
        has_videos: hasVideos,
        scene_count: files.filter(f => f.match(/^scene_\d+\.png$/)).length,
        last_updated: status.last_updated
      };
    });

    res.json({ success: true, total: stories.length, stories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Server-Sent Events (SSE) for Real-Time Background Pipeline Logs
 */
app.get('/api/pipeline/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send connected ping + buffer of recent logs
  res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), stage: 'system', level: 'info', message: '🟢 Connected to Real-Time Pipeline Log Stream' })}\n\n`);
  recentLogs.slice(-20).forEach(entry => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

/**
 * Get recent pipeline logs (from in-memory or PostgreSQL)
 */
app.get('/api/pipeline/logs/recent', async (req, res) => {
  try {
    const dbLogs = await db.getRecentLogs(50);
    res.json({ success: true, logs: dbLogs.length > 0 ? dbLogs : recentLogs });
  } catch (err) {
    res.json({ success: true, logs: recentLogs });
  }
});

/**
 * PostgreSQL: Get file uploads history
 */
app.get('/api/db/uploads', async (req, res) => {
  try {
    const uploads = await db.getFileUploads(req.query.story_id || null, 100);
    res.json({ success: true, total: uploads.length, uploads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
//  ENTERPRISE DASHBOARD API ENDPOINTS
// =============================================================================

/**
 * Dashboard: Overview & Real-time State (Happening NOW & LATER)
 */
app.get('/api/dashboard/overview', async (req, res) => {
  try {
    const stories = await db.getAllStories();
    const nextRun = calculateNextRun(currentCronExpression, isScheduleEnabled);

    const readyVideosCount = stories.filter(s => s.video_en_url || s.video_ta_url).length;
    const uploadedCount = stories.filter(s => s.status === 'uploaded' || s.youtube_en_id || s.youtube_ta_id).length;
    const awaitingApprovalCount = stories.filter(s => s.status === 'awaiting_approval' && !s.youtube_en_id).length;

    res.json({
      success: true,
      activity: {
        ...currentActivity,
        elapsedSeconds: currentActivity.startedAt ? Math.round((Date.now() - new Date(currentActivity.startedAt).getTime()) / 1000) : 0
      },
      schedule: {
        expression: currentCronExpression,
        enabled: isScheduleEnabled,
        ...nextRun
      },
      stats: {
        totalStories: stories.length,
        videosReady: readyVideosCount,
        uploaded: uploadedCount,
        awaitingApproval: awaitingApprovalCount,
        latestStoryTitle: stories[0]?.title_en || 'None'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Dashboard: Rich Stories & Videos Gallery (EN & TA Videos)
 */
app.get('/api/dashboard/stories', async (req, res) => {
  try {
    const dbStories = await db.getAllStories();
    const outputDir = path.join(__dirname, 'output');
    const dbStoryIds = new Set(dbStories.map(s => s.story_id));

    // Also include any story folders physically on disk
    if (fs.existsSync(outputDir)) {
      const diskDirs = fs.readdirSync(outputDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));
      for (const d of diskDirs) {
        if (!dbStoryIds.has(d.name)) {
          const scriptPath = path.join(outputDir, d.name, 'story_script.json');
          let script = {};
          if (fs.existsSync(scriptPath)) {
            try { script = JSON.parse(fs.readFileSync(scriptPath, 'utf8')); } catch (_) {}
          }
          dbStories.push({
            story_id: d.name,
            title_en: script.title_en || d.name,
            title_ta: script.title_ta || '',
            theme: script.theme || 'Story',
            moral: script.moral_en || script.moral || '',
            status: 'awaiting_approval',
            created_at: script.created_at || new Date().toISOString()
          });
        }
      }
    }

    const enriched = dbStories.map((story, index) => {
      const storyDir = path.join(outputDir, story.story_id);
      const existsOnDisk = fs.existsSync(storyDir);

      const enVideoDisk = path.join(storyDir, 'en_video.mp4');
      const taVideoDisk = path.join(storyDir, 'ta_video.mp4');
      const coverDisk = path.join(storyDir, 'scene_01.png');

      const hasEnVideo = fs.existsSync(enVideoDisk);
      const hasTaVideo = fs.existsSync(taVideoDisk);
      const hasCover = fs.existsSync(coverDisk);

      let sceneCount = 6;
      if (existsOnDisk) {
        try {
          const files = fs.readdirSync(storyDir);
          const scenes = files.filter(f => f.match(/^scene_\d+\.(png|jpg)$/i));
          if (scenes.length > 0) sceneCount = scenes.length;
        } catch (_) {}
      }

      return {
        story_id: story.story_id,
        title_en: story.title_en || 'Untitled Story',
        title_ta: story.title_ta || '',
        theme: story.theme || 'Kindness',
        moral: story.moral || '',
        status: story.status || 'awaiting_approval',
        is_latest: index === 0,
        is_uploaded: !!(story.youtube_en_id || story.youtube_ta_id || story.status === 'uploaded'),
        folder_url: story.folder_url || (existsOnDisk ? storyDir : ''),
        video_en_url: story.video_en_url || (hasEnVideo ? enVideoDisk : ''),
        video_ta_url: story.video_ta_url || (hasTaVideo ? taVideoDisk : ''),
        video_en_stream: hasEnVideo ? `/output/${story.story_id}/en_video.mp4` : null,
        video_ta_stream: hasTaVideo ? `/output/${story.story_id}/ta_video.mp4` : null,
        thumbnail: hasCover ? `/output/${story.story_id}/scene_01.png` : null,
        has_en_video: hasEnVideo,
        has_ta_video: hasTaVideo,
        scene_count: sceneCount,
        youtube_en_id: story.youtube_en_id,
        youtube_ta_id: story.youtube_ta_id,
        youtube_en_url: story.youtube_en_id ? `https://youtube.com/shorts/${story.youtube_en_id}` : null,
        youtube_ta_url: story.youtube_ta_id ? `https://youtube.com/shorts/${story.youtube_ta_id}` : null,
        created_at: story.created_at || new Date().toISOString()
      };
    });

    res.json({ success: true, total: enriched.length, stories: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Dashboard: Update Automated Schedule Timings dynamically
 */
app.post('/api/schedule/update', (req, res) => {
  const { expression, enabled } = req.body;
  if (!expression && enabled === undefined) {
    return res.status(400).json({ success: false, error: 'expression or enabled required' });
  }
  if (expression && !cron.validate(expression)) {
    return res.status(400).json({ success: false, error: 'Invalid cron expression' });
  }

  const newExpr = expression || currentCronExpression;
  const newEnabled = enabled !== undefined ? enabled : isScheduleEnabled;

  applySchedule(newExpr, newEnabled);
  const next = calculateNextRun(newExpr, newEnabled);

  broadcastLog({
    stage: 'schedule',
    level: 'info',
    message: `⏰ Schedule updated: ${next.label} (${newExpr}) — ${next.text}`
  });

  res.json({
    success: true,
    expression: newExpr,
    enabled: newEnabled,
    ...next
  });
});

/**
 * Dashboard: One-Click Full Pipeline Run (Auto or Custom Topic)
 */
app.post('/api/pipeline/run-full', async (req, res) => {
  const { topic } = req.body;
  if (isPipelineBusy) {
    return res.status(409).json({ success: false, error: 'A pipeline execution is already in progress.' });
  }

  isPipelineBusy = true;
  currentActivity.status = 'running';
  currentActivity.startedAt = new Date().toISOString();
  currentActivity.progress = 5;
  currentActivity.stageLabel = '🚀 Initializing Full Automated Pipeline...';
  broadcastActivity();

  // Non-blocking response
  res.json({
    success: true,
    message: 'Pipeline started successfully! Live progress is streaming on dashboard.'
  });

  (async () => {
    try {
      const selectedTopic = topic || await topicScout.getHourlyFreshTopic([], db);
      broadcastLog({
        stage: 'pipeline',
        level: 'info',
        message: `🚀 Full Pipeline Triggered for Topic: "${selectedTopic}"`
      });
      await pipeline.run({ topic: selectedTopic, skipUpload: true });
      broadcastLog({
        stage: 'pipeline',
        level: 'success',
        message: `🎉 Full Pipeline completed successfully for: "${selectedTopic}"`
      });
    } catch (err) {
      console.error('[Full Pipeline] Failed:', err.message);
      currentActivity.status = 'idle';
      currentActivity.stageLabel = `❌ Failed: ${err.message}`;
      broadcastActivity();
    } finally {
      isPipelineBusy = false;
    }
  })();
});

/**
 * Dashboard: Approve & Publish Specific Story to YouTube Shorts
 */
app.post('/api/stories/:storyId/publish', async (req, res) => {
  const { storyId } = req.params;
  const storyDir = path.join(__dirname, 'output', storyId);
  if (!fs.existsSync(storyDir)) {
    return res.status(404).json({ success: false, error: 'Story folder not found' });
  }

  const scriptPath = path.join(storyDir, 'story_script.json');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ success: false, error: 'story_script.json not found' });
  }

  const story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));

  // 0. Check if this story is ALREADY uploaded to YouTube
  const ytUploadPath = path.join(storyDir, 'youtube_upload.json');
  let existingYt = null;
  if (fs.existsSync(ytUploadPath)) {
    try { existingYt = JSON.parse(fs.readFileSync(ytUploadPath, 'utf8')); } catch (_) {}
  }

  let dbStory = null;
  try {
    const stories = await db.getAllStories();
    dbStory = stories.find(s => s.story_id === storyId);
  } catch (_) {}

  const existingEnId = story.youtube_en_id || existingYt?.results?.en?.videoId || dbStory?.youtube_en_id;
  const existingTaId = story.youtube_ta_id || existingYt?.results?.ta?.videoId || dbStory?.youtube_ta_id;

  if (existingEnId || existingTaId) {
    pipeline.updatePipelineStatus(storyDir, 'upload', 'done', { results: existingYt?.results });
    await db.upsertStory({
      story_id: storyId,
      status: 'uploaded',
      youtube_en_id: existingEnId || null,
      youtube_ta_id: existingTaId || null
    });

    broadcastLog({
      stage: 'upload',
      level: 'info',
      message: `🛑 Story "${story.title_en}" is ALREADY published on YouTube Shorts (EN: ${existingEnId || 'N/A'}, TA: ${existingTaId || 'N/A'}). Duplicate posting strictly prevented.`
    });

    return res.json({
      success: true,
      already_published: true,
      message: `Story "${story.title_en}" is already published on YouTube Shorts. Duplicate upload strictly prevented!`,
      youtube_en_id: existingEnId,
      youtube_ta_id: existingTaId,
      youtube_en_url: existingEnId ? `https://youtube.com/shorts/${existingEnId}` : null,
      youtube_ta_url: existingTaId ? `https://youtube.com/shorts/${existingTaId}` : null,
      result: existingYt || { success: true }
    });
  }

  try {
    const isAuth = await youtubePublisher.isAuthenticated();
    if (!isAuth) {
      const authUrl = '/auth/youtube';
      broadcastLog({
        stage: 'upload',
        level: 'warn',
        message: `⚠️ YouTube OAuth is not connected. Visit ${authUrl} to authorize your channel.`
      });
      return res.status(401).json({
        success: false,
        error: 'YouTube OAuth not authenticated. Visit /auth/youtube to authenticate.',
        authUrl,
        requiresAuth: true
      });
    }

    broadcastLog({
      stage: 'upload',
      level: 'info',
      message: `📤 Starting approved YouTube upload for "${story.title_en}"...`
    });

    const result = await youtubePublisher.uploadAll(storyDir, story, ['en', 'ta']);

    const enId = result?.results?.en?.videoId || result?.uploads?.en?.videoId || null;
    const taId = result?.results?.ta?.videoId || result?.uploads?.ta?.videoId || null;

    if (enId || taId) {
      pipeline.updatePipelineStatus(storyDir, 'upload', 'done', { results: result?.results || result?.uploads });
      await db.upsertStory({
        story_id: storyId,
        status: 'uploaded',
        youtube_en_id: enId,
        youtube_ta_id: taId
      });
      broadcastLog({
        stage: 'upload',
        level: 'success',
        message: `🎉 Published to YouTube Shorts! EN: ${enId || 'N/A'}, TA: ${taId || 'N/A'}`
      });
      res.json({ success: true, result, youtube_en_id: enId, youtube_ta_id: taId });
    } else {
      // Extract detailed underlying errors from each language result
      const enError = result?.results?.en?.error || result?.uploads?.en?.error;
      const taError = result?.results?.ta?.error || result?.uploads?.ta?.error;
      const rawError = enError || taError || 'YouTube upload failed';

      let userFriendlyError = rawError;
      if (rawError.includes('exceeded the number of videos')) {
        userFriendlyError = 'YouTube Daily Upload Limit Reached: Your channel has reached Google’s daily video upload limit (common on new or unverified channels, typically 5-10 videos per 24 hours). Please wait 24 hours or verify your channel features in YouTube Studio (Settings > Channel > Feature eligibility).';
      } else if (rawError.includes('invalid_grant') || rawError.includes('token')) {
        userFriendlyError = 'YouTube OAuth token expired or revoked. Please re-authenticate at /auth/youtube.';
      } else if (rawError.includes('quotaExceeded')) {
        userFriendlyError = 'YouTube Data API daily quota exceeded. Google resets API quota daily at midnight PST (1:30 PM IST).';
      }

      broadcastLog({
        stage: 'upload',
        level: 'error',
        message: `❌ YouTube upload failed for "${story.title_en}": ${userFriendlyError}`
      });

      res.status(500).json({
        success: false,
        error: userFriendlyError,
        raw_error: rawError,
        details: {
          en: enError,
          ta: taError
        },
        result
      });
    }
  } catch (err) {
    broadcastLog({
      stage: 'upload',
      level: 'error',
      message: `❌ YouTube upload exception: ${err.message}`
    });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Dashboard: Delete Story Folder (Disk) and Database Records
 */
app.delete('/api/stories/:storyId', async (req, res) => {
  const { storyId } = req.params;
  if (!storyId) {
    return res.status(400).json({ success: false, error: 'storyId is required' });
  }

  // Prevent directory traversal attacks
  const safeStoryId = path.basename(storyId);
  const storyDir = path.join(__dirname, 'output', safeStoryId);

  let folderDeleted = false;
  if (fs.existsSync(storyDir)) {
    try {
      fs.rmSync(storyDir, { recursive: true, force: true });
      folderDeleted = true;
    } catch (e) {
      console.error(`[Delete Story] Error removing folder ${storyDir}:`, e.message);
      return res.status(500).json({ success: false, error: `Failed to delete folder from disk: ${e.message}` });
    }
  }

  let dbDeleted = false;
  try {
    dbDeleted = await db.deleteStory(safeStoryId);
  } catch (e) {
    console.error(`[Delete Story] Error deleting DB records for ${safeStoryId}:`, e.message);
  }

  broadcastLog({
    stage: 'general',
    level: 'warn',
    message: `🗑️ Deleted story "${safeStoryId}" (Disk folder: ${folderDeleted ? 'deleted' : 'not found'}, DB: ${dbDeleted ? 'removed' : 'not found'})`
  });

  res.json({
    success: true,
    message: `Story "${safeStoryId}" deleted successfully.`,
    story_id: safeStoryId,
    folder_deleted: folderDeleted,
    db_deleted: dbDeleted
  });
});

/**
 * PostgreSQL: Get execution logs from database
 */
app.get('/api/db/logs', async (req, res) => {
  try {
    const logs = await db.getRecentLogs(req.query.limit || 100, req.query.story_id || null);
    res.json({ success: true, total: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PostgreSQL: Get all stories matching user schema
 */
app.get('/api/db/stories', async (req, res) => {
  try {
    const stories = await db.getAllStories();
    res.json({ success: true, total: stories.length, stories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PostgreSQL: Insert or update a story record
 */
app.post('/api/db/stories', async (req, res) => {
  try {
    const saved = await db.upsertStory(req.body);
    res.json({ success: true, story: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Generate story script from a topic.
 */
app.post('/api/story/generate', async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic is required' });

  try {
    const story = await storyGenerator.generateStory(topic);
    const storyDir = path.join(__dirname, 'output', story.story_id);
    if (!fs.existsSync(storyDir)) fs.mkdirSync(storyDir, { recursive: true });
    fs.writeFileSync(path.join(storyDir, 'story_script.json'), JSON.stringify(story, null, 2));
    res.json({ success: true, story, storyDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Generate audio for all scenes in a story folder.
 */
app.post('/api/audio/generate', async (req, res) => {
  const { story_id, languages = ['en', 'ta'] } = req.body;
  if (!story_id) return res.status(400).json({ error: 'story_id is required' });

  const storyDir = path.join(__dirname, 'output', story_id);
  const scriptPath = path.join(storyDir, 'story_script.json');
  if (!fs.existsSync(scriptPath)) return res.status(404).json({ error: 'story_script.json not found' });

  const story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));

  try {
    const result = await audioNarrator.generateAllSceneAudio(story.scenes, storyDir, languages);
    res.json({ success: true, story_id, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * List available ElevenLabs voices.
 */
app.get('/api/audio/voices', async (req, res) => {
  try {
    const voices = await audioNarrator.listVoices();
    res.json({ success: true, voices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Assemble video(s) for a story using FFmpeg.
 */
app.post('/api/video/assemble', async (req, res) => {
  const { story_id, languages = ['en', 'ta'] } = req.body;
  if (!story_id) return res.status(400).json({ error: 'story_id is required' });

  const storyDir = path.join(__dirname, 'output', story_id);
  if (!fs.existsSync(storyDir)) return res.status(404).json({ error: 'Story folder not found' });

  const scriptPath = path.join(storyDir, 'story_script.json');
  const story = fs.existsSync(scriptPath) ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : { scenes: Array(6) };
  const sceneCount = story.scenes?.length || 6;

  try {
    const result = await videoAssembler.assembleAll(storyDir, sceneCount, languages);
    res.json({ success: true, story_id, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * YouTube OAuth: Get authorization URL
 */
app.get('/auth/youtube', (req, res) => {
  const url = youtubePublisher.getAuthUrl();
  res.redirect(url);
});

/**
 * YouTube OAuth: Callback to exchange code for tokens
 */
app.get('/auth/youtube/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`YouTube OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const tokens = await youtubePublisher.exchangeCode(code);
    res.send(`
      <!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0f0f1a;color:#fff">
        <h1 style="color:#00ff88">✅ YouTube Connected!</h1>
        <p>Authorization successful. Tokens saved securely to <code>.youtube_tokens.json</code>.</p>
        <p><a href="/" style="color:#60a5fa">← Return to Dashboard</a></p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`OAuth token exchange failed: ${err.message}`);
  }
});

/**
 * YouTube: Check connection status
 */
app.get('/api/youtube/channel-status', async (req, res) => {
  try {
    const authenticated = await youtubePublisher.isAuthenticated();
    res.json({
      success: true,
      authenticated,
      authUrl: authenticated ? null : youtubePublisher.getAuthUrl()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * YouTube: Upload videos for a story
 */
app.post('/api/youtube/upload', async (req, res) => {
  const { story_id, languages = ['en', 'ta'] } = req.body;
  if (!story_id) return res.status(400).json({ error: 'story_id is required' });

  const storyDir = path.join(__dirname, 'output', story_id);
  const scriptPath = path.join(storyDir, 'story_script.json');
  if (!fs.existsSync(scriptPath)) return res.status(404).json({ error: 'story_script.json not found' });

  const story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));

  try {
    const result = await youtubePublisher.uploadAll(storyDir, story, languages);
    if (result && result.success) {
      res.json({ success: true, story_id, result });
    } else {
      const enError = result?.results?.en?.error;
      const taError = result?.results?.ta?.error;
      const rawError = enError || taError || 'Upload failed';
      let userFriendlyError = rawError;
      if (rawError.includes('exceeded the number of videos')) {
        userFriendlyError = 'YouTube Daily Upload Limit Reached: Your channel has reached Google’s daily video upload limit. Please try again in 24 hours.';
      }
      res.status(500).json({ success: false, error: userFriendlyError, raw_error: rawError, result });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Discover today's topics (manually callable)
 */
app.get('/api/topics/today', async (req, res) => {
  try {
    const topics = await topicScout.getTodayTopics();
    res.json({ success: true, topics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manually trigger any cron job
 */
app.post('/api/cron/trigger', async (req, res) => {
  const { job } = req.body;
  try {
    if (job === 'topic_and_pipeline' || job === 'story_to_video' || job === 'hourly_pipeline') {
      if (isPipelineBusy) {
        return res.status(409).json({ success: false, error: 'A pipeline execution is already in progress.' });
      }
      isPipelineBusy = true;
      const topic = await topicScout.getHourlyFreshTopic([], db);
      res.json({ success: true, message: `Hourly Story-to-Video pipeline triggered for: "${topic}"`, topic });
      pipeline.run({ topic, skipUpload: true })
        .then(() => console.log(`[Manual Trigger] ✅ Completed: "${topic}"`))
        .catch(e => console.error('[Manual Trigger] Pipeline error:', e.message))
        .finally(() => { isPipelineBusy = false; });
    } else if (job === 'upload_check') {
      const ready = pipeline.findReadyToUpload();
      res.json({ success: true, ready_count: ready.length, ready });
      for (const { storyId, storyDir } of ready) {
        const scriptPath = path.join(storyDir, 'story_script.json');
        const story = fs.existsSync(scriptPath) ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : null;
        if (story) {
          youtubePublisher.uploadAll(storyDir, story, ['en', 'ta'])
            .then(async uploadRes => {
              if (uploadRes && uploadRes.success) {
                pipeline.updatePipelineStatus(storyDir, 'upload', 'done', { results: uploadRes.results });
                const enId = uploadRes.results?.en?.videoId || null;
                const taId = uploadRes.results?.ta?.videoId || null;
                await db.upsertStory({
                  story_id: storyId,
                  status: 'uploaded',
                  youtube_en_id: enId,
                  youtube_ta_id: taId
                });
              }
            })
            .catch(e => console.error(`[Cron] Upload error for ${storyId}:`, e.message));
        }
      }
    } else {
      res.status(400).json({ error: 'Unknown job. Use: story_to_video, topic_and_pipeline, upload_check' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
//  CRON JOBS & DYNAMIC SCHEDULER
// =============================================================================

let currentCronExpression = process.env.STORY_PIPELINE_CRON || '0 * * * *';
let isScheduleEnabled = true;
let scheduledCronTask = null;

function calculateNextRun(cronExpr, enabled = true) {
  if (!enabled) {
    return {
      text: 'Schedule Paused',
      secondsRemaining: null,
      nextDate: null,
      label: 'Paused'
    };
  }

  const now = new Date();
  let next = new Date(now);
  let label = 'Custom Schedule';

  if (cronExpr === '0 * * * *') {
    label = 'Every 1 Hour';
    next.setHours(now.getHours() + 1, 0, 0, 0);
  } else if (cronExpr === '0 */2 * * *') {
    label = 'Every 2 Hours';
    const nextHour = (Math.floor(now.getHours() / 2) + 1) * 2;
    next.setHours(nextHour, 0, 0, 0);
  } else if (cronExpr === '0 */4 * * *') {
    label = 'Every 4 Hours';
    const nextHour = (Math.floor(now.getHours() / 4) + 1) * 4;
    next.setHours(nextHour, 0, 0, 0);
  } else if (cronExpr === '0 */6 * * *') {
    label = 'Every 6 Hours';
    const nextHour = (Math.floor(now.getHours() / 6) + 1) * 6;
    next.setHours(nextHour, 0, 0, 0);
  } else if (cronExpr === '0 6 * * *') {
    label = 'Daily at 6:00 AM IST';
    next.setHours(6, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  } else {
    label = `Custom (${cronExpr})`;
    next.setHours(now.getHours() + 1, 0, 0, 0);
  }

  const diffSec = Math.max(0, Math.round((next - now) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  let remainingStr = '';
  if (hours > 0) remainingStr = `${hours}h ${mins}m`;
  else if (mins > 0) remainingStr = `${mins}m ${secs}s`;
  else remainingStr = `${secs}s`;

  return {
    label,
    text: `In ${remainingStr} (at ${next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
    secondsRemaining: diffSec,
    nextDate: next.toISOString()
  };
}

function applySchedule(expression, enabled = true) {
  if (scheduledCronTask) {
    scheduledCronTask.stop();
    scheduledCronTask = null;
  }
  currentCronExpression = expression || '0 * * * *';
  isScheduleEnabled = enabled;

  if (enabled && cron.validate(currentCronExpression)) {
    scheduledCronTask = cron.schedule(currentCronExpression, async () => {
      console.log(`[Cron] ⏰ Hourly Story-to-Video Pipeline triggered (${currentCronExpression})...`);
      
      // Watchdog: If previous pipeline run has been marked busy for > 35 minutes, auto-reset
      if (isPipelineBusy) {
        const busyDurationMs = pipelineBusyStartedAt ? Date.now() - pipelineBusyStartedAt : 0;
        if (busyDurationMs > 35 * 60 * 1000) {
          console.warn(`[Cron] ⚠️ Previous pipeline run was busy for ${(busyDurationMs / 60000).toFixed(1)}m. Forcing busy flag reset.`);
          isPipelineBusy = false;
        } else {
          console.log('[Cron] ⚠️ A pipeline execution is already in progress. Skipping this hour trigger.');
          return;
        }
      }

      isPipelineBusy = true;
      pipelineBusyStartedAt = Date.now();
      try {
        const topic = await topicScout.getHourlyFreshTopic([], db);
        console.log(`[Cron] 🎯 Selected Topic for this hour: "${topic}"`);
        await pipeline.run({ topic, skipUpload: true });
        console.log(`[Cron] ✅ Hourly Story-to-Video generation completed successfully for: "${topic}"`);
      } catch (err) {
        console.error('[Cron] ❌ Hourly Story-to-Video generation failed:', err.message);
      } finally {
        isPipelineBusy = false;
        pipelineBusyStartedAt = null;
      }
    }, { timezone: 'Asia/Kolkata' });
    console.log(`[Schedule] Active story-to-video schedule set: ${currentCronExpression}`);
  }
}

// Initialize active schedule
applySchedule(currentCronExpression, isScheduleEnabled);

// Hourly: Detect completed videos + upload to YouTube (strictly prevents re-uploading approved/posted videos)
cron.schedule('0 * * * *', async () => {
  console.log('[Cron] 🔍 Checking for ready-to-upload stories...');
  try {
    const ready = pipeline.findReadyToUpload();
    if (ready.length === 0) {
      console.log('[Cron] No stories ready to upload.');
      return;
    }

    for (const { storyId, storyDir } of ready) {
      const scriptPath = path.join(storyDir, 'story_script.json');
      if (!fs.existsSync(scriptPath)) continue;
      const story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));

      // Check if story is already uploaded in DB
      let dbStory = null;
      try {
        const allDb = await db.getAllStories();
        dbStory = allDb.find(s => s.story_id === storyId);
      } catch (_) {}

      if (dbStory?.status === 'uploaded' || dbStory?.youtube_en_id || dbStory?.youtube_ta_id || story.youtube_en_id || story.youtube_ta_id) {
        pipeline.updatePipelineStatus(storyDir, 'upload', 'done');
        console.log(`[Cron] 🛑 Story "${story.title_en}" (${storyId}) is already uploaded. Skipping duplicate upload.`);
        continue;
      }

      // Check approval workflow: stories require manual approval in Dashboard unless AUTO_PUBLISH_TO_YOUTUBE is true
      const isApproved = dbStory?.status === 'approved' || process.env.AUTO_PUBLISH_TO_YOUTUBE === 'true';
      if (!isApproved) {
        console.log(`[Cron] ⏳ Story "${story.title_en}" (${storyId}) is awaiting manual approval in Dashboard before YouTube publishing. Skipping auto-upload.`);
        continue;
      }

      console.log(`[Cron] Uploading approved story: ${storyId}`);
      try {
        const uploadRes = await youtubePublisher.uploadAll(storyDir, story, ['en', 'ta']);
        if (uploadRes && uploadRes.success) {
          pipeline.updatePipelineStatus(storyDir, 'upload', 'done', { results: uploadRes.results });
          const enId = uploadRes.results?.en?.videoId || null;
          const taId = uploadRes.results?.ta?.videoId || null;
          await db.upsertStory({
            story_id: storyId,
            status: 'uploaded',
            youtube_en_id: enId,
            youtube_ta_id: taId
          });
          console.log(`[Cron] ✅ Uploaded: ${storyId}`);
        } else {
          const errReason = uploadRes?.results?.en?.error || uploadRes?.results?.ta?.error || 'Unknown upload failure';
          console.error(`[Cron] ❌ Upload failed for ${storyId}: ${errReason}`);
        }
      } catch (e) {
        console.error(`[Cron] Upload failed for ${storyId}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[Cron] Upload check failed:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

// Daily 2:00 AM: Archive completed stories to Google Drive
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] 🗄️ Drive archive sync starting...');
  try {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) return;

    const items = fs.readdirSync(outputDir, { withFileTypes: true }).filter(i => i.isDirectory());
    for (const item of items) {
      const storyDir = path.join(outputDir, item.name);
      const status = pipeline.readPipelineStatus(storyDir);
      // Archive only completed stories that haven't been archived yet
      if (status.overall === 'done' && !status.stages?.archived) {
        console.log(`[Cron] Archiving ${item.name} to Drive...`);
        // Non-blocking
      }
    }
  } catch (err) {
    console.error('[Cron] Archive sync failed:', err.message);
  }
}, { timezone: 'Asia/Kolkata' });

console.log('[Cron] ✅ Scheduled jobs registered:');
console.log(`[Cron]   → Active (${currentCronExpression}) IST: Discover topic & run Story-to-Video generation`);
console.log('[Cron]   → Hourly: Upload ready videos to YouTube');
console.log('[Cron]   → Daily 2:00 AM IST: Archive to Google Drive');

// =============================================================================
//  SERVER START
// =============================================================================
const http = require('http');
const { spawn } = require('child_process');

function ensureInternalFfmpegService() {
  const req = http.get('http://localhost:8787/health', { timeout: 1000 }, (res) => {
    if (res.statusCode === 200) {
      console.log('🎬 [FFmpeg Service] Connected & healthy on port 8787');
    }
  });
  req.on('error', () => {
    const ffmpegPath = path.join(__dirname, 'services', 'ffmpeg', 'server.js');
    if (fs.existsSync(ffmpegPath)) {
      console.log('🎬 [FFmpeg Service] Auto-starting internal service on port 8787...');
      const child = spawn(process.execPath, [ffmpegPath], {
        cwd: path.join(__dirname, 'services', 'ffmpeg'),
        env: { ...process.env, PORT: '8787', FFMPEG_PORT: '8787' },
        stdio: 'ignore'
      });
      process.on('exit', () => {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', child.pid, '/T', '/F'], { stdio: 'ignore' });
          } else {
            child.kill();
          }
        } catch (_) {}
      });
    }
  });
}

ensureInternalFfmpegService();

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 YouTube Kids Shorts Pipeline — Enterprise Mode`);
  console.log(`🌐 API + ngrok: http://localhost:${PORT}`);
  console.log(`📺 YouTube Auth: http://localhost:${PORT}/auth/youtube`);
  console.log(`📁 Google Drive: ${config.gdrive?.defaultFolderName} (${config.gdrive?.defaultFolderId})`);
  console.log(`=======================================================`);
});

if (PORT !== 3000) {
  try {
    app.listen(3000, () => {
      console.log(`🌐 Local Dashboard: http://localhost:3000`);
    });
  } catch (err) {
    console.log(`Note on port 3000: ${err.message}`);
  }
}
