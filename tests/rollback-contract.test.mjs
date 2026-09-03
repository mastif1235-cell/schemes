import assert from 'node:assert/strict';import crypto from 'node:crypto';import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','rollback','v3.4.2-compatible');
const info=JSON.parse(fs.readFileSync(path.join(root,'ROLLBACK_INFO.json'),'utf8'));
assert.equal(info.base_commit,'0a3ee7705178e813cc6b68ba2905c96df4ea4abb');assert.equal(info.version,'3.4.2');
const rows=info.files.map(file=>`${file}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}`);
assert.equal(crypto.createHash('sha256').update(rows.join('\n')).digest('hex'),info.tree_sha256);
const app=zlib.gunzipSync(Buffer.from(['chunk1.txt','chunk2.txt','chunk3.txt','chunk4.txt'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('').trim(),'base64')).toString();
const repo=path.resolve(root,'../..'),baseChunks=['chunk1.txt','chunk2.txt','chunk3.txt','chunk4.txt'].map(file=>execFileSync('git',['show',`${info.base_commit}:${file}`],{cwd:repo}).toString().trim());
const stable=zlib.gunzipSync(Buffer.from(baseChunks.join(''),'base64')).toString();
const expected=stable.replace('const req = indexedDB.open(DB_NAME, DB_VER);','const req = indexedDB.open(DB_NAME);')
  .replace('req.onsuccess = ()=>{ db = req.result; res(db); };','req.onsuccess = ()=>{ db = req.result; db.onversionchange = ()=>db.close(); res(db); };');
assert.equal(app,expected,'rollback runtime must otherwise be byte-for-byte stable v3.4.2');
assert.match(app,/indexedDB\.open\(DB_NAME\)/);assert.doesNotMatch(app,/indexedDB\.open\(DB_NAME,\s*DB_VER\)/);
assert.match(app,/db\.onversionchange\s*=\s*\(\)=>db\.close\(\)/);
for(const store of ['notebooks','spreads','photos','tags','spread_tags','history','sync_queue','settings','blobs','user_favorites'])assert.ok(app.includes(`'${store}'`));
assert.match(fs.readFileSync(path.join(root,'sw.js'),'utf8'),/rollback-compatible/);
console.log('rollback-contract: PASS',info.tree_sha256);
