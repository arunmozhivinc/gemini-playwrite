const fs = require('fs');
const path = require('path');
const PlaywrightGeminiGenerator = require('./playwrightGeminiGenerator');

/**
 * Image Generator Service
 * Multi-provider image generation supporting:
 * 1. Playwright Gemini Generator (using real Chrome profile & Imagen 3 web app)
 * 2. Local Antigravity asset pool resolver
 * 3. Google Gemini Imagen 3 REST API (if GEMINI_API_KEY is provided)
 */
class ImageGenerator {
  constructor(options = {}) {
    this.provider = options.provider || process.env.IMAGE_PROVIDER || 'playwright-gemini';
    this.defaultModel = options.defaultModel || 'imagen-3';
    this.geminiApiKey = options.geminiApiKey || process.env.GEMINI_API_KEY;
    this.artifactsDir = options.artifactsDir || 'C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain\\0ead3e50-2da5-475b-a1da-353731135c66';
    
    this.playwrightGenerator = new PlaywrightGeminiGenerator({
      profileDir: options.profileDir || process.env.GEMINI_PROFILE_DIR,
      headless: options.headless
    });
  }

  /**
   * Generate all scene images for an entire story.
   * Leverages Playwright with Google Gemini single-chat context preservation,
   * maintaining character appearance and art style throughout the story.
   * 
   * @param {object} story
   * @param {string} storyDir
   * @param {function} [onProgress]
   */
  async generateStoryScenes(story, storyDir, onProgress) {
    const scenes = story.scenes || [];
    if (scenes.length === 0) {
      return { success: true, count: 0, skipped: true };
    }

    // 1. Check if all images already exist on disk
    const missingScenes = [];
    for (const scene of scenes) {
      const pad = String(scene.scene_index).padStart(2, '0');
      const p = path.join(storyDir, `scene_${pad}.png`);
      if (!fs.existsSync(p) || fs.statSync(p).size < 10000) {
        missingScenes.push(scene);
      }
    }

    if (missingScenes.length === 0) {
      console.log(`[ImageGenerator] ⏭️ All ${scenes.length} scene images exist in ${storyDir}. Skipping.`);
      return { success: true, count: scenes.length, skipped: true };
    }

    // 2. Try resolving from local Antigravity artifact pool first
    for (const scene of missingScenes) {
      const pad = String(scene.scene_index).padStart(2, '0');
      const outputPath = path.join(storyDir, `scene_${pad}.png`);
      try {
        await this.generateWithLocalAntigravity({
          prompt: scene.image_prompt,
          outputPath,
          storyId: story.story_id,
          sceneIndex: scene.scene_index
        });
      } catch (_) {}
    }

    // Check if any remain missing
    const stillMissing = [];
    for (const scene of scenes) {
      const pad = String(scene.scene_index).padStart(2, '0');
      const p = path.join(storyDir, `scene_${pad}.png`);
      if (!fs.existsSync(p) || fs.statSync(p).size < 10000) {
        stillMissing.push(scene);
      }
    }

    if (stillMissing.length === 0) {
      console.log(`[ImageGenerator] ✅ All scenes resolved from local Antigravity pool.`);
      return { success: true, count: scenes.length, resolvedFromLocal: true };
    }

    // 3. Automated Playwright Gemini Generation (Single-Chat Context Preservation)
    console.log(`[ImageGenerator] 🚀 Generating ${stillMissing.length} missing scene(s) via Playwright Gemini Automation...`);
    return await this.playwrightGenerator.generateStoryScenes({
      story,
      storyDir,
      onProgress
    });
  }

  /**
   * Generate a single image from prompt and save directly to outputPath.
   */
  async generate(params) {
    const {
      prompt,
      outputPath,
      width = 1080,
      height = 1920,
      storyId,
      sceneIndex,
      provider = this.provider
    } = params;

    // Ensure output directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1. If output file already exists and is valid, keep it
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
      const stats = fs.statSync(outputPath);
      return {
        success: true,
        outputPath,
        fileSize: stats.size,
        dimensions: { width, height },
        provider: 'existing-file'
      };
    }

    // 2. Try local Antigravity artifacts pool
    try {
      const localResult = await this.generateWithLocalAntigravity({
        prompt,
        outputPath,
        width,
        height,
        storyId,
        sceneIndex
      });
      if (localResult && localResult.success) {
        return localResult;
      }
    } catch (_) {}

    // 3. Try Gemini REST API if key is explicitly configured
    if (this.geminiApiKey && provider === 'gemini') {
      try {
        return await this.generateWithGemini({ prompt, outputPath, width, height });
      } catch (e) {
        console.warn('[ImageGenerator] Gemini REST API failed, falling back to Playwright:', e.message);
      }
    }

    // 4. Default automated engine: Playwright Gemini Web App Automation
    console.log('[ImageGenerator] Using Playwright Gemini Web App automation for single image...');
    return await this.playwrightGenerator.generateSingleImage({
      prompt,
      outputPath,
      width,
      height
    });
  }

  /**
   * Local Antigravity generation & repository handler.
   */
  async generateWithLocalAntigravity({ prompt, outputPath, width = 1080, height = 1920, storyId, sceneIndex }) {
    // 1. Search local artifact directory for generated scenes matching THIS story
    if (sceneIndex && fs.existsSync(this.artifactsDir)) {
      const pad = String(sceneIndex).padStart(2, '0');
      const files = fs.readdirSync(this.artifactsDir);

      const cleanId = (storyId || '').replace(/^\d+-\d+-/, '');
      const parts = cleanId.split('-').filter(Boolean);
      const storySlug = parts.join('_');
      const firstWord = parts[0] || '';
      const secondWord = parts[1] || '';

      const matchPrefixes = [];
      if (storySlug) {
        matchPrefixes.push(`${storySlug}_scene_${pad}`);
        matchPrefixes.push(`${storySlug}_scene_${sceneIndex}`);
      }
      if (secondWord && ['the', 'a', 'little', 'young'].includes(firstWord)) {
        matchPrefixes.push(`${secondWord}_scene_${pad}`);
        matchPrefixes.push(`${firstWord}_${secondWord}_scene_${pad}`);
      }
      if (firstWord) {
        matchPrefixes.push(`${firstWord}_scene_${pad}`);
      }

      for (const prefix of matchPrefixes) {
        const found = files.filter(f => f.toLowerCase().startsWith(prefix.toLowerCase()) && (f.endsWith('.jpg') || f.endsWith('.png')));
        if (found.length > 0) {
          found.sort();
          const latest = found[found.length - 1];
          const src = path.join(this.artifactsDir, latest);
          fs.copyFileSync(src, outputPath);
          const stats = fs.statSync(outputPath);
          return {
            success: true,
            outputPath,
            fileSize: stats.size,
            dimensions: { width, height },
            provider: 'antigravity-local',
            sourceArtifact: latest
          };
        }
      }
    }

    // 2. Check local workspace output folder for matching story scenes
    const localOutputDir = path.join(__dirname, '..', 'output');
    if (sceneIndex && storyId && fs.existsSync(path.join(localOutputDir, storyId))) {
      const pad = String(sceneIndex).padStart(2, '0');
      const storyScenePath = path.join(localOutputDir, storyId, `scene_${pad}.png`);
      if (fs.existsSync(storyScenePath) && fs.statSync(storyScenePath).size > 10000) {
        if (storyScenePath !== outputPath) {
          fs.copyFileSync(storyScenePath, outputPath);
        }
        const stats = fs.statSync(outputPath);
        return {
          success: true,
          outputPath,
          fileSize: stats.size,
          dimensions: { width, height },
          provider: 'antigravity-local',
          sourceFile: `scene_${pad}.png`
        };
      }
    }

    // 3. If output file already exists, keep it
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
      const stats = fs.statSync(outputPath);
      return {
        success: true,
        outputPath,
        fileSize: stats.size,
        dimensions: { width, height },
        provider: 'antigravity-local',
        note: 'Existing local file retained'
      };
    }

    return null;
  }

  /**
   * Google Gemini / Imagen 3 API integration.
   */
  async generateWithGemini({ prompt, outputPath, width, height }) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${this.geminiApiKey}`;

    const body = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: width > height ? '16:9' : (width < height ? '9:16' : '1:1'),
        outputMimeType: 'image/png'
      }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini Imagen API error: ${errText}`);
    }

    const data = await response.json();
    const base64Data = data.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) {
      throw new Error('No image returned from Gemini Imagen');
    }

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(outputPath, buffer);
    const stats = fs.statSync(outputPath);

    return {
      success: true,
      outputPath,
      fileSize: stats.size,
      dimensions: { width, height },
      provider: 'google-imagen-3'
    };
  }
}

module.exports = ImageGenerator;
