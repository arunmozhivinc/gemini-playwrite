const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

/**
 * YouTube Publisher
 * Uploads finished Short videos to YouTube using YouTube Data API v3 (OAuth2).
 * Supports bilingual uploads (EN + TA as separate videos).
 * Configured for Kids Education shorts (Category 27, made for kids).
 */
class YouTubePublisher {
  constructor(options = {}) {
    this.clientId = options.clientId || process.env.YOUTUBE_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.YOUTUBE_CLIENT_SECRET;
    this.redirectUri = options.redirectUri || process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/auth/youtube/callback';
    this.channelId = options.channelId || process.env.YOUTUBE_CHANNEL_ID;

    this.oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri
    );

    // Load saved tokens if present
    const tokenPath = path.join(process.cwd(), '.youtube_tokens.json');
    if (fs.existsSync(tokenPath)) {
      try {
        const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        this.oauth2Client.setCredentials(tokens);
        this._tokensLoaded = true;
      } catch (_) {
        this._tokensLoaded = false;
      }
    } else {
      this._tokensLoaded = false;
    }

    this.youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });
  }

  /**
   * Generate an OAuth2 URL for user to grant YouTube upload permission.
   * @returns {string}
   */
  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube'
      ],
      prompt: 'consent'
    });
  }

  /**
   * Exchange OAuth2 code for tokens and persist them.
   * @param {string} code
   */
  async exchangeCode(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    this._tokensLoaded = true;

    // Persist tokens
    const tokenPath = path.join(process.cwd(), '.youtube_tokens.json');
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    console.log('[YouTube] OAuth tokens saved to .youtube_tokens.json');

    return tokens;
  }

  /**
   * Check if authenticated and token is valid.
   */
  async isAuthenticated() {
    if (!this._tokensLoaded) return false;
    try {
      const res = await this.youtube.channels.list({ part: 'snippet', mine: true });
      return !!(res.data.items && res.data.items.length > 0);
    } catch (_) {
      return false;
    }
  }

  /**
   * Build the title and description for a YouTube Short.
   * @param {object} story - Full story script JSON
   * @param {string} lang - 'en' or 'ta'
   */
  buildMetadata(story, lang) {
    const isEn = lang === 'en';
    const title = isEn ? story.title_en : story.title_ta;
    const moral = isEn ? story.moral_en : story.moral_ta;
    const theme = story.theme || 'kindness';
    const tags = [
      'kids story', 'children story', 'animated story', 'moral story',
      'Tamil story', 'bedtime story', 'YouTube Shorts', '#Shorts',
      ...(story.tags || []),
      theme
    ];

    const langLabel = isEn ? '🇬🇧 English' : '🇮🇳 Tamil';

    const description = isEn
      ? `${title}\n\n✨ Moral: ${moral}\n\n📖 Theme: ${theme}\n\nA beautiful animated story for children. Perfect for bedtime, learning, and growing with kindness.\n\n${langLabel} narration | 9:16 Shorts | Kids Education\n\n#Shorts #KidsStory #MoralStory #AnimatedStory #ChildrenStory #TamilStory #BedtimeStory`
      : `${title}\n\n✨ நீதி: ${moral}\n\n📖 கருப்பொருள்: ${theme}\n\nகுழந்தைகளுக்கான அழகான அனிமேட்டட் கதை. இரவில் படுக்கும் முன், கற்றல் மற்றும் அன்பாக வளர சிறந்தது.\n\n${langLabel} விளக்கம் | 9:16 Shorts | கல்வி\n\n#Shorts #குழந்தைகள்கதை #அனிமேட்டட் #TamilStory #நீதிகதை`;

    return {
      title: `${title} | ${langLabel} #Shorts`,
      description,
      tags: tags.slice(0, 30), // YouTube max 30 tags
      categoryId: '27', // Education
      defaultLanguage: isEn ? 'en' : 'ta',
      madeForKids: true,
      privacyStatus: 'public'
    };
  }

  /**
   * Upload a single video to YouTube.
   * @param {string} videoPath - Path to the MP4 file.
   * @param {object} story - Full story script object.
   * @param {string} lang - 'en' or 'ta'
   * @returns {Promise<object>}
   */
  async uploadVideo(videoPath, story, lang) {
    if (!this._tokensLoaded) {
      throw new Error('YouTube OAuth not authenticated. Visit /auth/youtube to authenticate.');
    }

    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    const metadata = this.buildMetadata(story, lang);
    const fileSize = fs.statSync(videoPath).size;

    console.log(`[YouTube] Uploading ${lang}_video.mp4 (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);
    console.log(`[YouTube] Title: ${metadata.title}`);

    const response = await this.youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          categoryId: metadata.categoryId,
          defaultLanguage: metadata.defaultLanguage
        },
        status: {
          privacyStatus: metadata.privacyStatus,
          selfDeclaredMadeForKids: metadata.madeForKids
        }
      },
      media: {
        body: fs.createReadStream(videoPath),
        mimeType: 'video/mp4'
      }
    });

    const videoId = response.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const shortsUrl = `https://www.youtube.com/shorts/${videoId}`;

    console.log(`[YouTube] ✅ Uploaded! Video ID: ${videoId}`);
    console.log(`[YouTube] 📺 Shorts URL: ${shortsUrl}`);

    return {
      success: true,
      videoId,
      videoUrl,
      shortsUrl,
      title: metadata.title,
      lang,
      uploadedAt: new Date().toISOString()
    };
  }

  /**
   * Upload both EN and TA videos for a story.
   * Strictly prevents duplicate video uploads if a video was already published.
   * @param {string} storyDir
   * @param {object} story
   * @param {string[]} languages
   * @returns {Promise<object>}
   */
  async uploadAll(storyDir, story, languages = ['en', 'ta']) {
    const results = {};

    // 1. Read existing upload manifest if present to prevent re-posting
    const uploadResultPath = path.join(storyDir, 'youtube_upload.json');
    let existingUploadData = {};
    if (fs.existsSync(uploadResultPath)) {
      try {
        existingUploadData = JSON.parse(fs.readFileSync(uploadResultPath, 'utf8'))?.results || {};
      } catch (_) {}
    }

    for (const lang of languages) {
      const videoPath = path.join(storyDir, `${lang}_video.mp4`);
      if (!fs.existsSync(videoPath)) {
        console.warn(`[YouTube] Skipping ${lang} — video not found: ${videoPath}`);
        results[lang] = { success: false, error: 'Video file not found' };
        continue;
      }

      // Check 1: Check existing youtube_upload.json
      const existingLang = existingUploadData[lang];
      if (existingLang && existingLang.success && existingLang.videoId) {
        console.log(`[YouTube] 🛑 Skipping ${lang}_video.mp4 — ALREADY posted previously (Video ID: ${existingLang.videoId}). Zero duplicate posting.`);
        results[lang] = { ...existingLang, already_uploaded: true };
        continue;
      }

      // Check 2: Check story object for existing YouTube ID
      const existingStoryVideoId = lang === 'en' ? (story.youtube_en_id || story.youtube_en_url?.split('/').pop()) : (story.youtube_ta_id || story.youtube_ta_url?.split('/').pop());
      if (existingStoryVideoId && existingStoryVideoId.length > 5) {
        console.log(`[YouTube] 🛑 Skipping ${lang}_video.mp4 — ALREADY recorded on story (Video ID: ${existingStoryVideoId}). Zero duplicate posting.`);
        results[lang] = {
          success: true,
          videoId: existingStoryVideoId,
          videoUrl: `https://www.youtube.com/watch?v=${existingStoryVideoId}`,
          shortsUrl: `https://www.youtube.com/shorts/${existingStoryVideoId}`,
          title: lang === 'en' ? story.title_en : story.title_ta,
          lang,
          already_uploaded: true,
          uploadedAt: existingLang?.uploadedAt || new Date().toISOString()
        };
        continue;
      }

      try {
        results[lang] = await this.uploadVideo(videoPath, story, lang);
        // Wait 5 seconds between uploads to respect rate limits
        if (languages.indexOf(lang) < languages.length - 1) {
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (err) {
        console.error(`[YouTube] Upload failed for ${lang}: ${err.message}`);
        results[lang] = { success: false, error: err.message };
      }
    }

    // Merge existing and new results
    const mergedResults = { ...existingUploadData, ...results };

    // Save upload result to story folder
    fs.writeFileSync(uploadResultPath, JSON.stringify({
      uploadedAt: new Date().toISOString(),
      storyId: story.story_id,
      results: mergedResults
    }, null, 2), 'utf8');

    // Also persist video IDs directly into story_script.json if it exists
    const scriptPath = path.join(storyDir, 'story_script.json');
    if (fs.existsSync(scriptPath)) {
      try {
        const sc = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
        if (mergedResults.en?.videoId) sc.youtube_en_id = mergedResults.en.videoId;
        if (mergedResults.ta?.videoId) sc.youtube_ta_id = mergedResults.ta.videoId;
        fs.writeFileSync(scriptPath, JSON.stringify(sc, null, 2), 'utf8');
      } catch (_) {}
    }

    return {
      success: Object.values(mergedResults).some(r => r.success),
      story_id: story.story_id,
      results: mergedResults
    };
  }
}

module.exports = YouTubePublisher;
