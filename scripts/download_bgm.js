/**
 * Pre-download all BGM tracks from public domain sources.
 * Run once: node scripts/download_bgm.js
 */
const BgmSelector = require('../lib/bgmSelector');
const path = require('path');

async function main() {
  console.log('[BGM Predownload] Starting download of all 8 mood tracks...');
  const bgm = new BgmSelector({
    assetsDir: path.join(__dirname, '..', 'assets', 'bgm'),
    autoDownload: true
  });

  const themes = [
    { theme: 'adventure', topic: 'courage brave' },
    { theme: 'kindness', topic: 'love gentle' },
    { theme: 'friendship', topic: 'playful fun happy' },
    { theme: 'nature', topic: 'forest animal bird' },
    { theme: 'learning', topic: 'discover wisdom' },
    { theme: 'festival', topic: 'celebration dance colorful' },
    { theme: 'sad loss', topic: 'emotional tender comfort' },
    { theme: '', topic: '' }  // default
  ];

  for (const story of themes) {
    try {
      const track = await bgm.selectForStory(story);
      console.log('[BGM]', story.theme || 'default', '->', track || 'FAILED');
    } catch (e) {
      console.error('[BGM] Error:', e.message);
    }
  }

  const catalog = bgm.getCatalog();
  const available = catalog.filter(m => m.available).length;
  console.log(`\n[BGM Predownload] Complete: ${available}/${catalog.length} tracks ready.`);
}

main().catch(console.error);

