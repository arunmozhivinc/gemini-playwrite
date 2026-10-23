const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const TopicScout = require('./topicScout');
const StoryGenerator = require('./storyGenerator');
const ImageGenerator = require('./imageGenerator');
const AudioNarrator = require('./audioNarrator');
const VideoAssembler = require('./videoAssembler');
const YouTubePublisher = require('./youtubePublisher');
const GDriveService = require('./gdrive');
const AntigravityService = require('./antigravity');
const DatabaseService = require('./db');

/**
 * Pipeline Orchestrator
 * Coordinates all stages of the YouTube Kids Shorts automation pipeline.
 *
 * Stages:
 *   TOPIC → STORY → IMAGES → AUDIO → VIDEO → UPLOAD → DONE
 *
 * - Skips already generated stories, scene images, audio, and videos.
 * - Logs all events and file uploads into PostgreSQL.
 * - Emits real-time logs for dashboard streaming.
 */

const STAGES = ['topic', 'story', 'images', 'audio', 'video', 'upload', 'done'];

class PipelineOrchestrator extends EventEmitter {
  constructor(config = {}) {
    super();

    this.outputDir = config.outputDir || path.join(process.cwd(), 'output');
    this.sceneCount = config.sceneCount || 12;
    this.languages = config.languages || ['en', 'ta'];
    this.autoUpload = config.autoUpload !== undefined ? config.autoUpload : true;
    this.youtubeN8nFolderId = config.youtubeN8nFolderId || '15y4Ettt3rjbhCb_dt8PVoVqRBB5WLtX1';

    // Init services
    this.db = config.db || new DatabaseService();
    this.topicScout = new TopicScout({
      newsApiKey: process.env.NEWS_API_KEY,
      db: this.db,
      cliPath: config.antigravityCli
    });
    this.storyGenerator = new StoryGenerator({
      cliPath: config.antigravityCli,
      timeoutMs: config.timeoutMs || 240000,
      sceneCount: this.sceneCount,
      outputDir: this.outputDir,
      db: this.db
    });
    this.imageGenerator = config.imageGenerator || new ImageGenerator({
      artifactsDir: config.artifactsDir,
      profileDir: process.env.GEMINI_PROFILE_DIR
    });
    this.audioNarrator = new AudioNarrator({
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceIdEn: process.env.ELEVENLABS_VOICE_EN,
      voiceIdTa: process.env.ELEVENLABS_VOICE_TA,
      bgmEnabled: config.bgm?.enabled !== false,
      bgmVolume: config.bgm?.volume || 0.08,
      bgmAssetsDir: config.bgm?.assetsDir,
      bgmAutoDownload: config.bgm?.autoDownload !== false
    });
    this.videoAssembler = new VideoAssembler({
      backgroundMusicPath: process.env.BACKGROUND_MUSIC_PATH,
      ffmpegServiceUrl: config.ffmpegService?.url || process.env.FFMPEG_SERVICE_URL,
      ffmpegApiKey: config.ffmpegService?.apiKey || process.env.RENDER_API_KEY
    });
    this.youtubePublisher = new YouTubePublisher({});
    this.gdrive = new GDriveService({
      defaultFolderId: this.youtubeN8nFolderId
    });
    this.antigravity = new AntigravityService({ cliPath: config.antigravityCli });
  }

  // --- Real-time Logging Helpers ---

  logInfo(stage, message, storyId = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      storyId,
      stage,
      level: 'info',
      message
    };
    console.log(`[${stage.toUpperCase()}] ${message}`);
    this.emit('log', entry);
    if (this.db) {
      this.db.log(storyId, stage, 'info', message).catch(() => {});
    }
  }

  logWarn(stage, message, storyId = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      storyId,
      stage,
      level: 'warn',
      message
    };
    console.warn(`[${stage.toUpperCase()}] ⚠️ ${message}`);
    this.emit('log', entry);
    if (this.db) {
      this.db.log(storyId, stage, 'warn', message).catch(() => {});
    }
  }

  logError(stage, message, storyId = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      storyId,
      stage,
      level: 'error',
      message
    };
    console.error(`[${stage.toUpperCase()}] ❌ ${message}`);
    this.emit('log', entry);
    if (this.db) {
      this.db.log(storyId, stage, 'error', message).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  //  Search Existing Story (Deduplication via PostgreSQL & Disk)
  // ---------------------------------------------------------------------------
  async findExistingStory(topic) {
    if (!topic) return null;

    // 1. Check PostgreSQL Database first
    if (this.db) {
      try {
        const dbStory = await this.db.findStoryByTopic(topic);
        if (dbStory) {
          const storyDir = path.join(this.outputDir, dbStory.story_id);
          const scriptPath = path.join(storyDir, 'story_script.json');
          let story = {
            story_id: dbStory.story_id,
            title_en: dbStory.title_en,
            title_ta: dbStory.title_ta,
            theme: dbStory.theme,
            moral_en: dbStory.moral
          };
          if (fs.existsSync(scriptPath)) {
            try {
              story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
            } catch (_) {}
          }
          return { story, storyDir, source: 'database' };
        }
      } catch (e) {
        console.warn('[Orchestrator] findExistingStory db check error:', e.message);
      }
    }

    // 2. Check Local Disk Output
    if (!fs.existsSync(this.outputDir)) return null;

    const clean = topic.toLowerCase().replace(/[^a-z0-9]/g, '');
    const items = fs.readdirSync(this.outputDir, { withFileTypes: true });

    for (const item of items) {
      if (!item.isDirectory()) continue;
      const storyDir = path.join(this.outputDir, item.name);
      const scriptPath = path.join(storyDir, 'story_script.json');
      if (!fs.existsSync(scriptPath)) continue;

      try {
        const story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
        const cleanTitle = (story.title_en || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanStoryTopic = (story.topic || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanFolder = item.name.toLowerCase().replace(/[^a-z0-9]/g, '');

        const matchTitle = cleanTitle.length >= 5 && clean.length >= 5 && (cleanTitle === clean || cleanTitle.includes(clean) || clean.includes(cleanTitle));
        const matchTopic = cleanStoryTopic.length >= 5 && clean.length >= 5 && (cleanStoryTopic === clean || cleanStoryTopic.includes(clean) || clean.includes(cleanStoryTopic));
        const matchFolder = cleanFolder.length >= 8 && clean.length >= 8 && (cleanFolder.includes(clean) || clean.includes(cleanFolder));

        if (matchTitle || matchTopic || matchFolder) {
          return { story, storyDir, source: 'disk' };
        }
      } catch (_) {}
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  //  Stage 1: TOPIC (PostgreSQL-Aware Zero Duplicate Selection)
  // ---------------------------------------------------------------------------
  async runTopicStage() {
    this.emit('stage', { stage: 'topic', status: 'running' });
    this.logInfo('topic', '🔍 Scouting fresh kid-friendly story topic from Google Trends / API...');

    // Gather existing story identifiers from PostgreSQL and Disk
    const existingIdentifiers = [];
    if (this.db) {
      try {
        const dbIds = await this.db.getExistingStoryIdentifiers();
        existingIdentifiers.push(...dbIds);
      } catch (e) {
        console.warn('[Orchestrator] Error fetching db identifiers:', e.message);
      }
    }

    if (fs.existsSync(this.outputDir)) {
      const items = fs.readdirSync(this.outputDir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory()) continue;
        existingIdentifiers.push(item.name);
        const scriptPath = path.join(this.outputDir, item.name, 'story_script.json');
        if (fs.existsSync(scriptPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
            if (data.title_en) existingIdentifiers.push(data.title_en);
            if (data.topic) existingIdentifiers.push(data.topic);
            if (data.theme) existingIdentifiers.push(data.theme);
          } catch (_) {}
        }
      }
    }

    const topic = await this.topicScout.getHourlyFreshTopic(existingIdentifiers, this.db);
    this.logInfo('topic', `✅ Discovered fresh ungenerated topic for this hour: "${topic}"`);
    this.emit('stage', { stage: 'topic', status: 'done', topic });
    return topic;
  }

  // ---------------------------------------------------------------------------
  //  Stage 2: STORY
  // ---------------------------------------------------------------------------
  async runStoryStage(topic) {
    this.emit('stage', { stage: 'story', status: 'running', topic });
    this.logInfo('story', `Checking if story already exists for topic: "${topic}"...`);

    // 1. Strictly check if story already generated in PostgreSQL or on disk
    const existing = await this.findExistingStory(topic);
    if (existing) {
      const videoEnPath = path.join(existing.storyDir, 'en_video.mp4');
      const videoTaPath = path.join(existing.storyDir, 'ta_video.mp4');
      const hasVideos = fs.existsSync(videoEnPath) && fs.existsSync(videoTaPath);

      if (hasVideos) {
        this.logInfo('story', `🛑 Story is ALREADY COMPLETED in database/disk: "${existing.story.title_en}" (${existing.story.story_id}). Strictly avoiding duplicate generation.`, existing.story.story_id);
        await this.db.upsertStory({
          story_id: existing.story.story_id,
          title_en: existing.story.title_en,
          title_ta: existing.story.title_ta,
          theme: existing.story.theme,
          moral: existing.story.moral_en || existing.story.moral,
          status: 'awaiting_approval',
          folder_url: path.resolve(existing.storyDir),
          video_en_url: path.resolve(videoEnPath),
          video_ta_url: path.resolve(videoTaPath),
          error_message: null
        });
        this.emit('stage', { stage: 'story', status: 'done', skipped: true, storyDir: existing.storyDir, story: existing.story });
        return { story: existing.story, storyDir: existing.storyDir, skipped: true };
      }

      // If script exists but media assets are not finished, resume this story
      this.logInfo('story', `🔄 Resuming incomplete story assets for: "${existing.story.title_en}" (${existing.story.story_id})...`, existing.story.story_id);
      this.emit('stage', { stage: 'story', status: 'done', skipped: false, storyDir: existing.storyDir, story: existing.story });
      return { story: existing.story, storyDir: existing.storyDir, skipped: false };
    }

    // 2. Generate fresh story via Antigravity CLI
    this.logInfo('story', `Generating new 6-scene story via Antigravity AI for: "${topic}"...`);
    const story = await this.storyGenerator.generateStory(topic);

    // Create story directory
    const storyDir = path.join(this.outputDir, story.story_id);
    if (!fs.existsSync(storyDir)) fs.mkdirSync(storyDir, { recursive: true });

    // Save story script
    const scriptPath = path.join(storyDir, 'story_script.json');
    fs.writeFileSync(scriptPath, JSON.stringify(story, null, 2), 'utf8');

    // Save to PostgreSQL with exact user schema
    const videoEnPath = path.join(storyDir, 'en_video.mp4');
    const videoTaPath = path.join(storyDir, 'ta_video.mp4');
    await this.db.upsertStory({
      story_id: story.story_id,
      title_en: story.title_en,
      title_ta: story.title_ta,
      theme: story.theme,
      moral: story.moral_en || story.moral,
      status: 'awaiting_approval',
      folder_url: path.resolve(storyDir),
      video_en_url: fs.existsSync(videoEnPath) ? path.resolve(videoEnPath) : '',
      video_ta_url: fs.existsSync(videoTaPath) ? path.resolve(videoTaPath) : '',
      error_message: null
    });
    this.logInfo('story', `✅ Created story script: "${story.title_en}" (${story.story_id}) with ${story.scenes?.length || 6} scenes.`, story.story_id);

    this.emit('stage', { stage: 'story', status: 'done', storyDir, story });
    return { story, storyDir, skipped: false };
  }

  // ---------------------------------------------------------------------------
  //  Stage 3: IMAGES
  // ---------------------------------------------------------------------------
  async runImagesStage(story, storyDir) {
    this.emit('stage', { stage: 'images', status: 'running' });
    this.logInfo('images', `Checking scene images for "${story.title_en}"...`, story.story_id);

    const result = await this.imageGenerator.generateStoryScenes(story, storyDir, ({ sceneIndex, total }) => {
      this.logInfo('images', `🎨 Rendered scene ${sceneIndex}/${total} via Gemini Playwright...`, story.story_id);
      this.emit('progress', { stage: 'images', scene: sceneIndex, total });
    });

    if (result && result.skipped) {
      this.logInfo('images', `⏭️ All ${story.scenes?.length || 6} scene images already exist! Skipping image generation.`, story.story_id);
      this.emit('stage', { stage: 'images', status: 'done', skipped: true });
      return;
    }

    this.logInfo('images', `✅ All ${story.scenes?.length || 6} scene images ready in: ${storyDir}`, story.story_id);
    this.emit('stage', { stage: 'images', status: 'done' });
  }

  // ---------------------------------------------------------------------------
  //  Stage 4: AUDIO
  // ---------------------------------------------------------------------------
  async runAudioStage(story, storyDir) {
    this.emit('stage', { stage: 'audio', status: 'running' });
    this.logInfo('audio', `Checking narration audio files (EN + TA) for "${story.title_en}"...`, story.story_id);

    const missingAudio = [];
    for (const lang of this.languages) {
      for (const scene of (story.scenes || [])) {
        const pad = String(scene.scene_index).padStart(2, '0');
        const p = path.join(storyDir, `${lang}_scene_${pad}.mp3`);
        if (!fs.existsSync(p) || fs.statSync(p).size < 1000) {
          missingAudio.push({ lang, scene });
        }
      }
    }

    if (missingAudio.length === 0) {
      this.logInfo('audio', `⏭️ All ${this.languages.length * (story.scenes?.length || 6)} audio files already exist on disk! Skipping ElevenLabs generation.`, story.story_id);
      this.emit('stage', { stage: 'audio', status: 'done', skipped: true });
      return { success: true, skipped: true };
    }

    this.logInfo('audio', `Generating ${missingAudio.length} missing audio files via ElevenLabs...`, story.story_id);
    const result = await this.audioNarrator.generateAllSceneAudio(
      story.scenes,
      storyDir,
      this.languages,
      story
    );

    if (!result.success) {
      const errors = result.files.filter(f => !f.success);
      const errMsg = `Audio generation failed for: ${errors.map(e => e.filename).join(', ')}`;
      this.logError('audio', errMsg, story.story_id);
      throw new Error(errMsg);
    }

    this.logInfo('audio', `✅ Narration audio ready for English and Tamil.`, story.story_id);
    this.emit('stage', { stage: 'audio', status: 'done', result });
    return result;
  }

  // ---------------------------------------------------------------------------
  //  Stage 5: VIDEO
  // ---------------------------------------------------------------------------
  async runVideoStage(storyDir, sceneCount, story = {}) {
    const storyId = story.story_id || path.basename(storyDir);
    this.emit('stage', { stage: 'video', status: 'running' });
    this.logInfo('video', `Checking vertical subtitled MP4 videos...`, storyId);

    const missingVideos = this.languages.filter(lang => {
      const vp = path.join(storyDir, `${lang}_video.mp4`);
      return !fs.existsSync(vp) || fs.statSync(vp).size < 50000;
    });

    if (missingVideos.length === 0) {
      this.logInfo('video', `⏭️ All subtitled videos (en_video.mp4 & ta_video.mp4) already exist! Skipping video assembly.`, storyId);
      this.emit('stage', { stage: 'video', status: 'done', skipped: true });
      return { success: true, skipped: true };
    }

    this.logInfo('video', `🎬 Delegating video assembly to FFmpeg microservice (port 8787) for ${missingVideos.join(', ')} with HarfBuzz Nirmala UI subtitles...`, storyId);

    const result = await this.videoAssembler.assembleAll(
      storyDir,
      sceneCount,
      missingVideos
    );

    this.logInfo('video', `✅ Videos assembled successfully with burned-in subtitles!`, storyId);

    const videoEnPath = path.join(storyDir, 'en_video.mp4');
    const videoTaPath = path.join(storyDir, 'ta_video.mp4');
    await this.db.upsertStory({
      story_id: storyId,
      status: 'awaiting_approval',
      folder_url: path.resolve(storyDir),
      video_en_url: fs.existsSync(videoEnPath) ? path.resolve(videoEnPath) : '',
      video_ta_url: fs.existsSync(videoTaPath) ? path.resolve(videoTaPath) : ''
    });

    this.emit('stage', { stage: 'video', status: 'done', result });
    return result;
  }

  // ---------------------------------------------------------------------------
  //  Stage 6: UPLOAD & LOGGING
  // ---------------------------------------------------------------------------
  async runUploadStage(story, storyDir) {
    this.emit('stage', { stage: 'upload', status: 'running' });
    this.logInfo('upload', `Starting YouTube upload and Drive sync for "${story.title_en}"...`, story.story_id);

    const result = await this.youtubePublisher.uploadAll(
      storyDir,
      story,
      this.languages
    );

    // Record upload details in PostgreSQL
    const uploadMap = result?.results || result?.uploads;
    if (uploadMap) {
      for (const [lang, upload] of Object.entries(uploadMap)) {
        const videoFile = `${lang}_video.mp4`;
        const videoPath = path.join(storyDir, videoFile);
        const size = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;

        if (upload.success) {
          const url = upload.url || `https://youtube.com/shorts/${upload.videoId}`;
          await this.db.recordFileUpload({
            storyId: story.story_id,
            fileName: videoFile,
            fileType: 'video/mp4',
            fileSize: size,
            localPath: videoPath,
            destination: 'youtube',
            remoteId: upload.videoId,
            remoteUrl: url,
            status: 'completed'
          });
          this.logInfo('upload', `✅ YouTube upload recorded in PostgreSQL: ${videoFile} -> ${url}`, story.story_id);
        } else {
          await this.db.recordFileUpload({
            storyId: story.story_id,
            fileName: videoFile,
            fileType: 'video/mp4',
            fileSize: size,
            localPath: videoPath,
            destination: 'youtube',
            status: 'failed',
            error: upload.error || 'Upload failed or unauthenticated'
          });
          this.logWarn('upload', `YouTube upload pending for ${videoFile}: ${upload.error || 'OAuth required'}`, story.story_id);
        }
      }
    }

    // Also sync to Google Drive for backup
    try {
      await this.syncToDrive(story, storyDir);
    } catch (err) {
      this.logWarn('drive', `Drive sync warning (non-fatal): ${err.message}`, story.story_id);
    }

    const youtubeEnId = result?.results?.en?.videoId || result?.uploads?.en?.videoId || null;
    const youtubeTaId = result?.results?.ta?.videoId || result?.uploads?.ta?.videoId || null;
    if (youtubeEnId || youtubeTaId) {
      this.updatePipelineStatus(storyDir, 'upload', 'done', { results: result?.results || result?.uploads });
    }
    await this.db.upsertStory({
      story_id: story.story_id,
      status: (youtubeEnId || youtubeTaId) ? 'uploaded' : 'awaiting_approval',
      youtube_en_id: youtubeEnId,
      youtube_ta_id: youtubeTaId
    });

    this.emit('stage', { stage: 'upload', status: 'done', result });
    return result;
  }

  // ---------------------------------------------------------------------------
  //  Drive Sync & PostgreSQL Logging
  // ---------------------------------------------------------------------------
  async syncToDrive(story, storyDir) {
    this.logInfo('drive', `Syncing video and script files to Google Drive...`, story.story_id);
    const resolved = await this.resolveDriveFolder(story.story_id);
    const folderId = resolved.folderId;

    const filesToUpload = [
      ...this.languages.map(l => ({ name: `${l}_video.mp4`, type: 'video/mp4' })),
      { name: 'story_script.json', type: 'application/json' }
    ].filter(f => fs.existsSync(path.join(storyDir, f.name)));

    for (const file of filesToUpload) {
      const filePath = path.join(storyDir, file.name);
      const stat = fs.statSync(filePath);
      try {
        const uploadRes = await this.gdrive.uploadFile(filePath, folderId, file.type);
        this.logInfo('drive', `✅ Uploaded ${file.name} to Drive (File ID: ${uploadRes.fileId})`, story.story_id);

        await this.db.recordFileUpload({
          storyId: story.story_id,
          fileName: file.name,
          fileType: file.type,
          fileSize: stat.size,
          localPath: filePath,
          destination: 'gdrive',
          remoteId: uploadRes.fileId,
          remoteUrl: uploadRes.webViewLink || `https://drive.google.com/file/d/${uploadRes.fileId}/view`,
          status: 'completed'
        });
      } catch (e) {
        this.logWarn('drive', `Upload failed for ${file.name}: ${e.message}`, story.story_id);
      }
    }
  }

  async resolveDriveFolder(storyId) {
    try {
      const files = await this.gdrive.listFiles(this.youtubeN8nFolderId, 100);
      const matched = files.find(f => f.name === storyId || f.name.includes(storyId));
      if (matched) return { folderId: matched.id };

      // Create new folder
      const created = await this.gdrive.createFolder(storyId, this.youtubeN8nFolderId);
      return { folderId: created.folderId };
    } catch (_) {
      return { folderId: this.youtubeN8nFolderId };
    }
  }

  // ---------------------------------------------------------------------------
  //  Pipeline Status Tracking
  // ---------------------------------------------------------------------------
  readPipelineStatus(storyDir) {
    const statusPath = path.join(storyDir, 'pipeline.json');
    if (fs.existsSync(statusPath)) {
      try {
        return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch (_) {}
    }
    return { stages: {}, created_at: new Date().toISOString() };
  }

  updatePipelineStatus(storyDir, stage, status, data = {}) {
    const statusPath = path.join(storyDir, 'pipeline.json');
    const current = this.readPipelineStatus(storyDir);

    current.stages[stage] = {
      status,
      timestamp: new Date().toISOString(),
      ...data
    };
    current.last_updated = new Date().toISOString();

    const allDone = STAGES.slice(0, -1).every(s => current.stages[s]?.status === 'done');
    current.overall = allDone ? 'done' : 'in_progress';

    fs.writeFileSync(statusPath, JSON.stringify(current, null, 2), 'utf8');
    return current;
  }

  // ---------------------------------------------------------------------------
  //  Full Pipeline Run
  // ---------------------------------------------------------------------------
  /**
   * Run the complete pipeline from topic to YouTube upload.
   * Supports resuming or reusing existing story/assets.
   */
  async run(options = {}) {
    let topic, story, storyDir;
    const startTime = Date.now();

    try {
      // ----- TOPIC & STORY (Deduplication) -----
      if (options.storyId) {
        storyDir = path.join(this.outputDir, options.storyId);
        const scriptPath = path.join(storyDir, 'story_script.json');
        if (!fs.existsSync(scriptPath)) {
          throw new Error(`Cannot resume: story_script.json not found in ${storyDir}`);
        }
        story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
        topic = story.topic || options.storyId;
        this.logInfo('pipeline', `Resuming existing story: "${story.title_en}" (${story.story_id})`, story.story_id);
      } else {
        topic = options.topic || await this.runTopicStage();
        this.logInfo('pipeline', `Starting pipeline execution for: "${topic}"`);

        // Check if story is already generated in database or on disk
        const storyResult = await this.runStoryStage(topic);
        story = storyResult.story;
        storyDir = storyResult.storyDir;
        this.updatePipelineStatus(storyDir, 'story', 'done', { title: story.title_en });

        if (storyResult.skipped) {
          this.logInfo('pipeline', `🛑 Story "${story.title_en}" (${story.story_id}) is already completed in the database. Strictly skipping redundant generation.`, story.story_id);
          this.emit('stage', { stage: 'done', status: 'done', story, skipped: true });
          return {
            success: true,
            story_id: story.story_id,
            title_en: story.title_en,
            skipped: true,
            message: `Story "${story.title_en}" is already generated and completed in database. Redundant execution skipped.`
          };
        }
      }

      // ----- IMAGES -----
      const pipelineStatus = this.readPipelineStatus(storyDir);
      const imagesExist = (story.scenes || []).every(scene => {
        const pad = String(scene.scene_index).padStart(2, '0');
        const p = path.join(storyDir, `scene_${pad}.png`);
        return fs.existsSync(p) && fs.statSync(p).size > 10000;
      });

      if (pipelineStatus.stages?.images?.status !== 'done' || !imagesExist) {
        this.updatePipelineStatus(storyDir, 'images', 'running');
        await this.runImagesStage(story, storyDir);
        this.updatePipelineStatus(storyDir, 'images', 'done');
      } else {
        this.logInfo('images', `⏭️ Images stage already done (${story.scenes?.length || this.sceneCount}/${story.scenes?.length || this.sceneCount} images exist), skipping.`, story.story_id);
      }

      // ----- AUDIO -----
      const ps2 = this.readPipelineStatus(storyDir);
      const audioFilesExist = this.languages.every(lang => {
        return (story.scenes || []).every(scene => {
          const pad = String(scene.scene_index).padStart(2, '0');
          const p = path.join(storyDir, `${lang}_scene_${pad}.mp3`);
          return fs.existsSync(p) && fs.statSync(p).size > 1000;
        });
      });

      if (ps2.stages?.audio?.status !== 'done' || !audioFilesExist) {
        this.updatePipelineStatus(storyDir, 'audio', 'running');
        await this.runAudioStage(story, storyDir);
        this.updatePipelineStatus(storyDir, 'audio', 'done');
      } else {
        this.logInfo('audio', `⏭️ Audio stage already done (EN + TA audio exists), skipping.`, story.story_id);
      }

      // ----- VIDEO -----
      const ps3 = this.readPipelineStatus(storyDir);
      const videoFilesExist = this.languages.every(lang => {
        const vp = path.join(storyDir, `${lang}_video.mp4`);
        return fs.existsSync(vp) && fs.statSync(vp).size > 50000;
      });

      if (ps3.stages?.video?.status !== 'done' || !videoFilesExist) {
        this.updatePipelineStatus(storyDir, 'video', 'running');
        await this.runVideoStage(storyDir, (story.scenes || []).length, story);
        this.updatePipelineStatus(storyDir, 'video', 'done', { video_ready: true });
      } else {
        this.logInfo('video', `⏭️ Video stage already done (en_video.mp4 & ta_video.mp4 exist), skipping.`, story.story_id);
      }

      // ----- UPLOAD -----
      if (!options.skipUpload && this.autoUpload) {
        const ps4 = this.readPipelineStatus(storyDir);
        if (ps4.stages?.upload?.status !== 'done') {
          this.updatePipelineStatus(storyDir, 'upload', 'running');
          const uploadResult = await this.runUploadStage(story, storyDir);
          this.updatePipelineStatus(storyDir, 'upload', 'done', { result: uploadResult });
        } else {
          this.logInfo('upload', `⏭️ Upload already completed, skipping.`, story.story_id);
        }
      }

      // ----- DONE -----
      this.updatePipelineStatus(storyDir, 'done', 'done');

      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      this.logInfo('pipeline', `🎉 Pipeline complete! Story: "${story.title_en}" | Time: ${elapsed} min`, story.story_id);

      return {
        success: true,
        story_id: story.story_id,
        title_en: story.title_en,
        storyDir,
        elapsed_minutes: parseFloat(elapsed)
      };
    } catch (err) {
      this.logError('pipeline', `Pipeline failed: ${err.message}`, story?.story_id);
      if (storyDir) {
        this.updatePipelineStatus(storyDir, 'error', 'failed', { error: err.message });
      }
      throw err;
    }
  }

  /**
   * Find stories whose videos are ready but have NOT yet been uploaded to YouTube.
   * Strictly verifies disk artifacts (youtube_upload.json, story_script.json, pipeline.json)
   * to guarantee that already posted/approved videos are NEVER uploaded again.
   * @returns {Array<{storyId: string, storyDir: string, status: object}>}
   */
  findReadyToUpload() {
    if (!fs.existsSync(this.outputDir)) return [];

    const items = fs.readdirSync(this.outputDir, { withFileTypes: true });
    const ready = [];

    for (const item of items) {
      if (!item.isDirectory() || item.name.startsWith('.') || item.name.startsWith('_')) continue;
      const storyDir = path.join(this.outputDir, item.name);
      const status = this.readPipelineStatus(storyDir);

      // 1. Check if all required video files exist on disk
      const videoDone = status.stages?.video?.status === 'done' ||
        this.languages.every(l => fs.existsSync(path.join(storyDir, `${l}_video.mp4`)));
      if (!videoDone) continue;

      // 2. Check if pipeline.json already marked upload as done
      if (status.stages?.upload?.status === 'done') {
        continue;
      }

      // 3. Check if youtube_upload.json exists and has valid videoId(s)
      const ytUploadPath = path.join(storyDir, 'youtube_upload.json');
      if (fs.existsSync(ytUploadPath)) {
        try {
          const ytData = JSON.parse(fs.readFileSync(ytUploadPath, 'utf8'));
          const enDone = ytData.results?.en?.success && ytData.results?.en?.videoId;
          const taDone = ytData.results?.ta?.success && ytData.results?.ta?.videoId;
          if (enDone || taDone) {
            // Auto-heal pipeline status to permanently prevent re-uploading
            this.updatePipelineStatus(storyDir, 'upload', 'done', { results: ytData.results });
            continue;
          }
        } catch (_) {}
      }

      // 4. Check if story_script.json already has YouTube video IDs
      const scriptPath = path.join(storyDir, 'story_script.json');
      if (fs.existsSync(scriptPath)) {
        try {
          const sc = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
          if (sc.youtube_en_id || sc.youtube_ta_id) {
            this.updatePipelineStatus(storyDir, 'upload', 'done');
            continue;
          }
        } catch (_) {}
      }

      ready.push({ storyId: item.name, storyDir, status });
    }

    return ready;
  }
}

module.exports = PipelineOrchestrator;
