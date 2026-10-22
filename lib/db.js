const { Pool } = require('pg');

class DatabaseService {
  constructor(options = {}) {
    this.pool = new Pool({
      host: options.host || process.env.PGHOST || 'localhost',
      port: parseInt(options.port || process.env.PGPORT || '5432', 10),
      user: options.user || process.env.PGUSER || 'postgres',
      password: options.password || process.env.PGPASSWORD || 'password',
      database: options.database || process.env.PGDATABASE || 'postgres',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000
    });

    this.connected = false;
    this.initPromise = this.initSchema();
  }

  async initSchema() {
    try {
      const client = await this.pool.connect();
      try {
        // 1. Stories Table (Exact user schema)
        await client.query(`
          CREATE TABLE IF NOT EXISTS stories (
            story_id VARCHAR(255) PRIMARY KEY,
            title_en TEXT,
            title_ta TEXT,
            theme TEXT,
            moral TEXT,
            status VARCHAR(50) DEFAULT 'awaiting_approval',
            folder_url TEXT,
            video_en_url TEXT,
            video_ta_url TEXT,
            youtube_en_id VARCHAR(100),
            youtube_ta_id VARCHAR(100),
            error_message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );

          -- Safe migration for existing tables
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS moral TEXT;
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'awaiting_approval';
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS folder_url TEXT;
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS video_en_url TEXT;
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS video_ta_url TEXT;
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS youtube_en_id VARCHAR(100);
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS youtube_ta_id VARCHAR(100);
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS error_message TEXT;
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS topic TEXT;
          ALTER TABLE stories ADD COLUMN IF NOT EXISTS protagonist VARCHAR(100);
        `);

        // 2. Pipeline Logs Table
        await client.query(`
          CREATE TABLE IF NOT EXISTS pipeline_logs (
            id SERIAL PRIMARY KEY,
            story_id VARCHAR(255),
            stage VARCHAR(50) NOT NULL,
            level VARCHAR(20) DEFAULT 'info',
            message TEXT NOT NULL,
            details JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_pipeline_logs_story ON pipeline_logs(story_id);
          CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created ON pipeline_logs(created_at DESC);
        `);

        // 3. File Uploads Table
        await client.query(`
          CREATE TABLE IF NOT EXISTS file_uploads (
            id SERIAL PRIMARY KEY,
            story_id VARCHAR(255) NOT NULL,
            file_name VARCHAR(255) NOT NULL,
            file_type VARCHAR(50) NOT NULL,
            file_size BIGINT DEFAULT 0,
            local_path TEXT,
            destination VARCHAR(50) NOT NULL,
            remote_id TEXT,
            remote_url TEXT,
            status VARCHAR(50) DEFAULT 'pending',
            error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_file_uploads_story ON file_uploads(story_id);
          CREATE INDEX IF NOT EXISTS idx_file_uploads_dest ON file_uploads(destination);
        `);

        this.connected = true;
        console.log('[PostgreSQL] Connected and schema initialized successfully.');
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn('[PostgreSQL] Connection / Schema initialization warning:', err.message);
      this.connected = false;
    }
  }

  // --- Story Operations ---

  async upsertStory(record) {
    if (!record || !record.story_id) return null;
    try {
      await this.initPromise;

      const moral = record.moral || record.moral_en || '';
      const status = record.status || record.overall_status || 'awaiting_approval';
      const folderUrl = record.folder_url || '';
      const videoEnUrl = record.video_en_url || '';
      const videoTaUrl = record.video_ta_url || '';
      const youtubeEnId = record.youtube_en_id || null;
      const youtubeTaId = record.youtube_ta_id || null;
      const errorMessage = record.error_message || null;
      const topic = record.topic || '';
      const protagonist = record.protagonist || '';

      const query = `
        INSERT INTO stories (
          story_id, title_en, title_ta, theme, moral, status,
          folder_url, video_en_url, video_ta_url, youtube_en_id, youtube_ta_id, error_message,
          topic, protagonist, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
        )
        ON CONFLICT (story_id) DO UPDATE SET
          title_en = COALESCE(NULLIF(EXCLUDED.title_en, ''), stories.title_en),
          title_ta = COALESCE(NULLIF(EXCLUDED.title_ta, ''), stories.title_ta),
          theme = COALESCE(NULLIF(EXCLUDED.theme, ''), stories.theme),
          moral = COALESCE(NULLIF(EXCLUDED.moral, ''), stories.moral),
          status = COALESCE(NULLIF(EXCLUDED.status, ''), stories.status),
          folder_url = COALESCE(NULLIF(EXCLUDED.folder_url, ''), stories.folder_url),
          video_en_url = COALESCE(NULLIF(EXCLUDED.video_en_url, ''), stories.video_en_url),
          video_ta_url = COALESCE(NULLIF(EXCLUDED.video_ta_url, ''), stories.video_ta_url),
          youtube_en_id = COALESCE(EXCLUDED.youtube_en_id, stories.youtube_en_id),
          youtube_ta_id = COALESCE(EXCLUDED.youtube_ta_id, stories.youtube_ta_id),
          error_message = EXCLUDED.error_message,
          topic = COALESCE(NULLIF(EXCLUDED.topic, ''), stories.topic),
          protagonist = COALESCE(NULLIF(EXCLUDED.protagonist, ''), stories.protagonist),
          updated_at = NOW()
        RETURNING *;
      `;
      const res = await this.pool.query(query, [
        record.story_id,
        record.title_en || '',
        record.title_ta || '',
        record.theme || '',
        moral,
        status,
        folderUrl,
        videoEnUrl,
        videoTaUrl,
        youtubeEnId,
        youtubeTaId,
        errorMessage,
        topic,
        protagonist
      ]);
      return res.rows[0];
    } catch (e) {
      console.warn('[PostgreSQL] upsertStory error:', e.message);
      return null;
    }
  }

  async getAllStories() {
    try {
      await this.initPromise;
      const res = await this.pool.query(`
        SELECT
          story_id,
          title_en,
          title_ta,
          theme,
          moral,
          status,
          folder_url,
          video_en_url,
          video_ta_url,
          youtube_en_id,
          youtube_ta_id,
          error_message,
          topic,
          protagonist,
          created_at,
          updated_at
        FROM stories
        ORDER BY created_at DESC;
      `);
      return res.rows;
    } catch (e) {
      console.warn('[PostgreSQL] getAllStories error:', e.message);
      return [];
    }
  }

  async getExistingStoryIdentifiers() {
    try {
      await this.initPromise;
      const res = await this.pool.query(`
        SELECT story_id, title_en, title_ta, theme, moral, topic, protagonist FROM stories;
      `);
      const identifiers = [];
      for (const row of res.rows) {
        if (row.story_id) identifiers.push(row.story_id);
        if (row.title_en) identifiers.push(row.title_en);
        if (row.title_ta) identifiers.push(row.title_ta);
        if (row.theme) identifiers.push(row.theme);
        if (row.moral) identifiers.push(row.moral);
        if (row.topic) identifiers.push(row.topic);
        if (row.protagonist) identifiers.push(row.protagonist);
      }
      return identifiers;
    } catch (e) {
      console.warn('[PostgreSQL] getExistingStoryIdentifiers error:', e.message);
      return [];
    }
  }

  async findStoryByTopic(topic) {
    if (!topic) return null;
    try {
      await this.initPromise;
      const cleanTopic = topic.trim().toLowerCase();
      const res = await this.pool.query(
        `SELECT * FROM stories 
         WHERE LOWER(story_id) ILIKE $1 
            OR LOWER(title_en) ILIKE $1 
            OR LOWER(theme) ILIKE $1 
            OR LOWER(moral) ILIKE $1
         ORDER BY created_at DESC LIMIT 1`,
        [`%${cleanTopic}%`]
      );
      return res.rows[0] || null;
    } catch (e) {
      console.warn('[PostgreSQL] findStoryByTopic error:', e.message);
      return null;
    }
  }

  async deleteStory(storyId) {
    if (!storyId) return false;
    try {
      await this.initPromise;
      await this.pool.query('DELETE FROM pipeline_logs WHERE story_id = $1', [storyId]);
      await this.pool.query('DELETE FROM file_uploads WHERE story_id = $1', [storyId]);
      const res = await this.pool.query('DELETE FROM stories WHERE story_id = $1', [storyId]);
      return res.rowCount > 0;
    } catch (e) {
      console.warn('[PostgreSQL] deleteStory error:', e.message);
      return false;
    }
  }

  // --- Pipeline Logs ---

  async log(storyId, stage, level, message, details = {}) {
    try {
      await this.initPromise;
      const query = `
        INSERT INTO pipeline_logs (story_id, stage, level, message, details)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
      `;
      await this.pool.query(query, [
        storyId || null,
        stage || 'general',
        level || 'info',
        message,
        JSON.stringify(details)
      ]);
    } catch (e) {
      // Fallback silently if DB is temporarily unreachable
      console.warn('[PostgreSQL] log error:', e.message);
    }
  }

  async getRecentLogs(limit = 100, storyId = null) {
    try {
      await this.initPromise;
      let query = `SELECT * FROM pipeline_logs`;
      const params = [];
      if (storyId) {
        query += ` WHERE story_id = $1`;
        params.push(storyId);
      }
      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const res = await this.pool.query(query, params);
      return res.rows;
    } catch (e) {
      console.warn('[PostgreSQL] getRecentLogs error:', e.message);
      return [];
    }
  }

  // --- File Uploads ---

  async recordFileUpload({
    storyId,
    fileName,
    fileType,
    fileSize = 0,
    localPath = null,
    destination,
    remoteId = null,
    remoteUrl = null,
    status = 'completed',
    error = null
  }) {
    try {
      await this.initPromise;
      const query = `
        INSERT INTO file_uploads (
          story_id, file_name, file_type, file_size, local_path, destination, remote_id, remote_url, status, error, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        RETURNING *;
      `;
      const res = await this.pool.query(query, [
        storyId,
        fileName,
        fileType,
        fileSize,
        localPath,
        destination,
        remoteId,
        remoteUrl,
        status,
        error
      ]);
      return res.rows[0];
    } catch (e) {
      console.warn('[PostgreSQL] recordFileUpload error:', e.message);
      return null;
    }
  }

  async getFileUploads(storyId = null, limit = 50) {
    try {
      await this.initPromise;
      let query = `SELECT * FROM file_uploads`;
      const params = [];
      if (storyId) {
        query += ` WHERE story_id = $1`;
        params.push(storyId);
      }
      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const res = await this.pool.query(query, params);
      return res.rows;
    } catch (e) {
      console.warn('[PostgreSQL] getFileUploads error:', e.message);
      return [];
    }
  }
}

module.exports = DatabaseService;
