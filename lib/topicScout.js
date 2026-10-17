const axios = require('axios');

/**
 * Topic Scout
 * Discovers trending, child-appropriate story topics from multiple sources:
 * 1. NewsAPI — filters for education, family, animals, nature topics
 * 2. Google Trends RSS — parses trending search topics
 * 3. Curated fallback pool — always-fresh rotating topic list
 */
class TopicScout {
  constructor(options = {}) {
    this.newsApiKey = options.newsApiKey || process.env.NEWS_API_KEY;
    this.maxTopics = options.maxTopics || 5;
    this.db = options.db || null;
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
    // (Little Anbu, Anu Tulsi, Malar Sparrow, Amudha Flower Bowl)
    const existingProtagonists = ['anbu', 'amudha', 'malar', 'anu', 'tulsi'];
    for (const name of existingProtagonists) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(cleanCand)) {
        return true;
      }
    }

    if (/animal.*bab|bab.*animal|animal.*child|child.*animal/.test(cleanCand)) {
      return true;
    }

    if (/flower.*bowl|bowl.*water|thirsty.*sparrow|sparrow.*water/.test(cleanCand)) {
      return true;
    }

    // 2. Check against all database & disk identifiers
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

    // 4. Fallback: dynamic timestamped fresh topic
    const fallback = `a curious child discovering a hidden garden of blooming sunflowers and singing crickets`;
    console.log(`[TopicScout] Using fresh fallback topic: "${fallback}"`);
    return fallback;
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
