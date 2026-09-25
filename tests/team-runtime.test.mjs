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
  await page.locator('[data-note-compose]').click();
  await page.locator('[data-note-input]').fill('Проверил муфту — всё нормально');
  await page.locator('[data-note-add]').click();
  await page.getByText('Проверил муфту — всё нормально',{exact:true}).waitFor();
  assert.equal(await page.evaluate(async () => (await getAll('spread_notes')).length),1);
  await context.route(origin+'/api/spreads/remote-s1/notes',async route => {
    if (route.request().method() === 'GET') { await route.fulfill({json:{notes:[]}}); return; }
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
  assert.equal(await page.locator('[data-note-edit]').count(),2,'all active members can edit notebook notes');
  assert.equal(await page.locator('[data-note-delete]').count(),2,'all active members can delete notebook notes');
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
  await page.waitForFunction(async () => {
    const notebook = await get('notebooks','nb');
    const cached = await get('blobs', window.v340CoverBlobId('nb'));
    return notebook.cover_state_known === true && notebook.cover_deleted_at === '2026-09-12T12:00:00.000Z' && !cached;
  }, null, {timeout:10000});
  // Cover must survive an app restart (IndexedDB state + cached blob).
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof db !== 'undefined' && db?.version === 3);
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
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof db !== 'undefined' && db?.version === 3);
  assert.equal(await page.evaluate(async () => {
    const notebook = await get('notebooks','nb');
    const cached = await get('blobs', window.v340CoverBlobId('nb'));
    const url = await getNotebookCoverUrl(notebook);
    return notebook.cover_state_known === true && !notebook.cover_deleted_at && !!cached && typeof url === 'string' && url.startsWith('blob:');
  }), true, 'a live cover survives a restart and renders');
  // ---- global server history + unread levels + legacy cover migration -------------------------
  await context.route(origin+'/api/spreads/remote-s1/activity/seen', route => route.fulfill({json:{last_seen_seq:8,
    unread:{notebooks:{},spreads:{},total:0}}}));
  await context.route(origin+'/api/activity/unread', route => route.fulfill({json:{unread:{
    notebooks:{'remote-nb':{count:1,max_seq:9}},spreads:{'remote-s1':{count:1,max_seq:9}},total:1}}}));
  await context.route(origin+'/api/notebooks/remote-nb/cover', async route => route.fulfill({
    json:{cover: route.request().method() === 'GET' ? null : {notebook_id:'remote-nb',revision:1,deleted_at:null,seq:40}}}));
  let memberRole = 'OWNER';
  await context.route(origin+'/api/notebooks/remote-nb/members', route => route.fulfill({
    json:{members:[{user_id:'u1',display_name:'Артём',role:memberRole}]}}));
  const levels = await page.evaluate(async () => {
    try {
      settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{activity:true, activity_seen:true, activity_spread_seen:true, notebook_cover:true}};
      settings.unread_by_notebook = {'remote-nb':{count:1,max_seq:9}};
      settings.unread_spreads = {'remote-s1':{count:1,max_seq:9}};
      settings.unread_total = 1;
      await saveSettings();
      route = {screen:'notebooks'}; render();
      await new Promise(res => setTimeout(res,60));
      const notebookBadge = (document.querySelector('.v340-unread-badge')?.textContent || '').trim();
      route = {screen:'spreads', notebookId:'nb'}; render();
      await new Promise(res => setTimeout(res,80));
      const spreadDot = (document.querySelector('.v340-unread-dot')?.textContent || '').trim();
      let historyError = null, rows = 0;
      try {
        await window.v340OpenGlobalHistory();
        await new Promise(res => setTimeout(res,150));
        rows = document.querySelectorAll('[data-server-history] .v340-history-row').length;
      } catch (error) { historyError = String(error && error.message || error); }
      await window.v340MarkSpreadSeen(await get('spreads','s1'));
      const dotAfterSeen = !!document.querySelector('.spread-card[data-spread-server-id="remote-s1"] .v340-unread-dot');
      const result = {notebookBadge, spreadDot, rows, historyError,
        dotAfterSeen, afterSeen:{...settings.unread_spreads}, notebookCount:settings.unread_by_notebook['remote-nb']?.count ?? null};
      document.querySelector('.sheet-backdrop')?.remove();
      return result;
    } catch (error) { return {fatal:String(error && error.stack || error)}; }
  });
  assert.ok(!levels.fatal, 'levels flow failed: ' + levels.fatal);
  assert.ok(!levels.historyError, 'global history failed: ' + levels.historyError);
  assert.equal(levels.notebookBadge,'1','per-notebook unread badge renders');
  assert.match(levels.spreadDot,/1/,'per-spread unread dot renders');
  assert.ok(levels.rows >= 1, 'global history lists server activity, rows=' + levels.rows);
  assert.deepEqual(levels.afterSeen,{},'opening a spread clears only that spread');
  assert.equal(levels.dotAfterSeen,false,'the spread dot disappears without a reload');
  assert.ok(levels.notebookCount === null || levels.notebookCount === 0,'notebook unread decreases with the spread');
  const migration = await page.evaluate(async () => {
    try {
      const notebook = await get('notebooks','nb');
      await put('notebooks',{...notebook, cover_state_known:false, cover_migrated_at:null, cover_migration:null});
      const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 56;
      await put('blobs',{id:window.v340CoverBlobId('nb'), blob:await new Promise(res => canvas.toBlob(res,'image/jpeg'))});
      await window.v340MigrateLegacyCovers();
      const owner = await get('notebooks','nb');
      return {migrated:!!owner.cover_migrated_at, skipped:owner.cover_migration || null};
    } catch (error) { return {fatal:String(error && error.message || error)}; }
  });
  assert.ok(!migration.fatal, 'migration flow failed: ' + migration.fatal);
  assert.equal(migration.migrated,true,'OWNER legacy cover migration is recorded and queued');
  assert.equal(migration.skipped,null);
  memberRole = 'MEMBER';
  const memberSkip = await page.evaluate(async () => {
    try {
      const notebook = await get('notebooks','nb');
      await put('notebooks',{...notebook, cover_state_known:false, cover_migrated_at:null, cover_migration:null});
      const before = (await getAll('sync_queue')).filter(row => row.entity === 'notebook_cover' && row.status === 'pending').length;
      await window.v340MigrateLegacyCovers();
      const after = (await getAll('sync_queue')).filter(row => row.entity === 'notebook_cover' && row.status === 'pending').length;
      return {before, after, skipped:(await get('notebooks','nb')).cover_migration || null};
    } catch (error) { return {fatal:String(error && error.message || error)}; }
  });
  assert.ok(!memberSkip.fatal, 'member migration flow failed: ' + memberSkip.fatal);
  assert.equal(memberSkip.after,memberSkip.before,'MEMBER does not auto-publish a legacy cover');
  assert.equal(memberSkip.skipped,'member-skip');
  // B→A notes: opening a spread must fetch the server copy even when the local cache is empty.
  await context.route(origin+'/api/spreads/remote-s1/notes', route => route.fulfill({json:{notes:[{
    id:'remote-note-b', spread_id:'remote-s1', notebook_id:'remote-nb', author_id:'u2',
    author_display_name:'Петя', body:'Заметка с телефона B', revision:1, created_at:'2026-09-12T13:00:00.000Z'}]}}));
  const noteFlow = await page.evaluate(async () => {
    settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{team_notes:true, activity:true, activity_spread_seen:true}};
    await window.v340OpenSpread(await get('spreads','s1'));
    await new Promise(res => setTimeout(res, 250));
    const text = document.querySelector('.vnext-notes')?.textContent || '';
    const unread = settings.unread_total;
    document.querySelector('.viewer')?.remove();
    return {text, unread};
  });
  assert.match(noteFlow.text,/Заметка с телефона B/,'owner sees a note created on the other phone');
  assert.equal(noteFlow.unread,0,'opening the spread clears the freshly fetched server unread state');
  // History list must render server activity even with no capability flags set.
  assert.equal(await page.evaluate(async () => {
    settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{}};
    route = {screen:'notebooks'}; render();
    await window.v340OpenGlobalHistory();
    await new Promise(res => setTimeout(res, 250));
    const rows = document.querySelectorAll('[data-server-history] .v340-history-row').length;
    const close = document.querySelector('[data-history-close]');
    if (!close) return false;
    close.click();
    await new Promise(res => setTimeout(res, 30));
    if (document.querySelector('[data-server-history]')) return false;
    return rows >= 1;
  }), true, 'global history is not capability-gated and has an explicit close button');
  // Notes composer must sit above the notes list.
  const composer = await page.evaluate(async () => {
    settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{team_notes:true, activity:true}};
    await window.v340OpenSpread(await get('spreads','s1'));
    await new Promise(res => setTimeout(res, 250));
    const host = document.querySelector('.vnext-notes');
    const compose = host?.querySelector('[data-note-compose]');
    const editor = host?.querySelector('[data-note-editor]');
    const initiallyCollapsed=!!(compose&&editor&&editor.hidden&&!compose.hidden);
    compose?.click();
    const input = host?.querySelector('[data-note-input]');
    const add = host?.querySelector('[data-note-add]');
    const list = host?.querySelector('[data-note-list]');
    const ordered = !!(input && list) && (input.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const texts = [...(host?.querySelectorAll('[data-note-list] .vnext-note p') || [])].map(el => el.textContent);
    const inputBox=input?.getBoundingClientRect(), editorBox=editor?.getBoundingClientRect(), hostBox=host?.getBoundingClientRect();
    const fullWidth=!!(inputBox&&editorBox&&hostBox)&&Math.abs(inputBox.width-hostBox.width)<2&&Math.abs(editorBox.width-hostBox.width)<2;
    const minHeight=inputBox?.height || 0;
    const foreignActions=host?.querySelectorAll('.vnext-note .v342-note-actions').length || 0;
    host?.querySelector('[data-note-cancel]')?.click();
    const collapsedAfterCancel=!!(editor?.hidden&&!compose?.hidden);
    document.querySelector('.viewer')?.remove();
    return {ordered, texts, fullWidth, minHeight, foreignActions, initiallyCollapsed, collapsedAfterCancel};
  });
  assert.equal(composer.ordered,true,'notes composer is above the notes list');
  assert.equal(composer.fullWidth,true,'expanded notes textarea uses full width');
  assert.ok(composer.minHeight>=80,'notes textarea remains comfortably tall');
  assert.ok(composer.foreignActions>=1,'active member sees edit/delete actions on another author note');
  assert.equal(composer.initiallyCollapsed,true,'new note textarea is hidden by default');
  assert.equal(composer.collapsedAfterCancel,true,'Cancel collapses the new note composer');
  const switches = await page.evaluate(async () => {
    settings.keep_originals_offline=false; settings.theme='light'; document.body.dataset.theme='light';
    route={screen:'settings'}; await render();
    const keep=document.querySelector('#swKeep');
    const light=getComputedStyle(keep); const offBackground=light.backgroundColor;
    const dimensions={width:light.width,height:light.height,radius:light.borderRadius};
    keep.click();
    await new Promise(resolve=>setTimeout(resolve,250));
    const onBackground=getComputedStyle(keep).backgroundColor;
    document.querySelector('#swTheme').click();
    await new Promise(resolve=>setTimeout(resolve,250));
    const darkOnBackground=getComputedStyle(keep).backgroundColor;
    keep.click(); await new Promise(resolve=>setTimeout(resolve,250));
    const darkOffBackground=getComputedStyle(keep).backgroundColor;
    keep.click(); await new Promise(resolve=>setTimeout(resolve,250));
    return {dimensions,offBackground,onBackground,darkOnBackground,darkOffBackground,
      functional:settings.keep_originals_offline===true&&settings.theme==='dark'&&keep.classList.contains('on')};
  });
  assert.deepEqual(switches.dimensions,{width:'56px',height:'30px',radius:'999px'});
  assert.notEqual(switches.offBackground,switches.onBackground,'off and on switches have distinct contrast');
  assert.notEqual(switches.darkOffBackground,switches.darkOnBackground,'off and on switches have distinct contrast in dark theme');
  assert.equal(switches.functional,true,'switch controls keep their original settings behavior');
  const fullscreen = await page.evaluate(async () => {
    settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{team_notes:true,activity_spread_seen:true}};
    await window.v340OpenSpread(await get('spreads','s1'));
    await new Promise(res=>setTimeout(res,150));
    const detail=document.querySelector('.v340-viewer'); detail.scrollTop=17;
    detail.querySelector('[data-image]')?.click(); await new Promise(res=>setTimeout(res,150));
    const full=document.querySelector('.v342-photo-fullscreen');
    const pure=!!full&&!full.querySelector('.vnext-notes')&&!full.textContent.includes('Примечания');
    const noPersistentNav=!full?.querySelector('.v342-photo-nav,[data-full-nav]');
    const noZoomButtons=!full?.querySelector('.v340-zoom-controls,[data-full-zoom]');
    const blackBackground=getComputedStyle(full).backgroundColor==='rgb(0, 0, 0)';
    const sameSpread=full?.querySelector('.num')?.textContent.includes('№1');
    full?.querySelector('[data-full-close]')?.click(); await new Promise(res=>setTimeout(res,50));
    const restored=!!document.querySelector('.v340-viewer')&&!document.querySelector('.v342-photo-fullscreen');
    document.querySelector('.v340-viewer')?.remove();
    return {pure,noPersistentNav,noZoomButtons,blackBackground,sameSpread,restored};
  });
  assert.deepEqual(fullscreen,{pure:true,noPersistentNav:true,noZoomButtons:true,blackBackground:true,sameSpread:true,restored:true},
    'fullscreen is photo-only, has no persistent nav/zoom bars and returns to the same spread detail');
  // Back from a spread opened in History must reopen History.
  const backToHistory = await page.evaluate(async () => {
    settings.team_capabilities = {scope:window.vNextSync.scope(), flags:{activity:true, activity_spread_seen:true}};
    route = {screen:'notebooks'}; render();
    await window.v340OpenGlobalHistory();
    await new Promise(res => setTimeout(res, 200));
    const row = document.querySelector('[data-server-history] [data-open]');
    if (!row) return {opened:false};
    row.click();
    await new Promise(res => setTimeout(res, 200));
    const viewerOpen = !!document.querySelector('.viewer');
    document.querySelector('.viewer [data-action="close"]')?.click();
    await new Promise(res => setTimeout(res, 400));
    const historyBack = !!document.querySelector('[data-server-history]');
    document.querySelector('.sheet-backdrop')?.remove();
    return {opened:viewerOpen, historyBack};
  });
  assert.equal(backToHistory.opened,true,'history row opens the spread');
  assert.equal(backToHistory.historyBack,true,'closing the spread returns to History');
  // Conflict diagnostics must expose only the requested fields and leave IndexedDB untouched.
  const diagnostic = await page.evaluate(async () => {
    document.querySelectorAll('.sheet-backdrop,.viewer').forEach(node=>node.remove());
    route={screen:'notebooks'};await render();
    const local=await get('spreads','s1');
    const server={id:local.server_id,number:local.number,title:local.title,status:local.status,
      note_short:local.note_short,note_full:local.note_full,revision:8};
    await put('sync_queue',{id:901,entity:'spread',local_id:'s1',status:'conflict',retry_count:2,last_error:'revision conflict',server_copy:server});
    await put('sync_queue',{id:902,entity:'spread',local_id:'s1',status:'conflict',retry_count:3,last_error:'revision conflict',server_copy:server});
    const before=JSON.stringify((await getAll('sync_queue')).filter(row=>row.id===901||row.id===902));
    let syncCalls=0;fullSync=async()=>{syncCalls++;};
    const originalApi=api; let requests=[];
    api=async (path,options) => {requests.push([path,options]); return {spread:server};};
    document.getElementById('syncDot').click();
    await new Promise(res=>setTimeout(res,30));
    const button=document.querySelector('[data-conflict-diagnostics]');
    button?.click();await new Promise(res=>setTimeout(res,30));
    const text=document.querySelector('[data-conflict-diagnostics]')?.textContent||'';
    const cleanup=document.querySelector('[data-safe-conflict-cleanup]');
    const afterView=JSON.stringify((await getAll('sync_queue')).filter(row=>row.id===901||row.id===902));
    const spreadBefore=JSON.stringify(await get('spreads','s1'));
    cleanup?.click();await new Promise(res=>setTimeout(res,50));
    const rows=(await getAll('sync_queue')).filter(row=>row.id===901||row.id===902);
    const spreadAfter=JSON.stringify(await get('spreads','s1'));
    api=originalApi;
    document.querySelector('.sheet-backdrop')?.remove();
    await del('sync_queue',901);await del('sync_queue',902);
    return {hasButton:!!button,text,unchangedBeforeCleanup:before===afterView,hasCleanup:!!cleanup,
      statuses:rows.map(row=>row.status),spreadUnchanged:spreadBefore===spreadAfter,syncCalls,
      onlyGets:requests.every(([path,options])=>path==='/api/spreads/'+encodeURIComponent(local.server_id)&&options===undefined)};
  });
  assert.equal(diagnostic.hasButton,true,'sync sheet exposes conflict diagnostics');
  assert.match(diagnostic.text,/legacy spread/);
  assert.match(diagnostic.text,/2 дублей/);
  assert.match(diagnostic.text,/не отправляет/,'diagnostics explains that Retry skips conflicts');
  assert.equal(diagnostic.unchangedBeforeCleanup,true,'opening diagnostics does not write IndexedDB');
  assert.equal(diagnostic.hasCleanup,true,'safe cleanup appears only after live server equality check');
  assert.deepEqual(diagnostic.statuses,['done','done'],'explicit safe cleanup retires every duplicate');
  assert.equal(diagnostic.spreadUnchanged,true,'safe cleanup does not change spread or current photo');
  assert.equal(diagnostic.onlyGets,true,'safe cleanup uses only read-only spread GET requests');
  assert.equal(diagnostic.syncCalls,0,'opening diagnostics does not start fullSync');
  const historyUnread = await page.evaluate(async () => {
    const originalApi = api;
    settings.backend_url = 'https://history-test.invalid'; settings.user_id = 'u1';
    settings.team_capabilities = {scope:window.vNextSync.scope(),flags:{activity:true,activity_seen:true,activity_spread_seen:true}};
    const scope = window.vNextSync.scope();
    const rows = [
      {id:'unread-20',seq:20,spread_id:'remote-s1'},
      {id:'read-19',seq:19,spread_id:'remote-s2'},
      {id:'unread-18',seq:18,spread_id:null},
      {id:'read-9',seq:9,spread_id:'remote-s1'},
    ].map(row => ({...row,cache_id:scope+'|'+row.id,scope,notebook_id:'remote-nb',
      actor_display_name:'Участник',action:'spread.updated',created_at:'2026-09-24T12:00:00Z'}));
    for (const row of rows) await put('activity_events',row);
    let cursors={notebooks:{'remote-nb':10},spreads:{'remote-s1':10,'remote-s2':19}};
    let unread={notebooks:{'remote-nb':{count:2,max_seq:20}},spreads:{'remote-s1':{count:1,max_seq:20}},total:2};
    api=async (path,options) => {
      if(path==='/api/activity/read-cursors') return {cursors:structuredClone(cursors)};
      if(path==='/api/activity/unread') return {unread:structuredClone(unread)};
      if(path.includes('/activity/seen') && options?.method==='PUT') {
        cursors={notebooks:{'remote-nb':20},spreads:{'remote-s1':20,'remote-s2':20}};
        unread={notebooks:{},spreads:{},total:0};
        return {unread:structuredClone(unread)};
      }
      if(path.includes('/activity?')) return {events:[],legacy_events:[]};
      return originalApi(path,options);
    };
    await window.v340ApplyUnread(unread);
    await window.v340OpenGlobalHistory();
    const state = () => ({ids:[...document.querySelectorAll('[data-server-history] .v340-history-row')]
      .map(item => item.dataset.eventId),
      unread:[...document.querySelectorAll('[data-server-history] .v340-history-unread')].length,
      dots:[...document.querySelectorAll('[data-server-history] .v340-history-unread-dot')].length,
      badge:document.querySelector('#v340HistoryButton .v340-history-badge')?.textContent || null});
    const before=state();
    const button=document.querySelector('[data-mark-all]');await button.onclick({target:button});
    const after=state();
    document.querySelector('[data-history-close]')?.click();
    api=originalApi;
    return {before,after,scope};
  });
  assert.equal(historyUnread.before.badge,'2');
  assert.equal(historyUnread.before.unread,2);
  assert.equal(historyUnread.before.dots,2);
  assert.deepEqual(historyUnread.before.ids,['unread-20','unread-18','read-19','read-9'],
    'unread first, newest first inside both groups');
  assert.equal(historyUnread.after.badge,null,'mark all hides the badge');
  assert.equal(historyUnread.after.unread,0,'mark all clears unread markers');
  assert.equal(historyUnread.after.dots,0);
  await page.reload();
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof db !== 'undefined');
  const historyReload = await page.evaluate(async expectedScope => {
    const originalApi=api;
    fullSync=async()=>{};
    const cursors={notebooks:{'remote-nb':20},spreads:{'remote-s1':20,'remote-s2':20}};
    let unread={notebooks:{},spreads:{},total:0};
    api=async (path,options) => {
      if(path==='/api/activity/read-cursors') return {cursors:structuredClone(cursors)};
      if(path==='/api/activity/unread') return {unread:structuredClone(unread)};
      if(path.includes('/activity/seen') && options?.method==='PUT') {
        cursors.notebooks['remote-nb']=21;
        unread={notebooks:{},spreads:{},total:0};
        return {unread:structuredClone(unread)};
      }
      if(path.includes('/activity?')) return {events:[],legacy_events:[]};
      return originalApi(path,options);
    };
    const scope=window.vNextSync.scope();
    await window.v340OpenGlobalHistory();
    const persisted={scope,storedScope:settings.activity_read_cursors?.scope,
      unread:document.querySelectorAll('[data-server-history] .v340-history-unread-dot').length,
      badge:document.querySelector('#v340HistoryButton .v340-history-badge')?.textContent || null};
    document.querySelector('[data-history-close]')?.click();
    const row={id:'new-21',cache_id:scope+'|new-21',scope,notebook_id:'remote-nb',spread_id:null,seq:21,
      actor_display_name:'Участник',action:'notebook.updated',created_at:'2026-09-24T13:00:00Z'};
    await put('activity_events',row);
    unread={notebooks:{'remote-nb':{count:1,max_seq:21,level:1}},spreads:{},total:1};
    await window.v340ApplyUnread(unread);
    await window.v340OpenGlobalHistory();
    const first=document.querySelector('[data-server-history] .v340-history-row');
    const fresh={id:first?.dataset.eventId,dots:document.querySelectorAll('[data-server-history] .v340-history-unread-dot').length,
      badge:document.querySelector('#v340HistoryButton .v340-history-badge')?.textContent || null};
    const button=first?.querySelector('[data-mark-notebook]');
    if(button) button.click();
    await new Promise(resolve=>setTimeout(resolve,80));
    const notebook={badge:document.querySelector('#v340HistoryButton .v340-history-badge')?.textContent || null,
      dots:document.querySelectorAll('[data-server-history] .v340-history-unread-dot').length};
    document.querySelector('[data-history-close]')?.click();
    api=originalApi;
    return {expectedScope,persisted,fresh,notebook};
  },historyUnread.scope);
  assert.equal(historyReload.persisted.scope,historyUnread.scope);
  assert.equal(historyReload.persisted.storedScope,historyUnread.scope);
  assert.equal(historyReload.persisted.unread,0,'read state survives reload');
  assert.equal(historyReload.persisted.badge,null);
  assert.deepEqual(historyReload.fresh,{id:'new-21',dots:1,badge:'1'},'one later event is unread and first');
  assert.deepEqual(historyReload.notebook,{badge:null,dots:0},'read whole notebook refreshes global badge');

  // ---- Production case: unread events of a DELETED notebook (seq 835 / 819) must be visible ----
  const deletedHistory = await page.evaluate(async () => {
    const originalApi = api; const calls = [];
    fullSync = async () => {}; // no background interference for this deterministic snapshot
    const scope = window.vNextSync.scope();
    await put('notebooks', {id:'nbX', server_id:'remote-nbX', title:'Удалённый старый блокнот',
      deleted_at:'2026-09-24T20:00:00.000Z', updated_at:'2026-09-24T20:00:00.000Z', revision:3});
    const base = {scope, notebook_id:'remote-nbX', actor_display_name:'Участник', created_at:'2026-09-24T12:00:00Z'};
    // mirrors production seq 835 (notebook.deleted) and seq 819 (spread.deleted)
    await put('activity_events', {...base, cache_id:scope+'|ev-nb-del', id:'ev-nb-del', seq:835,
      spread_id:null, action:'notebook.deleted', notebook_title:'Общий'});
    await put('activity_events', {...base, cache_id:scope+'|ev-sp-del', id:'ev-sp-del', seq:819,
      spread_id:'srv-sp-gone', action:'spread.deleted'}); // no spread row and no spread_number
    await put('activity_events', {scope, cache_id:scope+'|act-830', id:'act-830', seq:830,
      notebook_id:'remote-nb', spread_id:'remote-s1', action:'spread.updated',
      actor_display_name:'Участник', created_at:'2026-09-24T12:30:00Z'});
    let cursors = {notebooks:{'remote-nbX':795,'remote-nb':900}, spreads:{'srv-sp-gone':818,'remote-s1':829,'remote-s2':900}};
    let unread = {notebooks:{'remote-nbX':{count:2,max_seq:835},'remote-nb':{count:1,max_seq:830}},spreads:{},total:3};
    api = async (path, options) => {
      calls.push(path);
      if (path === '/api/activity/read-cursors') return {cursors:structuredClone(cursors)};
      if (path === '/api/activity/unread') return {unread:structuredClone(unread)};
      if (path.includes('/activity/seen') && options?.method === 'PUT') {
        cursors = {notebooks:{'remote-nbX':900,'remote-nb':900}, spreads:{'srv-sp-gone':900,'remote-s1':900,'remote-s2':900}};
        unread = {notebooks:{},spreads:{},total:0};
        return {unread:structuredClone(unread)};
      }
      if (path.includes('/activity?')) return {events:[],legacy_events:[]};
      return originalApi(path, options);
    };
    await window.v340ApplyUnread(unread);
    await window.v340OpenGlobalHistory();
    const rowById = id => document.querySelector(`[data-server-history] .v340-history-row[data-event-id="${id}"]`);
    const state = () => ({
      ids:[...document.querySelectorAll('[data-server-history] .v340-history-row')].map(item => item.dataset.eventId).slice(0, 5),
      dots:document.querySelectorAll('[data-server-history] .v340-history-unread-dot').length,
      badge:document.querySelector('#v340HistoryButton .v340-history-badge')?.textContent || null,
      nbRow:(() => { const row = rowById('ev-nb-del'); return row ? {text:row.textContent, open:!!row.querySelector('[data-open]'), mark:!!row.querySelector('[data-mark-notebook]')} : null; })(),
      spRow:(() => { const row = rowById('ev-sp-del'); return row ? {text:row.textContent, open:!!row.querySelector('[data-open]'), mark:!!row.querySelector('[data-mark-notebook]')} : null; })()
    });
    const before = state();
    // mark all read must clear the deleted-notebook unread too (cursor endpoints exist for it)
    const markButton = document.querySelector('[data-mark-all]');
    await markButton.onclick({target:markButton});
    const after = state();
    // the deleted-notebook journal must be requested too
    const fetchedDeleted = calls.some(path => path.startsWith('/api/notebooks/remote-nbX/activity'));
    document.querySelector('[data-history-close]')?.click();
    api = originalApi;
    return {before, after, fetchedDeleted};
  });
  // A/B/C: deleted notebook + deleted spread unread events are visible and counted
  assert.equal(deletedHistory.before.badge, '3', 'badge counts deleted notebook events (2) + active event (1)');
  assert.ok(deletedHistory.before.ids.includes('ev-nb-del'), 'deleted notebook event is visible in History');
  assert.ok(deletedHistory.before.ids.includes('ev-sp-del'), 'deleted spread event is visible in History');
  assert.equal(deletedHistory.before.dots, 3, 'unread dots present on all unread events');
  // I: unread-first + newest-first across active and deleted entities
  assert.deepEqual(deletedHistory.before.ids.slice(0, 3), ['ev-nb-del', 'act-830', 'ev-sp-del'],
    'unread first, all three unread rows sorted by seq desc');
  // labels: server-preserved notebook title wins; neutral fallbacks are used otherwise
  assert.ok(deletedHistory.before.nbRow.text.includes('Общий'), 'server notebook title is shown');
  assert.ok(deletedHistory.before.spRow.text.includes('Удалённый блокнот'), 'neutral notebook fallback is shown');
  assert.ok(deletedHistory.before.spRow.text.includes('Удалённый разворот'), 'neutral spread fallback is shown');
  // G: no Open navigation for deleted/missing entities; mark-whole-notebook stays available
  assert.equal(deletedHistory.before.spRow.open, false, 'no Open button for a deleted spread');
  assert.equal(deletedHistory.before.nbRow.open, false, 'no Open button without a living spread');
  assert.equal(deletedHistory.before.nbRow.mark, true, 'mark-whole-notebook stays clickable for the deleted notebook');
  assert.equal(deletedHistory.fetchedDeleted, true, 'journal of the deleted notebook is fetched into the cache');
  // D: mark all clears badge and dots
  assert.equal(deletedHistory.after.badge, null, 'mark all clears the badge');
  assert.equal(deletedHistory.after.dots, 0, 'mark all clears unread dots');

  // E: read state survives reload, and F: a NEW deleted event becomes unread again
  await page.reload();
  await page.waitForFunction(() => typeof window.vNextSync !== 'undefined' && typeof db !== 'undefined');
  const deletedReload = await page.evaluate(async () => {
    const originalApi = api;
    fullSync = async () => {};
    let cursors = {notebooks:{'remote-nbX':900,'remote-nb':900}, spreads:{'srv-sp-gone':900,'remote-s1':900,'remote-s2':900}};
    let unread = {notebooks:{},spreads:{},total:0};
    api = async (path, options) => {
      if (path === '/api/activity/read-cursors') return {cursors:structuredClone(cursors)};
      if (path === '/api/activity/unread') return {unread:structuredClone(unread)};
      if (path.includes('/activity?')) return {events:[],legacy_events:[]};
      return originalApi(path, options);
    };
    await window.v340ApplyUnread(unread);
    await window.v340OpenGlobalHistory();
    const persisted = {
      dots:document.querySelectorAll('[data-server-history] .v340-history-unread-dot').length,
      badge:document.querySelector('#v340HistoryButton .v340-history-badge')?.textContent || null};
    document.querySelector('[data-history-close]')?.click();
    // F: a later event on the deleted notebook becomes unread again and pins on top (I)
    const scope = window.vNextSync.scope();
    await put('activity_events', {scope, cache_id:scope+'|ev-nb-del-2', id:'ev-nb-del-2', seq:836,
      notebook_id:'remote-nbX', spread_id:null, action:'notebook.deleted', notebook_title:'Общий',
      actor_display_name:'Участник', created_at:'2026-09-24T13:00:00Z'});
    cursors.notebooks['remote-nbX'] = 835;
    unread = {notebooks:{'remote-nbX':{count:1,max_seq:836}},spreads:{},total:1};
    await window.v340ApplyUnread(unread);
    await window.v340OpenGlobalHistory();
    const first = await (async () => {
      for (let i = 0; i < 40; i++) {
        const row = document.querySelector('[data-server-history] .v340-history-row');
        if (row) return row;
        await new Promise(r => setTimeout(r, 50));
      }
      return document.querySelector('[data-server-history] .v340-history-row');
    })();
    const fresh = {id:first?.dataset.eventId,
      dots:document.querySelectorAll('[data-server-history] .v340-history-unread-dot').length,
      badge:document.querySelector('#v340HistoryButton .v340-history-badge')?.textContent || null};
    document.querySelector('[data-history-close]')?.click();
    api = originalApi;
    return {persisted, fresh};
  });
  assert.equal(deletedReload.persisted.dots, 0, 'E: read state survives reload');
  assert.equal(deletedReload.persisted.badge, null, 'E: badge stays clear after reload');
  assert.deepEqual(deletedReload.fresh, {id:'ev-nb-del-2', dots:1, badge:'1'},
    'F: a new event on the deleted notebook is unread again and first');
  // requirement 4: the deleted notebook never reappears in the main lists
  const lists = await page.evaluate(async () => {
    const row = await get('notebooks', 'nbX');
    return {deleted:!!row.deleted_at, route:JSON.parse(JSON.stringify(route || null))};
  });
  assert.equal(lists.deleted, true, 'deleted notebook stays deleted locally (no resurrection)');

  assert.deepEqual(errors,[]);
  console.log('team-runtime: PASS (v2→v3/reopen, IDB rollback, shared notes, metadata, photo safety, reorder, history, fullscreen/viewer Back; Chromium mobile viewport)');
} finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
