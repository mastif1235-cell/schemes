import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app-v3-manifest.json'), 'utf8'));
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert.equal(manifest.version, '3.4.0');
assert.ok(manifest.files.length > 0);
for (const entry of manifest.files) {
  const content = fs.readFileSync(path.join(root, entry.path), 'utf8').replace(/\r\n?/g, '\n');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  assert.equal(hash, entry.sha256, `${entry.path} hash mismatch`);
  assert.ok(sw.includes(`'./${entry.path}'`), `${entry.path} is missing from Service Worker shell`);
}

assert.match(index, /Promise\.all\(manifest\.files\.map/);
assert.match(index, /actual !== entry\.sha256/);
assert.doesNotMatch(index, /const fixes = await fetchTextWithOfflineFallback/);

const chunks = ['chunk1.txt', 'chunk2.txt', 'chunk3.txt', 'chunk4.txt'];
const base64 = chunks.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('').trim();
let html = zlib.gunzipSync(Buffer.from(base64, 'base64')).toString('utf8');
const runtime = [];
for (const entry of manifest.files) {
  if (chunks.includes(entry.path)) continue;
  const content = fs.readFileSync(path.join(root, entry.path), 'utf8');
  runtime.push(entry.path === 'v3-enhancements.txt'
    ? zlib.gunzipSync(Buffer.from(content.trim(), 'base64')).toString('utf8')
    : content);
}
const marker = '// ===================== INIT =====================';
assert.ok(html.includes(marker));
html = html.replace(marker, `window.__BLOCKNOT_APP_VERSION__ = ${JSON.stringify(manifest.version)};\n\n${runtime.join('\n\n')}\n\n${marker}`);
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert.ok(scripts.length > 0);
for (const script of scripts) new vm.Script(script);

console.log('runtime-integrity: PASS');
