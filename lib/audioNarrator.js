const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const BgmSelector = require('./bgmSelector');

/**
 * ElevenLabs Audio Narrator
 * Generates per-scene narration audio for English and Tamil using ElevenLabs TTS.
 * Uses Eleven Multilingual v2 model for authentic bilingual narration.
 *
 * BGM Integration:
 *   - Selects a mood-matched background music track via BgmSelector
 *   - Uses FFmpeg amix to blend narrator voice (100%) + BGM (8% volume)
 *     directly into each scene's final MP3 output
 */
class AudioNarrator {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.voiceIdEn = options.voiceIdEn || process.env.ELEVENLABS_VOICE_EN || '21m00Tcm4TlvDq8ikWAM'; // Rachel
    this.voiceIdTa = options.voiceIdTa || process.env.ELEVENLABS_VOICE_TA || '21m00Tcm4TlvDq8ikWAM'; // Fallback to Rachel
    this.model = options.model || 'eleven_multilingual_v2';
    this.stability = options.stability || 0.40;
    this.similarityBoost = options.similarityBoost || 0.75;
    this.style = options.style || 0.30; // Slight expressiveness for children's stories
    this.baseUrl = 'https://api.elevenlabs.io/v1';

    // BGM
    this.bgmSelector = new BgmSelector({
      assetsDir: options.bgmAssetsDir || path.join(process.cwd(), 'assets', 'bgm'),
      autoDownload: options.bgmAutoDownload !== false,
      volume: options.bgmVolume || 0.08
    });
    this.bgmVolume = options.bgmVolume || 0.08;
    this.bgmEnabled = options.bgmEnabled !== false;
  }

  /**
   * Generate narration for a single text in a given language.
   * Uses ElevenLabs when API key is set and valid; automatically falls back to Edge Neural TTS,
   * Google Translate TTS, or Windows SAPI.
   * @param {string} text - The narration text.
   * @param {string} lang - 'en' or 'ta'
   * @param {string} outputPath - Full file path for MP3 output.
   * @returns {Promise<object>}
   */
  async generateSceneAudio(text, lang, outputPath) {
    if (!this.apiKey || this.elevenLabsDisabled) {
      return await this.generateLocalAudio(text, lang, outputPath);
    }

    try {
      const voiceId = lang === 'ta' ? this.voiceIdTa : this.voiceIdEn;
      const url = `${this.baseUrl}/text-to-speech/${voiceId}`;

      const body = {
        text: text,
        model_id: this.model,
        voice_settings: {
          stability: this.stability,
          similarity_boost: this.similarityBoost,
          style: this.style,
          use_speaker_boost: true
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401 || response.status === 402 || errText.includes('payment_required') || errText.includes('payment_issue')) {
          console.warn(`[Audio] ⚠️ ElevenLabs payment/quota issue (${response.status}): ${errText.slice(0, 150)}. Switching to high-quality Edge Neural TTS.`);
          this.elevenLabsDisabled = true;
        } else {
          console.warn(`[Audio] ElevenLabs API error (${response.status}): ${errText.slice(0, 150)}. Using local synthesizer...`);
        }
        return await this.generateLocalAudio(text, lang, outputPath);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(outputPath, buffer);
      const stats = fs.statSync(outputPath);

      return {
        success: true,
        outputPath,
        fileSize: stats.size,
        lang,
        voiceId,
        model: this.model,
        provider: 'elevenlabs'
      };
    } catch (err) {
      console.warn(`[Audio] ElevenLabs exception: ${err.message}. Using local synthesizer...`);
      return await this.generateLocalAudio(text, lang, outputPath);
    }
  }

  /**
   * High-quality multilingual TTS fallback engine.
   * Priority:
   *   1. Microsoft Edge Neural TTS (Python edge-tts: ta-IN-PallaviNeural for Tamil, en-US-AnaNeural for English)
   *   2. Google Translate TTS (Direct audio/mpeg stream for Tamil & other languages)
   *   3. Windows SAPI (PowerShell System.Speech for English)
   *   4. FFmpeg ambient tone (ultimate fallback)
   */
  async generateLocalAudio(text, lang, outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cleanText = (text || 'Scene narration').replace(/['"\r\n\t]/g, ' ').trim();

    // 1. Priority Fallback: Microsoft Edge Neural TTS (Studio-quality human voices for Tamil & English)
    try {
      const edgeResult = await this.generateEdgeNeuralAudio(cleanText, lang, outputPath);
      if (edgeResult && edgeResult.success) {
        return edgeResult;
      }
    } catch (edgeErr) {
      console.warn(`[Audio] Edge Neural TTS attempt: ${edgeErr.message}`);
    }

    // 2. Secondary Fallback for Tamil: Google Translate TTS
    if (lang === 'ta') {
      try {
        const gttsResult = await this.generateGoogleTTSAudio(cleanText, lang, outputPath);
        if (gttsResult && gttsResult.success) {
          return gttsResult;
        }
      } catch (gttsErr) {
        console.warn(`[Audio] Google Translate TTS attempt: ${gttsErr.message}`);
      }
    }

    // 3. Secondary Fallback for English: Windows SAPI
    if (lang === 'en' && /^[\x00-\x7F\s.,!?'"()-]+$/.test(cleanText)) {
      try {
        const tempWav = outputPath.replace(/\.mp3$/, '_temp.wav');
        const { execFileSync } = require('child_process');
        const psScript = `Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile('${tempWav.replace(/\\/g, '/')}')
$synth.Speak('${cleanText.replace(/'/g, "''").slice(0, 500)}')
$synth.Dispose()
`;
        const psFile = path.join(dir, `_tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ps1`);
        fs.writeFileSync(psFile, psScript, 'utf8');

        execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', psFile], { timeout: 15000, stdio: 'ignore' });
        try { fs.unlinkSync(psFile); } catch (_) {}

        if (fs.existsSync(tempWav) && fs.statSync(tempWav).size > 1000) {
          execFileSync('ffmpeg', ['-y', '-i', tempWav, '-codec:a', 'libmp3lame', '-qscale:a', '2', outputPath], { timeout: 10000, stdio: 'ignore' });
          try { fs.unlinkSync(tempWav); } catch (_) {}

          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
            const stats = fs.statSync(outputPath);
            return {
              success: true,
              outputPath,
              fileSize: stats.size,
              lang,
              provider: 'windows-sapi-local'
            };
          }
        }
      } catch (sapiErr) {
        console.warn('[Audio] SAPI TTS fallback note:', sapiErr.message);
      }
    }

    // 4. Ultimate fallback: generate 5.0 second audio with FFmpeg
    const { execFileSync } = require('child_process');
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '5', '-codec:a', 'libmp3lame', '-b:a', '128k', outputPath], { timeout: 10000, stdio: 'ignore' });
    const stats = fs.statSync(outputPath);
    return {
      success: true,
      outputPath,
      fileSize: stats.size,
      lang,
      provider: 'ffmpeg-local'
    };
  }

  /**
   * Synthesize natural speech using Microsoft Edge Neural TTS.
   * Voices:
   *   - Tamil: ta-IN-PallaviNeural (expressive female) or ta-IN-ValluvarNeural (male)
   *   - English: en-US-AnaNeural (child-friendly warm female)
   */
  generateEdgeNeuralAudio(text, lang, outputPath) {
    return new Promise((resolve, reject) => {
      const voice = lang === 'ta' ? 'ta-IN-PallaviNeural' : 'en-US-AnaNeural';
      const args = [
        '-m', 'edge_tts',
        '--voice', voice,
        '--text', text,
        '--write-media', outputPath
      ];

      const proc = spawn('python', args);
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());

      proc.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
          const stats = fs.statSync(outputPath);
          resolve({
            success: true,
            outputPath,
            fileSize: stats.size,
            lang,
            voice,
            provider: 'edge-neural-tts'
          });
        } else {
          reject(new Error(`edge-tts exit code ${code}: ${stderr.slice(-200)}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Synthesize speech using Google Translate TTS endpoint.
   */
  generateGoogleTTSAudio(text, lang, outputPath) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const clean = (text || '').slice(0, 300);
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=${lang}&client=tw-ob`;

      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Google TTS status code: ${res.statusCode}`));
        }
        const fileStream = fs.createWriteStream(outputPath);
        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
              resolve({
                success: true,
                outputPath,
                fileSize: fs.statSync(outputPath).size,
                lang,
                provider: 'google-translate-tts'
              });
            } else {
              reject(new Error('Google TTS produced an empty file'));
            }
          });
        });

        fileStream.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * Generate narration for all scenes in all configured languages.
   * Optionally mixes a mood-matched BGM track under each scene's narrator audio.
   *
   * @param {Array} scenes - Array of scene objects with text_en, text_ta fields.
   * @param {string} storyDir - Directory to save MP3 files into.
   * @param {string[]} languages - Array of lang codes, e.g. ['en', 'ta']
   * @param {object} [story={}] - Full story object (used for BGM mood selection)
   * @returns {Promise<object>}
   */
  async generateAllSceneAudio(scenes, storyDir, languages = ['en', 'ta'], story = {}) {
    const results = [];

    // --- BGM Selection (once per story, shared across all scenes & languages) ---
    let bgmPath = null;
    if (this.bgmEnabled) {
      try {
        bgmPath = await this.bgmSelector.selectForStory(story);
      } catch (bgmErr) {
        console.warn(`[Audio] BGM selection failed (non-fatal): ${bgmErr.message}`);
        bgmPath = null;
      }
    }

    for (const lang of languages) {
      for (const scene of scenes) {
        const sceneIndex = scene.scene_index;
        const pad = String(sceneIndex).padStart(2, '0');
        const text = lang === 'ta' ? (scene.text_ta || scene.text_en) : scene.text_en;
        const filename = `${lang}_scene_${pad}.mp3`;
        const outputPath = path.join(storyDir, filename);

        // Skip if already exists
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          console.log(`[Audio] Skipping ${filename} — already exists (${stats.size} bytes)`);
          results.push({
            success: true,
            outputPath,
            filename,
            lang,
            scene_index: sceneIndex,
            skipped: true
          });
          continue;
        }

        console.log(`[Audio] Generating ${filename}...`);
        try {
          // Generate raw narrator-only voice first into a temp file
          const rawPath = outputPath.replace(/\.mp3$/, '_raw.mp3');
          const result = await this.generateSceneAudio(text, lang, rawPath);

          // Mix BGM under narrator voice if a track is available
          if (bgmPath && fs.existsSync(bgmPath) && result.success) {
            const mixed = await this.mixBgm(rawPath, bgmPath, outputPath);
            if (mixed) {
              // Clean up raw narrator-only temp file
              try { fs.unlinkSync(rawPath); } catch (_) {}
              console.log(`[Audio] ✅ ${filename} — narrator + BGM mixed successfully`);
              results.push({
                ...result,
                outputPath,
                filename,
                scene_index: sceneIndex,
                skipped: false,
                hasBgm: true
              });
            } else {
              // Mixing failed — rename raw to final as fallback
              fs.renameSync(rawPath, outputPath);
              results.push({
                ...result,
                outputPath,
                filename,
                scene_index: sceneIndex,
                skipped: false,
                hasBgm: false
              });
            }
          } else {
            // No BGM — just rename raw to final
            if (fs.existsSync(rawPath)) {
              fs.renameSync(rawPath, outputPath);
            }
            results.push({
              ...result,
              outputPath,
              filename,
              scene_index: sceneIndex,
              skipped: false,
              hasBgm: false
            });
          }

          // Small delay between API calls to respect rate limits
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          console.error(`[Audio] Failed ${filename}: ${err.message}`);
          results.push({
            success: false,
            filename,
            lang,
            scene_index: sceneIndex,
            error: err.message
          });
        }
      }
    }

    return {
      success: results.every(r => r.success),
      total: results.length,
      files: results,
      bgmTrack: bgmPath ? path.basename(bgmPath) : null
    };
  }

  /**
   * Mix a narrator MP3 with a BGM track using FFmpeg amix.
   * BGM is looped to match narrator duration, then ducked to bgmVolume.
   *
   * @param {string} narratorPath - Raw narrator MP3 path
   * @param {string} bgmPath - BGM track MP3 path
   * @param {string} outputPath - Final mixed MP3 path
   * @returns {Promise<boolean>} true if mixing succeeded
   */
  mixBgm(narratorPath, bgmPath, outputPath) {
    return new Promise((resolve) => {
      const bgmVol = this.bgmVolume;

      // FFmpeg filter:
      //   [0:a] = narrator (full volume)
      //   [1:a] = BGM looped (stream_loop -1) then trimmed to narrator duration, ducked to bgmVol
      //   amix combines both, duration=first ensures output matches narrator length
      const args = [
        '-y',
        '-i', narratorPath,
        '-stream_loop', '-1', '-i', bgmPath,
        '-filter_complex',
        `[1:a]volume=${bgmVol}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=1[aout]`,
        '-map', '[aout]',
        '-codec:a', 'libmp3lame',
        '-q:a', '2',
        outputPath
      ];

      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
          resolve(true);
        } else {
          console.warn(`[Audio] BGM mix warning (code ${code}): ${stderr.slice(-300)}`);
          resolve(false);
        }
      });

      proc.on('error', (err) => {
        console.warn(`[Audio] BGM mix spawn error: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * List available voices from ElevenLabs API.
   * @returns {Promise<Array>}
   */
  async listVoices() {
    if (!this.apiKey) throw new Error('ELEVENLABS_API_KEY not set');

    const response = await fetch(`${this.baseUrl}/voices`, {
      headers: { 'xi-api-key': this.apiKey }
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`ElevenLabs voices API error: ${err}`);
    }

    const data = await response.json();
    return (data.voices || []).map(v => ({
      voice_id: v.voice_id,
      name: v.name,
      preview_url: v.preview_url,
      category: v.category,
      description: v.description,
      labels: v.labels
    }));
  }

  /**
   * Get audio duration from an MP3 file using ffprobe.
   * @param {string} filePath
   * @returns {Promise<number>} Duration in seconds.
   */
  getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        filePath
      ], (err, stdout) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          const duration = parseFloat(data.streams[0]?.duration || 0);
          resolve(duration);
        } catch (e) {
          resolve(5); // Default 5 seconds if unable to detect
        }
      });
    });
  }
}

module.exports = AudioNarrator;
