const path = require('path');
const fs = require('fs');

/**
 * Foley Sound Effects Selector
 * Detects context and action keywords in scene narration & image prompts,
 * returning the optimal sound effect to mix into the scene audio.
 */
class SfxSelector {
  constructor(options = {}) {
    this.sfxDir = options.sfxDir || path.join(process.cwd(), 'assets', 'sfx');
    this.enabled = options.enabled !== false;
    this.sfxVolume = options.sfxVolume || 0.12; // Balanced under narrator (1.0) and BGM (0.08)
  }

  /**
   * Determine the best sound effect for a given scene.
   * @param {object} scene - Scene object { scene_index, text_en, text_ta, image_prompt }
   * @param {number} totalScenes - Total scenes in story (default 12)
   * @returns {string|null} Path to the selected SFX file or null if disabled
   */
  selectForScene(scene = {}, totalScenes = 12) {
    if (!this.enabled) return null;

    const textEn = (scene.text_en || '').toLowerCase();
    const prompt = (scene.image_prompt || '').toLowerCase();
    const combined = `${textEn} ${prompt}`;
    const sceneIndex = scene.scene_index || 1;

    // 1. Magic, sparkle, rainbow, glow, stars
    if (/(magic|sparkle|glow|shimmer|star|rainbow|crystal|lantern|beam|twinkle)/i.test(combined)) {
      return this.resolveFile('sfx_magic.mp3');
    }

    // 2. Whoosh, slide, flying, leaping, wind
    if (/(fly|slide|swing|wind|zoom|breeze|whoosh|soar|glide|parachute)/i.test(combined)) {
      return this.resolveFile('sfx_whoosh.mp3');
    }

    // 3. Water, stream, river, splash, bubbles
    if (/(water|river|splash|pond|stream|bubble|swim|lake|rain|drop|ocean|wave)/i.test(combined)) {
      return this.resolveFile('sfx_water.mp3');
    }

    // 4. Movement, scampering, hopping, dancing, footsteps
    if (/(hop|run|skip|walk|jump|chase|bounce|scamper|dance|trot|paws|step)/i.test(combined)) {
      return this.resolveFile('sfx_footsteps.mp3');
    }

    // 5. Cheer, celebration, laughing, winning, friends hugging, finale
    if (/(cheer|happy|smile|laugh|hug|celebrat|win|hooray|party|feast|applause|victory)/i.test(combined) || sceneIndex >= totalScenes - 1) {
      return this.resolveFile('sfx_cheer.mp3');
    }

    // 6. Forest, garden, flowers, nature, opening hook
    if (/(forest|garden|jungle|tree|flower|morning|meadow|grass|sun|bird|woodland)/i.test(combined) || sceneIndex <= 2) {
      return this.resolveFile('sfx_birds.mp3');
    }

    // Default gentle magic sparkle
    return this.resolveFile('sfx_magic.mp3');
  }

  resolveFile(filename) {
    const filePath = path.join(this.sfxDir, filename);
    return fs.existsSync(filePath) ? filePath : null;
  }
}

module.exports = SfxSelector;

