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
      'maran', 'yazhini', 'selam', 'ananya',
      'leo' // Retired to guarantee topic & animal diversity
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

    // 3. Animal variety check: Avoid repeating the same animal species if recently featured
    const animalKeywords = ['lion', 'rabbit', 'bunny', 'bear', 'elephant', 'monkey', 'squirrel', 'turtle', 'fox', 'penguin', 'panda', 'puppy', 'kitten', 'zebra', 'hedgehog', 'badger', 'parrot', 'owl', 'otter', 'cheetah', 'koala', 'kangaroo', 'dolphin', 'deer'];
    const candAnimals = animalKeywords.filter(a => new RegExp(`\\b${a}\\b`, 'i').test(cleanCand));
    if (candAnimals.length > 0) {
      for (const rec of existingIdentifiers) {
        if (!rec || typeof rec !== 'string') continue;
        const cleanRec = rec.toLowerCase();

        // Avoid repeating the exact animal pair
        if (candAnimals.length >= 2) {
          const matchesBoth = candAnimals.every(a => new RegExp(`\\b${a}\\b`, 'i').test(cleanRec));
          if (matchesBoth) {
            return true; // Already generated this exact animal duo, pick different animals!
          }
        }

        // Avoid repeating lion/leo since 5 stories already feature lion
        if ((candAnimals.includes('lion') || cleanCand.includes('leo')) && (cleanRec.includes('lion') || cleanRec.includes('leo'))) {
          return true;
        }
      }
    }

    // 4. Check against all database & disk identifiers
    for (const rec of existingIdentifiers) {
      if (!rec || typeof rec !== 'string') continue;
      const cleanRec = rec.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanRec.length < 4) continue;

      // Exact substring or equality match
      if (cleanCand === cleanRec) return true;
      if (cleanRec.length >= 6 && cleanCand.includes(cleanRec)) return true;
      if (cleanCand.length >= 6 && cleanRec.includes(cleanCand)) return true;

      // Significant content words overlap (allow 3+ letter words to catch names like pip, fox, owl)
      const sigCand = candWords.filter(w => !stopWords.has(w));
      const sigRec = cleanRec.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));

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
   * Curated pool of evergreen child-appropriate story topics featuring lovable animal characters.
   * Rotates based on day of year AND hour so every run gets a fresh, catchy animal fable.
   * @returns {string[]}
   */
  getCuratedTopics() {
    const allTopics = this.getAllCuratedTopics();

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

    // 5. Dynamic procedural fallback ensuring non-repetitive animal topic
    const freshTemplates = [
      "Barnaby the fluffy bear who lost his honey jar and found a butterfly dance party",
      "Ellie the baby elephant who learned to blow giant colorful flying bubbles with her trunk",
      "Ziggy the cheerful baby zebra who painted rainbow stripes on his coat with flower petals",
      "Milo the cheeky monkey and Penny the parrot who opened a flying jungle bakery",
      "Toby the tiny turtle who strapped on roller skates and won the great forest race",
      "Sammy the fluffy squirrel who planted glowing acorn nightlights for all woodland creatures",
      "Finny the baby red fox who discovered that singing makes strawberries grow double-sized",
      "Penny the baby penguin who built an ice slide to deliver frozen fish treats to walrus friends",
      "Kiki the koala and Oliver the wise owlet who built a starry sky telescope out of hollow bamboo",
      "Ollie the playful river otter who found a singing rainbow pebble in the crystal stream"
    ];
    for (const cand of freshTemplates) {
      if (!this.isDuplicateTopic(cand, combinedExisting)) {
        console.log(`[TopicScout] Using fresh procedural topic: "${cand}"`);
        return cand;
      }
    }

    // Dynamic rotation among unrepresented animals (never hardcoded single animal)
    const animalRotation = [
      "Barnaby the little bear who traded his sweet berries for a shiny golden star whistle",
      "Ellie the baby elephant who carried crystal spring water to save the thirsty enchanted meadow",
      "Ziggy the playful zebra who painted rainbow stripes on his coat with colorful flower petals",
      "Penny the penguin who made snow angels and taught a sleepy polar bear how to ice-skate",
      "Finny the fox and Sammy the squirrel who solved the riddle of the singing crystal cave",
      "Toby the turtle and Benny the badger who dug a secret underground tunnel to the sweet potato garden",
      "Oliver the baby owl who helped a lost firefly find its night lantern glow",
      "Bumble the little panda who gave warm bear hugs to sad sleepy trees to make them blossom"
    ];
    for (const fb of animalRotation) {
      if (!this.isDuplicateTopic(fb, combinedExisting)) {
        return fb;
      }
    }

    const species = ['dolphin', 'otter', 'panda', 'koala', 'penguin', 'hedgehog', 'badger', 'deer'];
    const chosen = species[Math.floor(Math.random() * species.length)];
    return `A joyful little ${chosen} who discovered a glowing musical seashell on the enchanted shore`;
  }

  /**
   * Use the Antigravity AI model to brainstorm a completely novel animal story topic
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
        "You are an imaginative children's author creating viral animal rhyming stories for toddlers and kids aged 2-8.",
        "We need ONE brand new, unique, charming animal story topic featuring lovable animal friends (such as a lion cub, bunny rabbit, baby elephant, monkey, bear cub, squirrel, turtle, puppy, or fox).",
        `STRICTLY DO NOT duplicate or repeat any of these already generated stories/topics: [${summaryList}].`,
        "STRICTLY FORBIDDEN: human village chores, carrying vegetables, making clay cups, fixing roofs, sharing lunchboxes.",
        "Generate 1 fresh, heartwarming, cheerful animal adventure topic in ONE short sentence (e.g., 'Leo the lion cub and Pip the bunny build a bouncing rainbow cloud trampoline').",
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
      "Barnaby the fluffy bear who lost his honey jar and found a butterfly dance party",
      "Ellie the baby elephant who learned to blow giant colorful flying bubbles with her trunk",
      "Ziggy the baby zebra who painted rainbow stripes on his coat with flower petals",
      "Milo the cheeky monkey and Penny the parrot who opened a flying jungle bakery",
      "Toby the tiny turtle who strapped on roller skates and won the great forest race",
      "Sammy the fluffy squirrel who planted glowing acorn nightlights for all woodland creatures",
      "Finny the baby red fox who discovered that singing makes sweet strawberries grow double-sized",
      "Kiki the koala and Oliver the wise owlet who built a starry sky telescope out of hollow bamboo",
      "Milo the golden puppy and Whiskers the kitten who formed a joyful puddle-splashing band",
      "Bumble the little panda who gave warm bear hugs to sad sleepy trees to make them blossom",
      "Penny the baby penguin who built an ice slide to deliver frozen fish treats to walrus friends",
      "Dash the spotted cheetah cub who learned that playing tag with turtle friends is more fun than winning",
      "Ollie the playful river otter who found a singing rainbow pebble in the crystal stream",
      "Bella the bluebird who taught a clumsy baby bear how to whistle a sweet bedtime song",
      "Hazel the hedgehog who collected colorful autumn leaves to make warm feather pillows for mice",
      "Barnaby the bear cub and Toby the turtle who built a leaf parachute to float across the river",
      "Dottie the gentle baby deer who followed a trail of blue fireflies to a hidden enchanted waterfall",
      "Ellie the baby elephant and Sammy the squirrel who planted a magic sunflower that grew to the clouds",
      "Milo the monkey who lost his balance and invented a hilarious silly tail dance",
      "Toby the turtle and Benny the badger who dug a secret underground tunnel to the sweet potato garden",
      "Sammy the squirrel and Fiona the frog who held a lily-pad jumping contest under the stars",
      "Finny the fox and Kiki the koala who solved the riddle of the singing crystal cave",
      "Penny the penguin who made snow angels and taught a sleepy polar bear how to ice-skate",
      "Poppy the baby panda who built a bamboo xylophone and played a lullaby for the forest",
      "Ellie the elephant who carried water in her trunk to save the thirsty enchanted meadow",
      "Barnaby the little bear who traded his sweet berries for a shiny golden star whistle",
      "Sunny the golden retriever puppy who showed a shy hedgehog how to play leaf tag",
      "Milo the monkey and Toby the turtle who built a floating coconut raft to explore the secret lagoon"
    ];
  }
}

module.exports = TopicScout;
