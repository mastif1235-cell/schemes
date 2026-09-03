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
    spread_notes: new Map((seed.spread_notes || []).map(row => [row.cache_id, structuredClone(row)])),
    activity_events: new Map(),
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
    settings: {auth_token:'token', user_id:'u1', backend_url:'https://example.test', keep_originals_offline:true, sync_status:'idle'},
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
      const key = store === 'sync_queue' ? (row.id ?? db.sync_queue.size + 1) :
        (store === 'user_favorites' ? row.spread_id : ['spread_notes','activity_events'].includes(store) ? row.cache_id : row.id);
      if (store === 'sync_queue') row.id = key;
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
  context.window.vNextAtomic = async (store, key, update) => {
    const result = update(await context.get(store, key));
    if (result.row) await context.put(store, result.row);
    if (result.item) await context.put('sync_queue', result.item);
    for (const item of result.retired || []) await context.put('sync_queue', item);
  };
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

const teamSeed = {
  notebooks:[{id:'nb',server_id:'remote-nb'}],
  spreads:[{id:'sp',server_id:'remote-sp',notebook_id:'nb',number:1,title:'before',current_photo_id:'local-photo'}],
  photos:[{id:'local-photo',spread_id:'sp',is_current:true,upload_status:'local_pending'}],
  sync_queue:[{id:1,entity:'photo',photo_id:'local-photo',status:'pending'}]
};
const team = createRuntime(teamSeed), c = team.context;
c.settings.team_capabilities = {scope:c.window.vNextSync.scope(),flags:{team_notes:true,field_merge:true,spread_order:true}};
c.fullSync = async () => {};
await c.window.vNextSync.saveNote(teamSeed.spreads[0], 'Phone A');
const queuedNote = [...team.db.sync_queue.values()].find(row => row.entity === 'spread_note');
assert.ok(queuedNote.payload.client_ref);
let tries = 0;
team.setApi(async (path, options) => {
  assert.equal(path, '/api/spreads/remote-sp/notes');
  assert.equal(options.json.client_ref, queuedNote.payload.client_ref, 'retry identity is immutable');
  if (++tries === 1) throw new Error('response lost');
  return {note:{id:options.json.id,spread_id:'remote-sp',body:'Phone A',author_id:'u1',revision:1}};
});
await c.pushEntityQueue(false);
assert.equal(team.db.sync_queue.get(queuedNote.id).status, 'failed');
await c.pushEntityQueue(true);
assert.equal(team.db.sync_queue.get(queuedNote.id).status, 'done');
assert.equal(team.db.spread_notes.get(queuedNote.local_id).pending, false);
await c.applyChangeBatch({spreads:[{id:'remote-sp',notebook_id:'remote-nb',title:'B text',number:1,revision:5,current_photo_id:'remote-photo'}],
  photos:[{id:'remote-photo',spread_id:'remote-sp',is_current:1}],
  spread_notes:[{id:'b-note',spread_id:'remote-sp',body:'Phone B',author_id:'u2'}],
  activity_events:[{id:'event-1',action:'note.created',actor_user_id:'u2'}]});
assert.equal(team.db.spreads.get('sp').title, 'B text', 'text from B reaches A');
assert.equal(team.db.spreads.get('sp').current_photo_id, 'local-photo', 'pending A photo not overwritten');
assert.equal(team.db.spread_notes.size, 2, 'independent notes retained');
assert.equal(team.db.activity_events.size, 1);
await assert.rejects(c.window.vNextSync.applyTeamChanges({spread_notes:[{id:'orphan',spread_id:'missing'}]}), /ожидает/);
const foreign = [...team.db.spread_notes.values()].find(row => row.author_id === 'u2');
await assert.rejects(c.window.vNextSync.saveNote(teamSeed.spreads[0], 'attack', foreign), /своё/);
await c.window.vNextSync.saveFields(team.db.spreads.get('sp'), {title:'mine'}, {title:'B text'});
team.setApi(async () => { const error = new Error('field_conflict'); error.status = 409;
  error.data = {conflicts:{title:{base:'B text',mine:'mine',server:'other'}}}; throw error; });
await c.pushEntityQueue(false);
assert.equal(team.db.spreads.get('sp').field_conflicts.title.server, 'other');
assert.equal(team.db.spreads.get('sp').conflict, undefined, 'no whole-record conflict for metadata');
await c.applyChangeBatch({spreads:[{id:'remote-sp',notebook_id:'remote-nb',title:'other',number:2,revision:6,current_photo_id:'remote-photo'}]});
assert.equal(team.db.spreads.get('sp').title, 'mine', 'pending field preserved');
assert.equal(team.db.spreads.get('sp').number, 2, 'independent field pulled');
assert.equal(team.db.spreads.get('sp').current_photo_id, 'local-photo');
c.settings.team_capabilities.flags = {};
await assert.rejects(c.window.vNextSync.saveNote(teamSeed.spreads[0], 'unsupported'), /обновления сервера/);
const pending = {...queuedNote,id:90,status:'pending'};
team.db.sync_queue.set(90,pending);
team.setApi(async () => { throw new Error('Must not send unsupported notes'); });
await c.pushEntityQueue(true);
assert.equal(team.db.sync_queue.get(90).status, 'pending', 'old backend does not discard team outbox');
const snapshotRuntime = createRuntime(teamSeed);
snapshotRuntime.setApi(async () => ({notebook:{title:'nb'},spreads:[{id:'remote-sp',notebook_id:'remote-nb',current_photo_id:'remote-photo'}],
  photos:[{id:'remote-photo',spread_id:'remote-sp',is_current:1}],tags:[],spread_tags:[],favorites:[]}));
await snapshotRuntime.context.applySnapshot('remote-nb');
assert.equal(snapshotRuntime.db.spreads.get('sp').current_photo_id,'local-photo','snapshot preserves pending original');
const orphanRuntime = createRuntime({notebooks:[{id:'nb',server_id:'remote-nb'}]});
orphanRuntime.setApi(async path => {
  assert.equal(path,'/api/notebooks/remote-nb/snapshot');
  return {notebook:{id:'remote-nb',title:'nb'},spreads:[{id:'late-parent',notebook_id:'remote-nb',title:'parent'}],photos:[],tags:[],spread_tags:[],favorites:[]};
});
await orphanRuntime.context.applyChangeBatch({spread_notes:[{id:'child',spread_id:'late-parent',notebook_id:'remote-nb',body:'earlier seq'}]});
assert.equal(orphanRuntime.db.spread_notes.size,1,'parent with later seq recovered without skipping child');
const upload = createRuntime(teamSeed);
upload.db.blobs.set('local-photo_orig',{blob:{}});
upload.context.fetch = async () => {
  upload.db.spreads.set('sp',{...upload.db.spreads.get('sp'),title:'edited during upload',current_photo_id:'newer-photo',revision:8});
  upload.db.photos.set('local-photo',{...upload.db.photos.get('local-photo'),is_current:false});
  return {ok:true,json:async()=>({photo_id:'uploaded',spread_revision:5})};
};
await upload.context.pushPhotoQueue(false);
assert.equal(upload.db.spreads.get('sp').title,'edited during upload');
assert.equal(upload.db.spreads.get('sp').current_photo_id,'newer-photo');
assert.equal(upload.db.spreads.get('sp').revision,8,'upload response cannot roll revision back');
assert.equal(upload.db.photos.get('local-photo').is_current,false,'late response cannot reselect superseded photo');
console.log('sync-safety: PASS');
