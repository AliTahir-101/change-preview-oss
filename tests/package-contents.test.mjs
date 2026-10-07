/**
 * Packaging + SW shape:
 * - Classic service worker: background.js has no ES import; manifest has no
 *   background.type module (avoids "unknown error when fetching the script").
 * - panel.js still imports ensure-content-script.js, so that file MUST ship.
 * - A naive copy of content/ + panel/ + icons/ + background.js + manifest
 *   omits ensure-content-script.js and breaks the side panel.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  SHIP_ROOT_FILES,
  collectRelativeImports,
  collectHtmlRefs,
  expandShipList,
  expandNaiveShipList
} from '../scripts/extension-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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

const shipped = expandShipList(readDir, isDir);
const naive = expandNaiveShipList(readDir, isDir);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'panel/panel.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'panel/panel.html'), 'utf8');
const ensureSrc = fs.readFileSync(path.join(ROOT, 'ensure-content-script.js'), 'utf8');

console.log('\nclassic service worker (no module fetch)');
check('manifest version is 0.4.2', manifest.version === '0.4.2', `version=${manifest.version}`);
check('background.service_worker is background.js',
  manifest.background && manifest.background.service_worker === 'background.js');
check('background has no type: module',
  !manifest.background || manifest.background.type == null);
check('background.js has no static import',
  !/\bimport\s+/.test(bg) && !/\bfrom\s+['"]/.test(bg));
check('background.js inlines ensureContentScript',
  /function ensureContentScript\s*\(/.test(bg));
check('no host_permissions', !manifest.host_permissions);
check('no content_scripts', !manifest.content_scripts);
check('permissions are activeTab+scripting+storage+sidePanel',
  JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'storage', 'sidePanel']));

console.log('\ncanonical ship list includes SW + panel helper module');
check('ensure-content-script.js is committed at repo root',
  fs.existsSync(path.join(ROOT, 'ensure-content-script.js')));
check('SHIP_ROOT_FILES lists ensure-content-script.js',
  SHIP_ROOT_FILES.includes('ensure-content-script.js'));
check('shipped set includes ensure-content-script.js',
  shipped.includes('ensure-content-script.js'));
check('shipped set includes background.js (MV3 service worker required)',
  shipped.includes('background.js'));
check('shipped set includes content/content.js',
  shipped.includes('content/content.js'));

console.log('\nnaive folder copy is the pitfall (must not be used)');
check('naive copy (manifest + background + content/panel/icons) omits ensure-content-script.js',
  !naive.includes('ensure-content-script.js'));

console.log('\npanel ES imports are all shipped; SW has none');
const bgImports = collectRelativeImports(bg, 'background.js');
check('background.js relative-import list is empty', bgImports.length === 0,
  JSON.stringify(bgImports));
check('panel.js imports ensure-content-script.js',
  collectRelativeImports(panel, 'panel/panel.js').includes('ensure-content-script.js'));

const needed = new Set([
  ...collectRelativeImports(panel, 'panel/panel.js'),
  ...collectRelativeImports(ensureSrc, 'ensure-content-script.js'),
  ...collectHtmlRefs(html, 'panel/panel.html')
]);

for (const rel of [...needed].sort()) {
  check(`import/ref ${rel} exists on disk`, fs.existsSync(path.join(ROOT, rel)));
  check(`import/ref ${rel} is in the ship list`, shipped.includes(rel));
}

console.log('\nnpm run stage copies the panel helper module');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-stage-'));
  const dest = path.join(tmp, 'extension');
  const result = spawnSync(process.execPath, ['scripts/stage-extension.mjs', dest], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  check('stage-extension.mjs exits 0', result.status === 0,
    `status=${result.status} stderr=${result.stderr}`);
  check('staged tree contains ensure-content-script.js',
    fs.existsSync(path.join(dest, 'ensure-content-script.js')));
  check('staged tree contains background.js',
    fs.existsSync(path.join(dest, 'background.js')));
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  check('staged manifest has no background.type module',
    !stagedManifest.background.type);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failed === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
} else {
  console.log(`${failed} FAILED, ${passed} passed.`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
