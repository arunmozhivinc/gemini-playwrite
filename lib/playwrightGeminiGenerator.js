const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Playwright Gemini Generator
 * Automates Google Gemini Web App (Imagen 3) using a real, authenticated Chrome profile.
 * 
 * Features:
 * - Single-Chat Context Preservation: Generates multi-scene stories in a single conversation
 *   to ensure strict character consistency, style uniformity, and visual coherence.
 * - Multi-tiered Download Engine:
 *     1. In-page authenticated high-res CDN fetch (=s0 raw 1080x1920)
 *     2. Native UI hover-to-download button event
 *     3. Pristine <img> element screenshot fallback
 * - Anti-Bot Stealth: Masks automation flags, simulates human typing cadence & pauses.
 * - Automatic Rate-Limit Cooldowns between sequential scene prompts.
 */
class PlaywrightGeminiGenerator {
  constructor(options = {}) {
    const rawProfile = options.profileDir || process.env.GEMINI_PROFILE_DIR || path.join(__dirname, '..', 'gemini_chrome_profile');
    this.profileDir = path.isAbsolute(rawProfile) ? rawProfile : path.resolve(__dirname, '..', rawProfile);
    this.headless = options.headless !== undefined
      ? options.headless
      : (process.env.PLAYWRIGHT_HEADLESS === 'false' ? false : true);
    this.geminiUrl = options.geminiUrl || 'https://gemini.google.com/app';
    this.cooldownMinMs = options.cooldownMinMs || 5000;
    this.cooldownMaxMs = options.cooldownMaxMs || 8000;
  }

  /**
   * Launch a stealth persistent Chrome browser context.
   */
  async launchBrowser() {
    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    console.log(`[PlaywrightGemini] Launching Chrome (headless: ${this.headless}) with profile:\n  ${this.profileDir}`);
    const context = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chrome',
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: 1440, height: 900 }
    });

    const page = context.pages()[0] || await context.newPage();

    // Strip automation indicators & suppress native anchor download click pipe crash
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      const origAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        if (this.download) {
          return;
        }
        return origAnchorClick.call(this);
      };
    });

    return { context, page };
  }

  /**
   * Check if Gemini is logged in and chat input is available.
   */
  async checkLogin(page) {
    const chatInputSelector = 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]:not(.ql-clipboard), div[contenteditable="true"]:not(.ql-clipboard)';
    const isInputVisible = await page.locator(chatInputSelector).first().isVisible().catch(() => false);
    if (!isInputVisible) return false;

    const signInVisible = await page
      .locator('a:has-text("Sign in"), button:has-text("Sign in")')
      .first()
      .isVisible()
      .catch(() => false);

    return !signInVisible;
  }

  /**
   * Generate all missing scenes for a story in a single cohesive Gemini chat session.
   * Maintains character and style consistency throughout the entire story.
   * 
   * @param {object} params
   * @param {object} params.story - Full story object containing story_id, character_sheet, scenes
   * @param {string} params.storyDir - Target directory where scene_01.png ... scene_06.png will be saved
   * @param {function} [params.onProgress] - Callback (sceneIndex, totalScenes, sceneFile)
   * @returns {Promise<{success: boolean, generatedCount: number, scenePaths: string[]}>}
   */
  async generateStoryScenes({ story, storyDir, onProgress }) {
    if (!story || !storyDir) {
      throw new Error('generateStoryScenes requires both story object and storyDir');
    }

    const scenes = story.scenes || [];
    if (scenes.length === 0) {
      return { success: true, generatedCount: 0, scenePaths: [] };
    }

    // Determine which scenes are missing
    const missingScenes = [];
    const allPaths = [];
    for (const scene of scenes) {
      const pad = String(scene.scene_index).padStart(2, '0');
      const targetPath = path.join(storyDir, `scene_${pad}.png`);
      allPaths.push(targetPath);
      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size < 10000) {
        missingScenes.push({ ...scene, targetPath, pad });
      }
    }

    if (missingScenes.length === 0) {
      console.log(`[PlaywrightGemini] ⏭️ All ${scenes.length} scene images already exist in ${storyDir}. Skipping.`);
      return { success: true, generatedCount: 0, scenePaths: allPaths };
    }

    console.log(`[PlaywrightGemini] 🎨 Starting automated generation for ${missingScenes.length} missing scene(s) of "${story.title_en}"...`);

    const { context, page } = await this.launchBrowser();

    try {
      console.log(`[PlaywrightGemini] Navigating to ${this.geminiUrl}...`);
      await page.goto(this.geminiUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);

      const loggedIn = await this.checkLogin(page);
      if (!loggedIn) {
        throw new Error(
          `Google account is not authenticated in profile at "${this.profileDir}". Please launch with headful mode or log in to Gemini in Chrome.`
        );
      }
      console.log('[PlaywrightGemini] ✅ Google Gemini session authenticated and ready.');

      const chatInputSelector = 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]:not(.ql-clipboard), div[contenteditable="true"]:not(.ql-clipboard)';
      const getImageLocator = () => page.locator('generated-image img, model-response img:not([src*="og_image"]):not(.avatar), .image-container img:not(.avatar), message-content img:not(.avatar)');

      // If this is a fresh multi-scene run, we can prime the chat with the story's visual character sheet
      let chatPrimed = false;

      for (let i = 0; i < missingScenes.length; i++) {
        const scene = missingScenes[i];
        console.log(`\n------------------------------------------------------------`);
        console.log(`[PlaywrightGemini] 🎬 Generating Scene ${scene.scene_index}/${scenes.length} for "${story.title_en}"...`);
        console.log(`------------------------------------------------------------`);

        const initialCount = await getImageLocator().count();

        // 1. Locate and focus input
        const textarea = page.locator(chatInputSelector).first();
        await textarea.waitFor({ state: 'visible', timeout: 25000 });
        await textarea.click();
        await textarea.focus();

        // Clear input safely
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300 + Math.floor(Math.random() * 200));

        // Format prompt: Combine character sheet if first prompt, otherwise prepend explicit image directive
        let promptToSend = scene.image_prompt || '';
        if (!chatPrimed && story.character_sheet && !promptToSend.includes(story.character_sheet)) {
          promptToSend = `Generate an image: ${promptToSend} Maintain character design: ${story.character_sheet}`;
          chatPrimed = true;
        } else if (!promptToSend.toLowerCase().startsWith('generate an image')) {
          promptToSend = `Generate an image: ${promptToSend}`;
        }

        console.log(`[PlaywrightGemini] Typing prompt (${promptToSend.length} chars)...`);
        await page.keyboard.type(promptToSend, { delay: 18 + Math.floor(Math.random() * 15) });
        await page.waitForTimeout(600 + Math.floor(Math.random() * 400));

        // 2. Click send button or press Enter
        let sent = false;
        try {
          const runButton = page.locator('button[aria-label*="Send message"], button[aria-label*="Send"], button.send-button, mat-icon:has-text("send")').first();
          if (await runButton.isVisible({ timeout: 2000 })) {
            await runButton.click();
            sent = true;
          }
        } catch (_) {}
        if (!sent) {
          await page.keyboard.press('Enter');
        }

        console.log(`[PlaywrightGemini] Prompt sent. Waiting for Imagen 3 to render Scene ${scene.scene_index}...`);

        // 3. Wait for new image to appear
        const waitStartTime = Date.now();
        const maxWaitMs = 90000;
        let newImageFound = false;

        while (Date.now() - waitStartTime < maxWaitMs) {
          await page.waitForTimeout(2000);

          // Handle scroll-to-bottom button if present
          try {
            const scrollBottomBtn = page.locator('button[aria-label*="Scroll to bottom"], button.scroll-to-bottom-button, button:has(mat-icon:has-text("arrow_downward"))').first();
            if (await scrollBottomBtn.isVisible({ timeout: 250 })) {
              await scrollBottomBtn.click();
            }
          } catch (_) {}

          const currentCount = await getImageLocator().count();
          if (currentCount > initialCount) {
            console.log(`[PlaywrightGemini] 🖼️ New scene image detected! Total images in chat: ${currentCount}`);
            newImageFound = true;
            break;
          }

          const elapsedSec = Math.floor((Date.now() - waitStartTime) / 1000);
          if (elapsedSec > 0 && elapsedSec % 10 === 0) {
            console.log(`[PlaywrightGemini] Still rendering... (${elapsedSec}s elapsed)`);
          }
        }

        if (!newImageFound) {
          console.warn(`[PlaywrightGemini] ⚠️ Timeout waiting for new image for Scene ${scene.scene_index}. Attempting extraction from latest available image...`);
        }

        // 4. Locate the newly generated image element
        const outputImage = getImageLocator().last();
        await outputImage.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await outputImage.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await page.waitForTimeout(1200);

        // 5. Multi-tiered Pure Image Download Engine (NO UI SCREENSHOTS)
        let saved = false;

        // --- STRATEGY 1: Native "Download full size image" button network interception ---
        try {
          console.log(`[PlaywrightGemini] 📥 Triggering native full-size download for Scene ${scene.scene_index}...`);
          await outputImage.hover({ force: true });
          await page.waitForTimeout(600);

          let highResUrl = null;
          const onResponse = res => {
            const url = res.url();
            if (
              url.includes('googleusercontent.com/rd-gg') ||
              url.includes('googleusercontent.com/rd-gg-dl') ||
              (url.includes('googleusercontent.com') && (res.headers()['content-type'] || '').includes('image') && url.includes('=s0'))
            ) {
              highResUrl = url;
            }
          };
          page.on('response', onResponse);

          // Find container and button
          const container = outputImage.locator('xpath=ancestor::generated-image | ancestor::div[contains(@class, "image-container")] | ancestor::model-response').first();
          const downloadBtn = container.locator('button[aria-label*="Download full size" i], button[aria-label*="Download" i]').first();

          if (await downloadBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await downloadBtn.click({ force: true });
            
            // Wait up to 10 seconds for intercepted CDN response
            for (let s = 0; s < 10; s++) {
              await page.waitForTimeout(1000);
              if (highResUrl) break;
            }
          }
          page.off('response', onResponse);

          if (highResUrl) {
            console.log(`[PlaywrightGemini] Downloading native full-resolution image from CDN...`);
            let res = await page.request.get(highResUrl);
            if (res.ok()) {
              const buffer = await res.body();
              if (buffer && buffer.length > 20000) {
                fs.writeFileSync(scene.targetPath, buffer);
                const w = buffer.readUInt32BE(16);
                const h = buffer.readUInt32BE(20);
                console.log(`[PlaywrightGemini] ✅ SUCCESS (Native Full-Res Download): Saved scene_${scene.pad}.png (${(buffer.length / 1024 / 1024).toFixed(2)} MB, ${w}x${h} px)`);
                saved = true;
              }
            }
          }
        } catch (dlErr) {
          console.log(`[PlaywrightGemini] Native download note: ${dlErr.message}`);
        }

        // --- STRATEGY 2: Direct =s0 CDN URL fetch if src is http ---
        if (!saved) {
          try {
            const src = await outputImage.getAttribute('src');
            if (src && src.startsWith('http')) {
              const fullResSrc = src.replace(/=w\d+-h\d+.*$/, '=s0').replace(/=s\d+.*$/, '=s0');
              console.log('[PlaywrightGemini] Fetching raw image from Google CDN URL...');
              const res = await page.request.get(fullResSrc);
              if (res.ok()) {
                const buffer = await res.body();
                if (buffer.length > 20000) {
                  fs.writeFileSync(scene.targetPath, buffer);
                  console.log(`[PlaywrightGemini] ✅ SUCCESS (CDN =s0): Saved scene_${scene.pad}.png (${(buffer.length / 1024).toFixed(1)} KB)`);
                  saved = true;
                }
              }
            }
          } catch (cdnErr) {
            console.log(`[PlaywrightGemini] Direct CDN fetch note: ${cdnErr.message}`);
          }
        }

        // --- STRATEGY 3: In-Page Pure Canvas Export (Extracts raw image without any UI elements) ---
        if (!saved) {
          try {
            console.log('[PlaywrightGemini] Extracting pure image via in-page Canvas render...');
            const canvasData = await outputImage.evaluate((imgEl) => {
              const canvas = document.createElement('canvas');
              canvas.width = imgEl.naturalWidth || imgEl.width;
              canvas.height = imgEl.naturalHeight || imgEl.height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(imgEl, 0, 0);
              return {
                dataUrl: canvas.toDataURL('image/png'),
                width: canvas.width,
                height: canvas.height
              };
            });

            if (canvasData && canvasData.dataUrl && canvasData.dataUrl.includes('base64,')) {
              const buffer = Buffer.from(canvasData.dataUrl.split('base64,')[1], 'base64');
              if (buffer.length > 10000) {
                fs.writeFileSync(scene.targetPath, buffer);
                console.log(`[PlaywrightGemini] ✅ SUCCESS (Pure Canvas Export): Saved scene_${scene.pad}.png (${(buffer.length / 1024).toFixed(1)} KB, ${canvasData.width}x${canvasData.height} px)`);
                saved = true;
              }
            }
          } catch (canvasErr) {
            console.log(`[PlaywrightGemini] Canvas export note: ${canvasErr.message}`);
          }
        }

        if (!saved) {
          throw new Error(`Failed to download pure image asset for Scene ${scene.scene_index}`);
        }

        if (typeof onProgress === 'function') {
          onProgress({
            sceneIndex: scene.scene_index,
            total: scenes.length,
            targetPath: scene.targetPath
          });
        }

        // 6. Inter-scene cooldown to respect Imagen 3 rate limits
        if (i < missingScenes.length - 1) {
          const cooldownMs = this.cooldownMinMs + Math.floor(Math.random() * (this.cooldownMaxMs - this.cooldownMinMs));
          console.log(`[PlaywrightGemini] Cooldown pause ${(cooldownMs / 1000).toFixed(1)}s before Scene ${missingScenes[i + 1].scene_index}...`);
          await page.waitForTimeout(cooldownMs);
        }
      }

      console.log(`\n[PlaywrightGemini] 🎉 All ${missingScenes.length} scenes generated successfully for "${story.title_en}"!`);
      return {
        success: true,
        generatedCount: missingScenes.length,
        scenePaths: allPaths
      };
    } finally {
      await context.close().catch(() => {});
    }
  }

  /**
   * Generate a single image from a prompt (for single-shot API callers).
   */
  async generateSingleImage({ prompt, outputPath, width = 1080, height = 1920 }) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fakeStory = {
      title_en: 'Single Frame Generation',
      scenes: [{ scene_index: 1, image_prompt: prompt }]
    };

    const tempDir = dir;
    const tempScenePath = path.join(tempDir, 'scene_01.png');

    const res = await this.generateStoryScenes({
      story: fakeStory,
      storyDir: tempDir
    });

    if (fs.existsSync(tempScenePath) && tempScenePath !== outputPath) {
      fs.copyFileSync(tempScenePath, outputPath);
    }

    const stats = fs.statSync(outputPath);
    return {
      success: true,
      outputPath,
      fileSize: stats.size,
      dimensions: { width, height },
      provider: 'playwright-gemini'
    };
  }
}

module.exports = PlaywrightGeminiGenerator;
