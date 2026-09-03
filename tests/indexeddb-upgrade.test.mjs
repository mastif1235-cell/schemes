// Standalone Chromium migration matrix. Uses only disposable browser profiles and synthetic data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const rollbackRoot = resolve(root, 'rollback/v3.4.2-compatible');
const base = gunzipSync(Buffer.from([1, 2, 3, 4]
  .map(number => readFileSync(resolve(root, `chunk${number}.txt`), 'utf8')).join(''), 'base64')).toString();
const oldOpen = base.slice(base.indexOf('function openDB()'), base.indexOf('function tx('));
assert.match(oldOpen, /indexedDB\.open\(DB_NAME, DB_VER\)/);

const types = {'.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.txt':'text/plain', '.svg':'image/svg+xml'};
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/fixture') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><meta charset="utf-8"><title>Disposable IDB fixture</title>');
    return;
  }
  const area = pathname.startsWith('/rollback/') ? rollbackRoot : root;
  const relative = pathname.startsWith('/rollback/') ? pathname.slice('/rollback'.length) : pathname;
  const file = resolve(area, '.' + (relative === '/' ? '/index.html' : relative));
  if (file !== area && !file.startsWith(area + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', (types[extname(file)] || 'application/octet-stream') + '; charset=utf-8');
    response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

async function isolatedContext(browser) {
  const context = await browser.newContext({serviceWorkers:'block'});
  context.on('page', page => page.on('pageerror', error => console.error('IDB page error:', error.message)));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  return context;
}

async function seedV2(page, hold = false) {
  await page.goto(origin + '/fixture');
  await page.evaluate(async ({source, hold}) => {
    const database = await new Function(`const DB_NAME='blocknotDB',DB_VER=2;let db;${source};return openDB()` )();
    const transaction = database.transaction(['notebooks','spreads','photos','blobs','history','settings','sync_queue'], 'readwrite');
    transaction.objectStore('notebooks').put({id:'nb', server_id:'remote-nb', title:'Sentinel notebook', description:'keep', sort_order:0, revision:1});
    transaction.objectStore('spreads').put({id:'spread', server_id:'remote-spread', notebook_id:'nb', number:1, title:'Sentinel spread', revision:1, current_photo_id:'photo'});
    transaction.objectStore('photos').put({id:'photo', spread_id:'spread', version:1, is_current:true, status:'local'});
    transaction.objectStore('blobs').put({id:'photo_orig', blob:new Blob(['sentinel-photo'])});
    transaction.objectStore('history').put({spread_id:'spread', action:'sentinel', created_at:'2026-09-03T00:00:00Z'});
    transaction.objectStore('settings').put({key:'app', theme:'light', auth_token:'synthetic-session', backend_url:'', user_id:'synthetic-user'});
    transaction.objectStore('sync_queue').put({id:'pending-sentinel', entity:'photo', entity_id:'photo', op:'upsert', created_at:'2026-09-03T00:00:00Z'});
    await new Promise((done, fail) => { transaction.oncomplete=done; transaction.onabort=()=>fail(transaction.error); });
    if (hold) window.heldV2 = database; else database.close();
  }, {source:oldOpen, hold});
}

async function waitV3(page) {
  try { await page.waitForFunction(() => typeof db !== 'undefined' && db?.version === 3, null, {timeout:10000}); }
  catch (error) {
    const state=await page.evaluate(async () => ({href:location.href,db:typeof db==='undefined'?'undefined':db?.version,
      openDB:typeof openDB,databases:typeof indexedDB.databases==='function'?await indexedDB.databases():[],body:document.body.innerText.slice(0,300)}));
    throw new Error(`v3 readiness timeout: ${JSON.stringify(state)}`, {cause:error});
  }
}

async function verifySentinels(page, expectedVersion = 3) {
  return page.evaluate(async version => {
    const names = [...db.objectStoreNames];
    const read = (store, key) => new Promise((done, fail) => {
      const request=db.transaction(store).objectStore(store).get(key);
      request.onsuccess=()=>done(request.result); request.onerror=()=>fail(request.error);
    });
    return db.version === version && names.includes('spread_notes') && names.includes('activity_events') &&
      (await read('notebooks','nb'))?.title === 'Sentinel notebook' &&
      (await read('settings','app'))?.auth_token === 'synthetic-session' &&
      (await read('sync_queue','pending-sentinel'))?.entity_id === 'photo' &&
      (await read('blobs','photo_orig'))?.blob.text().then(text => text === 'sentinel-photo');
  }, expectedVersion);
}

let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});

  // Fresh install, cold v2→v3, and reopen after a successful upgrade.
  {
    const context=await isolatedContext(browser), page=await context.newPage();
    await page.goto(origin + '/'); await waitV3(page);
    assert.deepEqual(await page.evaluate(() => [...db.objectStoreNames].filter(name => ['spread_notes','activity_events'].includes(name))), ['activity_events','spread_notes']);
    await context.close();
  }
  {
    const context=await isolatedContext(browser), page=await context.newPage();
    await seedV2(page);
    const started=Date.now(); await page.goto(origin + '/'); await waitV3(page);
    assert.ok(Date.now()-started < 10000, 'closed v2 connection should not cause a long upgrade');
    assert.equal(await verifySentinels(page), true);
    await page.reload(); await waitV3(page); assert.equal(await verifySentinels(page), true);
    await context.close();
  }

  // A genuinely old tab blocks. Closing it lets the pending request continue without reload or data loss.
  {
    const context=await isolatedContext(browser), oldPage=await context.newPage(), featurePage=await context.newPage();
    await seedV2(oldPage, true);
    await featurePage.goto(origin + '/');
    await featurePage.getByText('Другая вкладка держит старую версию базы.', {exact:false}).waitFor({timeout:5000});
    assert.equal(await featurePage.evaluate(() => typeof db !== 'undefined' && db?.version === 3), false);
    await oldPage.close(); await waitV3(featurePage);
    assert.equal(await verifySentinels(featurePage), true);
    await context.close();
  }

  // Two current tabs both release their cached connections on versionchange.
  {
    const context=await isolatedContext(browser), first=await context.newPage(), second=await context.newPage();
    await first.goto(origin + '/'); await waitV3(first);
    await second.goto(origin + '/'); await waitV3(second);
    const upgrader=await context.newPage(); await upgrader.goto(origin + '/fixture');
    const upgraded=await upgrader.evaluate(() => new Promise((done, fail) => {
      const request=indexedDB.open('blocknotDB',4);
      request.onsuccess=()=>{request.result.close();done(true);}; request.onerror=()=>fail(request.error); request.onblocked=()=>done(false);
    }));
    assert.equal(upgraded, true, 'both v3 tabs must close on versionchange');
    await context.close();
  }

  // An aborted/interrupted upgrade leaves v2 intact; the next startup retries cleanly.
  {
    const context=await isolatedContext(browser), page=await context.newPage(); await seedV2(page);
    await page.evaluate(() => new Promise(done => {
      const request=indexedDB.open('blocknotDB',3);
      request.onupgradeneeded=event=>event.target.transaction.abort();
      request.onerror=()=>done(); request.onsuccess=()=>{request.result.close();done();};
    }));
    assert.equal(await page.evaluate(() => new Promise((done, fail) => {
      const request=indexedDB.open('blocknotDB'); request.onsuccess=()=>{const version=request.result.version;request.result.close();done(version);};request.onerror=()=>fail(request.error);
    })), 2);
    await page.goto(origin + '/'); await waitV3(page); assert.equal(await verifySentinels(page), true);
    await context.close();
  }

  // Stable v3.4.2 → feature v3 → rollback-compatible stable: old and new data survive.
  {
    const context=await isolatedContext(browser), page=await context.newPage(); await seedV2(page);
    await page.goto(origin + '/'); await waitV3(page);
    await page.evaluate(() => new Promise((done, fail) => {
      const tx=db.transaction('spread_notes','readwrite');
      tx.objectStore('spread_notes').put({cache_id:'rollback-note',id:'rollback-note',spread_id:'spread',notebook_id:'nb',body:'preserve new store'});
      tx.oncomplete=done;tx.onabort=()=>fail(tx.error);
    }));
    await page.goto(origin + '/rollback/');
    await page.waitForFunction(() => typeof db !== 'undefined' && db?.version === 3, null, {timeout:10000});
    assert.equal(await verifySentinels(page), true);
    assert.equal(await page.evaluate(() => new Promise((done, fail) => {
      const request=db.transaction('spread_notes').objectStore('spread_notes').get('rollback-note');
      request.onsuccess=()=>done(request.result?.body);request.onerror=()=>fail(request.error);
    })), 'preserve new store');
    await context.close();
  }

  console.log('indexeddb-upgrade: PASS (fresh, v2→v3, reopen, blocked old tab, two tabs/versionchange, interrupted retry, rollback-compatible)');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
