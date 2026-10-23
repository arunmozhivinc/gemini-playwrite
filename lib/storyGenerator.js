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

FORBIDDEN PROTAGONIST NAMES (ALREADY USED — DO NOT USE THESE NAMES):
${usedNamesList}
You MUST create a COMPLETELY DIFFERENT, fresh, culturally rich name for the child protagonist that is NOT in the list above (e.g., Meera, Ezhil, Oviya, Chezhian, Aadhira, Velan, Thenmozhi, Bharathi, Kumaran, Arul, Mithran, Deepan, Ilango, Vani, Pragathi, Tamizh, Pugazh, etc.).

FORBIDDEN REPEATED STORY PLOTS (DO NOT REPEAT THESE TROPES):
- Saving a baby bird/sparrow with a flower bowl or water bowl
- Nursing a broken-winged bird back to health
- Sharing a lunchbox / lunch food with a classmate who forgot theirs
- Following a line of ants and learning teamwork
- Making clay cups of water for ants or making clay dolls
- Repairing a leaky roof with grandfather before the rain
- Helping grandmother carry vegetables from the market
- Surprising mother with garden flowers
- Finding a lost kitten or puppy and returning it home

REQUIREMENT FOR TOPIC: "${topic}"
- The new story must feature a completely fresh narrative arc, unique secondary characters, and a distinctive setting.
- If this topic seems similar to any past story, adopt an entirely different creative spin, conflict, and moral lesson.
================================================================================
`;
    }

    return `You are a creative children's storyteller and content generator. Create a complete, publish-ready story script for a Tamil-English bilingual YouTube Shorts animation.

Topic: "${topic}"
${pastStoriesSection}
OUTPUT FORMAT: Valid JSON only. No markdown, no preamble, no code blocks. Just raw JSON.

{
  "title_en": "Story Title in English",
  "title_ta": "கதையின் தலைப்பு தமிழில்",
  "theme": "main theme (e.g. kindness, courage, sharing)",
  "moral_en": "One sentence moral in English",
  "moral_ta": "ஒரு வாக்கிய நீதி தமிழில்",
  "description_en": "2 sentence description for YouTube Shorts",
  "description_ta": "2 வாக்கிய விளக்கம் யூடியூப் ஷார்ட்ஸிற்காக",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "character_sheet": "Detailed visual description of the unique protagonist (name, age, skin tone, hair style/color, exact top clothing, bottoms, footwear, facial features).",
  "scenes": [
    {
      "scene_index": 1,
      "image_prompt": "Soft 2D storybook watercolor illustration, vibrant warm pastel colors, vertical 9:16 portrait composition, 1080x1920, strictly no text. [Character Name], [exact character description and clothing from character_sheet], [action and facial expression]. [Setting details, foreground, background elements, lighting]. Children's picture book illustration style, clean outlines, warm gentle atmosphere.",
      "text_en": "ONE crisp sentence in English, max 12 words, for children aged 3-8.",
      "text_ta": "ஒரு வாக்கியம் மட்டும், அதிகபட்சம் 12 சொற்கள், 3-8 வயது குழந்தைகளுக்கு."
    }
  ]
}

Rules for Unique Story Image Prompts:
- Exactly ${this.sceneCount} scenes. This is NON-NEGOTIABLE — you must output exactly ${this.sceneCount} scene objects.
- Create a COMPLETELY UNIQUE protagonist for this story with a name NOT in the forbidden list.
- Every single image_prompt MUST follow the exact template:
  "Soft 2D storybook watercolor illustration, vibrant warm pastel colors, vertical 9:16 portrait composition, 1080x1920, strictly no text. [Character Name], [exact character description and clothing], [action/emotion]. [Setting and lighting details]. Children's picture book illustration style, clean outlines, warm gentle atmosphere."
- The exact clothing, hair, and visual features from character_sheet MUST be repeated in EVERY scene's image_prompt for visual consistency.
- NARRATION TEXT RULES (CRITICAL FOR YOUTUBE SHORTS TIMING):
  - Each text_en and text_ta MUST be a SINGLE sentence, maximum 12 words.
  - Short, punchy, child-friendly language only. No complex clauses.
  - This keeps each scene's narration under 4 seconds of voice, and the full video under 60 seconds.
- Story arc across ${this.sceneCount} micro-moments (comic-strip pacing):
  1.  Wide establishing shot — show the world and introduce the protagonist
  2.  Close-up on the protagonist's cheerful face, ready for the day
  3.  The protagonist notices something unusual or interesting nearby
  4.  Curiosity deepens — they move closer to investigate
  5.  They discover another character (friend, creature, or smaller child) in need
  6.  The protagonist's face shows empathy and concern
  7.  They take their first kind action to help
  8.  A complication or extra challenge arises
  9.  The protagonist persists with determination and creativity
  10. The helping action succeeds — a pivotal joyful moment
  11. The other character's face lights up with gratitude and happiness
  12. Both characters together, smiling broadly — warm golden light, celebratory mood
  (If sceneCount is 13-15, add transitional micro-moments such as: bystanders reacting, a shared laugh, or the protagonist reflecting with a warm expression.)
- Strictly NO violent, scary, or dark elements.`;
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
