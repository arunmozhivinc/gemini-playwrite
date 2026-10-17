const { execFile } = require('child_process');
const fs = require('fs');

class AntigravityService {
  constructor(options = {}) {
    this.cliPath = options.cliPath || 'C:\\Users\\Admin\\.gemini\\bin\\agy.exe';
    this.timeoutMs = options.timeoutMs || 25000;
  }

  /**
   * Check if Antigravity CLI is available and operational.
   */
  async checkStatus() {
    return new Promise((resolve) => {
      if (!fs.existsSync(this.cliPath)) {
        return resolve({ available: false, error: 'Executable not found at ' + this.cliPath });
      }

      execFile(this.cliPath, ['--help'], { timeout: 5000 }, (error, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        if (output.includes('agy')) {
          resolve({ available: true, path: this.cliPath });
        } else {
          resolve({ available: false, error: error ? error.message : 'Unrecognized CLI output' });
        }
      });
    });
  }

  /**
   * Expand a raw user prompt into a high-fidelity visual description for video keyframes.
   * Uses agy CLI with prompt engineering guidance.
   */
  async expandPrompt(rawPrompt, options = {}) {
    const { scene = 1, shot = 1, style = 'cinematic', aspectRatio = '16:9' } = options;

    const instructions = [
      'You are a lead cinematic director and AI visual prompt engineer preparing keyframes for a high-end video generation pipeline.',
      'Take the given user prompt and expand it into a photorealistic, ultra-detailed visual description.',
      'Specify camera composition (e.g. wide establishing shot, medium close-up, Dutch angle), volumetric lighting, atmospheric haze, color grade, textural details, and subtle motion dynamics.',
      `Aspect ratio target: ${aspectRatio}. Scene: ${scene}, Shot: ${shot}. Visual Style: ${style}.`,
      'CRITICAL: Return ONLY the final expanded visual prompt text. Do NOT include greetings, preamble, markdown formatting, or explanations.',
      `User Prompt: "${rawPrompt}"`
    ].join(' ');

    try {
      const expanded = await this.runPrintPrompt(instructions);
      // Clean up response if it has quotes or markdown blocks
      let cleaned = expanded.trim();
      cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      cleaned = cleaned.replace(/^"|"$/g, '').trim();

      if (cleaned.length > 20) {
        return {
          originalPrompt: rawPrompt,
          expandedPrompt: cleaned,
          source: 'antigravity-cli'
        };
      }
    } catch (err) {
      console.warn('Antigravity CLI expansion fallback:', err.message);
    }

    // High quality fallback prompt enhancer if agy is busy or times out
    const fallbackExpanded = this.generateFallbackExpansion(rawPrompt, { scene, shot, style });
    return {
      originalPrompt: rawPrompt,
      expandedPrompt: fallbackExpanded,
      source: 'local-enhancer'
    };
  }

  /**
   * Run agy in non-interactive print mode using execFile.
   */
  async runPrintPrompt(promptText) {
    return new Promise((resolve, reject) => {
      const args = ['-p', promptText, '--dangerously-skip-permissions'];

      execFile(this.cliPath, args, { timeout: this.timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(`Antigravity CLI failed: ${stderr || error.message}`));
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Local cinematic enhancement template when offline or as fast fallback.
   */
  generateFallbackExpansion(prompt, { scene, shot, style }) {
    const cameraAngles = ['cinematic wide angle shot', 'dramatic low angle shot', 'smooth medium tracking shot', 'master shot with shallow depth of field'];
    const lightingTypes = ['soft volumetric cinematic lighting', 'dramatic golden hour rim lighting', 'atmospheric neon cyberpunk lighting', 'diffused natural studio lighting'];
    const chosenAngle = cameraAngles[(scene + shot) % cameraAngles.length];
    const chosenLight = lightingTypes[scene % lightingTypes.length];

    return `${prompt}, ${chosenAngle}, ${chosenLight}, 8k UHD, photorealistic textures, motion blur hint, Panavision 35mm lens, color graded, highly detailed video keyframe`;
  }
}

module.exports = AntigravityService;
