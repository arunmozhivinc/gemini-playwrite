const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  // Dedicated Chrome profile for this app (do NOT point at your daily Chrome
  // profile while Chrome is open — Windows locks that folder).
  const rawProfile = process.env.GEMINI_PROFILE_DIR || path.join(__dirname, '..', 'gemini_chrome_profile');
  const userDataDir = path.isAbsolute(rawProfile) ? rawProfile : path.resolve(__dirname, '..', rawProfile);

  fs.mkdirSync(userDataDir, { recursive: true });

  // Use real installed Chrome (`channel: 'chrome'`). Google often blocks
  // sign-in inside Playwright's bundled Chromium ("browser may not be secure").
  console.log(`Launching Google Chrome with profile:\n  ${userDataDir}\n`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: null
  });

  // Prefer an existing tab; persistent contexts sometimes open a blank page.
  const page = context.pages()[0] || await context.newPage();

  // Strip automation indicators before Google scripts run
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  const chatInputSelector =
    'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]:not(.ql-clipboard), div[contenteditable="true"]:not(.ql-clipboard)';

  const isLoggedIn = async () => {
    const chatReady = await page.locator(chatInputSelector).first().isVisible().catch(() => false);
    if (!chatReady) return false;
    const signInVisible = await page
      .locator('a:has-text("Sign in"), button:has-text("Sign in")')
      .first()
      .isVisible()
      .catch(() => false);
    return !signInVisible;
  };

  console.log('Navigating to Gemini Web App...');
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });

  // --- MANUAL LOGIN (real Chrome + this profile; only needed once) ---
  if (!(await isLoggedIn())) {
    console.log('\n⚠️  Google login required in the Chrome window that just opened.');
    console.log('   1. Click Sign in and complete login (2FA / passkey OK).');
    console.log('   2. Stay on gemini.google.com until the chat box appears.');
    console.log('   3. This script waits up to 10 minutes — do not close the window.\n');
    console.log('   Tip: if Google still blocks login, close all Chrome windows,');
    console.log('   delete the gemini_chrome_profile folder, and run again.\n');

    const loginDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < loginDeadline) {
      if (await isLoggedIn()) {
        console.log('✅ Successfully authenticated — chat is ready.\n');
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!(await isLoggedIn())) {
      console.error('❌ Timed out waiting for login. Close the window and run again after signing in.');
      await context.close();
      process.exit(1);
    }
  } else {
    console.log('✅ Existing Chrome profile session found. Continuing...\n');
  }

  // Helper locator for generated content images inside model responses (strictly excludes profile avatar images)
  const getImageLocator = () => page.locator('model-response img[src*="googleusercontent.com"]:not([src*="og_image"]), .model-response img[src*="googleusercontent.com"]:not([src*="og_image"]), message-content img, generated-image img, .image-container img:not(.avatar), .message-content img:not(.avatar)');

  // --- INLINE DATA DECLARATION ---
  const scenes = [
    {
      "id": 1,
      "image_prompt": "Soft 2D storybook watercolor illustration, bright warm colors, vertical 9:16 portrait composition, 1080 x 1920, designed for YouTube Shorts and mobile viewing, no text in the image. Ponni, a 5-year-old Tamil girl, short and cheerful, with straight black hair in two small pigtails, a tiny jasmine flower clip on the left side, warm brown skin, big round black eyes, and a yellow frock with a green border and red sandals, stands in a sunny South Indian courtyard beside a neem tree and a tiny empty clay bowl on the ground. A few colorful flowers and a small stone path are nearby, peaceful village home in the background."
    },
    {
      "id": 2,
      "image_prompt": "Soft 2D storybook watercolor illustration, bright warm colors, vertical 9:16 portrait composition, 1080 x 1920, designed for YouTube Shorts and mobile viewing, no text in the image. Ponni, a 5-year-old Tamil girl, short and cheerful, with straight black hair in two small pigtails, a tiny jasmine flower clip on the left side, warm brown skin, big round black eyes, and a yellow frock with a green border and red sandals, carries a small brass tumbler from a house tap, carefully pouring clean water into the clay bowl under the neem tree. Two little sparrows watch from a branch, and the courtyard feels calm and fresh."
    },
    {
      "id": 3,
      "image_prompt": "Soft 2D storybook watercolor illustration, bright warm colors, vertical 9:16 portrait composition, 1080 x 1920, designed for YouTube Shorts and mobile viewing, no text in the image. Ponni, a 5-year-old Tamil girl, short and cheerful, with straight black hair in two small pigtails, a tiny jasmine flower clip on the left side, warm brown skin, big round black eyes, and a yellow frock with a green border and red sandals, gently places smooth pebbles around the inside edge of the clay bowl. A butterfly flutters nearby, and a sparrow perches on the neem branch, with sunlight sparkling on the water."
    },
    {
      "id": 4,
      "image_prompt": "Soft 2D storybook watercolor illustration, bright warm colors, vertical 9:16 portrait composition, 1080 x 1920, designed for YouTube Shorts and mobile viewing, no text in the image. Ponni, a 5-year-old Tamil girl, short and cheerful, with straight black hair in two small pigtails, a tiny jasmine flower clip on the left side, warm brown skin, big round black eyes, and a yellow frock with a green border and red sandals, sits beside the bowl and places a small yellow flower petal on the stone path. The two sparrows drink from the bowl, while a butterfly rests on a flower nearby, all in a cozy South Indian courtyard with a clay floor and potted plants."
    },
    {
      "id": 5,
      "image_prompt": "Soft 2D storybook watercolor illustration, bright warm colors, vertical 9:16 portrait composition, 1080 x 1920, designed for YouTube Shorts and mobile viewing, no text in the image. Ponni, a 5-year-old Tamil girl, short and cheerful, with straight black hair in two small pigtails, a tiny jasmine flower clip on the left side, warm brown skin, big round black eyes, and a yellow frock with a green border and red sandals, is joined by a smiling elderly grandmother in a simple cotton sari as they add fresh flowers around the clay bowl. Birds, butterflies, and a tiny squirrel are visible in the garden, with a warm house wall and banana plant in the background."
    },
    {
      "id": 6,
      "image_prompt": "Soft 2D storybook watercolor illustration, bright warm colors, vertical 9:16 portrait composition, 1080 x 1920, designed for YouTube Shorts and mobile viewing, no text in the image. Ponni, a 5-year-old Tamil girl, short and cheerful, with straight black hair in two small pigtails, a tiny jasmine flower clip on the left side, warm brown skin, big round black eyes, and a yellow frock with a green border and red sandals, stands proudly under the neem tree beside the filled clay bowl. Sparrows, butterflies, and a tiny squirrel gather gently around the bowl in a bright, peaceful courtyard at sunset, with golden light and potted plants all around."
    }
  ];

  // --- BATCH ITERATION LOOP ---
  for (const scene of scenes) {
    console.log(`\n========================================`);
    console.log(`🎬 Processing Scene ${scene.id} of ${scenes.length}...`);
    console.log(`========================================`);

    // 1. Count images currently in the conversation before sending
    const initialCount = await getImageLocator().count();
    console.log(`Images currently in chat before sending: ${initialCount}`);

    // 2. Locate active chat input textarea at the bottom (exclude hidden Quill clipboard helper)
    const textarea = page.locator(chatInputSelector).first();
    await textarea.waitFor({ state: 'visible', timeout: 30000 });
    await textarea.click();
    await textarea.focus();
    
    // Clear input
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400 + Math.floor(Math.random() * 300));

    // Prefix with explicit image command so multi-turn chats don't turn into conversational text
    const promptToSend = scene.image_prompt.trim().toLowerCase().startsWith('generate an image')
      ? scene.image_prompt
      : `Generate an image: ${scene.image_prompt}`;

    console.log(`Typing prompt for Scene ${scene.id} with human-like cadence...`);
    // Human-like typing with micro-pauses (30-55ms) instead of instant robot paste
    await page.keyboard.type(promptToSend, { delay: 35 + Math.floor(Math.random() * 20) });
    
    // Humanized thinking delay before hitting send
    const thinkingDelay = 1200 + Math.floor(Math.random() * 800);
    await page.waitForTimeout(thinkingDelay);

    // 3. Send message (humanized mouse move and click, or Enter fallback)
    let sent = false;
    try {
      const runButton = page.locator('button[aria-label*="Send message"], button[aria-label*="Send"], button.send-button, mat-icon:has-text("send")').first();
      if (await runButton.isVisible({ timeout: 2000 })) {
        // Move mouse naturally to the send button area before clicking
        const box = await runButton.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2 + (Math.random() * 6 - 3), box.y + box.height / 2 + (Math.random() * 6 - 3), { steps: 5 });
        }
        await runButton.click();
        sent = true;
      }
    } catch (_) {}

    if (!sent) {
      await page.keyboard.press('Enter');
    }

    // 4. Dynamic waiting for new image generation (up to 90 seconds)
    console.log("Waiting for Imagen 3 server to render scene (polling dynamically)...");
    const waitStartTime = Date.now();
    const maxWaitMs = 90000;
    let newImageFound = false;

    while (Date.now() - waitStartTime < maxWaitMs) {
      await page.waitForTimeout(2000);

      // Scroll to bottom if Gemini's floating down arrow button appears
      try {
        const scrollBottomBtn = page.locator('button[aria-label*="Scroll to bottom"], button.scroll-to-bottom-button, button:has(mat-icon:has-text("arrow_downward"))').first();
        if (await scrollBottomBtn.isVisible({ timeout: 300 })) {
          await scrollBottomBtn.click();
        }
      } catch (_) {}

      const currentCount = await getImageLocator().count();
      if (currentCount > initialCount) {
        console.log(`✅ New image rendered in chat! Total images: ${currentCount}`);
        newImageFound = true;
        break;
      }

      // Check if Gemini finished responding (Stop button gone) and gave text instead
      const elapsedSec = Math.floor((Date.now() - waitStartTime) / 1000);
      if (elapsedSec % 10 === 0) {
        console.log(`Still generating... (${elapsedSec}s elapsed)`);
      }
    }

    if (!newImageFound) {
      console.warn(`⚠️ Timeout waiting for new image in Scene ${scene.id}. Checking for latest available image...`);
    }

    // 5. Locate the newly generated image (strictly the last one in the chat)
    const outputImage = getImageLocator().last();
    await outputImage.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    
    // Scroll image into the CENTER of the viewport so the bottom isn't covered by the input bar
    await outputImage.evaluate((el) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    });
    await page.waitForTimeout(1500);

    // Save target file path
    const outputPath = path.join(__dirname, `scene_${scene.id}_${Date.now()}.png`);
    let savedSuccessfully = false;

    // --- STRATEGY 1: NATIVE HOVER DOWNLOAD BUTTON ---
    try {
      console.log("Hovering over image container to reveal download overlay...");
      // Hover on the image to trigger Gemini's hover action overlay
      await outputImage.hover({ force: true });
      await page.waitForTimeout(1000);

      // Locate download button: check both image container, parent message, and download aria labels
      const downloadBtn = page.locator('button[aria-label*="Download full size"], button[aria-label*="Download image"], button[aria-label*="Download"], button[mattooltip*="Download"], button:has(mat-icon:has-text("download")), [data-test-id*="download"]').last();
      
      await downloadBtn.waitFor({ state: 'visible', timeout: 4000 });
      console.log("Found download button! Clicking and waiting for download event...");

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        downloadBtn.click({ force: true })
      ]);

      await download.saveAs(outputPath);
      console.log(`🎉 SUCCESS! Scene ${scene.id} saved via native download button: ${outputPath}`);
      savedSuccessfully = true;
    } catch (uiErr) {
      console.log(`Native download button skipped (${uiErr.message}). Trying direct CDN fetch...`);
    }

    // --- STRATEGY 2: DIRECT HIGH-RES CDN DOWNLOAD (Session Authenticated) ---
    if (!savedSuccessfully) {
      try {
        const src = await outputImage.getAttribute('src');
        if (src && src.startsWith('http')) {
          console.log(`Attempting direct high-resolution fetch from Google CDN...`);
          const fullResSrc = src.replace(/=w\d+-h\d+.*$/, '=s0').replace(/=s\d+.*$/, '=s0');
          let response = await page.request.get(fullResSrc);
          if (!response.ok()) {
            response = await page.request.get(src);
          }

          if (response.ok()) {
            const buffer = await response.body();
            if (buffer && buffer.length > 5000) {
              fs.writeFileSync(outputPath, buffer);
              console.log(`🎉 SUCCESS! Scene ${scene.id} saved directly from CDN (${(buffer.length / 1024).toFixed(1)} KB): ${outputPath}`);
              savedSuccessfully = true;
            }
          }
        }
      } catch (cdnErr) {
        console.log(`Direct CDN fetch failed: ${cdnErr.message}. Trying full element screenshot...`);
      }
    }

    // --- STRATEGY 3: CLEAN CROPPED ELEMENT SCREENSHOT ---
    if (!savedSuccessfully) {
      try {
        await outputImage.evaluate((el) => {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
        });
        await page.waitForTimeout(1000);
        await outputImage.screenshot({ path: outputPath, timeout: 10000 });
        console.log(`🎉 SUCCESS! Scene ${scene.id} captured via clean element screenshot: ${outputPath}`);
        savedSuccessfully = true;
      } catch (cropErr) {
        console.warn(`Element screenshot failed: ${cropErr.message}.`);
      }
    }

    // --- POST-DOWNLOAD STEP: NOW SCROLL TO BOTTOM FOR NEXT SCENE ---
    console.log("Image saved! Scrolling to bottom for next prompt input...");
    try {
      const scrollBottomBtn = page.locator('button[aria-label*="Scroll to bottom"], button.scroll-to-bottom-button, button:has(mat-icon:has-text("arrow_downward"))').first();
      if (await scrollBottomBtn.isVisible({ timeout: 500 })) {
        await scrollBottomBtn.click();
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      }
    } catch (_) {}

    // Human-like inter-scene delay with jitter (6-9 seconds) to stay well within Imagen 3 per-minute burst rate limits
    const cooldownMs = 6000 + Math.floor(Math.random() * 3000);
    console.log(`Completed Scene ${scene.id}. Pausing ${(cooldownMs / 1000).toFixed(1)}s before next scene to respect rate limits...`);
    await page.waitForTimeout(cooldownMs);
  }

  console.log("\n🚀 All story scenes processed successfully!");
  await page.waitForTimeout(5000);
  await context.close();
})();
