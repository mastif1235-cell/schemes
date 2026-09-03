// Local-only manual/runtime fallback when sandbox policy prevents Chromium spawn.
// No production URL, account or DB is used. Each server gets a unique fixture DB name.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
const read = name => readFileSync(new URL('../'+name,import.meta.url),'utf8');
const manifest = JSON.parse(read('app-v3-manifest.json'));
let html = gunzipSync(Buffer.from([1,2,3,4].map(n=>read(`chunk${n}.txt`)).join(''),'base64')).toString();
const fixtureName = 'blocknot-fixture-' + randomUUID();
html = html.replace(/DB_NAME\s*=\s*'blocknotDB'/,`DB_NAME = '${fixtureName}'`);
if (!html.includes(fixtureName) || /DB_NAME\s*=\s*'blocknotDB'/.test(html)) throw new Error('Fixture DB isolation failed');
const scripts = manifest.files.filter(entry=>!entry.path.startsWith('chunk')).map(entry=>entry.path==='v3-enhancements.txt' ? gunzipSync(Buffer.from(read(entry.path).trim(),'base64')).toString() : read(entry.path)).join('\n');
const fixture = readFileSync(new URL('./team-preview-fixture.js',import.meta.url),'utf8');
html = html.replace('// ===================== INIT =====================',`const fixtureV2Open = openDB;\n${scripts}\n// ===================== INIT =====================`);
const begin = html.indexOf('(async function init(){');
html = html.slice(0,begin)+fixture+'</script></body></html>';
const server = createServer((req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src 'none'; worker-src 'none'");
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
});
server.listen(0,'127.0.0.1',()=>console.log(`LOCAL_FIXTURE http://127.0.0.1:${server.address().port}/`));
