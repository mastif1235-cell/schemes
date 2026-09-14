import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../backend/worker.js';

function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function now() { return '2026-09-14T00:00:00.000Z'; }

class FakeStatement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new FakeStatement(this.db, this.sql, params); }
  async all() { return {success:true, results:this.rows(), meta:{changes:0}}; }
  async first(column) { const row = this.rows()[0] || null; return column && row ? row[column] : row; }
  async run() { return this.runSync(); }
  runSync() {
    const sql = this.sql.replace(/\s+/g, ' ').trim();
    const p = this.params;
    if (/^WITH candidates/.test(sql)) return {success:true, results:this.rows(), meta:{changes:0}};
    if (/^INSERT INTO change_seq/.test(sql)) {
      this.db.seq += 1;
      return {success:true, results:[], meta:{changes:1, last_row_id:this.db.seq}};
    }
    if (/^UPDATE sessions SET last_used_at/.test(sql)) return {success:true, results:[], meta:{changes:1}};
    if (/^UPDATE photos SET is_current=0/.test(sql)) {
      const [seq, spreadId] = p;
      let changes = 0;
      for (const photo of this.db.photos) if (photo.spread_id === spreadId && photo.is_current) {
        photo.is_current = 0; photo.seq = seq; changes++;
      }
      return {success:true, results:[], meta:{changes}};
    }
    if (/^INSERT INTO photos/.test(sql)) {
      const [id, spread_id, version, storage_object_id, telegram_message_id, telegram_file_id,
        telegram_file_unique_id, mime_type, file_size, created_by, created_at, seq, client_upload_id] = p;
      this.db.photos.push({id, spread_id, version, is_current:1, provider:'telegram', storage_object_id,
        telegram_message_id, telegram_file_id, telegram_file_unique_id, mime_type, file_size,
        created_by, created_at, seq, client_upload_id});
      return {success:true, results:[], meta:{changes:1}};
    }
    if (/^UPDATE spreads SET current_photo_id=/.test(sql)) {
      const [photoId, updatedAt, updatedBy, seq, id] = p;
      const spread = this.db.spreads.find(row => row.id === id);
      if (spread) { spread.current_photo_id = photoId; spread.updated_at = updatedAt; spread.updated_by = updatedBy; spread.revision += 1; spread.seq = seq; }
      return {success:true, results:[], meta:{changes:spread ? 1 : 0}};
    }
    if (/^INSERT INTO activity_events/.test(sql)) return {success:true, results:[], meta:{changes:1}};
    if (/^INSERT INTO uploads/.test(sql)) {
      const [client_upload_id, photo_id, result_json, created_at] = p;
      this.db.uploads.push({client_upload_id, photo_id, result_json, created_at});
      return {success:true, results:[], meta:{changes:1}};
    }
    return {success:true, results:[], meta:{changes:0}};
  }
  rows() {
    const sql = this.sql.replace(/\s+/g, ' ').trim();
    const p = this.params;
    if (/FROM sessions s JOIN users u/.test(sql)) {
      const session = this.db.sessions.find(row => row.token_hash === p[0] && !row.revoked_at);
      if (!session) return [];
      const user = this.db.users.find(row => row.id === session.user_id);
      return [{session_id:session.id, user_id:session.user_id, expires_at:session.expires_at,
        revoked_at:session.revoked_at || null, display_name:user.display_name}];
    }
    if (/SELECT role FROM notebook_members/.test(sql)) {
      const row = this.db.members.find(m => m.notebook_id === p[0] && m.user_id === p[1] && !m.revoked_at);
      return row ? [{role:row.role}] : [];
    }
    if (/SELECT id FROM notebooks WHERE id=\? AND owner_id=\?/.test(sql)) {
      return this.db.notebooks.filter(row => row.id === p[0] && row.owner_id === p[1]).map(row => ({id:row.id}));
    }
    if (/SELECT \* FROM notebooks WHERE id=\?/.test(sql)) return this.db.notebooks.filter(row => row.id === p[0]).map(row => ({...row}));
    if (/SELECT \* FROM spreads WHERE id=\?/.test(sql)) return this.db.spreads.filter(row => row.id === p[0]).map(row => ({...row}));
    if (/SELECT revision FROM spreads WHERE id=\?/.test(sql)) return this.db.spreads.filter(row => row.id === p[0]).map(row => ({revision:row.revision}));
    if (/SELECT \* FROM spreads WHERE notebook_id=\?/.test(sql)) return this.db.spreads.filter(row => row.notebook_id === p[0]).map(row => ({...row}));
    if (/SELECT \* FROM photos WHERE id=\?/.test(sql)) return this.db.photos.filter(row => row.id === p[0]).map(row => ({...row}));
    if (/SELECT \* FROM photos WHERE spread_id IN/.test(sql) && !/^WITH candidates/.test(sql)) {
      const notebookId = p[0];
      const spreadIds = new Set(this.db.spreads.filter(row => row.notebook_id === notebookId).map(row => row.id));
      return this.db.photos.filter(row => spreadIds.has(row.spread_id)).map(row => ({...row}));
    }
    if (/SELECT MAX\(version\) as v FROM photos WHERE spread_id=\?/.test(sql)) {
      const versions = this.db.photos.filter(row => row.spread_id === p[0]).map(row => row.version || 0);
      return [{v:versions.length ? Math.max(...versions) : null}];
    }
    if (/SELECT \* FROM uploads WHERE client_upload_id=\?/.test(sql)) return this.db.uploads.filter(row => row.client_upload_id === p[0]).map(row => ({...row}));
    if (/SELECT name FROM sqlite_master/.test(sql)) return [];
    if (/SELECT MAX\(seq\) as m FROM change_seq/.test(sql)) return [{m:this.db.seq}];
    if (/SELECT \* FROM spread_tags/.test(sql)) return [];
    if (/SELECT \* FROM user_favorites/.test(sql)) return [];
    if (/SELECT \* FROM tags/.test(sql)) return [];
    if (/SELECT \* FROM notebook_members/.test(sql)) return this.db.members.filter(row => row.notebook_id === p[0]).map(row => ({...row}));
    if (/FROM spread_notes sn WHERE notebook_id=\?/.test(sql)) return [];
    if (/SELECT notebook_id FROM notebook_members WHERE user_id=\?/.test(sql)) {
      const ids = new Set(this.db.members.filter(row => row.user_id === p[0] && !row.revoked_at).map(row => row.notebook_id));
      for (const nb of this.db.notebooks) if (nb.owner_id === p[1] && !nb.deleted_at) ids.add(nb.id);
      return [...ids].map(notebook_id => ({notebook_id}));
    }
    if (/^WITH candidates/.test(sql)) return this.syncRows(sql, p);
    return [];
  }
  syncRows(sql, p) {
    const since = p[p.length - 2];
    const notebookIds = p.slice(0, p.length - 2);
    const spreadIds = new Set(this.db.spreads.filter(row => notebookIds.includes(row.notebook_id)).map(row => row.id));
    let rows = [];
    if (/FROM photos WHERE/.test(sql)) rows = this.db.photos.filter(row => spreadIds.has(row.spread_id));
    else if (/FROM notebooks WHERE/.test(sql)) rows = this.db.notebooks.filter(row => notebookIds.includes(row.id));
    else if (/FROM spreads WHERE/.test(sql)) rows = this.db.spreads.filter(row => notebookIds.includes(row.notebook_id));
    else rows = [];
    return rows.filter(row => Number(row.seq || 0) > since).sort((a,b) => Number(a.seq || 0) - Number(b.seq || 0)).map(row => ({...row}));
  }
}

class FakeD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new FakeStatement(this.db, sql); }
  async batch(statements) { return statements.map(statement => statement.runSync()); }
}

function createEnv() {
  const db = {
    seq: 10,
    users:[{id:'u1', display_name:'Owner'}],
    sessions:[{id:'session-1', user_id:'u1', token_hash:tokenHash('token-1'), expires_at:'2099-01-01T00:00:00.000Z'}],
    notebooks:[{id:'n1', owner_id:'u1', created_by:'u1', title:'Notebook', description:null, archived:0, sort_order:0,
      created_at:now(), updated_at:now(), revision:1, seq:1, deleted_at:null}],
    members:[{notebook_id:'n1', user_id:'u1', role:'OWNER', added_at:now(), updated_at:now(), seq:1, revoked_at:null}],
    spreads:[{id:'s1', notebook_id:'n1', number:1, title:'Spread', note_short:'short', note_full:'full', status:'Актуально',
      current_photo_id:'p-old', searchableText:'spread', created_by:'u1', created_at:now(), updated_by:'u1', updated_at:now(),
      revision:1, seq:2, deleted_at:null}],
    photos:[{id:'p-old', spread_id:'s1', version:1, is_current:1, provider:'telegram', storage_object_id:'storage-old',
      telegram_message_id:'321', telegram_file_id:'file-old', telegram_file_unique_id:'unique-old', mime_type:'image/jpeg',
      file_size:1234, created_by:'u1', created_at:now(), seq:3, client_upload_id:'old-upload'}],
    uploads:[],
  };
  return {DB:new FakeD1(db), CHAT_ID:'-100555777', BOT_TOKEN:'test-token', __db:db};
}

async function api(env, method, path, body) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`, {
    method,
    headers:{Authorization:'Bearer token-1'},
    body,
  }), env, {waitUntil() {}});
  return {status:response.status, data:await response.json()};
}

const env = createEnv();
const snapshot = await api(env, 'GET', '/api/notebooks/n1/snapshot');
assert.equal(snapshot.status, 200);
assert.equal(snapshot.data.photos.find(row => row.id === 'p-old').telegram_link, 'https://t.me/c/555777/321',
  'snapshot computes Telegram links for old photo rows without a telegram_link column');
const sync = await api(env, 'GET', '/api/sync?since=0');
assert.equal(sync.status, 200);
assert.equal(sync.data.changes.photos.find(row => row.id === 'p-old').telegram_link, 'https://t.me/c/555777/321',
  'sync computes Telegram links for photo changes');
assert.ok(!Object.hasOwn(env.__db.photos[0], 'telegram_link'), 'test fixture mimics D1 photos without a stored telegram_link column');

const nativeFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith('https://api.telegram.org/'), 'test must not call non-Telegram external services');
  return Response.json({ok:true, result:{message_id:444, document:{file_id:'fresh-file', file_unique_id:'fresh-unique',
    file_size:4, mime_type:'image/jpeg'}}});
};
try {
  const form = new FormData();
  form.append('file', new Blob(['test'], {type:'image/jpeg'}), 'test.jpg');
  form.append('client_upload_id', 'fresh-upload');
  const upload = await api(env, 'POST', '/api/spreads/s1/photos', form);
  assert.equal(upload.status, 200);
  assert.equal(upload.data.message_id, 444);
  assert.equal(upload.data.telegram_link, 'https://t.me/c/555777/444', 'fresh upload response includes computed Telegram link');
  assert.equal(upload.data.photo.telegram_link, upload.data.telegram_link);
  const stored = env.__db.photos.find(row => row.id === upload.data.photo_id);
  assert.ok(stored && !Object.hasOwn(stored, 'telegram_link'), 'computed link is not stored as a D1 photo column');
} finally { globalThis.fetch = nativeFetch; }

console.log('backend-photo-link: PASS');
