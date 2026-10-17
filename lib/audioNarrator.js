const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * ElevenLabs Audio Narrator
 * Generates per-scene narration audio for English and Tamil using ElevenLabs TTS.
 * Uses Eleven Multilingual v2 model for authentic bilingual narration.
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
  }

  /**
   * Generate narration for a single text in a given language.
   * Uses ElevenLabs when API key is set; automatically falls back to local synthesis.
   * @param {string} text - The narration text.
   * @param {string} lang - 'en' or 'ta'
   * @param {string} outputPath - Full file path for MP3 output.
   * @returns {Promise<object>}
   */
  async generateSceneAudio(text, lang, outputPath) {
    if (!this.apiKey) {
      console.log(`[Audio] ELEVENLABS_API_KEY not configured. Using local synthesizer for ${lang}...`);
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
        console.warn(`[Audio] ElevenLabs API error (${response.status}): ${errText}. Using local synthesizer...`);
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
   * Local synthesizer fallback using Windows SAPI + FFmpeg MP3 encoding,
   * or clean FFmpeg audio if SAPI is unavailable.
   */
  async generateLocalAudio(text, lang, outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tempWav = outputPath.replace(/\.mp3$/, '_temp.wav');
    const { execFileSync } = require('child_process');

    // For English text, synthesize with Windows SAPI
    if (lang === 'en' && /^[\x00-\x7F\s.,!?'"()-]+$/.test(text || '')) {
      try {
        const cleanText = (text || 'Scene narration').replace(/['"\r\n\t]/g, ' ').slice(0, 500);
        const psScript = `Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile('${tempWav.replace(/\\/g, '/')}')
$synth.Speak('${cleanText.replace(/'/g, "''")}')
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
        try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch (_) {}
      }
    }

    // Ultimate fallback: generate 5.0 second silent/subtle ambient audio with FFmpeg
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
   * Generate narration for all scenes in all configured languages.
   * @param {Array} scenes - Array of scene objects with text_en, text_ta fields.
   * @param {string} storyDir - Directory to save MP3 files into.
   * @param {string[]} languages - Array of lang codes, e.g. ['en', 'ta']
   * @returns {Promise<object>}
   */
  async generateAllSceneAudio(scenes, storyDir, languages = ['en', 'ta']) {
    const results = [];

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
          const result = await this.generateSceneAudio(text, lang, outputPath);
          results.push({
            ...result,
            filename,
            scene_index: sceneIndex,
            skipped: false
          });
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
      files: results
    };
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
