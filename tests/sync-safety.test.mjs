import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../v3-sync.js', import.meta.url), 'utf8');

function createRuntime(seed = {}) {
  const db = {
    notebooks: new Map((seed.notebooks || []).map(row => [row.id, structuredClone(row)])),
    spreads: new Map((seed.spreads || []).map(row => [row.id, structuredClone(row)])),
    tags: new Map((seed.tags || []).map(row => [row.id, structuredClone(row)])),
    photos: new Map((seed.photos || []).map(row => [row.id, structuredClone(row)])),
    blobs: new Map(),
    spread_tags: new Map(),
    user_favorites: new Map(),
    sync_queue: new Map((seed.sync_queue || []).map(row => [row.id, structuredClone(row)]))
  };
  let apiImpl = async () => { throw new Error('Unexpected API request'); };
  const context = {
    console:{...console, warn() {}},
    Date,
    Math,
    Set,
    Object,
    String,
    Number,
    Promise,
    Error,
    window: {},
    settings: {auth_token:'token', backend_url:'https://example.test', keep_originals_offline:true, sync_status:'idle'},
    syncing: false,
    route: {screen:'notebooks'},
    nowISO: () => new Date().toISOString(),
    normalize: value => String(value || '').toLowerCase(),
    uid: (() => { let i = 0; return () => `generated-${++i}`; })(),
    isAuthed: () => true,
    isOnline: () => true,
    toast: () => {},
    updateSyncIndicator: () => {},
    saveSettings: async () => {},
    syncMembership: async () => {},
    pullChanges: async () => {},
    renderSyncStatus: () => {},
    document: {getElementById: () => null},
    fetch: async () => { throw new Error('Unexpected fetch'); },
    FormData: class { append() {} },
    api: (...args) => apiImpl(...args),
    get: async (store, id) => structuredClone(db[store].get(id)),
    getAll: async store => [...db[store].values()].map(row => structuredClone(row)),
    getAllByIndex: async () => [],
    put: async (store, row) => {
      const key = store === 'sync_queue' ? row.id : (store === 'user_favorites' ? row.spread_id : row.id);
      db[store].set(key, structuredClone(row));
      return key;
    },
    del: async (store, id) => db[store].delete(id),
    pushNotebook: async () => {}, pushSpread: async () => {}, pushTagLink: async () => {},
    pushFavorite: async () => {}, pushEntityQueue: async () => {}, pushPhotoQueue: async () => {},
    applyChangeBatch: async () => {}, applySnapshot: async () => {}, fullSync: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(source, context, {filename:'v3-sync.js'});
  return {context, db, setApi(fn) { apiImpl = fn; }};
}

async function testDeferredDependencyStaysPending() {
  const runtime = createRuntime({
    notebooks:[{id:'nb-local'}],
    spreads:[{id:'sp-local', notebook_id:'nb-local'}],
    sync_queue:[{id:1, entity:'spread', local_id:'sp-local', status:'pending', retry_count:0}]
  });
  await runtime.context.pushEntityQueue(false);
  assert.equal(runtime.db.sync_queue.get(1).status, 'pending');
  assert.match(runtime.db.sync_queue.get(1).last_error, /server id/);
}

async function testFailedRetryBackoffAndManualRetry() {
  const runtime = createRuntime({
    spreads:[{id:'sp-local', server_id:'sp-server'}],
    sync_queue:[{id:2, entity:'favorite', local_id:'sp-local', op:'add', status:'pending', retry_count:0}]
  });
  let calls = 0;
  runtime.setApi(async () => { calls++; throw new Error('temporary'); });
  await runtime.context.pushEntityQueue(false);
  const failed = runtime.db.sync_queue.get(2);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retry_count, 1);
  assert.ok(Date.parse(failed.next_attempt_at) > Date.now());
  await runtime.context.pushEntityQueue(false);
  assert.equal(calls, 1, 'automatic retry must respect backoff');
  await runtime.context.pushEntityQueue(true);
  assert.equal(calls, 2, 'manual sync may retry immediately');
}

async function testConflictIsNotMarkedDone() {
  const runtime = createRuntime({
    notebooks:[{id:'nb-local', server_id:'nb-server'}],
    spreads:[{id:'sp-local', server_id:'sp-server', notebook_id:'nb-local', title:'local', revision:1}],
    sync_queue:[{id:3, entity:'spread', local_id:'sp-local', status:'pending', retry_count:0}]
  });
  runtime.setApi(async () => {
    const error = new Error('conflict');
    error.status = 409;
    error.data = {server_copy:{title:'remote', revision:2}};
    throw error;
  });
  await runtime.context.pushEntityQueue(false);
  assert.equal(runtime.db.sync_queue.get(3).status, 'conflict');
  assert.equal(runtime.db.spreads.get('sp-local').title, 'local');
  assert.equal(runtime.db.spreads.get('sp-local').conflict.title, 'remote');
}

async function testPullPreservesPendingLocalEdit() {
  const runtime = createRuntime({
    notebooks:[{id:'nb-local', server_id:'nb-server'}],
    spreads:[{id:'sp-local', server_id:'sp-server', notebook_id:'nb-local', title:'local', revision:1}],
    sync_queue:[{id:4, entity:'spread', local_id:'sp-local', status:'conflict', retry_count:0}]
  });
  await runtime.context.applyChangeBatch({spreads:[{
    id:'sp-server', notebook_id:'nb-server', title:'remote', number:'1', revision:2
  }]});
  assert.equal(runtime.db.spreads.get('sp-local').title, 'local');
  assert.equal(runtime.db.spreads.get('sp-local').revision, 1);
}

async function testIncrementalPhotoMappingMatchesSnapshotFields() {
  const runtime = createRuntime();
  const mapped = runtime.context.window.v340Sync.mapServerPhoto({}, {
    id:'photo-server', version:3, is_current:1, storage_object_id:'object',
    telegram_message_id:'message', telegram_file_id:'file',
    telegram_file_unique_id:'unique', telegram_link:'link', mime_type:'image/jpeg', file_size:123
  }, 'spread-local');
  assert.equal(mapped.telegram_message_id, 'message');
  assert.equal(mapped.telegram_file_unique_id, 'unique');
  assert.equal(mapped.upload_status, 'synced');
}

await testDeferredDependencyStaysPending();
await testFailedRetryBackoffAndManualRetry();
await testConflictIsNotMarkedDone();
await testPullPreservesPendingLocalEdit();
await testIncrementalPhotoMappingMatchesSnapshotFields();
console.log('sync-safety: PASS');
