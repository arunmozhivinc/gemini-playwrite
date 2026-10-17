const fs = require('fs');
const path = require('path');

class ManifestManager {
  constructor(manifestPath) {
    this.manifestPath = manifestPath || path.join(__dirname, '..', 'output', 'manifest.json');
    this.ensureManifest();
  }

  ensureManifest() {
    const dir = path.dirname(this.manifestPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.manifestPath)) {
      const initial = {
        version: '1.0.0',
        pipeline: 'antigravity-video-keyframes',
        updatedAt: new Date().toISOString(),
        totalFrames: 0,
        driveFolderId: null,
        frames: []
      };
      fs.writeFileSync(this.manifestPath, JSON.stringify(initial, null, 2));
    }
  }

  read() {
    this.ensureManifest();
    try {
      const data = fs.readFileSync(this.manifestPath, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return { totalFrames: 0, frames: [] };
    }
  }

  write(data) {
    data.updatedAt = new Date().toISOString();
    data.totalFrames = data.frames ? data.frames.length : 0;
    fs.writeFileSync(this.manifestPath, JSON.stringify(data, null, 2));
  }

  addFrame(frameData) {
    const manifest = this.read();
    if (!manifest.frames) {
      manifest.frames = [];
    }

    // Check if filename already exists; if so, update it, otherwise push
    const existingIndex = manifest.frames.findIndex(f => f.filename === frameData.filename);
    if (existingIndex >= 0) {
      manifest.frames[existingIndex] = { ...manifest.frames[existingIndex], ...frameData };
    } else {
      manifest.frames.push(frameData);
    }

    if (frameData.driveFolderId) {
      manifest.driveFolderId = frameData.driveFolderId;
    }

    this.write(manifest);
    return manifest;
  }

  getFrames() {
    const manifest = this.read();
    return manifest.frames || [];
  }

  getNextIndex() {
    const frames = this.getFrames();
    if (frames.length === 0) return 1;
    const maxSeq = Math.max(...frames.map(f => f.sequence || 0));
    return maxSeq + 1;
  }

  /**
   * Export frames to CSV format for spreadsheets or external pipelines.
   */
  exportCSV() {
    const frames = this.getFrames();
    const headers = ['Sequence', 'Filename', 'Drive_File_ID', 'Drive_Web_Link', 'Scene', 'Shot', 'Prompt'];
    const rows = frames.map(f => [
      f.sequence || '',
      `"${f.filename || ''}"`,
      f.driveFileId || '',
      `"${f.driveWebViewLink || ''}"`,
      f.scene || 1,
      f.shot || 1,
      `"${(f.originalPrompt || '').replace(/"/g, '""')}"`
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  /**
   * Export bash / ffmpeg script for assembling frames into video.
   */
  exportVideoScript(fps = 24, outputFilename = 'generated_video.mp4') {
    return [
      '# Antigravity Video Assembly Script',
      '# Stitch generated frames into MP4 video with ffmpeg',
      `ffmpeg -framerate ${fps} -pattern_type glob -i "*.png" -c:v libx264 -pix_fmt yuv420p ${outputFilename}`,
      ''
    ].join('\n');
  }
}

module.exports = ManifestManager;
