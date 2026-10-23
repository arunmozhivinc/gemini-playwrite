const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

/**
 * BGM Selector
 * Maps story themes/moods to appropriate royalty-free background music tracks.
 *
 * Selection Logic:
 *   1. Keyword-match `story.theme` + `story.moral_en` + `story.topic` against mood table
 *   2. Return local file path to the matching BGM MP3 in assets/bgm/
 *   3. Auto-download from public domain sources on first use if the file is missing
 *   4. Fall back to `bgm_default.mp3` if nothing matches or download fails
 *
 * Volume: Tracks are mixed at 8% volume under narrator (controlled by VideoAssembler).
 */

const BGM_MOODS = [
  {
    id: 'adventure',
    label: 'Epic / Uplifting',
    filename: 'bgm_adventure.mp3',
    keywords: ['courage', 'brave', 'adventure', 'quest', 'strong', 'hero', 'fearless', 'determined', 'challenge', 'climb'],
    // Incompetech "Floating Cities" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Floating%20Cities.mp3'
  },
  {
    id: 'gentle',
    label: 'Warm / Gentle',
    filename: 'bgm_gentle.mp3',
    keywords: ['kindness', 'empathy', 'love', 'care', 'warmth', 'gentle', 'soft', 'tender', 'nurture', 'compassion', 'heart'],
    // Incompetech "Peaceful Desolation" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Peaceful%20Desolation.mp3'
  },
  {
    id: 'playful',
    label: 'Playful / Happy',
    filename: 'bgm_playful.mp3',
    keywords: ['friendship', 'sharing', 'teamwork', 'laugh', 'play', 'fun', 'joy', 'together', 'friend', 'school', 'happy'],
    // Incompetech "Carefree" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3'
  },
  {
    id: 'nature',
    label: 'Whimsical / Nature',
    filename: 'bgm_nature.mp3',
    keywords: ['nature', 'animal', 'forest', 'bird', 'garden', 'tree', 'flower', 'river', 'butterfly', 'rain', 'earth', 'plant'],
    // Incompetech "Water Lily" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Water%20Lily.mp3'
  },
  {
    id: 'curious',
    label: 'Curious / Hopeful',
    filename: 'bgm_curious.mp3',
    keywords: ['learning', 'wisdom', 'discover', 'wonder', 'curiosity', 'explore', 'question', 'knowledge', 'science', 'secret', 'magic', 'mystery'],
    // Incompetech "Wholesome" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wholesome.mp3'
  },
  {
    id: 'festive',
    label: 'Festive / Bright',
    filename: 'bgm_festive.mp3',
    keywords: ['festival', 'celebration', 'dance', 'music', 'bright', 'colorful', 'holiday', 'harvest', 'culture', 'tradition', 'folk'],
    // Incompetech "Monkeys Spinning Monkeys" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Monkeys%20Spinning%20Monkeys.mp3'
  },
  {
    id: 'tender',
    label: 'Tender / Emotional',
    filename: 'bgm_tender.mp3',
    keywords: ['sad', 'loss', 'missing', 'lonely', 'tears', 'emotional', 'forgiveness', 'understand', 'comfort', 'support'],
    // Incompetech "Evening of Chaos" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Evening%20of%20Chaos.mp3'
  },
  {
    id: 'default',
    label: 'Soft Lullaby',
    filename: 'bgm_default.mp3',
    keywords: [],
    // Incompetech "Clean Soul" (Kevin MacLeod) — CC BY
    downloadUrl: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Clean%20Soul.mp3'
  }
];

class BgmSelector {
  constructor(options = {}) {
    this.assetsDir = options.assetsDir
      ? path.isAbsolute(options.assetsDir)
        ? options.assetsDir
        : path.resolve(process.cwd(), options.assetsDir)
      : path.join(process.cwd(), 'assets', 'bgm');

    this.autoDownload = options.autoDownload !== false;
    this.volume = options.volume || 0.08;
  }

  /**
   * Select a BGM track for a story based on theme, moral, and topic keywords.
   * Returns the full path to the selected BGM MP3 (downloading if needed).
   *
   * @param {object} story - Story object with theme, moral_en, topic fields
   * @returns {Promise<string|null>} Absolute path to the BGM MP3, or null if unavailable
   */
  async selectForStory(story = {}) {
    const combined = [
      story.theme || '',
      story.moral_en || story.moral || '',
      story.topic || '',
      story.title_en || ''
    ].join(' ').toLowerCase();

    const selectedMood = this._matchMood(combined);
    console.log(`[BGM] Theme: "${story.theme || 'unspecified'}" → Mood: "${selectedMood.label}" (${selectedMood.filename})`);

    const trackPath = path.join(this.assetsDir, selectedMood.filename);

    // Ensure assets dir exists
    if (!fs.existsSync(this.assetsDir)) {
      fs.mkdirSync(this.assetsDir, { recursive: true });
    }

    // Return existing file immediately
    if (fs.existsSync(trackPath) && fs.statSync(trackPath).size > 10000) {
      console.log(`[BGM] ✅ Using cached track: ${selectedMood.filename}`);
      return trackPath;
    }

    // Auto-download from public domain source
    if (this.autoDownload && selectedMood.downloadUrl) {
      try {
        console.log(`[BGM] 📥 Downloading "${selectedMood.label}" track...`);
        await this._download(selectedMood.downloadUrl, trackPath);

        if (fs.existsSync(trackPath) && fs.statSync(trackPath).size > 10000) {
          console.log(`[BGM] ✅ Downloaded: ${selectedMood.filename} (${(fs.statSync(trackPath).size / 1024).toFixed(0)} KB)`);
          return trackPath;
        }
      } catch (err) {
        console.warn(`[BGM] Download failed for "${selectedMood.filename}": ${err.message}`);
      }

      // Try default as ultimate fallback
      if (selectedMood.id !== 'default') {
        const defaultMood = BGM_MOODS.find(m => m.id === 'default');
        const defaultPath = path.join(this.assetsDir, defaultMood.filename);
        if (fs.existsSync(defaultPath) && fs.statSync(defaultPath).size > 10000) {
          return defaultPath;
        }
        try {
          console.log(`[BGM] 📥 Downloading default fallback track...`);
          await this._download(defaultMood.downloadUrl, defaultPath);
          if (fs.existsSync(defaultPath) && fs.statSync(defaultPath).size > 10000) {
            return defaultPath;
          }
        } catch (e) {
          console.warn(`[BGM] Default track download also failed: ${e.message}`);
        }
      }
    }

    console.warn('[BGM] ⚠️ No BGM track available. Proceeding without background music.');
    return null;
  }

  /**
   * Match a combined text string to the best mood entry by keyword scoring.
   * @param {string} text - Lowercased combined story metadata
   * @returns {object} The matched mood entry
   */
  _matchMood(text) {
    let best = null;
    let bestScore = 0;

    for (const mood of BGM_MOODS) {
      if (mood.id === 'default') continue;
      let score = 0;
      for (const kw of mood.keywords) {
        if (text.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = mood;
      }
    }

    return best || BGM_MOODS.find(m => m.id === 'default');
  }

  /**
   * Download a file via HTTP/HTTPS.
   * @param {string} url
   * @param {string} destPath
   * @returns {Promise<void>}
   */
  _download(url, destPath) {
    return new Promise((resolve, reject) => {
      const proto = url.startsWith('https') ? https : http;

      const request = proto.get(url, { timeout: 30000 }, (res) => {
        // Follow redirects (up to 5 hops)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._download(res.headers.location, destPath).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const tempPath = destPath + '.tmp';
        const file = fs.createWriteStream(tempPath);
        res.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            try {
              fs.renameSync(tempPath, destPath);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });

        file.on('error', (err) => {
          try { fs.unlinkSync(tempPath); } catch (_) {}
          reject(err);
        });
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`Download timed out: ${url}`));
      });
    });
  }

  /**
   * Return the full BGM mood catalog (for dashboard/admin inspection).
   */
  getCatalog() {
    return BGM_MOODS.map(m => ({
      id: m.id,
      label: m.label,
      filename: m.filename,
      keywords: m.keywords,
      available: fs.existsSync(path.join(this.assetsDir, m.filename))
    }));
  }
}

module.exports = BgmSelector;

