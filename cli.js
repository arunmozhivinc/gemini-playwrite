#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const GDriveService = require('./lib/gdrive');
const AntigravityService = require('./lib/antigravity');
const ImageGenerator = require('./lib/imageGenerator');
const Namer = require('./lib/namer');
const ManifestManager = require('./lib/manifest');

// Load config
const configPath = path.join(__dirname, 'config.json');
let config = {};
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const gdrive = new GDriveService({
  scriptPath: config.gdrive?.scriptPath,
  defaultFolderId: config.gdrive?.defaultFolderId
});

const antigravity = new AntigravityService({
  cliPath: config.antigravity?.cliPath,
  timeoutMs: config.antigravity?.timeoutMs
});

const imageGenerator = new ImageGenerator({
  provider: config.generator?.provider,
  defaultModel: config.generator?.defaultModel
});

const manifest = new ManifestManager(path.join(__dirname, 'output', 'manifest.json'));

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--status')) {
    console.log('\n--- Checking Antigravity & Google Drive Status ---');
    const [driveStatus, agyStatus] = await Promise.all([
      gdrive.getAuthStatus(),
      antigravity.checkStatus()
    ]);
    console.log('🤖 Antigravity CLI:', agyStatus.available ? '✅ Available' : `❌ ${agyStatus.error}`);
    console.log('☁️ Google Drive:', driveStatus.authenticated ? `✅ Connected (${driveStatus.email})` : '❌ Not Logged In');
    console.log('📁 Default Drive Folder:', config.gdrive?.defaultFolderName, `(${config.gdrive?.defaultFolderId})`);
    console.log('🎞️ Frames Generated:', manifest.getFrames().length);
    console.log('🔢 Next Index:', manifest.getNextIndex());
    process.exit(0);
  }

  // Parse arguments
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const prompt = getArg('--prompt') || getArg('-p');
  const batchFile = getArg('--batch') || getArg('-b');
  const pattern = getArg('--pattern') || config.naming?.defaultPattern || 'frame_{index:04d}.png';
  const folderId = getArg('--folder') || config.gdrive?.defaultFolderId;
  const scene = parseInt(getArg('--scene') || '1', 10);
  const shot = parseInt(getArg('--shot') || '1', 10);
  const noUpload = args.includes('--no-upload');
  const noExpand = args.includes('--no-expand');

  if (batchFile) {
    if (!fs.existsSync(batchFile)) {
      console.error(`Error: Batch file not found: ${batchFile}`);
      process.exit(1);
    }
    const content = fs.readFileSync(batchFile, 'utf8');
    let prompts = [];
    try {
      prompts = JSON.parse(content);
    } catch (e) {
      // Split by line
      prompts = content.split('\n').map(l => l.trim()).filter(Boolean);
    }

    console.log(`Processing ${prompts.length} prompts in batch...`);
    for (const item of prompts) {
      const p = typeof item === 'string' ? item : item.prompt;
      await processPrompt({
        prompt: p,
        pattern,
        folderId,
        scene: item.scene || scene,
        shot: item.shot || shot,
        noUpload,
        noExpand
      });
    }
    console.log('\n✅ Batch processing completed!');
    process.exit(0);
  }

  if (prompt) {
    await processPrompt({ prompt, pattern, folderId, scene, shot, noUpload, noExpand });
    process.exit(0);
  }

  printHelp();
}

async function processPrompt({ prompt, pattern, folderId, scene, shot, noUpload, noExpand }) {
  const index = manifest.getNextIndex();
  console.log(`\n======================================================`);
  console.log(`🎬 Processing Frame #${index} (Scene ${scene}, Shot ${shot})`);
  console.log(`📝 Original Prompt: "${prompt}"`);

  let finalPrompt = prompt;
  if (!noExpand) {
    process.stdout.write('🧠 Expanding with Antigravity AI...');
    const exp = await antigravity.expandPrompt(prompt, { scene, shot });
    finalPrompt = exp.expandedPrompt;
    console.log(' Done!');
    console.log(`✨ Expanded Prompt: "${finalPrompt}"`);
  }

  const filename = Namer.format(pattern, { index, scene, shot, prompt });
  const localOutputPath = path.join(__dirname, 'output', filename);

  process.stdout.write(`🎨 Generating Image (${filename})...`);
  await imageGenerator.generate({
    prompt: finalPrompt,
    outputPath: localOutputPath
  });
  console.log(' Done!');

  let driveResult = null;
  if (!noUpload) {
    process.stdout.write('☁️ Uploading to Google Drive...');
    try {
      driveResult = await gdrive.uploadFile(localOutputPath, folderId);
      console.log(' Done!');
      console.log(`🔗 Drive File ID: ${driveResult.fileId}`);
      console.log(`🌐 Web URL: ${driveResult.webViewLink}`);
    } catch (err) {
      console.log(' ⚠️ Upload failed:', err.message);
    }
  }

  manifest.addFrame({
    sequence: index,
    filename,
    localPath: `output/${filename}`,
    originalPrompt: prompt,
    expandedPrompt: finalPrompt,
    scene,
    shot,
    driveFolderId: folderId,
    driveFileId: driveResult?.fileId || null,
    driveWebViewLink: driveResult?.webViewLink || null,
    driveDownloadLink: driveResult?.downloadLink || null,
    timestamp: new Date().toISOString()
  });

  console.log(`💾 Recorded to manifest: output/manifest.json`);
}

function printHelp() {
  console.log(`
Antigravity Video Frame Pipeline CLI

Usage:
  node cli.js --prompt "Your image prompt" [options]
  node cli.js --batch prompts.json [options]
  node cli.js --status

Options:
  -p, --prompt <text>      Single prompt to generate
  -b, --batch <file>       JSON or text file containing list of prompts
  --pattern <template>     Filename template (e.g. frame_{index:04d}.png)
  --folder <id>            Google Drive Parent Folder ID
  --scene <num>            Scene number (default: 1)
  --shot <num>             Shot number (default: 1)
  --no-upload              Skip uploading to Google Drive
  --no-expand              Skip Antigravity prompt expansion
  --status                 Check Antigravity and Google Drive auth status
  -h, --help               Show this help message
`);
}

main().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
