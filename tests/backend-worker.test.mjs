import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../backend/worker.js';

class TestPreparedStatement {
  constructor(owner, sql, params = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    assert.ok(params.length <= 100, 'D1 maximum 100 parameters per statement');
    return new TestPreparedStatement(this.owner, this.sql, params);
  }
  async all() {
    const results = this.owner.sqlite.prepare(this.sql).all(...this.params);
    return { success: true, results, meta: { changes: 0 } };
  }
  async first(column) {
    const row = this.owner.sqlite.prepare(this.sql).get(...this.params) || null;
    return column && row ? row[column] : row;
  }
  async run() { return this.runSync(); }
  runSync() {
    const statement = this.owner.sqlite.prepare(this.sql);
    if (statement.columns().length) return {success:true,results:statement.all(...this.params),meta:{changes:0}};
    const info = statement.run(...this.params);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

class TestD1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new TestPreparedStatement(this, sql); }
  async batch(statements) {
    this.lastBatchSql = statements.map(statement => statement.sql);
    assert.ok(statements.length <= 40, 'leave room for auth/read queries on D1 Free');
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; hook(); }
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

const baseSchema = `
PRAGMA foreign_keys=ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  device_name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  client_ref TEXT,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE UNIQUE INDEX ux_notebooks_client_ref
ON notebooks(created_by, client_ref) WHERE client_ref IS NOT NULL;
CREATE TABLE notebook_members (
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(notebook_id,user_id)
);
CREATE TABLE spreads (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  number INTEGER NOT NULL,
  title TEXT,
  note_short TEXT,
  note_full TEXT,
  status TEXT NOT NULL DEFAULT 'Актуально',
  current_photo_id TEXT,
  searchableText TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id),
  client_ref TEXT
);
CREATE UNIQUE INDEX ux_spreads_notebook_number
ON spreads(notebook_id, number) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_spreads_client_ref
ON spreads(created_by, client_ref) WHERE client_ref IS NOT NULL;
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  spread_id TEXT NOT NULL REFERENCES spreads(id),
  version INTEGER NOT NULL,
  is_current INTEGER NOT NULL,
  provider TEXT,
  storage_object_id TEXT,
  telegram_message_id TEXT,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  mime_type TEXT,
  file_size INTEGER,
  created_by TEXT,
  created_at TEXT,
  seq INTEGER NOT NULL,
  client_upload_id TEXT UNIQUE
);
CREATE UNIQUE INDEX ux_photos_spread_version ON photos(spread_id, version);
CREATE UNIQUE INDEX ux_photos_current ON photos(spread_id) WHERE is_current = 1;
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE change_seq (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL);
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  name TEXT,
  normalized_name TEXT,
  seq INTEGER NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX ux_tags_notebook_norm ON tags(notebook_id, normalized_name);
CREATE TABLE spread_tags (
  spread_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(spread_id,tag_id)
);
CREATE TABLE user_favorites (
  user_id TEXT NOT NULL,
  spread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(user_id,spread_id)
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, notebook_id TEXT, code_hash TEXT, role TEXT,
  created_by TEXT, created_at TEXT, expires_at TEXT, used_by TEXT, used_at TEXT
);
CREATE TABLE uploads (
  client_upload_id TEXT PRIMARY KEY, photo_id TEXT, result_json TEXT, created_at TEXT
);
CREATE TABLE photo_previews (
  photo_id TEXT PRIMARY KEY, preview_base64 TEXT, mime_type TEXT, created_at TEXT
);
`;

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createFixture({ withCover = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(baseSchema);
  sqlite.exec(readFileSync(new URL('../backend/migrations/0001_team_history_notes.sql', import.meta.url), 'utf8'));
  if (withCover) {
    sqlite.exec(readFileSync(new URL('../backend/migrations/0002_notebook_covers_activity_seen.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../backend/migrations/0003_activity_spread_seen.sql', import.meta.url), 'utf8'));
  }
  const now = '2026-09-03T10:00:00.000Z';
  const expiry = '2099-01-01T00:00:00.000Z';
  const seed = sqlite.prepare.bind(sqlite);
  seed('INSERT INTO users VALUES (?,?,?)').run('u1', 'Артём', now);
  seed('INSERT INTO users VALUES (?,?,?)').run('u2', 'Петя', now);
  seed('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run('session-1', 'u1', tokenHash('token-1'), 'phone-a', now, expiry);
  seed('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run('session-2', 'u2', tokenHash('token-2'), 'phone-b', now, expiry);
  seed(`INSERT INTO notebooks
    (id,owner_id,created_by,title,created_at,updated_at,revision,seq)
    VALUES(?,?,?,?,?,?,?,?)`).run('n1', 'u1', 'u1', 'Общий', now, now, 1, 1);
  seed(`INSERT INTO notebook_members
    (notebook_id,user_id,role,added_at,updated_at,seq) VALUES(?,?,?,?,?,?)`)
    .run('n1', 'u1', 'OWNER', now, now, 1);
  seed(`INSERT INTO notebook_members
    (notebook_id,user_id,role,added_at,updated_at,seq) VALUES(?,?,?,?,?,?)`)
    .run('n1', 'u2', 'MEMBER', now, now, 1);
  seed(`INSERT INTO spreads
    (id,notebook_id,number,title,note_short,note_full,status,current_photo_id,searchableText,
     created_by,created_at,updated_by,updated_at,revision,seq)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('s1', 'n1', 1, 'Разворот', 'legacy short', 'legacy full', 'Актуально', null,
      '1 разворот legacy short legacy full', 'u1', now, 'u1', now, 1, 2);
  return { sqlite, env: { DB: new TestD1(sqlite) } };
}

async function api(env, method, path, token = 'token-1', body) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let requestBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`https://worker.test${path}`, {
    method, headers, body: requestBody,
  }), env, { waitUntil() {} });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data, headers: response.headers };
}

const { sqlite, env } = createFixture();

const created = await api(env, 'POST', '/api/spreads/s1/notes', 'token-1', {
  id: 'note-1', client_ref: 'phone-a:create-1', body: 'Проверил муфту',
});
assert.equal(created.status, 201, 'create note');
assert.equal(created.data.note.author_id, 'u1');
assert.equal(created.data.note.body, 'Проверил муфту');

const retry = await api(env, 'POST', '/api/spreads/s1/notes', 'token-1', {
  id: 'different-id', client_ref: 'phone-a:create-1', body: 'Проверил муфту',
});
assert.equal(retry.status, 200, 'retry note');
assert.equal(retry.data.note.id, 'note-1');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM spread_notes WHERE client_ref=?').get('phone-a:create-1').c, 1);

const secondPhone = await api(env, 'POST', '/api/spreads/s1/notes', 'token-2', {
  id: 'note-2', client_ref: 'phone-b:create-1', body: 'Обновил бумажный блокнот',
});
assert.equal(secondPhone.status, 201, 'second phone creates independent note');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM spread_notes').get().c, 2);
const notesList = await api(env, 'GET', '/api/spreads/s1/notes', 'token-1');
assert.equal(notesList.data.notes.length, 2);
assert.equal(notesList.data.notes[0].id, 'note-2', 'newest note first (seq DESC)');

const edited = await api(env, 'PATCH', '/api/notes/note-1', 'token-1', {
  client_ref: 'phone-a:edit-1', revision: 1, body: 'Проверил муфту — всё нормально',
});
assert.equal(edited.status, 200, 'edit own note');
assert.equal(edited.data.note.revision, 2);

const editForeign = await api(env, 'PATCH', '/api/notes/note-1', 'token-2', {
  client_ref: 'phone-b:edit-foreign', revision: 2, body: 'Участник исправил текст',
});
assert.equal(editForeign.status, 200, 'MEMBER edits another author note');
assert.equal(editForeign.data.note.author_id, 'u1', 'original note author is preserved');
assert.equal(editForeign.data.note.revision, 3);
const editEvent = sqlite.prepare("SELECT actor_user_id FROM activity_events WHERE action='note.updated' ORDER BY seq DESC LIMIT 1").get();
assert.equal(editEvent.actor_user_id, 'u2', 'activity records the actual editor');

const staleEdit = await api(env, 'PATCH', '/api/notes/note-1', 'token-1', {
  client_ref: 'phone-a:stale-edit', revision: 2, body: 'Устаревшая версия',
});
assert.equal(staleEdit.status, 409, 'two users editing the same revision still conflict');

sqlite.prepare('INSERT INTO users VALUES (?,?,?)').run('u9', 'Чужой', '2026-09-03T10:00:00.000Z');
sqlite.prepare('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
  .run('session-9', 'u9', tokenHash('token-9'), 'phone-x', '2026-09-03T10:00:00.000Z', '2099-01-01T00:00:00.000Z');
assert.equal((await api(env, 'PATCH', '/api/notes/note-1', 'token-9', {
  client_ref:'outsider-edit', revision:3, body:'Нет доступа',
})).status, 403, 'outsider cannot edit a note');
assert.equal((await api(env, 'DELETE', '/api/notes/note-1', 'token-9', {
  client_ref:'outsider-delete', revision:3,
})).status, 403, 'outsider cannot delete a note');

const deleted = await api(env, 'DELETE', '/api/notes/note-1', 'token-2', {
  client_ref: 'phone-b:delete-1', revision: 3,
});
assert.equal(deleted.status, 200, 'MEMBER soft-deletes another author note');
assert.ok(deleted.data.note.deleted_at);
assert.equal(deleted.data.note.author_id, 'u1', 'soft delete preserves original author');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM spread_notes WHERE id=?').get('note-1').c, 1);

const deleteEvent = sqlite.prepare("SELECT actor_user_id,old_value FROM activity_events WHERE action='note.deleted'").get();
assert.equal(deleteEvent.actor_user_id, 'u2', 'activity records the actual deleter');
assert.equal(JSON.parse(deleteEvent.old_value).body, 'Участник исправил текст');

const activityForMember = await api(env, 'GET', '/api/notebooks/n1/activity', 'token-2');
assert.equal(activityForMember.status, 200, 'activity visible to second member');
assert.ok(activityForMember.data.events.some(event => event.action === 'note.deleted'));

const sync = await api(env, 'GET', '/api/sync?since=2', 'token-2');
assert.equal(sync.status, 200, 'incremental sync');
assert.ok(sync.data.changes.spread_notes.some(note => note.id === 'note-1'));
assert.ok(sync.data.changes.activity_events.some(event => event.action === 'note.deleted'));

sqlite.prepare(`INSERT INTO spread_notes
  (id,spread_id,notebook_id,author_id,body,created_at,updated_at,revision,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('tie-1', 's1', 'n1', 'u1', 'tie one', 'x', 'x', 1, 1000, 'tie-1');
sqlite.prepare(`INSERT INTO spread_notes
  (id,spread_id,notebook_id,author_id,body,created_at,updated_at,revision,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('tie-2', 's1', 'n1', 'u2', 'tie two', 'x', 'x', 1, 1000, 'tie-2');
const tiedSync = await api(env, 'GET', '/api/sync?since=999&limit=1', 'token-1');
assert.deepEqual(tiedSync.data.changes.spread_notes.map(note => note.id), ['tie-1', 'tie-2']);
assert.equal(tiedSync.data.next_cursor, 1000);

const scenario = createFixture();
const db2 = scenario.sqlite, env2 = scenario.env;
env2.CHAT_ID = '-100555777';
for (const [id, version, current] of [['p1', 1, 1], ['p2', 2, 0]]) {
  db2.prepare('INSERT INTO photos(id,spread_id,version,is_current,seq) VALUES(?,?,?,?,?)').run(id, 's1', version, current, 1);
}
db2.prepare(`UPDATE photos SET storage_object_id=?, telegram_message_id=?, telegram_file_id=?,
  telegram_file_unique_id=?, mime_type=?, file_size=? WHERE id=?`)
  .run('storage-old', '321', 'file-old', 'unique-old', 'image/jpeg', 1234, 'p2');
db2.prepare('UPDATE spreads SET current_photo_id=? WHERE id=?').run('p1', 's1');
const beforePhoto = db2.prepare('SELECT * FROM spreads WHERE id=?').get('s1');
const madeCurrent = await api(env2, 'POST', '/api/spreads/s1/photos/p2/make-current', 'token-1', { client_ref: 'switch-photo' });
assert.equal(madeCurrent.status, 200);
const textMerge = await api(env2, 'PATCH', '/api/spreads/s1', 'token-2', {
  client_ref: 'b:text', base_revision: beforePhoto.revision,
  changes: { title: 'Текст с телефона B' }, base_values: { title: beforePhoto.title },
});
assert.equal(textMerge.status, 200, 'photo update + stale text update merge');
assert.equal(textMerge.data.spread.current_photo_id, 'p2', 'metadata never removes photo');
const phoneAPull = await api(env2, 'GET', '/api/sync?since=0', 'token-1');
assert.equal(phoneAPull.data.changes.spreads.find(row => row.id === 's1').title, 'Текст с телефона B');
assert.equal(phoneAPull.data.changes.spreads.find(row => row.id === 's1').current_photo_id, 'p2');
assert.equal(phoneAPull.data.changes.photos.find(row => row.id === 'p1').is_current, 0);
assert.equal(phoneAPull.data.changes.photos.find(row => row.id === 'p2').is_current, 1);
assert.equal(phoneAPull.data.changes.photos.find(row => row.id === 'p2').telegram_link, 'https://t.me/c/555777/321',
  'sync returns computed Telegram links for old D1 photo rows without a stored link column');
const oldPhotoGet = await api(env2, 'GET', '/api/photos/p2', 'token-1');
assert.equal(oldPhotoGet.data.photo.telegram_link, 'https://t.me/c/555777/321', 'photo GET returns computed Telegram link');
assert.ok(phoneAPull.data.changes.activity_events.some(event => event.action === 'photo.made_current'));
const sameField = await api(env2, 'PATCH', '/api/spreads/s1', 'token-1', {
  client_ref: 'a:text', changes: { title: 'Другой текст' }, base_values: { title: beforePhoto.title },
});
assert.equal(sameField.status, 409, 'same-field conflict');
assert.equal(sameField.data.error, 'field_conflict');
assert.ok(sameField.data.conflicts.title);
const independent = await api(env2, 'PATCH', '/api/spreads/s1', 'token-1', {
  client_ref: 'a:status', changes: { status: 'Готово' }, base_values: { status: 'Актуально' },
});
assert.equal(independent.status, 200, 'different metadata fields merge');
assert.equal(independent.data.spread.title, 'Текст с телефона B');
const injectPhoto = await api(env2, 'PATCH', '/api/spreads/s1', 'token-1', { current_photo_id: null });
assert.equal(injectPhoto.status, 400);

const addSpread = (id, number) => db2.prepare(`INSERT INTO spreads
  (id,notebook_id,number,title,created_by,created_at,updated_at,revision,seq)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(id, 'n1', number, id, 'u1', 'x', 'x', 1, 1);
addSpread('s2', 2);
const orderItems = ids => ids.map(id => {
  const row = db2.prepare('SELECT * FROM spreads WHERE id=?').get(id);
  return { spread_id: id, expected_revision: row.revision, expected_number: row.number };
});
const swap = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-2', {
  client_ref: 'swap-12', items: orderItems(['s2', 's1']),
});
assert.equal(swap.status, 200, 'reorder 1 ↔ 2');
assert.deepEqual(swap.data.spreads.map(row => [row.id, row.number]), [['s2', 1], ['s1', 2]]);
addSpread('s3', 3);
const savedOrder = orderItems(['s3', 's1', 's2']);
const reorder3 = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {
  client_ref: 'reorder-3', items: savedOrder,
});
assert.equal(reorder3.status, 200, 'reorder 3 spreads');
assert.deepEqual(reorder3.data.spreads.map(row => row.id), ['s3', 's1', 's2']);
const staleOrder = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {
  client_ref: 'reorder-stale', items: savedOrder,
});
assert.equal(staleOrder.status, 409, 'stale reorder');
const raceItems = orderItems(['s1', 's2', 's3']);
env2.DB.beforeBatch = () => db2.prepare('UPDATE spreads SET revision=revision+1 WHERE id=?').run('s2');
const racedOrder = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {
  client_ref: 'reorder-race', items: raceItems,
});
assert.equal(racedOrder.status, 409, 'atomic reorder guard catches concurrent change');
assert.deepEqual(db2.prepare('SELECT number FROM spreads ORDER BY number').all().map(row => row.number), [1, 2, 3]);
const reorderedSeq = reorder3.data.spreads[0].seq;
const tiedSpreads = await api(env2, 'GET', `/api/sync?since=${reorderedSeq - 1}&limit=1`, 'token-2');
assert.equal(tiedSpreads.data.changes.spreads.length, 3, 'same-seq reorder rows all returned across limit');
const removed = await api(env2, 'DELETE', '/api/spreads/s1', 'token-1');
assert.equal(removed.status, 200);
assert.deepEqual(db2.prepare('SELECT number FROM spreads WHERE deleted_at IS NULL ORDER BY number').all().map(row => row.number), [1, 3], 'delete does not renumber');

const preflight = await worker.fetch(new Request('https://worker.test/api/favorites/s2', {
  method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'PUT' },
}), env2);
assert.ok(preflight.headers.get('Access-Control-Allow-Methods').split(',').includes('PUT'), 'CORS PUT preflight');
db2.prepare('UPDATE notebook_members SET revoked_at=? WHERE notebook_id=? AND user_id=?').run('x', 'n1', 'u2');
assert.equal((await api(env2, 'PUT', '/api/favorites/s2', 'token-2')).status, 403, 'favorite without membership forbidden');
assert.equal((await api(env2, 'PUT', '/api/favorites/missing', 'token-1')).status, 404);
assert.equal((await api(env2, 'PUT', '/api/favorites/s1', 'token-1')).status, 404, 'favorite deleted spread forbidden');
assert.equal((await api(env2, 'PUT', '/api/favorites/s2', 'token-1')).status, 200);

const snapshot = await api(env2, 'GET', '/api/notebooks/n1/snapshot', 'token-1');
assert.equal(snapshot.status, 200, 'v3.4.2 snapshot remains readable');
for (const key of ['notebook', 'spreads', 'photos', 'tags', 'spread_tags', 'favorites', 'members', 'cursor']) assert.ok(key in snapshot.data);
assert.equal(snapshot.data.spreads.find(row => row.id === 's1').note_full, 'legacy full');
assert.equal(snapshot.data.photos.length, 2, 'original photo rows remain');
assert.equal(snapshot.data.photos.find(row => row.id === 'p2').telegram_link, 'https://t.me/c/555777/321',
  'snapshot returns computed Telegram links for old photos');
const invite = await api(env2, 'POST', '/api/invites', 'token-1', { notebook_id: 'n1' });
assert.equal(invite.status, 200);
assert.equal((await api(env2, 'GET', '/api/invites?notebook_id=n1')).data.invites.length, 1);
assert.equal((await api(env2, 'GET', '/api/me')).status, 200);
assert.equal((await api(env2, 'GET', '/api/notebooks')).status, 200);
assert.equal((await api(env2, 'GET', '/api/notebooks', null)).status, 401);
assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM users').get().c, 2, 'users not reset');
const nativeFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith('https://api.telegram.org/'), 'test must not contact external services');
  return Response.json({ ok: true, result: { message_id: 100, document: {
    file_id: 'fixture-file', file_unique_id: 'fixture-unique', file_size: 4, mime_type: 'image/jpeg',
  } } });
};
try {
  const form = new FormData();
  form.append('file', new Blob(['test'], { type: 'image/jpeg' }), 'test.jpg');
  form.append('client_upload_id', 'fixture-upload');
  const uploaded = await worker.fetch(new Request('https://worker.test/api/spreads/s2/photos', {
    method: 'POST', headers: { Authorization: 'Bearer token-1' }, body: form,
  }), { ...env2, CHAT_ID: 'fixture-chat', BOT_TOKEN: 'fixture-only' });
  assert.equal(uploaded.status, 200, 'existing photo upload SQL remains valid');
  const uploadedData = await uploaded.json();
  assert.equal(uploadedData.telegram_link, 'https://t.me/c/fixture-chat/100', 'fresh upload response includes Telegram link');
  assert.equal(uploadedData.photo.telegram_link, uploadedData.telegram_link, 'fresh upload response includes mapped photo metadata');
  assert.equal(db2.prepare('SELECT current_photo_id FROM spreads WHERE id=?').get('s2').current_photo_id, uploadedData.photo_id);
  assert.ok(db2.prepare("SELECT id FROM activity_events WHERE action='photo.added'").get());
} finally { globalThis.fetch = nativeFetch; }
// ---- CRITICAL A/B: shared notebook cover + per-user unread history --------------------------
  db2.prepare('UPDATE notebook_members SET revoked_at=NULL WHERE notebook_id=? AND user_id=?').run('n1', 'u2');
  // OWNER access must not depend on an owner row inside notebook_members.
  db2.prepare('DELETE FROM notebook_members WHERE notebook_id=? AND user_id=?').run('n1', 'u1');
  const ownerWithoutMemberRow = await api(env2, 'GET', '/api/sync?since=0', 'token-1');
  assert.equal(ownerWithoutMemberRow.status, 200, 'owner sync works without a notebook_members row');
  assert.ok(ownerWithoutMemberRow.data.changes.notebooks.some(row => row.id === 'n1'), 'owner still receives the notebook');
  assert.ok(ownerWithoutMemberRow.data.unread, 'owner still receives unread state');
  assert.ok((await api(env2, 'GET', '/api/notebooks/n1/activity', 'token-1')).status === 200, 'owner reads history without a member row');
  db2.prepare(`INSERT INTO notebook_members(notebook_id,user_id,role,added_at,updated_at,seq)
    VALUES(?,?,?,?,?,?)`).run('n1', 'u1', 'OWNER', '2026-09-03T10:00:00.000Z', '2026-09-03T10:00:00.000Z', 1);
let telegramCalls = 0;
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith('https://api.telegram.org/'), 'test must not contact external services');
  telegramCalls++;
  return Response.json({ ok: true, result: { message_id: 200 + telegramCalls, document: {
    file_id: 'cover-file-' + telegramCalls, file_unique_id: 'cover-unique-' + telegramCalls,
    file_size: 5, mime_type: 'image/jpeg',
  } } });
};
try {
  const coverEnv = { ...env2, CHAT_ID: 'fixture-chat', BOT_TOKEN: 'fixture-only' };
  const coverForm = new FormData();
  coverForm.append('file', new Blob(['cover'], { type: 'image/jpeg' }), 'cover.jpg');
  coverForm.append('preview', new Blob(['preview'], { type: 'image/webp' }), 'preview.webp');
  coverForm.append('client_ref', 'phone-a:cover-1');
  const coverPut = await worker.fetch(new Request('https://worker.test/api/notebooks/n1/cover', {
    method: 'PUT', headers: { Authorization: 'Bearer token-1' }, body: coverForm,
  }), coverEnv);
  assert.equal(coverPut.status, 200, 'owner sets the shared cover');
  const coverBody = await coverPut.json();
  assert.equal(coverBody.cover.revision, 1);
  assert.equal(coverBody.cover.deleted_at, null);
  assert.equal(coverBody.cover.has_preview, true);
  assert.ok(!('file_id' in coverBody.cover), 'telegram file id never leaves the worker');

  const coverRetryForm = new FormData();
  coverRetryForm.append('file', new Blob(['cover'], { type: 'image/jpeg' }), 'cover.jpg');
  coverRetryForm.append('client_ref', 'phone-a:cover-1');
  const coverRetry = await worker.fetch(new Request('https://worker.test/api/notebooks/n1/cover', {
    method: 'PUT', headers: { Authorization: 'Bearer token-1' }, body: coverRetryForm,
  }), coverEnv);
  assert.equal((await coverRetry.json()).cover.revision, 1, 'cover retry is idempotent');
  assert.equal(telegramCalls, 1, 'idempotent retry does not re-upload');

  const preview = await worker.fetch(new Request('https://worker.test/api/notebooks/n1/cover/preview', {
    headers: { Authorization: 'Bearer token-2' },
  }), coverEnv);
  assert.equal(preview.status, 200, 'member reads the shared preview');
  assert.equal(await preview.text(), 'preview');
  const coverFile = await worker.fetch(new Request('https://worker.test/api/notebooks/n1/cover/file', {
    headers: { Authorization: 'Bearer token-2' },
  }), coverEnv);
  assert.equal(coverFile.status, 200, 'member downloads the cover through the worker');

  const memberPull = await api(env2, 'GET', '/api/sync?since=0', 'token-2');
  const coverRow = memberPull.data.changes.notebook_covers.find(row => row.notebook_id === 'n1');
  assert.ok(coverRow && !coverRow.deleted_at, 'member receives the cover through sync');
  assert.equal(coverRow.preview_base64, undefined, 'sync must not ship preview base64');
  assert.ok(memberPull.data.unread.notebooks.n1.count >= 1, 'member gets an unread badge');
  const ownerUnreadBefore = (await api(env2, 'GET', '/api/sync?since=0', 'token-1')).data.unread.notebooks.n1.count;

  const seen = await api(env2, 'PUT', '/api/notebooks/n1/activity/seen', 'token-2', {});
  assert.ok(seen.data.last_seen_seq > 0, 'seen cursor is stored server-side');
  const afterNotebookSeen = (await api(env2, 'GET', '/api/sync?since=0', 'token-2')).data.unread;
  assert.ok(afterNotebookSeen.notebooks.n1, 'spread unread keeps the notebook badge until the spread is opened');
  assert.equal(afterNotebookSeen.notebooks.n1.level, 0, 'notebook-level (no spread) events are marked seen');
  assert.ok(Object.values(afterNotebookSeen.spreads).reduce((sum, row) => sum + row.count, 0) > 0, 'spread events stay unread');
  assert.equal((await api(env2, 'GET', '/api/sync?since=0', 'token-1')).data.unread.notebooks.n1.count, ownerUnreadBefore,
    'seen is per user: opening history on one device never clears another');

  const afterSeenNote = await api(env2, 'POST', '/api/spreads/s2/notes', 'token-1', { id: 'cover-note', client_ref: 'phone-a:note-after-seen', body: 'после seen' });
  assert.equal(afterSeenNote.status, 201, 'a new shared change is recorded after seen');
  assert.ok((await api(env2, 'GET', '/api/sync?since=0', 'token-2')).data.unread.notebooks.n1.count >= 1,
    'a new change raises unread again for the member');

  const coverDelete = await api(env2, 'DELETE', '/api/notebooks/n1/cover', 'token-2', { client_ref: 'phone-b:cover-delete' });
  assert.ok(coverDelete.data.cover.deleted_at, 'member can remove the cover');
  const tombstone = (await api(env2, 'GET', '/api/sync?since=0', 'token-1')).data.changes.notebook_covers.find(row => row.notebook_id === 'n1');
  assert.ok(tombstone.deleted_at, 'cover tombstone reaches the other device');
  assert.equal((await worker.fetch(new Request('https://worker.test/api/notebooks/n1/cover/file', {
    headers: { Authorization: 'Bearer token-1' },
  }), coverEnv)).status, 404, 'removed cover is no longer downloadable');

  // Per-spread unread: opening one spread clears only that spread, for the current user only.
  const spreadUnreadBefore = (await api(env2, 'GET', '/api/sync?since=0', 'token-2')).data.unread.spreads.s2?.count || 0;
  assert.ok(spreadUnreadBefore >= 1, 'per-spread unread is reported');
  const canonical = (await api(env2, 'GET', '/api/sync?since=0', 'token-2')).data.unread;
  const notebookSum = Object.values(canonical.notebooks).reduce((sum, row) => sum + row.count, 0);
  const spreadSum = Object.values(canonical.spreads).reduce((sum, row) => sum + row.count, 0);
  const levelSum = Object.values(canonical.notebooks).reduce((sum, row) => sum + (row.level || 0), 0);
  assert.equal(canonical.total, notebookSum, 'global unread equals the sum of notebook unread');
  assert.equal(notebookSum, spreadSum + levelSum, 'notebook unread equals spread unread plus notebook-level unread');
  const spreadSeen = await api(env2, 'PUT', '/api/spreads/s2/activity/seen', 'token-2', {});
  assert.ok(spreadSeen.data.last_seen_seq > 0, 'spread seen cursor stored');
  assert.ok(spreadSeen.data.unread, 'spread seen returns the fresh canonical unread state');
  assert.equal(spreadSeen.data.unread.total,
    Object.values(spreadSeen.data.unread.notebooks).reduce((sum, row) => sum + row.count, 0),
    'seen response keeps global equal to the notebook sum');
  const afterSpreadSeen = await api(env2, 'GET', '/api/sync?since=0', 'token-2');
  assert.equal(afterSpreadSeen.data.unread.spreads.s2, undefined, 'only the opened spread is cleared');
  const afterNotebookSum = Object.values(afterSpreadSeen.data.unread.notebooks).reduce((sum, row) => sum + row.count, 0);
  assert.equal(afterSpreadSeen.data.unread.total, afterNotebookSum, 'global still equals the notebook sum after spread seen');
  assert.ok((afterSpreadSeen.data.unread.notebooks.n1?.count || 0) < notebookSum, 'notebook unread decreases with the spread');
  assert.ok(((await api(env2, 'GET', '/api/sync?since=0', 'token-1')).data.unread.spreads.s2?.count || 0) >= 1,
    'spread seen is isolated per user');
  const notebookSeenResponse = await api(env2, 'PUT', '/api/notebooks/n1/activity/seen', 'token-2', {});
  assert.ok(notebookSeenResponse.data.unread, 'notebook seen returns the fresh canonical unread state');

  db2.prepare('INSERT INTO users VALUES (?,?,?)').run('u9', 'Чужой', '2026-09-03T10:00:00.000Z');
  db2.prepare('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run('session-9', 'u9', tokenHash('token-9'), 'phone-x', '2026-09-03T10:00:00.000Z', '2099-01-01T00:00:00.000Z');
  assert.equal((await api(env2, 'GET', '/api/notebooks/n1/cover', 'token-9')).status, 403, 'cover requires membership');
  assert.equal((await api(env2, 'PUT', '/api/notebooks/n1/activity/seen', 'token-9', {})).status, 403, 'seen requires membership');
} finally { globalThis.fetch = nativeFetch; }
db2.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?)').run('legacy-event', 'n1', 'spread', 's2', 'u1', 'spread_created', '2026-01-01');
const legacyRead = await api(env2, 'GET', '/api/spreads/s2/activity');
assert.ok(legacyRead.data.legacy_events.some(event => event.id === 'legacy-event' && event.legacy && event.old_value === null));
assert.deepEqual(db2.prepare('PRAGMA foreign_key_check').all(), []);
const large = createFixture();
for (let i = 2; i <= 200; i++) large.sqlite.prepare(`INSERT INTO spreads
  (id,notebook_id,number,title,created_by,created_at,updated_at,revision,seq)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('s'+i, 'n1', i, 'title '+i, 'u1', 'x', 'x', 1, 1);
const largeItems = large.sqlite.prepare('SELECT * FROM spreads ORDER BY number DESC').all().map(row =>
  ({spread_id:row.id, expected_revision:row.revision, expected_number:row.number}));
const largeOrder = await api(large.env, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {client_ref:'large-order', items:largeItems});
assert.equal(largeOrder.status, 200, '200-spread reorder respects D1 parameter/query limits');
assert.equal((await api(large.env, 'GET', '/api/sync?since=0')).status, 200, 'sync with 200 spreads respects D1 bind limits');
assert.equal(largeOrder.data.spreads[0].id, 's200');
assert.equal(largeOrder.data.spreads[199].id, 's1');
assert.equal((await api(large.env, 'GET', '/api/notebooks/n1/snapshot')).data.spreads.length,200,'large reordered notebook remains readable');
db2.prepare(`INSERT INTO activity_events
  (id,notebook_id,entity,entity_id,actor_user_id,action,created_at,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('activity-tie-a','n1','spread','s2','u1','fixture','x',2000,'activity-tie-a');
db2.prepare(`INSERT INTO activity_events
  (id,notebook_id,entity,entity_id,actor_user_id,action,created_at,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('activity-tie-b','n1','spread','s2','u1','fixture','x',2000,'activity-tie-b');
const activityTie = await api(env2, 'GET', '/api/notebooks/n1/activity?limit=1');
assert.equal(activityTie.data.events.length, 2, 'history pagination includes all seq ties');
assert.equal(activityTie.data.next_before_seq, 2000);

// Deploy order is forgiving: with only migration 0001 applied the app keeps working, the new cover
// endpoints answer 503 and the new capabilities stay hidden.
const pre0002 = createFixture({ withCover: false });
const preCaps = await api(pre0002.env, 'GET', '/api/me', 'token-1');
assert.equal(preCaps.data.capabilities.notebook_cover, undefined, 'cover flag hidden before migration 0002');
assert.equal(preCaps.data.capabilities.activity_seen, undefined, 'seen flag hidden before migration 0002');
const preSync = await api(pre0002.env, 'GET', '/api/sync?since=0', 'token-1');
assert.equal(preSync.status, 200, 'sync keeps working before migration 0002');
assert.deepEqual(preSync.data.changes.notebook_covers, [], 'cover table omitted safely');
assert.deepEqual(preSync.data.unread, { notebooks: {}, spreads: {}, total: 0 });
assert.equal(preCaps.data.capabilities.activity_spread_seen, undefined, 'spread seen flag hidden before migration 0003');
assert.equal((await api(pre0002.env, 'GET', '/api/notebooks/n1/cover', 'token-1')).status, 503);
assert.equal((await api(pre0002.env, 'PUT', '/api/notebooks/n1/activity/seen', 'token-1', {})).status, 503);

// Production-shaped asymmetric scope: A owns 272 spreads; B sees one small notebook.
const asym = createFixture();
asym.sqlite.prepare(`INSERT INTO notebooks (id,owner_id,created_by,title,created_at,updated_at,revision,seq)
  VALUES('n2','u1','u1','Owner only','x','x',1,1)`).run();
for (let i=2;i<=272;i++) asym.sqlite.prepare(`INSERT INTO spreads
  (id,notebook_id,number,title,created_by,created_at,updated_at,revision,seq)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('large-'+i,'n2',i,'fixture','u1','x','x',1,1);
for (const [actor,receiver,id] of [['token-2','token-1','b-to-a'],['token-1','token-2','a-to-b']]) {
  const write=await api(asym.env,'POST','/api/spreads/s1/notes',actor,{id,client_ref:id,body:id});
  assert.equal(write.status,201);
  const pull=await api(asym.env,'GET','/api/sync?since=0',receiver);
  assert.equal(pull.status,200);
  assert.ok(pull.data.changes.spread_notes.some(row=>row.id===id));
  assert.ok(pull.data.changes.activity_events.some(row=>row.entity_id===id));
  assert.ok(pull.data.unread.spreads.s1.count>0);
  assert.equal(asym.env.DB.lastBatchSql.length,10,'all change tables share one D1 transaction');
  assert.ok(asym.env.DB.lastBatchSql.every(sql=>sql.startsWith('WITH candidates')));
}
asym.sqlite.prepare('DELETE FROM notebook_members WHERE user_id=?').run('u1');
const ownerList=await api(asym.env,'GET','/api/notebooks','token-1');
assert.ok(ownerList.data.notebooks.some(row=>row.id==='n1'));
for(const route of ['/api/notebooks/n1','/api/notebooks/n1/snapshot','/api/notebooks/n1/activity',
  '/api/notebooks/n1/members','/api/notebooks/n1/cover','/api/spreads/s1/notes','/api/sync?since=0','/api/activity/unread']) {
  assert.equal((await api(asym.env,'GET',route,'token-1')).status,200,'OWNER fallback '+route);
}
const beforeOwn=(await api(asym.env,'GET','/api/activity/unread','token-1')).data.unread.total;
const allSeen=await api(asym.env,'PUT','/api/notebooks/n1/activity/seen','token-2',{all_spreads:true});
assert.equal(allSeen.status,200);assert.equal(allSeen.data.unread.total,0);
assert.equal((await api(asym.env,'GET','/api/activity/unread','token-2')).data.unread.total,0,'server confirms read-all');
assert.equal((await api(asym.env,'GET','/api/activity/unread','token-1')).data.unread.total,beforeOwn,'seen isolated');
assert.ok((await api(asym.env,'GET','/api/notebooks/n1/activity','token-2')).data.events.length>=2,'read history retained');
{
const mutations=createFixture();
const created=await api(mutations.env,'POST','/api/notebooks','token-1',{title:'New',client_ref:'create-once'});
assert.equal(created.status,200);const notebookId=created.data.notebook.id;
await api(mutations.env,'POST','/api/notebooks','token-1',{title:'New',client_ref:'create-once'});
mutations.sqlite.prepare('DELETE FROM notebook_members WHERE notebook_id=? AND user_id=?').run(notebookId,'u1');
assert.equal((await api(mutations.env,'PATCH','/api/notebooks/'+notebookId,'token-1',{title:'Renamed',revision:1})).status,200);
const spreadCreated=await api(mutations.env,'POST',`/api/notebooks/${notebookId}/spreads`,'token-1',{number:1,title:'New spread',client_ref:'spread-once'});
assert.equal(spreadCreated.status,200);const spreadId=spreadCreated.data.spread.id;
assert.equal((await api(mutations.env,'PATCH','/api/spreads/'+spreadId,'token-1',{title:'Updated',revision:1})).status,200);
assert.equal((await api(mutations.env,'POST',`/api/notebooks/${notebookId}/members`,'token-1',{user_id:'u2'})).status,200);
assert.equal((await api(mutations.env,'DELETE',`/api/notebooks/${notebookId}/members/u2`,'token-1')).status,200);
const invitation=await api(mutations.env,'POST','/api/invites','token-1',{notebook_id:notebookId});
assert.equal(invitation.status,200);
assert.equal((await api(mutations.env,'POST','/api/auth/redeem-invite','token-2',{code:invitation.data.code})).status,200);
for(let repeat=0;repeat<2;repeat++)assert.equal((await api(mutations.env,'DELETE','/api/spreads/'+spreadId,'token-1')).status,200);
for(let repeat=0;repeat<2;repeat++)assert.equal((await api(mutations.env,'DELETE','/api/notebooks/'+notebookId,'token-1')).status,200);
const coverage=mutations.sqlite.prepare('SELECT action,COUNT(*) AS count FROM activity_events GROUP BY action').all();
for(const action of ['notebook.created','notebook.updated','notebook.deleted','spread.created','spread.updated','spread.deleted','member.joined','member.revoked']) {
  assert.ok(coverage.some(row=>row.action===action),action+' has canonical activity');
}
assert.equal(coverage.find(row=>row.action==='notebook.created').count,1,'create retry does not duplicate activity');
assert.equal(coverage.find(row=>row.action==='spread.deleted').count,1,'delete retry does not duplicate activity');
assert.equal(coverage.find(row=>row.action==='notebook.deleted').count,1);
}

// ---- AUDIT FIXES regression tests -----------------------------------------------------------
{
  // F1/F3: restore endpoints
  const fx = createFixture();
  // A: a third party with NO membership must not restore foreign notebooks/spreads
  fx.sqlite.prepare('INSERT INTO users VALUES (?,?,?)').run('u3', 'Чужой', new Date().toISOString());
  fx.sqlite.prepare('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run('session-3', 'u3', tokenHash('token-3'), 'pc', new Date().toISOString(), '2099-01-01T00:00:00.000Z');
  assert.equal((await api(fx.env, 'POST', '/api/spreads/s1/restore', 'token-3')).status, 403,
    'non-member cannot restore a spread');
  assert.equal((await api(fx.env, 'POST', '/api/notebooks/n1/restore', 'token-3')).status, 403,
    'non-member cannot restore a notebook');
  // delete twice (idempotent), then restore
  for (let i = 0; i < 2; i++) assert.equal((await api(fx.env, 'DELETE', '/api/spreads/s1', 'token-2')).status, 200);
  const tombstoned = fx.sqlite.prepare('SELECT deleted_at FROM spreads WHERE id=?').get('s1');
  assert.ok(tombstoned.deleted_at, 'spread tombstoned');
  const revBefore = fx.sqlite.prepare('SELECT revision FROM spreads WHERE id=?').get('s1').revision;
  const restored1 = await api(fx.env, 'POST', '/api/spreads/s1/restore', 'token-2');
  assert.equal(restored1.status, 200, 'member can restore (consistent with member delete)');
  assert.equal(restored1.data.restored, true);
  const spreadAfter = fx.sqlite.prepare('SELECT * FROM spreads WHERE id=?').get('s1');
  assert.equal(spreadAfter.deleted_at, null, 'tombstone cleared');
  assert.equal(spreadAfter.revision, revBefore + 1, 'restore bumps revision');
  const restored2 = await api(fx.env, 'POST', '/api/spreads/s1/restore', 'token-2');
  assert.equal(restored2.status, 200);
  assert.equal(restored2.data.restored, false, 'repeat restore is an idempotent no-op (lost response safe)');
  const activityCount = fx.sqlite.prepare("SELECT COUNT(*) AS c FROM activity_events WHERE action='spread.restored'").get().c;
  assert.equal(activityCount, 1, 'restore retry does not duplicate activity');
  // restore of a never-deleted spread is a no-op too
  const restored3 = await api(fx.env, 'POST', '/api/spreads/s1/restore', 'token-1');
  assert.equal(restored3.data.restored, false);
  // 404 for unknown spread
  assert.equal((await api(fx.env, 'POST', '/api/spreads/nope/restore', 'token-1')).status, 404);
  // restore forbidden when parent notebook is tombstoned
  for (let i = 0; i < 2; i++) assert.equal((await api(fx.env, 'DELETE', '/api/spreads/s1', 'token-2')).status, 200);
  assert.equal((await api(fx.env, 'DELETE', '/api/notebooks/n1', 'token-1')).status, 200);
  const blockedRestore = await api(fx.env, 'POST', '/api/spreads/s1/restore', 'token-1');
  assert.equal(blockedRestore.status, 409, 'spread restore refused while notebook is deleted');
  // notebook restore by member → 403; by owner → 200; idempotent
  const memberRestore = await api(fx.env, 'POST', '/api/notebooks/n1/restore', 'token-2');
  assert.equal(memberRestore.status, 403, 'notebook restore requires owner');
  const nbRestored = await api(fx.env, 'POST', '/api/notebooks/n1/restore', 'token-1');
  assert.equal(nbRestored.status, 200);
  assert.equal(nbRestored.data.restored, true);
  assert.equal(fx.sqlite.prepare('SELECT deleted_at FROM notebooks WHERE id=?').get('n1').deleted_at, null);
  assert.equal((await api(fx.env, 'POST', '/api/notebooks/n1/restore', 'token-1')).data.restored, false);
  const nbRestoreActivity = fx.sqlite.prepare("SELECT COUNT(*) AS c FROM activity_events WHERE action='notebook.restored'").get().c;
  assert.equal(nbRestoreActivity, 1, 'notebook restore retry does not duplicate activity');
  const nbRestoreHistory = fx.sqlite.prepare("SELECT COUNT(*) AS c FROM history WHERE action='notebook_restored'").get().c;
  assert.equal(nbRestoreHistory, 1, 'notebook restore retry does not duplicate history');
  const spRestoreHistory = fx.sqlite.prepare("SELECT COUNT(*) AS c FROM history WHERE action='spread_restored'").get().c;
  assert.ok(spRestoreHistory >= 1, 'spread restore recorded in history exactly per actual restore');
  // after notebook restore the spread can be restored again
  assert.equal((await api(fx.env, 'POST', '/api/spreads/s1/restore', 'token-1')).status, 200);
  // photos/notes of the spread were never touched (children preserved through delete+restore)
  assert.ok(fx.sqlite.prepare('SELECT COUNT(*) AS c FROM spread_notes WHERE spread_id=?').get('s1') !== undefined, 'notes queryable after restore');
}
{
  // F2: input validation on legacy PATCH + create endpoints
  const fx = createFixture();
  const xssNumber = await api(fx.env, 'PATCH', '/api/spreads/s1', 'token-2', {number: '1<img src=x onerror=alert(1)>', revision: 1});
  assert.equal(xssNumber.status, 400, 'legacy PATCH rejects non-numeric number');
  assert.equal(fx.sqlite.prepare('SELECT number FROM spreads WHERE id=?').get('s1').number, 1, 'number unchanged');
  const xssStatus = await api(fx.env, 'PATCH', '/api/spreads/s1', 'token-2', {status: 'Ок<script>alert(1)</script>', revision: 1});
  assert.equal(xssStatus.status, 200, 'a normal string status is fine (escaping is a client duty)');
  const badStatusType = await api(fx.env, 'PATCH', '/api/spreads/s1', 'token-2', {status: 42, revision: 1});
  assert.equal(badStatusType.status, 400, 'status must be a string');
  const hugeField = await api(fx.env, 'PATCH', '/api/spreads/s1', 'token-2', {note_full: 'x'.repeat(10001), revision: 1});
  assert.equal(hugeField.status, 400, 'overlong field rejected');
  const objTitle = await api(fx.env, 'PATCH', '/api/spreads/s1', 'token-2', {title: {nested: 1}, revision: 1});
  assert.equal(objTitle.status, 400, 'non-string title rejected');
  const badCreateNumber = await api(fx.env, 'POST', '/api/notebooks/n1/spreads', 'token-1', {number: '7'});
  assert.equal(badCreateNumber.status, 400, 'create spread requires numeric number');
  const badCreateZero = await api(fx.env, 'POST', '/api/notebooks/n1/spreads', 'token-1', {number: 0});
  assert.equal(badCreateZero.status, 400, 'number must be >= 1');
  const okCreate = await api(fx.env, 'POST', '/api/notebooks/n1/spreads', 'token-1', {number: 7, title: 'ok'});
  assert.equal(okCreate.status, 200, 'valid create still works');
  const badNbTitle = await api(fx.env, 'PATCH', '/api/notebooks/n1', 'token-1', {title: 42, revision: 1});
  assert.equal(badNbTitle.status, 400, 'notebook title must be a string');
  const okNbEdit = await api(fx.env, 'PATCH', '/api/notebooks/n1', 'token-1', {title: 'Новое имя', revision: 1});
  assert.equal(okNbEdit.status, 200, 'valid notebook edit still works');
}
{
  // F9: sliding session renewal
  const fx = createFixture();
  const soon = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const far = new Date(Date.now() + 120 * 24 * 3600 * 1000).toISOString();
  fx.sqlite.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(soon, 'session-1');
  fx.sqlite.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(far, 'session-2');
  assert.equal((await api(fx.env, 'GET', '/api/me', 'token-1')).status, 200);
  const renewed = fx.sqlite.prepare('SELECT expires_at FROM sessions WHERE id=?').get('session-1').expires_at;
  assert.ok(new Date(renewed) > new Date(Date.now() + 170 * 24 * 3600 * 1000), 'active session near expiry is renewed');
  const untouched = fx.sqlite.prepare('SELECT expires_at FROM sessions WHERE id=?').get('session-2').expires_at;
  assert.equal(untouched, far, 'session with plenty of time left is not rewritten');
  const pastExp = new Date(Date.now() - 1000).toISOString();
  fx.sqlite.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(pastExp, 'session-2');
  assert.equal((await api(fx.env, 'GET', '/api/me', 'token-2')).status, 401, 'expired session stays expired');
  assert.equal(fx.sqlite.prepare('SELECT expires_at FROM sessions WHERE id=?').get('session-2').expires_at, pastExp,
    'expired session is never rewritten/renewed');
  const revokedBefore = fx.sqlite.prepare('SELECT expires_at FROM sessions WHERE id=?').get('session-1').expires_at;
  fx.sqlite.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), 'session-1');
  assert.equal((await api(fx.env, 'GET', '/api/me', 'token-1')).status, 401, 'revoked session is rejected');
  assert.equal(fx.sqlite.prepare('SELECT expires_at FROM sessions WHERE id=?').get('session-1').expires_at, revokedBefore,
    'revoked session is never renewed');
}
{
  // F8: large preview must not crash the photo upload
  const fx = createFixture();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.ok(String(url).startsWith('https://api.telegram.org/'));
    return Response.json({ ok: true, result: { message_id: 555, document: {
      file_id: 'big-file', file_unique_id: 'big-unique', file_size: 4, mime_type: 'image/jpeg' } } });
  };
  try {
    const form = new FormData();
    form.append('file', new Blob(['test'], { type: 'image/jpeg' }), 'test.jpg');
    form.append('client_upload_id', 'big-preview-upload');
    const bigPreview = new Uint8Array(260000);
    for (let i = 0; i < bigPreview.length; i++) bigPreview[i] = (i * 31) % 251;
    form.append('preview', new Blob([bigPreview], { type: 'image/webp' }), 'thumb.webp');
    const res = await worker.fetch(new Request('https://worker.test/api/spreads/s1/photos', {
      method: 'POST', headers: { Authorization: 'Bearer token-1' }, body: form,
    }), { ...fx.env, CHAT_ID: 'fixture-chat', BOT_TOKEN: 'fixture-only' });
    assert.equal(res.status, 200, '260KB preview uploads without RangeError');
    const row = fx.sqlite.prepare('SELECT preview_base64 FROM photo_previews p JOIN photos ph ON ph.id=p.photo_id WHERE ph.client_upload_id=?').get('big-preview-upload');
    assert.ok(row && row.preview_base64.length > 300000, 'preview stored as base64');
  } finally { globalThis.fetch = nativeFetch; }
}
console.log('backend: PASS (existing scenarios + 272-spread bidirectional delivery + OWNER fallback + server read-all + audit fixes F1/F2/F3/F8/F9)');
