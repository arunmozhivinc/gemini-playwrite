/**
 * Patterned File Namer for Video Frames and Sequences.
 * 
 * Supports pattern templates such as:
 * - "frame_{index:04d}.png" -> frame_0001.png
 * - "scene_{scene:02d}_shot_{shot:02d}_{index:04d}.png" -> scene_01_shot_01_0001.png
 * - "{prefix}_{timestamp}_{index:04d}.png" -> anim_20261014_143000_0001.png
 * - "{prompt_slug}_{index:03d}.png" -> cyberpunk_detective_001.png
 */

class Namer {
  /**
   * Format a patterned filename based on template and metadata.
   * @param {string} template 
   * @param {object} params
   * @returns {string} Formatted filename
   */
  static format(template = 'frame_{index:04d}.png', params = {}) {
    const {
      index = 1,
      scene = 1,
      shot = 1,
      prompt = '',
      prefix = 'frame',
      ext = '.png',
      timestamp = new Date()
    } = params;

    let result = template;

    // Handle prompt slug: first 4-5 words, lowercase, alphanumeric only
    const slug = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join('_') || 'shot';

    // Format timestamp string YYYYMMDD_HHmmss
    const dateObj = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const tsStr = [
      dateObj.getFullYear(),
      String(dateObj.getMonth() + 1).padStart(2, '0'),
      String(dateObj.getDate()).padStart(2, '0'),
      '_',
      String(dateObj.getHours()).padStart(2, '0'),
      String(dateObj.getMinutes()).padStart(2, '0'),
      String(dateObj.getSeconds()).padStart(2, '0')
    ].join('');

    // Replace padding tokens like {index:04d}, {scene:02d}, {shot:03d}
    result = result.replace(/\{(index|scene|shot):0(\d+)d\}/g, (match, key, padding) => {
      const val = key === 'index' ? index : (key === 'scene' ? scene : shot);
      return String(val).padStart(parseInt(padding, 10), '0');
    });

    // Replace standard tokens
    result = result
      .replace(/\{index\}/g, String(index))
      .replace(/\{scene\}/g, String(scene))
      .replace(/\{shot\}/g, String(shot))
      .replace(/\{prompt_slug\}/g, slug)
      .replace(/\{prefix\}/g, prefix)
      .replace(/\{timestamp\}/g, tsStr)
      .replace(/\{ext\}/g, ext.startsWith('.') ? ext : `.${ext}`);

    // Ensure extension exists
    if (!pathHasExt(result)) {
      result += ext.startsWith('.') ? ext : `.${ext}`;
    }

    // Sanitize for file system (remove invalid characters: \ / : * ? " < > |)
    result = result.replace(/[\\/:*?"<>|]/g, '_');

    return result;
  }

  /**
   * Generate an example filename for preview in UI.
   */
  static preview(template, sampleParams = {}) {
    return Namer.format(template, {
      index: 1,
      scene: 1,
      shot: 1,
      prompt: 'cyberpunk detective in rain',
      prefix: 'video',
      ...sampleParams
    });
  }
}

function pathHasExt(filename) {
  return /\.[a-zA-Z0-9]{2,5}$/.test(filename);
}

module.exports = Namer;
