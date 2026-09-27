import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const NOW = '2026-09-27T00:00:00.000Z';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first(column) {
    const row = this.db.sqlite.prepare(this.sql).get(...this.params) || null;
    return column && row ? row[column] : row;
  }
  async all() { return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.params), meta: { changes: 0 } }; }
  async run() { return this.runSync(); }
  runSync() {
    this.db.beforeRun?.(this.sql, this.params);
    const info = this.db.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export class DualPreviewD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT,
        expires_at TEXT, revoked_at TEXT, last_used_at TEXT);
      CREATE TABLE notebooks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE notebook_members (notebook_id TEXT REFERENCES notebooks(id), user_id TEXT REFERENCES users(id),
        role TEXT, revoked_at TEXT);
      CREATE TABLE spreads (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id), number INTEGER,
        title TEXT, revision INTEGER, seq INTEGER, deleted_at TEXT, current_photo_id TEXT,
        updated_at TEXT, updated_by TEXT);
      CREATE TABLE change_seq (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL);
      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        spread_id TEXT NOT NULL REFERENCES spreads(id),
        version INTEGER NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'telegram',
        storage_object_id TEXT,
        telegram_message_id INTEGER,
        telegram_file_id TEXT,
        telegram_file_unique_id TEXT,
        mime_type TEXT,
        file_size INTEGER,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ocr_text TEXT,
        ocr_status TEXT NOT NULL DEFAULT 'none',
        ocr_updated_at TEXT,
        client_upload_id TEXT UNIQUE
      );
      CREATE UNIQUE INDEX ux_photos_spread_version ON photos(spread_id, version);
      CREATE UNIQUE INDEX ux_photos_current ON photos(spread_id) WHERE is_current=1;
      CREATE TABLE uploads (
        client_upload_id TEXT PRIMARY KEY,
        photo_id TEXT NOT NULL REFERENCES photos(id),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE history (id TEXT PRIMARY KEY, notebook_id TEXT, entity TEXT, entity_id TEXT, user_id TEXT,
        action TEXT, created_at TEXT);
      CREATE TABLE activity_events (id TEXT PRIMARY KEY, notebook_id TEXT, spread_id TEXT, entity TEXT,
        entity_id TEXT, actor_user_id TEXT, action TEXT, entity_revision_before INTEGER,
        entity_revision_after INTEGER, old_value TEXT, new_value TEXT, payload_json TEXT,
        created_at TEXT, seq INTEGER, client_ref TEXT);
      CREATE UNIQUE INDEX ux_activity_events_idempotency ON activity_events(actor_user_id, client_ref);
      CREATE TABLE photo_previews (photo_id TEXT PRIMARY KEY REFERENCES photos(id), preview_base64 TEXT,
        mime_type TEXT, created_at TEXT);
      INSERT INTO users (id, display_name) VALUES ('u1','Owner');
      INSERT INTO notebooks (id,owner_id) VALUES ('nbE','u1');
      INSERT INTO notebook_members (notebook_id,user_id,role) VALUES ('nbE','u1','OWNER');
      INSERT INTO spreads (id,notebook_id,number,title,revision,seq,current_photo_id)
        VALUES ('srv-spE','nbE',1,'Spread',1,2,NULL);
      INSERT INTO change_seq (seq,at) VALUES (42,'${NOW}');
    `);
    this.sqlite.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
      .run('session-1', 'u1', createHash('sha256').update('token-1').digest('hex'), '2099-01-01T00:00:00.000Z');
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map((statement, index) => {
        this.beforeBatchStatement?.(statement, index);
        return statement.runSync();
      });
      this.sqlite.exec('COMMIT');
      return out;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  get uploads() { return this.sqlite.prepare('SELECT * FROM uploads').all(); }
  get photos() { return this.sqlite.prepare('SELECT * FROM photos').all(); }
  get spreads() { return this.sqlite.prepare('SELECT * FROM spreads').all(); }
  close() { this.sqlite.close(); }
}
