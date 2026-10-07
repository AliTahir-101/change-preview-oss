/**
 * Automated harness for ChangePreview's click-to-locate / highlight feature.
 *
 * Verifies, inside jsdom:
 *   - A REVEAL_FIELD message for a top-document field resolves the element and
 *     draws the highlight overlay (data-changepreview-reveal), responding found.
 *   - A missing key responds found:false and draws no overlay.
 *   - A frame-namespaced key is forwarded (not handled locally) → forwarded:true.
 *   - handleFrameMessage CMD REVEAL highlights a field that belongs to this frame
 *     (namespaced with this frame's prefix) and ignores one that doesn't.
 *   - revealFieldLocal re-resolves a re-rendered element (stale baseline ref).
 *
 * chrome is stubbed; the onMessage listener content.js registers is captured so
 * we can drive REVEAL_FIELD end-to-end. scrollIntoView is shimmed (jsdom lacks it).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content', 'content.js'), 'utf8');

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

function loadHarness(html) {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://dashboard.example.com/settings'
  });
  const { window } = dom;
  window.__CHANGEPREVIEW_TEST__ = true;

  if (!window.CSS || typeof window.CSS.escape !== 'function') {
    window.CSS = window.CSS || {};
    window.CSS.escape = (value) => String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => `\\${ch}`);
  }

  // jsdom does not implement scrollIntoView; make it a no-op so content.js runs clean.
  window.HTMLElement.prototype.scrollIntoView = function () {};

  let messageListener = null;
  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { messageListener = fn; } },
      sendMessage() { return { catch() {} }; }
    },
    storage: {
      local: { get(key, cb) { cb({}); }, set(obj, cb) { if (cb) cb(); } },
      onChanged: { addListener() {} }
    }
  };

  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.isConnected ? (this.parentNode || window.document.body) : null; }
  });

  window.eval(CONTENT_JS);
  const internals = window.__changePreviewInternals;
  if (!internals) throw new Error('content.js did not expose test internals');
  return { window, document: window.document, internals, getMessageListener: () => messageListener };
}

const overlay = (document) => document.querySelector('[data-changepreview-reveal]');

/* ------------------------------------------------------------------ */
console.log('\nREVEAL_FIELD message: locate a top-document field');
{
  const { document, internals, getMessageListener } = loadHarness(
    '<!DOCTYPE html><body><form><input name="email" value="a@x.com"><input name="other" value="z"></form></body>'
  );
  internals.snapshotBaseline();
  const listener = getMessageListener();
  check('content.js registered an onMessage listener', typeof listener === 'function');

  let response = null;
  listener({ type: 'REVEAL_FIELD', key: 'name:email' }, {}, (r) => { response = r; });
  check('reveal responds found:true for a real field', response && response.found === true,
    JSON.stringify(response));
  check('highlight overlay is drawn', !!overlay(document));
  check('overlay is visible (opacity 1)', overlay(document) && overlay(document).style.opacity === '1',
    overlay(document) && overlay(document).style.opacity);
  check('overlay does not capture clicks', overlay(document) && overlay(document).style.pointerEvents === 'none');
}

/* ------------------------------------------------------------------ */
console.log('\nREVEAL_FIELD message: missing field fails soft');
{
  const { document, internals, getMessageListener } = loadHarness(
    '<!DOCTYPE html><body><form><input name="email" value="a@x.com"></form></body>'
  );
  internals.snapshotBaseline();
  let response = null;
  getMessageListener()({ type: 'REVEAL_FIELD', key: 'name:does-not-exist' }, {}, (r) => { response = r; });
  check('reveal responds found:false for a missing field', response && response.found === false,
    JSON.stringify(response));
  check('no overlay drawn for a missing field', !overlay(document));
}

/* ------------------------------------------------------------------ */
console.log('\nREVEAL_FIELD message: frame-namespaced key is forwarded');
{
  const { document, internals, getMessageListener } = loadHarness(
    '<!DOCTYPE html><body><form><input name="email" value="a@x.com"></form></body>'
  );
  internals.snapshotBaseline();
  let response = null;
  getMessageListener()({ type: 'REVEAL_FIELD', key: 'frame:f-abc:name:email' }, {}, (r) => { response = r; });
  check('frame-namespaced reveal responds forwarded:true', response && response.forwarded === true,
    JSON.stringify(response));
  check('top frame does not draw its own overlay for a sub-frame key', !overlay(document));
}

/* ------------------------------------------------------------------ */
console.log('\nhandleFrameMessage CMD REVEAL: highlight a field owned by this frame');
{
  const { document, internals } = loadHarness(
    '<!DOCTYPE html><body><form><input name="city" value="Berlin"></form></body>'
  );
  internals.snapshotBaseline();

  // This (top) frame's key prefix is `frame:<FRAME_UID>:`. A matching CMD reveals it.
  const prefix = `frame:${internals.FRAME_UID}:`;
  internals.handleFrameMessage({
    source: {},
    data: { __changepreview_frame__: true, kind: 'CMD', cmd: 'REVEAL', key: `${prefix}name:city`, cmdId: 'rv-1' }
  });
  check('CMD REVEAL with this frame prefix draws the overlay', !!overlay(document));

  // A command for a different frame's prefix must NOT reveal here.
  const { document: doc2, internals: int2 } = loadHarness(
    '<!DOCTYPE html><body><form><input name="city" value="Berlin"></form></body>'
  );
  int2.snapshotBaseline();
  int2.handleFrameMessage({
    source: {},
    data: { __changepreview_frame__: true, kind: 'CMD', cmd: 'REVEAL', key: 'frame:other-uid:name:city', cmdId: 'rv-2' }
  });
  check('CMD REVEAL for a different frame prefix draws nothing', !overlay(doc2));
}

/* ------------------------------------------------------------------ */
console.log('\nrevealFieldLocal re-resolves a re-rendered element');
{
  const { document, internals } = loadHarness(
    '<!DOCTYPE html><body><form id="f"><input name="q1" value="one"></form></body>'
  );
  internals.snapshotBaseline();

  // Simulate a re-render: replace the input node with a fresh one of the same name.
  const form = document.getElementById('f');
  form.innerHTML = '<input name="q1" value="one">';

  const ok = internals.revealFieldLocal('name:q1');
  check('revealFieldLocal finds the re-rendered element', ok === true);
  check('overlay drawn after re-resolution', !!overlay(document));
}

/* ------------------------------------------------------------------ */
console.log('');
if (failed === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
} else {
  console.log(`${failed} FAILED, ${passed} passed.`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
