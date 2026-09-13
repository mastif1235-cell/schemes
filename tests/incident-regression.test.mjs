// Disposable Chromium profiles and synthetic data only. No production API access.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH?pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href:'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const requests=[];
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push(url.pathname+url.search);
  const file=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(resolve(root)+sep)){res.writeHead(403).end();return;}
  try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.json':'application/json','.txt':'text/plain'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));}
  catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:412,height:915}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(()=>typeof db!=='undefined'&&db?.version===3&&typeof window.vNextSync!=='undefined');
  assert.equal(requests.filter(p=>p==='/app-v3-manifest.json').length,1,'metadata fetched once without TDZ fallback');
  assert.equal(requests.filter(p=>p==='/version.json').length,1);
  const result=await page.evaluate(async()=>{
    settings.backend_url=location.origin;settings.user_id='owner';settings.auth_token='synthetic';
    settings.team_capabilities={scope:window.vNextSync.scope(),flags:{team_notes:true,activity:true,activity_seen:true,activity_spread_seen:true,notebook_cover:true}};
    await put('notebooks',{id:'nb',server_id:'server-nb',title:'Notebook',cover_revision:1,cover_state_known:true});
    await put('spreads',{id:'sp',server_id:'server-sp',notebook_id:'nb',number:1,title:'Spread'});
    await put('blobs',{id:window.v340CoverBlobId('nb'),blob:new Blob(['old']),cover_revision:1});
    apiBlob=async()=>{throw new Error('synthetic download failure');};
    await window.v340ApplyServerCover(await get('notebooks','nb'),{notebook_id:'server-nb',revision:2});
    const failed=await get('notebooks','nb');
    const previous=await (await get('blobs',window.v340CoverBlobId('nb'))).blob.text();
    api=async()=>({cover:{notebook_id:'server-nb',revision:2}});
    apiBlob=async()=>new Blob(['new']);
    await window.v340RetryCovers();
    const retried=await get('notebooks','nb');
    const current=await (await get('blobs',window.v340CoverBlobId('nb'))).blob.text();
    await put('notebooks',{...retried,cover_retry:true});
    api=async()=>({cover:{notebook_id:'server-nb',revision:3,deleted_at:'2026-09-13T00:00:00Z'}});
    await window.v340RetryCovers();
    const deleted=await get('notebooks','nb');
    const removed=!(await get('blobs',window.v340CoverBlobId('nb')));
    fullSync=async()=>{};
    await window.vNextSync.saveNote(await get('spreads','sp'),'local unsent');
    const note=(await getAll('spread_notes'))[0];
    let unreadFetches=0;
    api=async path=>{
      if(path.endsWith('/notes'))return {notes:[{...note,body:'stale remote',pending:false}]};
      if(path==='/api/activity/unread'){unreadFetches++;return {unread:{notebooks:{},spreads:{},total:0}};}
      return {events:[],legacy_events:[]};
    };
    await window.v340OpenSpread(await get('spreads','sp'));
    await new Promise(done=>setTimeout(done,100));
    const preserved=await get('spread_notes',note.cache_id);
    const refreshBefore=unreadFetches;
    window.BlocknotV3.emit('sync-complete');
    await new Promise(done=>setTimeout(done,100));
    document.querySelector('.viewer')?.remove();
    let unread={notebooks:{'server-nb':{count:1,max_seq:10,level:0}},spreads:{'never-cached':{count:1,max_seq:10}},total:1};
    const seenCalls=[];
    api=async(path,opts)=>{
      if(path==='/api/activity/unread')return {unread};
      if(path.endsWith('/activity/seen')){seenCalls.push(opts.json);unread={notebooks:{},spreads:{},total:0};return {unread};}
      return {events:[],legacy_events:[]};
    };
    await window.v340OpenGlobalHistory();
    document.querySelector('[data-mark-all]').click();
    await new Promise(done=>setTimeout(done,100));
    const readAll=settings.unread_total;
    document.querySelector('.sheet-backdrop')?.remove();
    unread={notebooks:{'server-nb':{count:1,max_seq:11}},spreads:{},total:1};
    api=async(path)=>{
      if(path==='/api/activity/unread')return {unread};
      if(path.endsWith('/activity/seen'))throw new Error('synthetic seen failure');
      return {events:[],legacy_events:[]};
    };
    await window.v340OpenGlobalHistory();document.querySelector('[data-mark-all]').click();
    await new Promise(done=>setTimeout(done,100));
    return {failedRevision:failed.cover_revision,retry:failed.cover_retry,previous,newRevision:retried.cover_revision,current,
      deleted:deleted.cover_deleted_at,removed,preserved:preserved.body,pending:preserved.pending,
      refreshBefore,refreshAfter:unreadFetches,seenCalls,readAll,failedSeenCount:settings.unread_total};
  });
  assert.equal(result.failedRevision,1);assert.equal(result.retry,true);assert.equal(result.previous,'old');
  assert.equal(result.newRevision,2);assert.equal(result.current,'new');assert.ok(result.deleted);assert.equal(result.removed,true);
  assert.equal(result.preserved,'local unsent');assert.equal(result.pending,true);
  assert.equal(result.refreshBefore,1);assert.equal(result.refreshAfter,1,'sync rendering must not cause unread refetch loop');
  assert.deepEqual(result.seenCalls,[{all_spreads:true}]);assert.equal(result.readAll,0);assert.equal(result.failedSeenCount,1);
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('incident-regression: PASS (loader, real IDB cover retry/tombstone, pending notes, refetch, server read-all failures)');
}finally{await browser?.close();await new Promise(done=>server.close(done));}
