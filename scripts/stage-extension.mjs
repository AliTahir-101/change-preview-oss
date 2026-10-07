#!/usr/bin/env node
/**
 * Stage the unpacked Chrome extension (CWS zip / Load unpacked).
 *
 * Copies every file in the canonical ship list, including
 * ensure-content-script.js (imported by panel/panel.js). A folder-only copy
 * of content/ + panel/ + icons/ + background.js is not enough.
 *
 * Usage:
 *   node scripts/stage-extension.mjs [destDir]
 *   npm run stage
 *
 * Default dest: dist/extension
 * Omit tests/, fixtures/, worker/, docs, node_modules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandShipList } from './extension-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destArg = process.argv[2];
const DEST = destArg
  ? path.resolve(destArg)
  : path.join(ROOT, 'dist', 'extension');

function readDir(rel) {
  return fs.readdirSync(path.join(ROOT, rel));
}

function isDir(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).isDirectory();
  } catch {
    return false;
  }
}

const files = expandShipList(readDir, isDir);

if (!files.includes('ensure-content-script.js')) {
  throw new Error(
    'Ship list is missing ensure-content-script.js. panel/panel.js imports it; omitting it breaks the side panel.'
  );
}
if (!files.includes('background.js')) {
  throw new Error('Ship list is missing background.js. MV3 requires a service worker; do not remove it.');
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

for (const rel of files) {
  const from = path.join(ROOT, rel);
  const to = path.join(DEST, rel);
  if (!fs.existsSync(from)) {
    throw new Error(`Shipped file missing from repo: ${rel}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

console.log(`Staged ${files.length} files to ${DEST}`);
for (const rel of files) console.log(`  ${rel}`);
