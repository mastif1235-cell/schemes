import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {extname} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH?pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href:'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const old='b594462';
const oldManifest=JSON.parse(execFileSync('git',['show',old+':app-v3-manifest.json'],{cwd:root}));
const names=['index.html','sw.js','version.js','version.json','manifest.json','icon.svg','app-v3-manifest.json',...oldManifest.files.map(r=>r.path)];
const oldFiles=new Map(names.map(name=>[name,execFileSync('git',['show',old+':'+name],{cwd:root})]));
let phase='old';
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const name=path==='/'?'index.html':path.slice(1);
  if(!names.includes(name)){res.writeHead(404).end();return;}
  if(phase==='missing'&&name==='v3-photos.js'){res.writeHead(503).end();return;}
  let body=phase==='old'?oldFiles.get(name):readFileSync(new URL('../'+name,import.meta.url));
  if(name==='sw.js')body=Buffer.concat([body,Buffer.from('\n// phase '+phase)]);
  if(phase==='mixed'&&name==='v3-sync.js')body=Buffer.concat([body,Buffer.from('\n// mixed asset')]);
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.json':'application/json','.txt':'text/plain','.svg':'image/svg+xml'})[extname(name)]||'text/plain');
  res.end(body);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext();
  const page=await context.newPage();let navigations=0;
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
  await page.goto(origin);
  await page.waitForFunction(()=>navigator.serviceWorker.controller&&typeof db!=='undefined'&&db?.version===3);
  await page.evaluate(async()=>put('blobs',{id:'release-sentinel',blob:new Blob(['keep-data'])}));
  await page.reload();
  await page.waitForFunction(()=>typeof db!=='undefined'&&db?.version===3);
  for(const failedPhase of ['missing','mixed']){
    phase=failedPhase;
    const state=await page.evaluate(async attempt=>{
      const registration=await navigator.serviceWorker.ready;
      const settled=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Update did not settle: '+registration.installing?.state)),15000);
        registration.addEventListener('updatefound',()=>{
        const installing=registration.installing;
        installing.addEventListener('statechange',()=>{if(installing.state==='redundant'||installing.state==='activated'){clearTimeout(timer);resolve(installing.state);}});
      },{once:true});});
      await navigator.serviceWorker.register('sw.js?attempt='+attempt,{updateViaCache:'none'});return settled;
    },failedPhase).catch(error=>{throw new Error(failedPhase+': '+error.message);});
    assert.equal(state,'redundant',failedPhase+' release must not replace old worker');
    assert.equal(await page.evaluate(()=>window.__BLOCKNOT_APP_VERSION__),'3.4.7');
  }
  phase='new';
  await page.evaluate(async()=>{await navigator.serviceWorker.register('sw.js',{updateViaCache:'none'});});
  const release=JSON.parse(readFileSync(new URL('../version.json',import.meta.url))).version;
  await page.waitForFunction(release=>window.__BLOCKNOT_APP_VERSION__===release&&typeof db!=='undefined'&&db?.version===3,release);
  assert.ok(navigations<=4,'update must not reload indefinitely');
  await context.setOffline(true);await page.reload();
  await page.waitForFunction(release=>window.__BLOCKNOT_APP_VERSION__===release&&typeof db!=='undefined'&&db?.version===3,release);
  assert.equal(await page.evaluate(async()=>(await get('blobs','release-sentinel')).blob.text()),'keep-data');
  assert.ok((await page.evaluate(()=>caches.keys())).includes('blocknot-shell-v'+release));
  await context.close();
  console.log('release-update: PASS (old SW, missing/mixed release rejection, upgrade, offline restart, data preservation)');
}finally{await browser?.close();await new Promise(done=>server.close(done));}
