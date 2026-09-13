import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'version.json');
const outputPath = path.join(root, 'version.js');
const version = JSON.parse(fs.readFileSync(sourcePath, 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('version.json must contain a semantic version like "3.4.2"');
  process.exit(1);
}
const output = '/* Generated from version.json by tools/build-version.mjs. Do not edit. */\n'
  + `self.__BLOCKNOT_VERSION__ = ${JSON.stringify(version)};\n`;

if (process.argv.includes('--check')) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').replace(/\r\n?/g, '\n') : '';
  if (current !== output) {
    console.error('version.js is not generated from version.json');
    process.exit(1);
  }
  console.log('version: PASS');
} else {
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log('Generated version.js');
}
