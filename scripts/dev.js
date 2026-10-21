#!/usr/bin/env node

/**
 * 🚀 Gemini-Playwrite Monolithic Dev Runner
 * Starts both:
 *  1. FFmpeg Subtitling Microservice (Port 8787) -> services/ffmpeg/server.js
 *  2. Main Web Application & Pipeline (Port 3000) -> server.js
 *
 * Provides synchronized console logging and clean process management on exit.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT_DIR = path.resolve(__dirname, '..');
const FFMPEG_SERVER_PATH = path.join(ROOT_DIR, 'services', 'ffmpeg', 'server.js');
const APP_SERVER_PATH = path.join(ROOT_DIR, 'server.js');

// ANSI Colors for formatted console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m'
};

function log(service, color, data) {
  const lines = data.toString().split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length > 0) {
      console.log(`${color}[${service}]${colors.reset} ${line}`);
    }
  }
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, { timeout: 1000 }, (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

const processes = [];

function killProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', child.pid, '/T', '/F'], { stdio: 'ignore' });
    } catch (_) {
      try { child.kill('SIGKILL'); } catch (__) {}
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
  }
}

function cleanupAndExit() {
  console.log(`\n${colors.yellow}Shutting down all services gracefully...${colors.reset}`);
  for (const p of processes) {
    killProcess(p);
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
process.on('exit', () => {
  for (const p of processes) {
    killProcess(p);
  }
});

async function main() {
  console.log(`\n${colors.bright}${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}      🚀 GEMINI-PLAYWRITE MONOLITHIC DEV ENVIRONMENT          ${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}================================================================${colors.reset}`);
  console.log(`  ${colors.green}• Main Web App & Pipeline:${colors.reset}  http://localhost:3000`);
  console.log(`  ${colors.cyan}• FFmpeg Subtitling Service:${colors.reset} http://localhost:8787`);
  console.log(`  ${colors.magenta}• Local Chrome Profile:${colors.reset}      ./gemini_chrome_profile`);
  console.log(`${colors.gray}----------------------------------------------------------------${colors.reset}\n`);

  // 1. Start FFmpeg Service
  const ffmpegAlreadyRunning = await checkPortInUse(8787);
  if (ffmpegAlreadyRunning) {
    console.log(`${colors.cyan}[FFMPEG:8787]${colors.reset} FFmpeg service is already active on port 8787.`);
  } else {
    console.log(`${colors.cyan}[FFMPEG:8787]${colors.reset} Spawning internal FFmpeg microservice (services/ffmpeg/server.js)...`);
    const ffmpegProc = spawn(process.execPath, [FFMPEG_SERVER_PATH], {
      cwd: path.join(ROOT_DIR, 'services', 'ffmpeg'),
      env: { ...process.env, PORT: '8787', FFMPEG_PORT: '8787' }
    });

    ffmpegProc.stdout.on('data', (d) => log('FFMPEG:8787', colors.cyan, d));
    ffmpegProc.stderr.on('data', (d) => log('FFMPEG:8787', colors.red, d));
    ffmpegProc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.log(`${colors.red}[FFMPEG:8787] Exited with code ${code}${colors.reset}`);
      }
    });

    processes.push(ffmpegProc);
  }

  // 2. Start Main Application Web Server
  console.log(`${colors.green}[APP:3000]${colors.reset} Spawning Gemini-Playwrite Web Server (server.js)...`);
  const appProc = spawn(process.execPath, [APP_SERVER_PATH], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: process.env.PORT || '3000' }
  });

  appProc.stdout.on('data', (d) => log('APP:3000', colors.green, d));
  appProc.stderr.on('data', (d) => log('APP:3000', colors.red, d));
  appProc.on('exit', (code) => {
    console.log(`${colors.yellow}[APP:3000] App exited with code ${code}${colors.reset}`);
    cleanupAndExit();
  });

  processes.push(appProc);
}

main().catch((err) => {
  console.error(`${colors.red}Failed to start dev services:${colors.reset}`, err);
  process.exit(1);
});
