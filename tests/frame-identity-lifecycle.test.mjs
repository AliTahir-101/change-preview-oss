/**
 * Automated harness for ChangePreview's frame-identity split and detection
 * lifecycle (follow-up to the top-level-only identity gate).
 *
 * Verifies, inside jsdom (top frame):
 *   - Sub-frame detections forwarded via the cross-frame message protocol are
 *     merged into the top frame's aggregated report (so iframe forms surface),
 *     and are dropped on a GONE message or when their heartbeat goes stale.
 *   - When a tracked field's element is detached from the DOM (modal/overlay
 *     closed), it is pruned from the baseline so the panel can clear stale rows.
 *   - clearBaselineLocal() stops detections until the next real user input.
 *
 * chrome is stubbed (runtime + storage) and offsetParent is shimmed because
 * jsdom does not lay out elements.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'content', 'content.js'), 'utf8');

// Must match CP_FRAME_TAG in content.js.
const CP_FRAME_TAG = '__changepreview_frame__';

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

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
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
  return { window, document: window.document, internals };
}

/* ------------------------------------------------------------------ */
console.log('\nframe aggregation: sub-frame reports merge into the top frame');
{
  const { internals } = loadHarness('<!DOCTYPE html><body><form><input name="top1" value="x"></form></body>');

  check('this frame is treated as the top frame', internals.IS_TOP_FRAME === true);

  internals.snapshotBaseline();
  const own = internals.getLocalReport();
  check('top frame starts with no own dirty rows', own.dirty.length === 0,
    `got ${own.dirty.length}`);

  // Simulate a sub-frame forwarding one dirty field.
  internals.handleFrameMessage({
    source: {},
    data: {
      [CP_FRAME_TAG]: true,
      kind: 'FIELDS',
      uid: 'sub1',
      dirty: [{ key: 'frame:sub1:name:email', label: 'Work email', type: 'text', was: 'a@x.com', now: 'b@x.com' }],
      allFieldKeys: ['frame:sub1:name:email'],
      coverage: { tracked: 1, total: 1, skipped: 0 }
    }
  });

  let agg = internals.getAggregatedReport();
  check('aggregated report includes the sub-frame row', agg.dirty.some(d => d.label === 'Work email'),
    `dirty: ${JSON.stringify(agg.dirty)}`);
  // Own top-level form has one tracked field (top1); the sub-frame adds one more.
  check('aggregated coverage sums own + sub-frame', agg.coverage.tracked === 2,
    `tracked=${agg.coverage.tracked}`);

  // A GONE message (frame removed) drops the sub-frame's rows.
  internals.handleFrameMessage({ source: {}, data: { [CP_FRAME_TAG]: true, kind: 'GONE', uid: 'sub1' } });
  agg = internals.getAggregatedReport();
  check('sub-frame rows cleared after GONE', !agg.dirty.some(d => d.label === 'Work email'));
  check('sub-frame report removed from the map', internals.getSubFrameReports().size === 0);
}

/* ------------------------------------------------------------------ */
console.log('\nframe aggregation: remounted iframe does not duplicate the same field');
{
  const { internals } = loadHarness('<!DOCTYPE html><body></body>');
  internals.snapshotBaseline();

  const row = (uid) => ({
    key: `frame:${uid}:name:email`, label: 'Work email', type: 'text', was: 'a@x.com', now: 'b@x.com'
  });

  internals.handleFrameMessage({
    source: {},
    data: {
      [CP_FRAME_TAG]: true, kind: 'FIELDS', uid: 'oldUid',
      dirty: [row('oldUid')], allFieldKeys: ['frame:oldUid:name:email'],
      coverage: { tracked: 1, total: 1, skipped: 0 }
    }
  });
  internals.handleFrameMessage({
    source: {},
    data: {
      [CP_FRAME_TAG]: true, kind: 'FIELDS', uid: 'newUid',
      dirty: [row('newUid')], allFieldKeys: ['frame:newUid:name:email'],
      coverage: { tracked: 1, total: 1, skipped: 0 }
    }
  });

  const agg = internals.getAggregatedReport();
  const emailRows = agg.dirty.filter((d) => internals.logicalFieldKey(d.key) === 'name:email');
  check('same logical field from two frame UIDs collapses to one dirty row',
    emailRows.length === 1, `rows=${emailRows.length} dirty=${JSON.stringify(agg.dirty)}`);
  check('winning row is the newer frame UID', emailRows[0] && emailRows[0].key === 'frame:newUid:name:email',
    emailRows[0] && emailRows[0].key);
  check('allFieldKeys are unique logical keys',
    agg.allFieldKeys.filter((k) => k === 'name:email').length === 1,
    JSON.stringify(agg.allFieldKeys));
}

/* ------------------------------------------------------------------ */
console.log('\nframe aggregation: stale sub-frames expire (heartbeat TTL)');
{
  const { internals } = loadHarness('<!DOCTYPE html><body></body>');
  internals.snapshotBaseline();

  internals.handleFrameMessage({
    source: {},
    data: {
      [CP_FRAME_TAG]: true, kind: 'FIELDS', uid: 'subStale',
      dirty: [{ key: 'frame:subStale:name:x', label: 'Modal field', type: 'text', was: '1', now: '2' }],
      allFieldKeys: ['frame:subStale:name:x'],
      coverage: { tracked: 1, total: 1, skipped: 0 }
    }
  });
  check('stale test: sub-frame present before expiry', internals.getSubFrameReports().size === 1);

  // Backdate the heartbeat so it is older than the TTL, then prune.
  const rep = internals.getSubFrameReports().get('subStale');
  rep.ts = Date.now() - 60000;
  const changed = internals.pruneStaleSubFrames();
  check('pruneStaleSubFrames reports a change', changed === true);
  check('stale sub-frame expired', internals.getSubFrameReports().size === 0);
}

/* ------------------------------------------------------------------ */
console.log('\nlifecycle: closing a modal (detaching fields) prunes the baseline');
{
  const { document, internals } = loadHarness(
    '<!DOCTYPE html><body><form><input name="keep" value="stays"></form><div id="modal"><input name="modalField" value="orig"></div></body>'
  );
  internals.snapshotBaseline();

  const modalInput = document.querySelector('input[name="modalField"]');
  modalInput.value = 'changed';
  let dirty = internals.getDirtyFields();
  check('modal field detected as dirty while open', dirty.some(d => d.key === 'name:modalField'),
    `dirty: ${JSON.stringify(dirty.map(d => d.key))}`);

  const baselineBefore = internals.getBaseline().size;

  // Close the modal: remove its subtree from the DOM.
  document.getElementById('modal').remove();

  const prunedCount = internals.pruneDetachedBaseline();
  check('pruneDetachedBaseline removes the detached modal field', prunedCount >= 1,
    `pruned ${prunedCount}`);
  check('baseline shrank after modal close', internals.getBaseline().size < baselineBefore);

  dirty = internals.getDirtyFields();
  check('modal field no longer reported as dirty after close',
    !dirty.some(d => d.key === 'name:modalField'),
    `dirty: ${JSON.stringify(dirty.map(d => d.key))}`);
  check('unrelated field is untouched', internals.getBaseline().has('name:keep'));
}

/* ------------------------------------------------------------------ */
console.log('\nlifecycle: clearBaselineLocal stops detections until next input');
{
  const { document, internals } = loadHarness(
    '<!DOCTYPE html><body><form><input name="a" value="1"></form></body>'
  );
  internals.snapshotBaseline();
  document.querySelector('input[name="a"]').value = '2';
  check('dirty before clear', internals.getDirtyFields().length === 1);

  internals.clearBaselineLocal();
  check('no dirty immediately after clearBaselineLocal', internals.getDirtyFields().length === 0);
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
