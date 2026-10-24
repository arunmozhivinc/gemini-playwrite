const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Story Generator using Antigravity CLI (local, no external keys required).
 * Takes a topic and generates a full bilingual (English + Tamil) story script
 * with scene-by-scene image prompts, narration text, characters, and metadata.
 */
class StoryGenerator {
  constructor(options = {}) {
    this.cliPath = options.cliPath || process.env.ANTIGRAVITY_CLI_PATH || 'C:\\Users\\Admin\\.gemini\\bin\\agy.exe';
    this.timeoutMs = options.timeoutMs || 180000; // 3 minutes timeout for complete bilingual script
    this.sceneCount = options.sceneCount || 12;
    this.outputDir = options.outputDir || path.join(process.cwd(), 'output');
    this.db = options.db || null;
  }

  /**
   * Fetch all previously generated stories from disk and database.
   * Extracts titles, topics, themes, morals, and protagonist names.
   * @returns {Promise<Array<{title_en: string, title_ta: string, topic: string, theme: string, moral: string, protagonist: string}>>}
   */
  async getExistingStories() {
    const storyMap = new Map();

    // 1. Scan filesystem output directory
    try {
      if (fs.existsSync(this.outputDir)) {
        const dirs = fs.readdirSync(this.outputDir, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('_')) continue;
          const scriptPath = path.join(this.outputDir, d.name, 'story_script.json');
          if (fs.existsSync(scriptPath)) {
            try {
              const s = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
              const titleEn = s.title_en || d.name;
              
              // Extract protagonist name from character_sheet or title
              let protagonist = '';
              if (s.character_sheet) {
                const charMatch = s.character_sheet.match(/^([A-Za-z]+)\b/);
                if (charMatch && charMatch[1].length > 2) {
                  protagonist = charMatch[1];
                }
              }
              if (!protagonist && titleEn) {
                const titleMatch = titleEn.match(/^([A-Za-z]+)(?:'s|\s+and|\s+in|\s+the)/i);
                if (titleMatch && !['the', 'little', 'our', 'a', 'an'].includes(titleMatch[1].toLowerCase())) {
                  protagonist = titleMatch[1];
                }
              }

              storyMap.set(titleEn.toLowerCase(), {
                story_id: s.story_id || d.name,
                title_en: titleEn,
                title_ta: s.title_ta || '',
                topic: s.topic || '',
                theme: s.theme || '',
                moral: s.moral_en || s.moral || '',
                protagonist: protagonist || ''
              });
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.warn('[Story] Error scanning disk stories for deduplication:', e.message);
    }

    // 2. Fetch from PostgreSQL database if available
    if (this.db) {
      try {
        if (typeof this.db.getAllStories === 'function') {
          const dbStories = await this.db.getAllStories();
          for (const s of dbStories) {
            const titleEn = s.title_en || s.story_id;
            if (!titleEn) continue;
            const key = titleEn.toLowerCase();
            if (!storyMap.has(key)) {
              storyMap.set(key, {
                story_id: s.story_id,
                title_en: titleEn,
                title_ta: s.title_ta || '',
                topic: s.topic || '',
                theme: s.theme || '',
                moral: s.moral || '',
                protagonist: s.protagonist || ''
              });
            }
          }
        }
      } catch (e) {
        console.warn('[Story] Error fetching DB stories for deduplication:', e.message);
      }
    }

    return Array.from(storyMap.values());
  }

  /**
   * Build a rich prompt for story generation that tells the model
   * all previously generated stories and strictly forbids duplicating them.
   * @param {string} topic - e.g. "a girl who shares her lunch with a sparrow"
   * @param {Array} [existingStories=[]] - List of past generated story records
   * @returns {string}
   */
  buildPrompt(topic, existingStories = []) {
    // Collect unique used protagonists
    const usedNamesSet = new Set(['Kavin', 'Kayal', 'Nila', 'Amudha', 'Anbu', 'Tara', 'Iniya', 'Maran', 'Yazhini', 'Selam', 'Ananya']);
    for (const s of existingStories) {
      if (s.protagonist && s.protagonist.length > 2) {
        usedNamesSet.add(s.protagonist);
      }
    }
    const usedNamesList = Array.from(usedNamesSet).join(', ');

    // Format list of past stories for the model
    let pastStoriesSection = '';
    if (existingStories && existingStories.length > 0) {
      const storyLines = existingStories.slice(0, 35).map((s, idx) => {
        const parts = [`"${s.title_en}"`];
        if (s.protagonist) parts.push(`Protagonist: ${s.protagonist}`);
        if (s.topic) parts.push(`Topic: ${s.topic}`);
        if (s.theme) parts.push(`Theme: ${s.theme}`);
        return `  ${idx + 1}. ${parts.join(' | ')}`;
      });
      pastStoriesSection = `
================================================================================
CRITICAL INSTRUCTION: ZERO REPETITION / DO NOT DUPLICATE ALREADY GENERATED STORIES
================================================================================
We have ALREADY generated and published the following ${existingStories.length} stories.
You MUST NOT generate any story that has already been generated or closely resembles past stories.
Do NOT reuse any of these story plots, conflicts, resolutions, morals, or characters!

STORIES ALREADY GENERATED:
${storyLines.join('\n')}

FORBIDDEN OLD HUMAN PROTAGONIST NAMES & GENERIC TROPES:
${usedNamesList}
DO NOT create stories about human village children doing farm/household chores.
Children on YouTube demand fun, cute animal characters, magical adventures, and rhyming verse!

FORBIDDEN REPEATED STORY PLOTS (DO NOT REPEAT THESE TROPES):
- Human children walking in dusty villages or doing garden chores
- Saving a baby bird/sparrow with a flower bowl or water bowl
- Nursing a broken-winged bird back to health
- Sharing a school lunchbox / lunch food with a classmate
- Following a line of ants and learning teamwork
- Making clay cups of water for ants or making clay dolls
- Repairing a leaky roof with grandfather before the rain
- Helping grandmother carry vegetables from the market
- Surprising mother with garden flowers
- Finding a lost kitten or puppy and returning it home

REQUIREMENT FOR TOPIC: "${topic}"
- The new story MUST feature lovable, cute ANIMAL characters (e.g. lion cub, bunny, bear, baby elephant, playful monkey, squirrel, panda, turtle, fox, puppy, kitten).
- If this topic seems similar to any past story, adopt an entirely different creative animal adventure spin.
================================================================================
`;
    }

    return `You are an award-winning children's author and 3D animation director specializing in viral YouTube Shorts for kids and toddlers (ages 2-8).
Create a complete, publish-ready, highly engaging bilingual (English + Tamil) rhyming animated story script.

Topic: "${topic}"
${pastStoriesSection}

CRITICAL RULES FOR HIGH YOUTUBE ENGAGEMENT (0 VIEWS FIX):
1. CHARACTERS: ALWAYS use lovable, expressive ANIMAL characters (e.g., Leo the lion cub, Pip the fluffy bunny, Barnaby the little bear, Ellie the baby elephant, Milo the mischievous monkey, Sammy the squirrel, Toby the tiny turtle). Include a dynamic friendship between two animal friends!
2. RHYMING / RHYTHMIC STORYTELLING:
   - Toddlers and kids LOVE catchy rhymes and rhythmic cadence! It drives huge audience retention and repeat looping.
   - ENGLISH (text_en): Write as rhythmic rhyming couplets!
     * Scene 1 & 2 rhyme with each other (Rhyme A)
     * Scene 3 & 4 rhyme with each other (Rhyme B)
     * Scene 5 & 6 rhyme with each other (Rhyme C)
     * Scene 7 & 8 rhyme with each other (Rhyme D)
     * Scene 9 & 10 rhyme with each other (Rhyme E)
     * Scene 11 & 12 rhyme with each other (Rhyme F)
     * Each line MUST be 7 to 11 words with a bouncy, musical rhythm (perfect for kids narration).
   - TAMIL (text_ta): Write as catchy, musical children's rhyming verse (மழலையர் பாடல் சந்த நயம் / எதுகை மோனை)!
     * Scene 1 & 2 must rhyme / share musical rhythm (எதுகை/மோனை/இயைபு).
     * Scene 3 & 4 must rhyme / share musical rhythm.
     * Scene 5 & 6 must rhyme / share musical rhythm.
     * Scene 7 & 8 must rhyme / share musical rhythm.
     * Scene 9 & 10 must rhyme / share musical rhythm.
     * Scene 11 & 12 must rhyme / share musical rhythm.
     * Short, lyrical Tamil words (7 to 11 words) that toddlers and parents can sing along to.
3. 3D PIXAR / DISNEY ANIMATION STYLE (IMAGE PROMPTS):
   - NO 2D watercolor. NO flat sketches.
   - High-end 3D CGI animation style (Pixar, Disney, DreamWorks quality).
   - Chubby, adorable proportions, giant glossy sparkling eyes, soft fluffy fur / feather textures, rich vibrant candy colors, magical sunbeams, and dynamic 9:16 vertical composition.
4. YOUTUBE SHORTS HOOK PACING (Under 55 seconds total):
   - Scene 1: Instant visual & verbal hook! Introduce the cute animal with a funny quirk or magical discovery.
   - Scene 2: Big adorable close-up showing cheerful, emotive personality.
   - Scene 3-4: The fun puzzle or playful mystery begins.
   - Scene 5-6: Teaming up with the second animal friend.
   - Scene 7-8: Trying silly, bouncy, creative attempts together.
   - Scene 9-10: Breakthrough! A sparkling, joyous success moment!
   - Scene 11: Heartwarming high-five, cuddle, or happy dance between the friends.
   - Scene 12: Grand celebration finale with a sweet rhyming moral couplet!

OUTPUT FORMAT: Valid JSON only. No markdown, no preamble, no code blocks. Just raw JSON.

{
  "title_en": "Catchy Kid-Friendly Title in English (e.g. Leo the Lion & Pip the Bunny 🦁🐰)",
  "title_ta": "குழந்தைகள் விரும்பும் கவர்ச்சியான தலைப்பு (எ.கா: குட்டி சிங்கமும் பஞ்சு முயலும் 🦁🐰)",
  "theme": "main theme (e.g. friendship, courage, sharing, teamwork)",
  "moral_en": "One rhyming sentence moral in English",
  "moral_ta": "ஒரு எளிய பாட்டு போன்ற நீதி வாக்கியம் தமிழில்",
  "description_en": "A charming 3D animated rhyming story for kids about [Character] and [Friend]. Perfect for bedtime and sing-along fun! #Shorts #KidsStory #Rhymes",
  "description_ta": "குழந்தைகளுக்கான அழகான 3D அனிமேஷன் பாடல் கதை. படுக்கும் முன் கேட்க சிறந்த கதை! #Shorts #TamilRhymes #KidsStory",
  "tags": ["rhymes for kids", "kids story", "animal story", "nursery rhymes", "lion and rabbit", "3d animation kids", "bedtime story", "tamil rhymes", "tamil kids story"],
  "character_sheet": "Detailed 3D stylized character design (character name, species, plush fluffy fur color and markings, huge glossy round eyes, adorable signature accessory like a tiny striped sweater or acorn backpack, Pixar chibi proportions, warm cheerful expression).",
  "scenes": [
    {
      "scene_index": 1,
      "image_prompt": "Vibrant 3D Pixar Disney animated movie style, vertical 9:16 portrait composition, 1080x1920, strictly no text. [Animal Name], adorable [species], [exact 3D character features, plush fluffy fur, giant glossy eyes, cute accessory], [dynamic action and joyful face]. [Enchanting fairytale 3D forest environment, glowing sunlight, vivid saturated colors]. Raytraced cinematic lighting, Unreal Engine 5 render, cute chibi proportions, child-friendly 3D animation.",
      "text_en": "Little Leo the lion had a big fluffy mane,",
      "text_ta": "சிங்கக் குட்டி லியோவாம், சிரித்துப் பேசும் தோழனாம்!"
    }
  ]
}

Rules for Story Generation:
- Exactly ${this.sceneCount} scenes. This is NON-NEGOTIABLE — you must output exactly ${this.sceneCount} scene objects.
- Protagonist and co-star MUST be cute animals (e.g. lion cub, bunny, bear, elephant, monkey, squirrel, panda, puppy, turtle, penguin).
- Every single image_prompt MUST follow the exact 3D Pixar/Disney template:
  "Vibrant 3D Pixar Disney animated movie style, vertical 9:16 portrait composition, 1080x1920, strictly no text. [Animal Name], adorable [species], [exact 3D character features from character_sheet repeated for consistency], [action and emotion]. [3D environment and lighting details]. Raytraced cinematic lighting, Unreal Engine 5 render, cute chibi proportions, child-friendly 3D animation, saturated colors."
- The exact animal features, fur color, and accessory from character_sheet MUST be repeated in EVERY scene's image_prompt for visual consistency.
- NARRATION RULES (CRITICAL):
  * Each text_en and text_ta must be 7 to 11 words.
  * Every pair of scenes MUST rhyme (1&2 rhyme, 3&4 rhyme, 5&6 rhyme, 7&8 rhyme, 9&10 rhyme, 11&12 rhyme).
  * In English: bouncy rhythm and clear rhymes.
  * In Tamil: lyrical, musical rhythm with alliteration/rhyme (மழலையர் பாடல் நயம்).
- Strictly NO violent, scary, or dark elements. Everything should be cheerful, colorful, and heartwarming.`;
  }

  /**
   * Generate a story from a topic using Antigravity CLI.
   * Feeds all existing stories to the model prompt to guarantee zero duplication.
   * @param {string} topic
   * @param {object|number} [optionsOrRetry=1] - options object or retryCount number
   * @param {number} [retryCount=1]
   * @returns {Promise<object>} Parsed story JSON
   */
  async generateStory(topic, optionsOrRetry = {}, retryCount = 1) {
    let options = {};
    let retries = 1;

    if (typeof optionsOrRetry === 'number') {
      retries = optionsOrRetry;
    } else if (typeof optionsOrRetry === 'object' && optionsOrRetry !== null) {
      options = optionsOrRetry;
      retries = options.retryCount !== undefined ? options.retryCount : (typeof retryCount === 'number' ? retryCount : 1);
    }

    // Retrieve existing stories to pass into model prompt
    const existingStories = options.existingStories || await this.getExistingStories();
    console.log(`[Story] Generating story for topic: "${topic}" (informing model of ${existingStories.length} past stories to avoid duplicates, timeout: ${this.timeoutMs / 1000}s)...`);

    const instructions = this.buildPrompt(topic, existingStories);

    const runCli = () => {
      return new Promise((resolve, reject) => {
        const args = ['-p', instructions, '--dangerously-skip-permissions'];

        execFile(this.cliPath, args, {
          timeout: this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          cwd: os.tmpdir()
        }, (error, stdout, stderr) => {
          if (error) {
            const isTimeout = error.killed || error.signal === 'SIGTERM';
            const msg = isTimeout
              ? `Antigravity CLI timed out after ${this.timeoutMs / 1000}s while generating story.`
              : (stderr || error.message);
            return reject(new Error(`Antigravity CLI failed: ${msg}`));
          }

          const raw = (stdout || '').trim();

          // Try to extract JSON from the response
          const story = this.extractJSON(raw);
          if (!story) {
            return reject(new Error(`Could not parse story JSON from Antigravity output. Raw: ${raw.slice(0, 500)}`));
          }

          // Validate required fields
          if (!story.scenes || !Array.isArray(story.scenes)) {
            return reject(new Error('Story missing required scenes array'));
          }

          // Enrich with metadata
          story.story_id = this.generateStoryId(story.title_en || topic);
          story.topic = topic;
          story.created_at = new Date().toISOString();
          story.generated_at = story.created_at;
          story.tags_csv = (story.tags || []).join(',');

          console.log(`[Story] ✅ Generated: "${story.title_en}" with ${story.scenes.length} scenes`);
          resolve(story);
        });
      });
    };

    try {
      return await runCli();
    } catch (err) {
      if (retries > 0) {
        console.warn(`[Story] ⚠️ Story generation attempt failed (${err.message}). Retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        return await this.generateStory(topic, { ...options, retryCount: retries - 1 });
      }
      throw err;
    }
  }

  /**
   * Extract valid JSON from potentially messy LLM output.
   * @param {string} raw
   * @returns {object|null}
   */
  extractJSON(raw) {
    // Try direct parse
    try {
      return JSON.parse(raw);
    } catch (_) {}

    // Try to find JSON block
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (_) {}
    }

    // Try to find JSON after code fence
    const codeFenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeFenceMatch) {
      try {
        return JSON.parse(codeFenceMatch[1].trim());
      } catch (_) {}
    }

    return null;
  }

  /**
   * Generate a URL-safe, timestamped story ID from a title.
   * @param {string} title
   * @returns {string}
   */
  generateStoryId(title) {
    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '-',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0')
    ].join('');

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 50);

    return `${timestamp}-${slug}`;
  }
}

module.exports = StoryGenerator;
