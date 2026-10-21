const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Video Assembler using FFmpeg
 * Combines scene images (1080x1920 PNG) with per-scene audio (MP3)
 * into a finished YouTube Shorts MP4 for each language.
 *
 * FFmpeg strategy:
 *   - Each scene = image displayed for the duration of its audio + 0.3s fade
 *   - Crossfade between scenes via xfade filter
 *   - Concatenate all scenes
 *   - Final output: H.264 video, AAC audio, 1080x1920, 30fps
 */
class VideoAssembler {
  constructor(options = {}) {
    this.ffmpegServiceUrl = options.ffmpegServiceUrl || process.env.FFMPEG_SERVICE_URL || 'http://localhost:8787';
    this.ffmpegApiKey = options.ffmpegApiKey || process.env.RENDER_API_KEY || '72cd0ffdd03a7aedefb6c2c5f077323e522abf70cf8e01f5d29e0b271e6892dd';
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.outputFps = options.fps || 30;
    this.videoBitrate = options.videoBitrate || '4000k';
    this.audioBitrate = options.audioBitrate || '128k';
    this.backgroundMusicPath = options.backgroundMusicPath || process.env.BACKGROUND_MUSIC_PATH;
    this.bgMusicVolume = options.bgMusicVolume || 0.08; // Very soft, story narration takes priority
  }

  /**
   * Assemble a complete video for a single language.
   * Prioritizes the monolithic ffmpeg microservice (at services/ffmpeg on port 8787),
   * falling back to local FFmpeg if the service is not currently running.
   *
   * @param {string} storyDir - Folder with scene_XX.png and lang_scene_XX.mp3
   * @param {string} lang - 'en' or 'ta'
   * @param {number} sceneCount - Total number of scenes
   * @returns {Promise<object>}
   */
  async assembleVideo(storyDir, lang, sceneCount = 6) {
    console.log(`[Video] Assembling ${lang} video for: ${path.basename(storyDir)}`);

    const outputPath = path.join(storyDir, `${lang}_video.mp4`);

    // Skip if already assembled
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      if (stats.size > 100000) { // > 100KB means a real video
        console.log(`[Video] ${lang}_video.mp4 already exists, skipping.`);
        return { success: true, outputPath, skipped: true, lang };
      }
    }

    // Load script text for subtitles
    const scriptPath = path.join(storyDir, 'story_script.json');
    let scenes = [];
    if (fs.existsSync(scriptPath)) {
      try {
        const story = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
        scenes = story.scenes || [];
      } catch (_) {}
    }

    // 1. Try rendering via the dedicated ffmpeg-n8n microservice
    try {
      const remote = await this.renderWithFfmpegService(storyDir, lang, sceneCount, scenes, outputPath);
      if (remote && remote.success) {
        return remote;
      }
    } catch (remoteErr) {
      console.warn(`[Video] ffmpeg-n8n service note (${remoteErr.message}). Using local FFmpeg assembly...`);
    }

    // 2. Local FFmpeg assembly (fallback)
    return await this.assembleLocally(storyDir, lang, sceneCount, scenes, outputPath);
  }

  /**
   * Delegate video rendering to the dedicated ffmpeg-n8n microservice.
   */
  async renderWithFfmpegService(storyDir, lang, sceneCount, scenes, outputPath) {
    const storyId = path.basename(storyDir);

    const scriptPath = path.join(storyDir, 'story_script.json');
    let title = 'Children Story';
    if (fs.existsSync(scriptPath)) {
      try {
        const s = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
        title = lang === 'ta' ? (s.title_ta || s.title_en) : s.title_en;
      } catch (_) {}
    }

    const payloadScenes = [];
    for (let i = 0; i < sceneCount; i++) {
      const pad = String(i + 1).padStart(2, '0');
      const imgPath = path.join(storyDir, `scene_${pad}.png`);
      const audioPath = path.join(storyDir, `${lang}_scene_${pad}.mp3`);
      const sceneData = scenes.find(s => s.scene_index === i + 1) || scenes[i] || {};
      const subtitleText = lang === 'ta' ? (sceneData.text_ta || sceneData.text_en || '') : (sceneData.text_en || '');

      payloadScenes.push({
        index: i + 1,
        image_url: imgPath,
        audio_url: audioPath,
        subtitle_text: subtitleText
      });
    }

    const payload = {
      story_id: storyId,
      language: lang,
      title: title,
      output_filename: `${lang}_video.mp4`,
      video: { width: 1080, height: 1920, fps: 30, crf: 23 },
      effects: { ken_burns: true, zoom_max: 1.12, scene_padding_seconds: 0.5 },
      subtitles: { burn_in: true, font: 'Nirmala UI', font_size: 48 },
      scenes: payloadScenes
    };

    console.log(`[Video] 🎬 Rendering via ffmpeg-n8n microservice (${this.ffmpegServiceUrl}/render/story)...`);
    const response = await fetch(`${this.ffmpegServiceUrl}/render/story`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.ffmpegApiKey}`,
        'ngrok-skip-browser-warning': '1'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ffmpeg-n8n HTTP ${response.status}: ${text}`);
    }

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength < 50000) {
      throw new Error(`Video file received is too small (${arrayBuf.byteLength} bytes)`);
    }

    fs.writeFileSync(outputPath, Buffer.from(arrayBuf));
    const stats = fs.statSync(outputPath);
    console.log(`[Video] ✅ ${lang}_video.mp4 successfully rendered via ffmpeg-n8n! (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      success: true,
      outputPath,
      fileSize: stats.size,
      lang,
      sceneCount,
      provider: 'ffmpeg-n8n-service'
    };
  }

  /**
   * Local FFmpeg assembly fallback.
   */
  async assembleLocally(storyDir, lang, sceneCount, scenes, outputPath) {
    const sceneDurations = await this.getSceneDurations(storyDir, lang, sceneCount);
    console.log(`[Video] Scene durations (${lang}):`, sceneDurations.map(d => d.toFixed(2) + 's').join(', '));

    // Build a temp folder for segment videos
    const tempDir = path.join(storyDir, '_temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    // Step 1: Create individual scene videos
    const segmentPaths = [];
    for (let i = 0; i < sceneCount; i++) {
      const pad = String(i + 1).padStart(2, '0');
      const imagePath = path.join(storyDir, `scene_${pad}.png`);
      const audioPath = path.join(storyDir, `${lang}_scene_${pad}.mp3`);
      const segPath = path.join(tempDir, `seg_${pad}.mp4`);

      if (!fs.existsSync(imagePath)) {
        throw new Error(`Missing scene image: ${imagePath}`);
      }
      if (!fs.existsSync(audioPath)) {
        throw new Error(`Missing audio file: ${audioPath}`);
      }

      const sceneData = scenes.find(s => s.scene_index === i + 1) || scenes[i] || {};
      const subtitleText = lang === 'ta' ? (sceneData.text_ta || sceneData.text_en || '') : (sceneData.text_en || '');

      await this.createSceneSegment(imagePath, audioPath, segPath, sceneDurations[i], subtitleText);
      segmentPaths.push(segPath);
    }

    // Step 2: Concatenate all segments
    await this.concatenateSegments(segmentPaths, outputPath, storyDir);

    // Step 3: Cleanup temp files
    this.cleanupTempDir(tempDir);

    const stats = fs.statSync(outputPath);
    console.log(`[Video] ✅ ${lang}_video.mp4 assembled! (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      success: true,
      outputPath,
      fileSize: stats.size,
      lang,
      sceneCount,
      skipped: false
    };
  }

  /**
   * Get audio duration for each scene in a language.
   * @param {string} storyDir
   * @param {string} lang
   * @param {number} sceneCount
   * @returns {Promise<number[]>}
   */
  async getSceneDurations(storyDir, lang, sceneCount) {
    const durations = [];
    for (let i = 1; i <= sceneCount; i++) {
      const pad = String(i).padStart(2, '0');
      const audioPath = path.join(storyDir, `${lang}_scene_${pad}.mp3`);

      if (fs.existsSync(audioPath)) {
        const dur = await this.probeAudioDuration(audioPath);
        // Shorts safety clamp: min 4.0s, max 9.0s per scene
        durations.push(Math.min(Math.max(dur + 0.3, 4.0), 9.0));
      } else {
        durations.push(5.0); // Fallback: 5 seconds if audio missing
      }
    }

    // Ensure total duration across all scenes stays under 58 seconds (YouTube Shorts hard limit: 60s)
    const total = durations.reduce((a, b) => a + b, 0);
    if (total > 58.0) {
      const scale = 54.0 / total;
      return durations.map(d => Math.max(parseFloat((d * scale).toFixed(2)), 3.5));
    }

    return durations;
  }

  /**
   * Create an individual scene video clip (image + audio + subtitle).
   */
  createSceneSegment(imagePath, audioPath, outputSegPath, duration, subtitleText = '') {
    return new Promise((resolve, reject) => {
      let vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,zoompan=z='min(zoom+0.0008,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(duration * this.outputFps)}:s=1080x1920:fps=${this.outputFps},format=yuv420p`;

      if (subtitleText && subtitleText.trim()) {
        const srtFile = outputSegPath.replace(/\.mp4$/, '.srt');
        const wrapped = this.wrapSubtitleText(subtitleText.trim(), 32);
        const endSec = Math.max(duration - 0.2, 1.0);
        const endFormatted = this.formatSrtTime(endSec);
        const srtContent = `1\r\n00:00:00,000 --> ${endFormatted}\r\n${wrapped}\r\n`;
        fs.writeFileSync(srtFile, srtContent, 'utf8');

        const srtEscaped = srtFile.replace(/\\/g, '/').replace(/:/g, '\\:');
        vf += `,subtitles='${srtEscaped}':force_style='PlayResX=1080,PlayResY=1920,FontSize=48,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=2,MarginV=180,Alignment=2'`;
      }

      const args = [
        '-y',
        '-loop', '1', '-i', imagePath,
        '-i', audioPath,
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-tune', 'stillimage',
        '-b:v', this.videoBitrate,
        '-c:a', 'aac',
        '-b:a', this.audioBitrate,
        '-shortest',
        '-t', String(duration),
        outputSegPath
      ];

      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';

      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg segment failed (code ${code}): ${stderr.slice(-500)}`));
        }
      });
    });
  }

  wrapSubtitleText(text, maxCharsPerLine = 36) {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
        currentLine = (currentLine + ' ' + word).trim();
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.join('\n');
  }

  formatSrtTime(seconds) {
    const totalMs = Math.floor(seconds * 1000);
    const ms = totalMs % 1000;
    const totalSecs = Math.floor(totalMs / 1000);
    const s = totalSecs % 60;
    const m = Math.floor(totalSecs / 60) % 60;
    const h = Math.floor(totalSecs / 3600);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  /**
   * Concatenate segment videos using FFmpeg concat demuxer.
   */
  concatenateSegments(segmentPaths, outputPath, storyDir) {
    return new Promise((resolve, reject) => {
      // Write concat list file
      const concatFile = path.join(storyDir, '_concat_list.txt');
      const lines = segmentPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
      fs.writeFileSync(concatFile, lines, 'utf8');

      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-c', 'copy',
        outputPath
      ];

      // If background music is configured, mix it in
      if (this.backgroundMusicPath && fs.existsSync(this.backgroundMusicPath)) {
        // We'd need a more complex filter graph — simpler for now to just concat
        // TODO: Add background music mixing in Phase 2
      }

      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';

      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        // Cleanup concat list
        try { fs.unlinkSync(concatFile); } catch (_) {}

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg concat failed (code ${code}): ${stderr.slice(-500)}`));
        }
      });
    });
  }

  /**
   * Get audio duration via ffprobe.
   * @param {string} filePath
   * @returns {Promise<number>}
   */
  probeAudioDuration(filePath) {
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        filePath
      ]);

      let stdout = '';
      proc.stdout.on('data', d => stdout += d);
      proc.on('close', () => {
        try {
          const data = JSON.parse(stdout);
          const dur = parseFloat(data.streams?.[0]?.duration || 0);
          resolve(isNaN(dur) || dur === 0 ? 5.0 : dur);
        } catch (_) {
          resolve(5.0);
        }
      });
    });
  }

  /**
   * Assemble both EN and TA videos for a story folder.
   * @param {string} storyDir
   * @param {number} sceneCount
   * @param {string[]} languages
   * @returns {Promise<object>}
   */
  async assembleAll(storyDir, sceneCount = 6, languages = ['en', 'ta']) {
    const results = [];
    for (const lang of languages) {
      const result = await this.assembleVideo(storyDir, lang, sceneCount);
      results.push(result);
    }

    return {
      success: results.every(r => r.success),
      storyDir,
      videos: results
    };
  }

  cleanupTempDir(tempDir) {
    try {
      const files = fs.readdirSync(tempDir);
      files.forEach(f => {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {}
      });
      fs.rmdirSync(tempDir);
    } catch (_) {}
  }
}

module.exports = VideoAssembler;
