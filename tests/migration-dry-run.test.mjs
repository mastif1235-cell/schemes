// Forward-only migration dry-run against an in-memory copy of the audited production schema.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const backendTest = readFileSync(new URL('./backend-worker.test.mjs', import.meta.url), 'utf8');
const match = backendTest.match(/const baseSchema = `([\s\S]*?)`;\s*\n\s*function tokenHash/);
assert.ok(match, 'audited production schema fixture must remain available');
const baseSchema = match[1];
const migration = readFileSync(new URL('../backend/migrations/0001_team_history_notes.sql', import.meta.url), 'utf8');
const database = new DatabaseSync(':memory:');
database.exec(baseSchema);

const now = '2026-09-03T10:00:00.000Z';
database.prepare('INSERT INTO users VALUES (?,?,?)').run('u1', 'Synthetic User', now);
database.prepare('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
  .run('session', 'u1', 'synthetic-hash', 'test-device', now, '2099-01-01T00:00:00.000Z');
database.prepare(`INSERT INTO notebooks(id,owner_id,created_by,title,description,created_at,updated_at,revision,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('nb', 'u1', 'u1', 'Synthetic notebook', 'preserve', now, now, 2, 10, 'nb-client');
database.prepare(`INSERT INTO notebook_members(notebook_id,user_id,role,added_at,updated_at,seq)
  VALUES(?,?,?,?,?,?)`).run('nb', 'u1', 'OWNER', now, now, 11);
database.prepare(`INSERT INTO spreads(id,notebook_id,number,title,note_short,note_full,status,current_photo_id,searchableText,
  created_by,created_at,updated_by,updated_at,revision,seq,client_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('spread', 'nb', 7, 'Synthetic spread', 'short', 'full', 'Актуально', 'photo', 'synthetic search', 'u1', now, 'u1', now, 3, 12, 'spread-client');
database.prepare(`INSERT INTO photos(id,spread_id,version,is_current,provider,storage_object_id,mime_type,file_size,created_by,created_at,seq,client_upload_id)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('photo', 'spread', 1, 1, 'telegram', 'synthetic-object', 'image/jpeg', 123, 'u1', now, 13, 'upload-client');
database.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?)').run('history', 'nb', 'spread', 'spread', 'u1', 'created', now);
database.prepare('INSERT INTO change_seq(at) VALUES(?)').run(now);
database.prepare('INSERT INTO tags VALUES(?,?,?,?,?,?)').run('tag', 'nb', 'Tag', 'tag', 14, null);
database.prepare('INSERT INTO spread_tags VALUES(?,?,?,?)').run('spread', 'tag', 15, null);
database.prepare('INSERT INTO user_favorites VALUES(?,?,?,?)').run('u1', 'spread', 16, null);
database.prepare('INSERT INTO invites VALUES(?,?,?,?,?,?,?,?,?)').run('invite', 'nb', 'synthetic-code-hash', 'MEMBER', 'u1', now, '2099-01-01', null, null);
database.prepare('INSERT INTO uploads VALUES(?,?,?,?)').run('upload-client', 'photo', '{"ok":true}', now);
database.prepare('INSERT INTO photo_previews VALUES(?,?,?,?)').run('photo', 'c3ludGhldGlj', 'image/jpeg', now);

const legacyTables = ['users','sessions','notebooks','notebook_members','spreads','photos','history','change_seq','tags','spread_tags','user_favorites','invites','uploads','photo_previews'];
const snapshot = table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const beforeRows = new Map(legacyTables.map(table => [table, snapshot(table)]));
const beforeObjects = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().filter(row => legacyTables.includes(row.tbl_name));

database.exec(migration);

for (const table of legacyTables) assert.deepEqual(snapshot(table), beforeRows.get(table), `${table} rows changed`);
const afterLegacyObjects = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().filter(row => legacyTables.includes(row.tbl_name));
assert.deepEqual(afterLegacyObjects, beforeObjects, 'migration altered a legacy table or index');
for (const name of ['spread_notes','activity_events','ux_spread_notes_author_client_ref','idx_spread_notes_spread_active',
  'idx_spread_notes_notebook_seq','ux_activity_events_idempotency','idx_activity_events_notebook_seq',
  'idx_activity_events_notebook_time','idx_activity_events_spread_time','idx_activity_events_entity_revision']) {
  assert.ok(database.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), `missing migrated object ${name}`);
}
assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

// Exercise the new tables, including tied seq values, update and soft delete.
database.prepare(`INSERT INTO spread_notes(id,spread_id,notebook_id,author_id,body,created_at,updated_at,revision,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('note', 'spread', 'nb', 'u1', 'created', now, now, 1, 20, 'note-client');
database.prepare('UPDATE spread_notes SET body=?,revision=revision+1,updated_at=? WHERE id=?').run('updated', now, 'note');
database.prepare(`INSERT INTO activity_events(id,notebook_id,spread_id,entity,entity_id,actor_user_id,action,created_at,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('event-a', 'nb', 'spread', 'note', 'note', 'u1', 'note.updated', now, 21, 'event-a-client');
database.prepare(`INSERT INTO activity_events(id,notebook_id,spread_id,entity,entity_id,actor_user_id,action,created_at,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('event-b', 'nb', 'spread', 'spread', 'spread', 'u1', 'spread.reordered', now, 21, 'event-b-client');
database.prepare('UPDATE spread_notes SET deleted_at=?,revision=revision+1 WHERE id=?').run(now, 'note');
assert.equal(database.prepare('SELECT revision FROM spread_notes WHERE id=?').get('note').revision, 3);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE seq=21').get().count, 2);
assert.equal(database.prepare('SELECT current_photo_id FROM spreads WHERE id=?').get('spread').current_photo_id, 'photo');
assert.equal(database.prepare('SELECT is_current FROM photos WHERE id=?').get('photo').is_current, 1);
assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

// Phase 2: cover + per-user seen migration stays additive and never rewrites existing objects.
const objectsBefore = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
const trackedTables = [...legacyTables, 'spread_notes', 'activity_events'];
const rowsBefore = new Map(trackedTables.map(table => [table, snapshot(table)]));
database.exec(readFileSync(new URL('../backend/migrations/0002_notebook_covers_activity_seen.sql', import.meta.url), 'utf8'));
const before0003 = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
const rowsBefore0003 = new Map(trackedTables.map(table => [table, snapshot(table)]));
database.exec(readFileSync(new URL('../backend/migrations/0003_activity_spread_seen.sql', import.meta.url), 'utf8'));
const after0003 = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
for (const before of before0003) {
  assert.deepEqual(after0003.find(row => row.type === before.type && row.name === before.name), before,
    `migration 0003 altered ${before.name}`);
}
for (const table of trackedTables) assert.deepEqual(snapshot(table), rowsBefore0003.get(table), `migration 0003 changed rows in ${table}`);
for (const name of ['activity_spread_seen', 'idx_activity_spread_seen_spread']) {
  assert.ok(database.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), `missing migrated object ${name}`);
}
database.prepare('INSERT INTO activity_spread_seen(user_id,spread_id,last_seen_seq,updated_at) VALUES(?,?,?,?)').run('u1', 'spread', 21, now);
database.prepare(`INSERT INTO activity_spread_seen(user_id,spread_id,last_seen_seq,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(user_id,spread_id) DO UPDATE SET
    last_seen_seq=MAX(activity_spread_seen.last_seen_seq, excluded.last_seen_seq), updated_at=excluded.updated_at`)
  .run('u1', 'spread', 19, now);
assert.equal(database.prepare('SELECT last_seen_seq FROM activity_spread_seen WHERE user_id=? AND spread_id=?').get('u1', 'spread').last_seen_seq, 21,
  'spread seen cursor never moves backwards');
const objectsAfter = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
for (const before of objectsBefore) {
  assert.deepEqual(objectsAfter.find(row => row.type === before.type && row.name === before.name), before,
    `migration 0002 altered ${before.name}`);
}
for (const table of trackedTables) assert.deepEqual(snapshot(table), rowsBefore.get(table), `migration 0002 changed rows in ${table}`);
for (const name of ['notebook_covers', 'activity_seen', 'ux_notebook_covers_client_ref', 'idx_notebook_covers_seq', 'idx_activity_seen_notebook']) {
  assert.ok(database.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), `missing migrated object ${name}`);
}

// Cover lifecycle: set, replace (revision+1), tombstone; seen cursor never moves backwards.
database.prepare(`INSERT INTO notebook_covers(notebook_id,cover_revision,telegram_message_id,telegram_file_id,
  preview_base64,preview_mime,updated_by,updated_at,seq,client_ref) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  .run('nb', 1, 77, 'file-1', 'cHJldmlldw==', 'image/webp', 'u1', now, 22, 'cover-client');
database.prepare(`UPDATE notebook_covers SET cover_revision=cover_revision+1, deleted_at=?, telegram_file_id=NULL,
  preview_base64=NULL, updated_at=?, seq=?, client_ref=? WHERE notebook_id=?`)
  .run(now, now, 23, 'cover-delete-client', 'nb');
const coverRow = database.prepare('SELECT * FROM notebook_covers WHERE notebook_id=?').get('nb');
assert.equal(coverRow.deleted_at, now);
assert.equal(coverRow.cover_revision, 2);
assert.equal(coverRow.telegram_file_id, null);
database.prepare('INSERT INTO activity_seen(user_id,notebook_id,last_seen_seq,updated_at) VALUES(?,?,?,?)').run('u1', 'nb', 21, now);
database.prepare(`INSERT INTO activity_seen(user_id,notebook_id,last_seen_seq,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(user_id,notebook_id) DO UPDATE SET
    last_seen_seq=MAX(activity_seen.last_seen_seq, excluded.last_seen_seq), updated_at=excluded.updated_at`)
  .run('u1', 'nb', 19, now);
assert.equal(database.prepare('SELECT last_seen_seq FROM activity_seen WHERE user_id=? AND notebook_id=?').get('u1', 'nb').last_seen_seq, 21,
  'seen cursor never moves backwards');
assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
database.close();
console.log('migration-dry-run: PASS (legacy schema/data, all new objects, notes CRUD, activity, seq ties, photo preservation, cover/seen additive, foreign keys)');
