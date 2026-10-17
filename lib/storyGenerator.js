const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Story Generator using Antigravity CLI (local, no external keys required).
 * Takes a topic and generates a full bilingual (English + Tamil) story script
 * with scene-by-scene image prompts, narration text, characters, and metadata.
 */
class StoryGenerator {
  constructor(options = {}) {
    this.cliPath = options.cliPath || process.env.ANTIGRAVITY_CLI_PATH || 'C:\\Users\\Admin\\.gemini\\bin\\agy.exe';
    this.timeoutMs = options.timeoutMs || 180000; // 3 minutes timeout for complete bilingual script
    this.sceneCount = options.sceneCount || 6;
  }

  /**
   * Build a rich prompt for story generation.
   * @param {string} topic - e.g. "a girl who shares her lunch with a sparrow"
   * @returns {string}
   */
  buildPrompt(topic) {
    return `You are a creative children's storyteller and content generator. Create a complete, publish-ready story script for a Tamil-English bilingual YouTube Shorts animation.

Topic: "${topic}"

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
      "text_en": "English narration for this scene. 1-2 warm, simple sentences for children aged 3-8.",
      "text_ta": "இந்தக் காட்சிக்கான தமிழ் விளக்கம். 3-8 வயது குழந்தைகளுக்கு எளிய 1-2 வாக்கியங்கள்."
    }
  ]
}

Rules for Unique Story Image Prompts:
- Exactly ${this.sceneCount} scenes.
- Create a COMPLETELY UNIQUE protagonist for this story (do NOT reuse characters from past stories).
- Every single image_prompt MUST follow the exact template:
  "Soft 2D storybook watercolor illustration, vibrant warm pastel colors, vertical 9:16 portrait composition, 1080x1920, strictly no text. [Character Name], [exact character description and clothing], [action/emotion]. [Setting and lighting details]. Children's picture book illustration style, clean outlines, warm gentle atmosphere."
- The exact clothing, hair, and visual features from character_sheet MUST be repeated in EVERY scene's image_prompt for visual consistency.
- Scene progression:
  1. Introduction / setting out on adventure
  2. Discovering something new or interesting
  3. Close interaction with another creature / friend
  4. Heartwarming helpful action
  5. Emotional realization / feeling grateful and loving
  6. Happy celebration / waving smile under warm golden lighting
- Strictly NO violent, scary, or dark elements.`;
  }

  /**
   * Generate a story from a topic using Antigravity CLI.
   * @param {string} topic
   * @param {number} [retryCount=1]
   * @returns {Promise<object>} Parsed story JSON
   */
  async generateStory(topic, retryCount = 1) {
    console.log(`[Story] Generating story for topic: "${topic}" (timeout: ${this.timeoutMs / 1000}s)...`);

    const instructions = this.buildPrompt(topic);

    const runCli = () => {
      return new Promise((resolve, reject) => {
        const args = ['-p', instructions, '--dangerously-skip-permissions'];

        execFile(this.cliPath, args, {
          timeout: this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024
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
      if (retryCount > 0) {
        console.warn(`[Story] ⚠️ Story generation attempt failed (${err.message}). Retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        return await this.generateStory(topic, retryCount - 1);
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
