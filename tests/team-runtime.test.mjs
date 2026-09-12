// Isolated Chromium + synthetic v2 IndexedDB. Never opens production or a user profile.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = fileURLToPath(new URL('../',import.meta.url));
const base = gunzipSync(Buffer.from([1,2,3,4].map(n => readFileSync(resolve(root,`chunk${n}.txt`),'utf8')).join(''),'base64')).toString();
const oldOpen = base.slice(base.indexOf('function openDB()'),base.indexOf('function tx('));
const server = createServer((req,res) => {
  const pathname = new URL(req.url,'http://localhost').pathname;
  if (pathname === '/fixture') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Isolated test</title>'); return; }
  const file = resolve(root,'.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.json':'application/json','.txt':'text/plain','.svg':'image/svg+xml'})[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const context = await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const page = await context.newPage(), errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await context.route('**/*',route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin+'/fixture');
  await page.evaluate(async source => {
    await new Function('return (async()=>{const DB_NAME="blocknotDB", DB_VER=2;let db;'+source+'; await openDB();db.close();})()')();
    const database = await new Promise((res,rej) => { const r=indexedDB.open('blocknotDB',2);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error); });
    const t = database.transaction(['notebooks','spreads','blobs','history','settings'],'readwrite');
    t.objectStore('notebooks').put({id:'nb',server_id:'remote-nb',title:'Тестовый блокнот',description:'keep me',sort_order:0,revision:1});
    for (let n=1;n<=3;n++) t.objectStore('spreads').put({id:'s'+n,server_id:'remote-s'+n,notebook_id:'nb',title:'Разворот '+n,
      number:n,revision:1,note_short:'legacy short',note_full:'legacy full',status:'Актуально',current_photo_id:null});
    t.objectStore('blobs').put({id:'sentinel',blob:new Blob(['original must survive'])});
    t.objectStore('history').put({spread_id:'s1',action:'Создано',created_at:'2026-09-01T10:00:00Z'});
    t.objectStore('settings').put({key:'app',theme:'light',auth_token:null,backend_url:'',user_id:null});
    await new Promise((res,rej) => {t.oncomplete=res;t.onabort=()=>rej(t.error);});database.close();
  },oldOpen);
  await page.goto(origin+'/');
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof db !== 'undefined' && db?.version === 3);
  await page.getByText('Тестовый блокнот',{exact:true}).waitFor();
  assert.equal(await page.evaluate(async () => (await get('blobs','sentinel')).blob.text()),'original must survive');
  assert.equal(await page.evaluate(async () => (await get('spreads','s1')).note_full),'legacy full');
  await page.reload();
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof db !== 'undefined' && db?.version === 3);
  await page.getByText('Тестовый блокнот',{exact:true}).waitFor();
  await page.evaluate(origin => {
    settings.backend_url=origin;settings.user_id='u1';settings.user_display_name='Артём';settings.auth_token='fixture-only';
    settings.team_capabilities={scope:window.vNextSync.scope(),flags:{team_notes:true,activity:true,field_merge:true,spread_order:true}};
    fullSync=async()=>{};
  },origin);
  // Real IDB abort must roll back both content and outbox.
  assert.equal(await page.evaluate(async () => {
    const before=(await getAll('sync_queue')).length;
    try { await window.vNextAtomic('spreads','s1',row=>({row:{...row,title:'must rollback'},item:{entity:'fixture',uncloneable:()=>{}}})); }
    catch { return (await get('spreads','s1')).title==='Разворот 1' && (await getAll('sync_queue')).length===before; }
    return false;
  }),true);
  await page.evaluate(async () => window.v340OpenSpread(await get('spreads','s1')));
  await page.getByRole('button',{name:'+ Добавить примечание',exact:true}).click();
  await page.locator('[data-note-body]').fill('Проверил муфту — всё нормально');
  await page.locator('[data-note-save]').click();
  await page.getByText('Проверил муфту — всё нормально',{exact:true}).waitFor();
  assert.equal(await page.evaluate(async () => (await getAll('spread_notes')).length),1);
  await context.route(origin+'/api/spreads/remote-s1/notes',async route => {
    const body=route.request().postDataJSON();
    await route.fulfill({json:{note:{id:body.id,spread_id:'remote-s1',author_id:'u1',author_display_name:'Артём',body:body.body,revision:1,created_at:'2026-09-03T10:42:00Z'}}});
  });
  await page.evaluate(async () => {await pushEntityQueue(false);window.BlocknotV3.emit('sync-complete');});
  await page.locator('[data-note-edit]').waitFor();
  await page.evaluate(async () => {
    await window.vNextSync.applyTeamChanges({spread_notes:[{id:'second-note',spread_id:'remote-s1',author_id:'u2',author_display_name:'Петя',body:'Примечание Пети',revision:1,created_at:'2026-09-03T11:03:00Z'}]});
    window.BlocknotV3.emit('sync-complete');
  });
  await page.getByText('Примечание Пети',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-note-edit]').count(),1,'only own note editable');
  const icon = await page.locator('.viewer-top [data-action="close"]').evaluate(el => ({width:el.getBoundingClientRect().width,color:getComputedStyle(el).color}));
  assert.ok(icon.width>=43.9);assert.equal(icon.color,'rgb(255, 255, 255)');
  assert.equal(await page.locator('.v340-zoom-controls button').count(),6);
  await page.locator('[data-action="edit"]').click();
  await page.locator('[data-field="title"]').fill('Текст с телефона B');
  await page.locator('[data-fields-save]').click();
  await page.waitForFunction(async () => (await getAll('sync_queue')).some(row=>row.entity==='spread_fields'));
  const metadataRequest=await page.evaluate(async () => (await getAll('sync_queue')).find(row=>row.entity==='spread_fields'));
  assert.deepEqual(metadataRequest.payload.changes,{title:'Текст с телефона B'});
  assert.deepEqual(metadataRequest.payload.base_values,{title:'Разворот 1'});
  assert.ok(!('current_photo_id' in metadataRequest.payload.changes));
  // A stale caller must not overwrite an independently updated field when attaching a photo.
  assert.equal(await page.evaluate(async () => {
    const stale=await get('spreads','s1');
    await put('spreads',{...stale,title:'new independent text'});
    const canvas=document.createElement('canvas');canvas.width=16;canvas.height=8;
    const blob=await new Promise(res=>canvas.toBlob(res,'image/png'));
    await attachPhoto(stale,new File([blob],'fixture.png',{type:'image/png'}));
    const latest=await get('spreads','s1');
    return latest.title==='new independent text' && !!latest.current_photo_id && !!(await get('blobs',latest.current_photo_id+'_orig')) &&
      !(await getAll('sync_queue')).some(row=>row.entity==='spread');
  }),true);
  await page.evaluate(async () => window.vNextOpenOrder(await get('notebooks','nb')));
  await page.locator('[data-order-list] [data-down]').first().click();
  assert.equal(await page.evaluate(async () => (await get('spreads','s1')).number),1,'draft order does not mutate data');
  await page.locator('[data-order-save]').click();
  await page.waitForFunction(async () => (await getAll('sync_queue')).some(row=>row.entity==='spread_order'));
  const orderRequest=await page.evaluate(async () => (await getAll('sync_queue')).find(row=>row.entity==='spread_order'));
  assert.deepEqual(orderRequest.payload.items.map(row=>row.spread_id),['remote-s2','remote-s1','remote-s3']);
  await context.route(origin+'/api/notebooks/remote-nb/activity?limit=100',route=>route.fulfill({json:{events:[{
    id:'activity-one',notebook_id:'remote-nb',spread_id:'remote-s1',actor:{id:'u2',display_name:'Петя'},action:'note.updated',
    old_value:{body:'Было'},new_value:{body:'Стало'},created_at:'2026-09-03T11:03:00Z',seq:8}],legacy_events:[],has_more:false,next_before_seq:8}}));
  await page.evaluate(async () => window.openNotebookHistory(await get('notebooks','nb')));
  await page.getByText('Изменено примечание',{exact:true}).click();
  await page.getByText('"Стало"',{exact:false}).waitFor();
  await page.locator('[data-team-history] [data-open]').click();
  await page.locator('.viewer').waitFor();
  await page.goBack();
  await page.locator('.viewer').waitFor({state:'detached'});
  // The frozen photo target must refuse a spread that belongs to another notebook.
  assert.equal(await page.evaluate(async () => {
    const spread=await get('spreads','s1');
    const canvas=document.createElement('canvas');canvas.width=16;canvas.height=8;
    const blob=await new Promise(res=>canvas.toBlob(res,'image/png'));
    try {
      await attachPhoto(spread,new File([blob],'guard.png',{type:'image/png'}),{notebookId:'another-notebook',spreadId:'s1'});
      return 'allowed';
    } catch (error) { return error.message; }
  }),'Фото не сохранено: разворот принадлежит другому блокноту');
  // No global file-input hook: a plain image input must not open the page camera/crop flow.
  assert.equal(await page.evaluate(async () => {
    const input=document.createElement('input');input.type='file';input.accept='image/*';
    document.body.appendChild(input);input.click();
    await new Promise(res=>setTimeout(res,80));
    const leaked=!!document.querySelector('.sheet-backdrop.v340-camera-sheet')||!!document.querySelector('.v340-crop-backdrop');
    input.remove();
    return leaked;
  }),false,'cover/gallery picker must not be hijacked by the page camera flow');
  assert.equal(await page.evaluate(() => typeof v3PhotoFromImage),'undefined','legacy runtime must not be loaded');
  assert.equal(await page.evaluate(() => URL.createObjectURL.toString().includes('v3BlobKeyByUrl')),false,'URL helpers must not be monkey-patched');
  // ---- cross-device cover + server unread: mocked endpoints, real IndexedDB ------------------
  await context.route(origin+'/api/notebooks/remote-nb/cover', async route => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({json:{cover:{notebook_id:'remote-nb',revision:1,deleted_at:null,seq:30,has_preview:true}}});
      return;
    }
    await route.fulfill({status:404});
  });
  await context.route(origin+'/api/notebooks/remote-nb/cover/preview', route => route.fulfill({
    status:200, headers:{'Content-Type':'image/webp'}, body:Buffer.from([1,2,3,4]),
  }));
  const coverFlow = await page.evaluate(async () => {
    settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{notebook_cover:true, activity_seen:true}};
    const notebook = await get('notebooks','nb');
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 56;
    const blob = await new Promise(res => canvas.toBlob(res,'image/jpeg'));
    await put('blobs',{id:window.v340CoverBlobId(notebook.id), blob});
    await window.vNextAtomic('notebooks',notebook.id,()=>({item:{entity:'notebook_cover',local_id:notebook.id,
      scope:window.vNextSync.scope(),status:'pending',retry_count:0,payload:{op:'put',client_ref:'fixture-cover-1'}}}));
    await pushEntityQueue(true);
    const afterPush = await get('notebooks','nb');
    const queued = (await getAll('sync_queue')).find(row => row.entity === 'notebook_cover');
    const uploaded = !!queued && queued.status === 'done' && afterPush.cover_state_known === true && afterPush.cover_revision === 1;
    await applyChangeBatch({notebook_covers:[{notebook_id:'remote-nb',cover_revision:2,deleted_at:null,seq:31}]});
    const cached = await get('blobs', window.v340CoverBlobId('nb'));
    const downloaded = !!cached && cached.cover_revision === 2;
    await applyChangeBatch({notebook_covers:[{notebook_id:'remote-nb',cover_revision:3,deleted_at:'2026-09-12T12:00:00.000Z',seq:32}]});
    const afterTombstone = await get('notebooks','nb');
    const gone = afterTombstone.cover_deleted_at === '2026-09-12T12:00:00.000Z' && !(await get('blobs', window.v340CoverBlobId('nb')));
    settings.unread_by_notebook = {'remote-nb':{count:2,max_seq:32}};
    await window.v340RefreshHistoryBadge();
    const badge = (document.getElementById('v340HistoryButton')?.textContent || '').trim();
    return {uploaded, downloaded, gone, badge};
  });
  assert.equal(coverFlow.uploaded,true,'local cover is uploaded through the sync queue');
  assert.equal(coverFlow.downloaded,true,'server cover is cached locally');
  assert.equal(coverFlow.gone,true,'cover tombstone removes the local picture');
  assert.match(coverFlow.badge,/2/,'history badge counts server unread');
  // Cover must survive an app restart (IndexedDB state + cached blob).
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof get === 'function');
  assert.equal(await page.evaluate(async () => {
    const notebook = await get('notebooks','nb');
    const cached = await get('blobs', window.v340CoverBlobId('nb'));
    return notebook.cover_state_known === true && notebook.cover_deleted_at === '2026-09-12T12:00:00.000Z' && !cached;
  }), true, 'cover tombstone survives a restart');
  // A live server cover must also survive a restart (blob + synced state in IndexedDB).
  await page.evaluate(async () => {
    settings.backend_url = location.origin; settings.user_id = 'u1'; settings.auth_token = 'fixture-only';
    await saveSettings();
    settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{notebook_cover:true, activity_seen:true}};
    await applyChangeBatch({notebook_covers:[{notebook_id:'remote-nb',cover_revision:4,deleted_at:null,seq:33}]});
  });
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof get === 'function');
  assert.equal(await page.evaluate(async () => {
    const notebook = await get('notebooks','nb');
    const cached = await get('blobs', window.v340CoverBlobId('nb'));
    const url = await getNotebookCoverUrl(notebook);
    return notebook.cover_state_known === true && !notebook.cover_deleted_at && !!cached && typeof url === 'string' && url.startsWith('blob:');
  }), true, 'a live cover survives a restart and renders');
  assert.deepEqual(errors,[]);
  console.log('team-runtime: PASS (v2→v3/reopen, IDB rollback, own notes, metadata, photo safety, reorder, history, viewer Back; Chromium mobile viewport)');
} finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
