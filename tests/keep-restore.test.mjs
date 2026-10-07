/**
 * Keep-across-reload: one canonical pageKey → one snapshot.
 *
 * Reproduces the 0.3.3–0.3.6 stacking bug: fingerprint-suffixed storage keys
 * (`<pageKey>#<hash>`) plus ephemeral `frame:<uid>:` dirty keys meant a reload
 * could restore several copies of the same change. Verifies:
 *   - saveDetections writes a single canonical slot and prunes siblings
 *   - load collapses legacy host+path + hash-suffixed keys to one deduped row
 *   - frame-UID variants of the same field become one logical row
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PANEL_HTML = fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8');

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

const store = {};
const chromeStub = {
  runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
  tabs: {
    query() { return Promise.resolve([]); },
    sendMessage() { return Promise.resolve(); },
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  storage: {
    local: {
      get(keys) {
        if (keys == null) return Promise.resolve({ ...store });
        if (typeof keys === 'string') return Promise.resolve({ [keys]: store[keys] });
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = store[k];
          return Promise.resolve(out);
        }
        return Promise.resolve({ ...store });
      },
      set(obj) {
        Object.assign(store, obj);
        return Promise.resolve();
      },
      remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        return Promise.resolve();
      }
    },
    session: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } },
    onChanged: { addListener() {} }
  }
};

const dom = new JSDOM(PANEL_HTML, { url: 'https://panel.invalid/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.chrome = chromeStub;
dom.window.chrome = chromeStub;
dom.window.__CHANGEPREVIEW_TEST__ = true;

await import(pathToFileURL(path.join(ROOT, 'panel', 'panel.js')).href);

const I = dom.window.__changePreviewPanelInternals;
I.setPersistEnabled(true);

const PAGE = 'https://nodes.example/form';
const payload = (dirty, extra = {}) => ({
  host: 'nodes.example',
  path: '/form',
  url: `${PAGE}?utm_source=x`,
  dirty,
  ...extra
});

const detectionKeys = () => Object.keys(store).filter((k) => k.startsWith('cp_detections:'));

/* ------------------------------------------------------------------ */
console.log('\ndedupeDirtyFields: frame-UID copies collapse to one logical row');
{
  const rows = I.dedupeDirtyFields([
    { key: 'frame:uid1:name:q1', label: 'Q1', type: 'text', was: 'a', now: 'b' },
    { key: 'frame:uid2:name:q1', label: 'Q1', type: 'text', was: 'a', now: 'b' },
    { key: 'frame:uid3:name:q1', label: 'Q1', type: 'text', was: 'a', now: 'b' },
    { key: 'name:other', label: 'Other', type: 'text', was: '1', now: '2' }
  ], { stripFramePrefix: true });
  check('three UID variants of q1 become one row', rows.filter((r) => r.key === 'name:q1').length === 1,
    JSON.stringify(rows));
  check('unrelated field is kept', rows.some((r) => r.key === 'name:other'));
  check('stored key has no frame prefix', rows.every((r) => !String(r.key).startsWith('frame:')));
}

/* ------------------------------------------------------------------ */
console.log('\nsaveDetections: one canonical slot; fingerprint variants do not stack');
{
  const dirty = [{ key: 'name:q1', label: 'Q1', type: 'text', was: 'a', now: 'b' }];
  await I.saveDetections(payload(dirty), I.createFingerprint(PAGE, ['name:q1', 'name:a']));
  await I.saveDetections(payload(dirty), I.createFingerprint(PAGE, ['name:q1', 'name:a', 'name:b']));
  await I.saveDetections(
    payload([{ key: 'frame:abc:name:q1', label: 'Q1', type: 'text', was: 'a', now: 'b' }]),
    I.createFingerprint(PAGE, ['frame:abc:name:q1'])
  );

  const keys = detectionKeys();
  check('only one Keep snapshot exists for the page', keys.length === 1, `keys=${keys.join(', ')}`);
  check('snapshot lives at the canonical pageKey slot',
    keys[0] === I.getCanonicalStorageKey(PAGE), keys[0]);
  check('saved dirty is a single logical row', store[keys[0]].dirty.length === 1,
    JSON.stringify(store[keys[0]].dirty));
  check('saved key is not frame-namespaced', store[keys[0]].dirty[0].key === 'name:q1');
}

/* ------------------------------------------------------------------ */
console.log('\nloadPersistedByPageKey: legacy + hash-suffixed keys collapse, no row stacking');
{
  for (const k of detectionKeys()) delete store[k];

  const row = (uid) => ({ key: `frame:${uid}:name:q1`, label: 'Q1', type: 'text', was: 'a', now: 'b' });
  store['cp_detections:nodes.example/form#old'] = {
    host: 'nodes.example', path: '/form', savedAt: 1,
    dirty: [row('s1')]
  };
  store[`cp_detections:${PAGE}#aaa`] = {
    pageKey: PAGE, host: 'nodes.example', path: '/form', savedAt: 2,
    dirty: [row('s1'), row('s2')]
  };
  store[`cp_detections:${PAGE}#bbb`] = {
    pageKey: PAGE, host: 'nodes.example', path: '/form', savedAt: 3,
    dirty: [row('s1'), row('s2'), row('s3'), row('s4')]
  };

  const loaded = await I.loadPersistedByPageKey(PAGE);
  check('restore returns the newest snapshot', loaded && loaded.data.savedAt === 3,
    loaded && loaded.data.savedAt);
  check('four frame-UID copies restore as one row', loaded.data.dirty.length === 1,
    JSON.stringify(loaded.data.dirty));
  check('restored key is the logical field', loaded.data.dirty[0].key === 'name:q1');

  const keys = detectionKeys();
  check('sibling snapshots are deleted after load', keys.length === 1, `keys=${keys.join(', ')}`);
  check('migrated onto the canonical pageKey slot',
    keys[0] === I.getCanonicalStorageKey(PAGE), keys[0]);
}

/* ------------------------------------------------------------------ */
console.log('\nisDetectionKeyForPage does not match a different path on the same host');
{
  check('other form on the same domain is a different page',
    I.isDetectionKeyForPage(
      'cp_detections:https://nodes.example/other#x',
      { pageKey: 'https://nodes.example/other' },
      PAGE
    ) === false);
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
