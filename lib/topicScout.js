const axios = require('axios');
const { execFile } = require('child_process');

/**
 * Topic Scout
 * Discovers trending, child-appropriate story topics from multiple sources:
 * 1. NewsAPI — filters for education, family, animals, nature topics
 * 2. Google Trends RSS — parses trending search topics
 * 3. Curated fallback pool — always-fresh rotating topic list
 * 4. Antigravity AI Model — dynamically creates 100% novel topics when past topics are exhausted
 */
class TopicScout {
  constructor(options = {}) {
    this.newsApiKey = options.newsApiKey || process.env.NEWS_API_KEY;
    this.maxTopics = options.maxTopics || 5;
    this.db = options.db || null;
    this.cliPath = options.cliPath || process.env.ANTIGRAVITY_CLI_PATH || 'C:\\Users\\Admin\\.gemini\\bin\\agy.exe';
  }

  /**
   * Check if a candidate topic overlaps with any already generated story in PostgreSQL or disk
   */
  isDuplicateTopic(candidateTopic, existingIdentifiers = []) {
    if (!candidateTopic) return true;
    const cleanCand = candidateTopic.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanCand.length < 4) return true;
    const candWords = cleanCand.split(/\s+/).filter(w => w.length >= 3);

    const stopWords = new Set([
      'little', 'child', 'learns', 'about', 'story', 'village', 'kind', 'with', 'from',
      'what', 'kids', 'that', 'this', 'their', 'shares', 'helps', 'makes', 'every', 'when',
      'into', 'some', 'good', 'will', 'have', 'were', 'been', 'them', 'they', 'your', 'find'
    ]);

    // 1. Direct character / known story signature blacklist
    const existingProtagonists = [
      'anbu', 'amudha', 'malar', 'anu', 'tulsi',
      'kavin', 'kayal', 'nila', 'tara', 'iniya',
      'maran', 'yazhini', 'selam', 'ananya'
    ];
    for (const name of existingProtagonists) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(cleanCand)) {
        return true;
      }
    }

    // 2. Blacklist repetitive story plot tropes
    if (/animal.*bab|bab.*animal|animal.*child|child.*animal/.test(cleanCand)) return true;
    if (/flower.*bowl|bowl.*water|thirsty.*sparrow|sparrow.*water|broken.*wing/.test(cleanCand)) return true;
    if (/share.*lunch|lunch.*friend|forgot.*lunch|lunchbox.*friend/.test(cleanCand)) return true;
    if (/trail.*ant|ant.*teamwork|cups.*ant|water.*ant/.test(cleanCand)) return true;
    if (/clay.*doll|clay.*cup/.test(cleanCand)) return true;
    if (/repair.*roof|leak.*roof/.test(cleanCand)) return true;
    if (/carry.*vegetable|vegetable.*market/.test(cleanCand)) return true;
    if (/lost.*kitten|lost.*puppy/.test(cleanCand)) return true;
    if (/harvest.*festival|weaves.*mat/.test(cleanCand)) return true;

    // 3. Check against all database & disk identifiers
    for (const rec of existingIdentifiers) {
      if (!rec || typeof rec !== 'string') continue;
      const cleanRec = rec.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanRec.length < 4) continue;

      // Exact substring or equality match
      if (cleanCand === cleanRec) return true;
      if (cleanRec.length >= 6 && cleanCand.includes(cleanRec)) return true;
      if (cleanCand.length >= 6 && cleanRec.includes(cleanCand)) return true;

      // Significant content words overlap (2 or more meaningful nouns/verbs match)
      const sigCand = candWords.filter(w => !stopWords.has(w));
      const sigRec = cleanRec.split(/\s+/).filter(w => w.length >= 4 && !stopWords.has(w));

      let overlap = 0;
      for (const w of sigCand) {
        if (sigRec.includes(w)) {
          overlap++;
        }
      }
      if (overlap >= 2) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get today's top child-friendly topics.
   * Tries NewsAPI first, falls back to curated pool.
   * @returns {Promise<string[]>}
   */
  async getTodayTopics() {
    const topics = [];

    // 1. Try NewsAPI
    if (this.newsApiKey) {
      try {
        const newsTopics = await this.fetchFromNewsAPI();
        topics.push(...newsTopics);
      } catch (err) {
        console.warn('[TopicScout] NewsAPI failed:', err.message);
      }
    }

    // 2. Try Google Trends RSS
    try {
      const trendTopics = await this.fetchFromGoogleTrends();
      topics.push(...trendTopics);
    } catch (err) {
      console.warn('[TopicScout] Google Trends failed:', err.message);
    }

    // 3. Always add curated fallback topics
    const curated = this.getCuratedTopics();
    topics.push(...curated);

    // De-duplicate and take top N
    const unique = [...new Set(topics)].slice(0, this.maxTopics);
    console.log(`[TopicScout] Today's topics:`, unique);
    return unique;
  }

  /**
   * Fetch child-appropriate topics from Google News RSS.
   * @returns {Promise<string[]>}
   */
  async fetchFromGoogleTrends() {
    const queries = [
      'children science discovery nature',
      'village moral story children folklore',
      'kids gardening friendship school'
    ];

    const topics = [];
    const rssBase = 'https://news.google.com/rss/search?q=';

    for (const q of queries.slice(0, 2)) {
      try {
        const url = `${rssBase}${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
        const response = await axios.get(url, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const xml = response.data;
        const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

        for (const itemXml of itemMatches.slice(0, 4)) {
          const tMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
          if (!tMatch) continue;
          let title = tMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<\/?title>/gi, '').trim();
          if (title.toLowerCase().includes('google news') || title.includes('"')) {
            continue;
          }
          if (this.isChildFriendly(title) && title.length > 15 && title.length < 80) {
            const topic = this.headlineToStoryTopic(title);
            if (topic) topics.push(topic);
          }
        }
      } catch (_) {}
    }

    return topics;
  }

  /**
   * Fetch from NewsAPI.
   * @returns {Promise<string[]>}
   */
  async fetchFromNewsAPI() {
    const url = 'https://newsapi.org/v2/top-headlines';
    const response = await axios.get(url, {
      timeout: 8000,
      params: {
        country: 'in',
        category: 'general',
        apiKey: this.newsApiKey,
        pageSize: 20
      }
    });

    const topics = [];
    const articles = response.data?.articles || [];

    for (const article of articles) {
      const title = article.title || '';
      if (this.isChildFriendly(title)) {
        const topic = this.headlineToStoryTopic(title);
        if (topic) topics.push(topic);
      }
    }

    return topics.slice(0, 3);
  }

  /**
   * Check if a headline is safe and appropriate for children's content.
   */
  isChildFriendly(text) {
    const blocklist = [
      'war', 'attack', 'kill', 'death', 'murder', 'crime', 'accident', 'crash',
      'bomb', 'terror', 'drug', 'rape', 'suicide', 'fraud', 'scam', 'corruption',
      'election', 'political', 'BJP', 'Congress', 'minister', 'stock', 'market',
      'IPO', 'bank', 'court', 'arrest', 'police', 'robbery', 'flood disaster'
    ];
    const lowerText = text.toLowerCase();
    return !blocklist.some(word => lowerText.includes(word));
  }

  /**
   * Convert a news headline into a children's story topic.
   */
  headlineToStoryTopic(headline) {
    // Simplify by stripping source name and special chars
    const cleaned = headline
      .replace(/\s*-\s*[A-Z].*$/, '') // Remove source suffix
      .replace(/[|]/g, '')
      .trim();

    if (cleaned.length < 10) return null;

    // Map to a story concept
    const storyTopics = [
      `a little child who learns about ${cleaned.toLowerCase().slice(0, 40)}`,
      `a kind village child discovers ${cleaned.toLowerCase().slice(0, 40)}`
    ];

    return storyTopics[0];
  }

  /**
   * Curated pool of evergreen child-appropriate story topics.
   * Rotates based on day of year so you get variety across the year.
   * @returns {string[]}
   */
  getCuratedTopics() {
    const allTopics = [
      // Nature & Animals
      "a little girl who saves a baby sparrow with a flower bowl of water",
      "a boy who plants a seed and watches it grow into a mango tree",
      "a child who befriends a lonely elephant at the village water tank",
      "a girl who teaches her dog to share toys with other puppies",
      "a boy who helps a lost butterfly find its flower garden",
      "a child who discovers a magical peacock feather in the forest",
      "a girl who learns why fireflies glow from a wise old owl",
      "a child who follows a trail of ants and learns about teamwork",
      "a little boy who brings rain to the village by caring for trees",
      "a girl who nurses a broken-winged bird back to health",

      // Kindness & Sharing
      "a child who shares her last piece of jaggery with a hungry bee",
      "a boy who gives his warm blanket to a shivering stray puppy",
      "a girl who collects rainwater for the thirsty street dogs in summer",
      "a child who saves his pocket money to feed birds in winter",
      "a village girl who teaches other children to water the school garden",
      "a boy who finds a lost kitten and works to return it home",
      "a child who makes clay cups of water for ants near the ant hill",
      "a girl who shares her lunch with a new friend who forgot hers",

      // Courage & Honesty
      "a little boy who tells the truth after breaking the clay pot",
      "a girl who is afraid of the dark and learns courage from the moon",
      "a child who stands up for a smaller friend being teased",
      "a boy who admits his mistake and learns that honesty feels light",

      // Family & Community
      "a child who helps her grandmother carry vegetables from the market",
      "a boy who surprises his mother with a garden of her favorite flowers",
      "a girl who learns the value of patience while making clay dolls",
      "a child who helps his grandfather repair a leaking roof before rain",
      "a village child who organizes a festival to celebrate the harvest",
      "a girl who weaves a mat with her aunts and learns stories of the village",

      // Learning & Curiosity
      "a curious boy who learns why the sky turns orange at sunset",
      "a girl who counts stars with her grandfather and learns about constellations",
      "a child who asks so many questions that he finds a hidden river",
      "a boy who discovers that mud can be shaped into anything beautiful",
      "a girl who learns to read from the patterns of leaves on the ground"
    ];

    // Rotate by day of year AND hour so every hour gets a fresh topic
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const hour = now.getHours();
    const startIndex = (dayOfYear * 24 + hour) % allTopics.length;

    return [
      allTopics[startIndex % allTopics.length],
      allTopics[(startIndex + 1) % allTopics.length],
      allTopics[(startIndex + 2) % allTopics.length],
      allTopics[(startIndex + 3) % allTopics.length],
      allTopics[(startIndex + 4) % allTopics.length]
    ];
  }

  /**
   * Get a single topic for today's scheduled run.
   * @returns {Promise<string>}
   */
  async getTodayPrimaryTopic() {
    const topics = await this.getTodayTopics();
    return topics[0];
  }

  /**
   * Get a completely fresh, ungenerated topic for the hourly pipeline.
   * Strictly queries PostgreSQL database and on-disk stories to prevent repeating any story.
   * @param {string[]} existingIdentifiers - Array of titles, folders, or topics already generated
   * @param {object} dbInstance - Optional DatabaseService instance to query
   * @returns {Promise<string>}
   */
  async getHourlyFreshTopic(existingIdentifiers = [], dbInstance = null) {
    const db = dbInstance || this.db;
    const combinedExisting = [...(existingIdentifiers || [])];

    // 1. Fetch ALL existing story records from PostgreSQL database
    if (db) {
      try {
        if (typeof db.getExistingStoryIdentifiers === 'function') {
          const dbIds = await db.getExistingStoryIdentifiers();
          combinedExisting.push(...dbIds);
        } else if (typeof db.getAllStories === 'function') {
          const stories = await db.getAllStories();
          for (const s of stories) {
            if (s.story_id) combinedExisting.push(s.story_id);
            if (s.title_en) combinedExisting.push(s.title_en);
            if (s.title_ta) combinedExisting.push(s.title_ta);
            if (s.theme) combinedExisting.push(s.theme);
            if (s.moral) combinedExisting.push(s.moral);
          }
        }
      } catch (err) {
        console.warn('[TopicScout] Error reading existing stories from DB:', err.message);
      }
    }

    // Also include all story titles, folders, and themes from disk output
    try {
      const fs = require('fs');
      const path = require('path');
      const outputDir = path.join(process.cwd(), 'output');
      if (fs.existsSync(outputDir)) {
        const dirs = fs.readdirSync(outputDir, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          combinedExisting.push(d.name);
          const sp = path.join(outputDir, d.name, 'story_script.json');
          if (fs.existsSync(sp)) {
            try {
              const sc = JSON.parse(fs.readFileSync(sp, 'utf8'));
              if (sc.title_en) combinedExisting.push(sc.title_en);
              if (sc.topic) combinedExisting.push(sc.topic);
              if (sc.theme) combinedExisting.push(sc.theme);
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    console.log(`[TopicScout] 🛡️ Checking against ${combinedExisting.length} database & disk identifiers to ensure zero duplicate stories...`);

    // 2. Try candidates from Google Trends / NewsAPI
    const topics = await this.getTodayTopics();
    for (const t of topics) {
      if (!this.isDuplicateTopic(t, combinedExisting)) {
        console.log(`[TopicScout] ✅ Found ungenerated trending topic: "${t}"`);
        return t;
      }
    }

    // 3. Cycle through curated topics for the first ungenerated match
    const all = this.getAllCuratedTopics();
    for (const t of all) {
      if (!this.isDuplicateTopic(t, combinedExisting)) {
        console.log(`[TopicScout] ✅ Found ungenerated curated topic: "${t}"`);
        return t;
      }
    }

    // 4. Ask Antigravity AI Model to generate a guaranteed fresh ungenerated topic
    try {
      const modelTopic = await this.generateNovelTopicWithModel(combinedExisting);
      if (modelTopic && !this.isDuplicateTopic(modelTopic, combinedExisting)) {
        console.log(`[TopicScout] 🤖 Generated 100% fresh novel topic via Antigravity Model: "${modelTopic}"`);
        return modelTopic;
      }
    } catch (e) {
      console.warn('[TopicScout] AI novel topic generation failed, using procedural pool:', e.message);
    }

    // 5. Dynamic procedural fallback ensuring non-repetitive topic
    const freshTemplates = [
      "a curious child who builds a colorful paper kite that carries happy wishes across the village",
      "a gentle girl who helps a tiny sea turtle safely reach the moonlit ocean waves",
      "a boy who learns how to bake traditional sweet pongal with his grandfather for the birds",
      "a child who discovers how seashells make ocean sounds while walking along the morning beach",
      "a girl who crafts a wind chime from bamboo sticks to make music for the neighborhood sparrows",
      "a little boy who paints beautiful stone markers so travelers never lose their way in the forest",
      "a child who rescues a fallen baby squirrel and feeds it coconut water until its mother returns",
      "a kind girl who teaches an elderly neighbor how to identify constellations in the night sky"
    ];
    for (const cand of freshTemplates) {
      if (!this.isDuplicateTopic(cand, combinedExisting)) {
        console.log(`[TopicScout] Using fresh procedural topic: "${cand}"`);
        return cand;
      }
    }

    const timestampFallback = `a curious child exploring a quiet bamboo grove at sunrise listening to singing stream water`;
    return timestampFallback;
  }

  /**
   * Use the Antigravity AI model to brainstorm a completely novel story topic
   * informed by the list of already generated stories.
   * @param {string[]} existingIdentifiers
   * @returns {Promise<string|null>}
   */
  async generateNovelTopicWithModel(existingIdentifiers = []) {
    return new Promise((resolve) => {
      const summaryList = existingIdentifiers
        .filter(x => typeof x === 'string' && x.length > 5)
        .slice(0, 30)
        .join('; ');

      const prompt = [
        "You are an imaginative children's story writer.",
        "We need ONE brand new, unique, charming story topic for a bilingual animated story for children aged 3-8.",
        `STRICTLY DO NOT duplicate or repeat any of these already generated stories/topics: [${summaryList}].`,
        "DO NOT use themes of: sparrows with water bowls, sharing lunch, following ant trails, making clay cups/dolls, repairing leaky roofs, carrying vegetables, lost pets.",
        "Generate 1 fresh, heartwarming, simple story topic in ONE short sentence (e.g., 'a boy who helps a baby sea turtle find the moonlight on the beach').",
        "OUTPUT FORMAT: Return ONLY the one-sentence topic. No quotes, no markdown, no preamble."
      ].join(' ');

      execFile(this.cliPath, ['-p', prompt, '--dangerously-skip-permissions'], { timeout: 45000 }, (err, stdout) => {
        if (err || !stdout) {
          return resolve(null);
        }
        let cleaned = (stdout || '').trim().replace(/^["']|["']$/g, '').replace(/^Topic:\s*/i, '').trim();
        // Remove code blocks if present
        cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        if (cleaned.length >= 10 && cleaned.length <= 150) {
          resolve(cleaned);
        } else {
          resolve(null);
        }
      });
    });
  }

  getAllCuratedTopics() {
    return [
      "a little girl who saves a baby sparrow with a flower bowl of water",
      "a boy who plants a seed and watches it grow into a mango tree",
      "a child who befriends a lonely elephant at the village water tank",
      "a girl who teaches her dog to share toys with other puppies",
      "a boy who helps a lost butterfly find its flower garden",
      "a child who discovers a magical peacock feather in the forest",
      "a girl who learns why fireflies glow from a wise old owl",
      "a child who follows a trail of ants and learns about teamwork",
      "a little boy who brings rain to the village by caring for trees",
      "a girl who nurses a broken-winged bird back to health",
      "a child who shares her last piece of jaggery with a hungry bee",
      "a boy who gives his warm blanket to a shivering stray puppy",
      "a girl who collects rainwater for the thirsty street dogs in summer",
      "a child who saves his pocket money to feed birds in winter",
      "a village girl who teaches other children to water the school garden",
      "a boy who finds a lost kitten and works to return it home",
      "a child who makes clay cups of water for ants near the ant hill",
      "a girl who shares her lunch with a new friend who forgot hers",
      "a little boy who tells the truth after breaking the clay pot",
      "a girl who is afraid of the dark and learns courage from the moon",
      "a child who stands up for a smaller friend being teased",
      "a boy who admits his mistake and learns that honesty feels light",
      "a child who helps her grandmother carry vegetables from the market",
      "a boy who surprises his mother with a garden of her favorite flowers",
      "a girl who learns the value of patience while making clay dolls",
      "a child who helps his grandfather repair a leaking roof before rain",
      "a village child who organizes a festival to celebrate the harvest",
      "a girl who weaves a mat with her aunts and learns stories of the village",
      "a curious boy who learns why the sky turns orange at sunset",
      "a girl who counts stars with her grandfather and learns about constellations",
      "a child who asks so many questions that he finds a hidden river",
      "a boy who discovers that mud can be shaped into anything beautiful",
      "a girl who learns to read from the patterns of leaves on the ground"
    ];
  }
}

module.exports = TopicScout;
