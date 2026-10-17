const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

class GDriveService {
  constructor(options = {}) {
    this.binPath = options.binPath || 'C:\\Users\\Admin\\.gemini\\antigravity\\plugin_data\\gdrive\\bin\\gdrive-986250228.exe';
    this.scriptPath = options.scriptPath || 'C:\\Users\\Admin\\.gemini\\config\\plugins\\gdrive\\skills\\gdrive\\scripts\\gdrive.cmd';
    this.defaultFolderId = options.defaultFolderId || null;
  }

  /**
   * Run a gdrive command using execFile.
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  async runGdrive(args) {
    return new Promise((resolve, reject) => {
      // Find executable: prefer direct binary if it exists
      const targetExe = fs.existsSync(this.binPath) ? this.binPath : this.scriptPath;

      execFile(targetExe, args, { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          const errMessage = stderr ? stderr.trim() : error.message;
          return reject(new Error(`GDrive command failed: ${errMessage}`));
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Get authentication status of Google Drive customization.
   */
  async getAuthStatus() {
    try {
      const output = await this.runGdrive(['auth', 'status', '--json']);
      try {
        const json = JSON.parse(output);
        return {
          authenticated: json.authenticated === true,
          email: json.email || 'Connected Account',
          expiresAt: json.expires_at,
          tokenFile: json.token_file,
          raw: json
        };
      } catch (parseErr) {
        const isLogged = output.toLowerCase().includes('logged in');
        return {
          authenticated: isLogged,
          rawText: output
        };
      }
    } catch (err) {
      return {
        authenticated: false,
        error: err.message
      };
    }
  }

  /**
   * List files from a Drive folder.
   */
  async listFiles(folderId = null, max = 50) {
    const targetFolder = folderId || this.defaultFolderId;
    const args = ['readonly', 'ls'];
    if (targetFolder) {
      args.push(targetFolder);
    }
    args.push('--max', String(max), '--json');

    try {
      const output = await this.runGdrive(args);
      try {
        return JSON.parse(output);
      } catch (e) {
        return [];
      }
    } catch (err) {
      console.error('Error listing Drive files:', err.message);
      return [];
    }
  }

  /**
   * Create a folder in Google Drive.
   */
  async createFolder(folderName, parentFolderId = null) {
    const args = ['mutate', 'mkdir', folderName];
    if (parentFolderId) {
      args.push('--parent', parentFolderId);
    }
    args.push('--json');

    const output = await this.runGdrive(args);
    const match = output.match(/ID:\s*([a-zA-Z0-9_-]+)/);
    const folderId = match ? match[1] : null;

    return {
      folderName,
      folderId,
      rawOutput: output
    };
  }

  /**
   * Upload a local file to Google Drive.
   */
  async uploadFile(filePath, parentFolderId = null, mimeType = null) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const targetFolder = parentFolderId || this.defaultFolderId;
    const args = ['mutate', 'upload', filePath];
    if (targetFolder) {
      args.push('--parent', targetFolder);
    }
    if (mimeType) {
      args.push('--mime-type', mimeType);
    }
    args.push('--json');

    const output = await this.runGdrive(args);
    const match = output.match(/ID:\s*([a-zA-Z0-9_-]+)/);
    const fileId = match ? match[1] : null;

    const fileName = path.basename(filePath);
    const webViewLink = fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
    const downloadLink = fileId ? `https://drive.google.com/uc?id=${fileId}&export=download` : null;

    return {
      fileName,
      fileId,
      parentFolderId: targetFolder,
      webViewLink,
      downloadLink,
      rawOutput: output
    };
  }

  /**
   * Copy a file in Google Drive to a new name and/or destination folder.
   */
  async copyFile(fileId, newName, parentFolderId = null) {
    const args = ['mutate', 'cp', fileId, newName];
    if (parentFolderId) {
      args.push('--parent', parentFolderId);
    }
    const output = await this.runGdrive(args);
    const match = output.match(/ID:\s*([a-zA-Z0-9_-]+)/);
    const newFileId = match ? match[1] : null;
    return {
      name: newName,
      fileId: newFileId,
      webViewLink: newFileId ? `https://drive.google.com/file/d/${newFileId}/view` : null,
      raw: output
    };
  }

  /**
   * Search files or folders by name.
   */
  async search(query) {
    try {
      const output = await this.runGdrive(['readonly', 'search', '--name-contains', query, '--json']);
      return JSON.parse(output);
    } catch (e) {
      return [];
    }
  }
}

module.exports = GDriveService;
