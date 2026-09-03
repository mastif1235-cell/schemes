import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'rollback', 'v3.4.2-compatible');
assert.ok(output.startsWith(path.join(root, 'rollback') + path.sep));
const baseCommit = '0a3ee7705178e813cc6b68ba2905c96df4ea4abb';
const show = file => execFileSync('git', ['show', `${baseCommit}:${file}`], {cwd:root});
const originalManifest = JSON.parse(show('app-v3-manifest.json').toString('utf8'));
const files = new Set(['index.html','sw.js','manifest.json','icon.svg',...originalManifest.files.map(row=>row.path)]);

fs.rmSync(output, {recursive:true,force:true});
fs.mkdirSync(output, {recursive:true});
for (const file of files) {
  const target = path.join(output,file);
  assert.ok(target.startsWith(output + path.sep));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,show(file));
}

const chunkNames = ['chunk1.txt','chunk2.txt','chunk3.txt','chunk4.txt'];
const oldChunks = chunkNames.map(name=>show(name).toString('utf8').trim());
let app = zlib.gunzipSync(Buffer.from(oldChunks.join(''),'base64')).toString('utf8');
const openNeedle = 'const req = indexedDB.open(DB_NAME, DB_VER);';
const successNeedle = 'req.onsuccess = ()=>{ db = req.result; res(db); };';
assert.equal(app.split(openNeedle).length,2,'expected one stable DB opener');
assert.equal(app.split(successNeedle).length,2,'expected one stable DB success handler');
app = app.replace(openNeedle,'const req = indexedDB.open(DB_NAME);')
  .replace(successNeedle,"req.onsuccess = ()=>{ db = req.result; db.onversionchange = ()=>db.close(); res(db); };");
const compressed = zlib.gzipSync(Buffer.from(app),{level:9,mtime:0});compressed[9]=255;
const encoded = compressed.toString('base64');
let offset=0;
for(let i=0;i<chunkNames.length;i++){
  const length=i===chunkNames.length-1?encoded.length-offset:oldChunks[i].length;
  fs.writeFileSync(path.join(output,chunkNames[i]),encoded.slice(offset,offset+length)+'\n');offset+=length;
}
assert.equal(offset,encoded.length);

let sw=fs.readFileSync(path.join(output,'sw.js'),'utf8');
sw=sw.replace(/const CACHE_NAME\s*=\s*['"][^'"]+['"]/,"const CACHE_NAME = 'blocknot-scan-v3.4.2-rollback-compatible';");
fs.writeFileSync(path.join(output,'sw.js'),sw);
const manifest={...originalManifest,files:originalManifest.files.map(entry=>{
  const text=fs.readFileSync(path.join(output,entry.path),'utf8').replace(/\r\n?/g,'\n');
  return {...entry,sha256:crypto.createHash('sha256').update(text).digest('hex')};
})};
fs.writeFileSync(path.join(output,'app-v3-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const rows=[...files].sort().map(file=>{
  const data=fs.readFileSync(path.join(output,file));return `${file}\0${crypto.createHash('sha256').update(data).digest('hex')}`;
});
const treeSha256=crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
fs.writeFileSync(path.join(output,'ROLLBACK_INFO.json'),JSON.stringify({base_commit:baseCommit,version:'3.4.2',tree_sha256:treeSha256,
  changes:['open IndexedDB without requesting downgrade','close connection on versionchange','use rollback-specific Service Worker cache'],files:[...files].sort()},null,2)+'\n');
console.log(`rollback build: ${output}`);console.log(`rollback tree sha256: ${treeSha256}`);
