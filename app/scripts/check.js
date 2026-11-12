// Build step: syntax-check every script and make sure the files the app loads are present.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'shots' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error(String(e.stderr || e.message)); }
}
const needed = ['main.js', 'preload.js', 'renderer/index.html', 'renderer/mirror.html', 'renderer/sender/sender.html', 'mechanics.json'];
for (const n of needed) if (!fs.existsSync(path.join(root, n))) { failed++; console.error('missing ' + n); }
JSON.parse(fs.readFileSync(path.join(root, 'mechanics.json'), 'utf8'));
if (failed) { console.error(`${failed} problem(s)`); process.exit(1); }
console.log(`checked ${files.length} scripts, all good`);
