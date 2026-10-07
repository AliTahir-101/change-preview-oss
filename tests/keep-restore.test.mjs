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
let fieldsListener = null;
let focusListener, activatedListener, updatedListener;
const TAB = { id: 42, url: 'https://agentreshta.example/member/profile/preferences', windowId: 1 };
let getFieldsResponse = {
  host: 'agentreshta.example',
  path: '/member/profile/preferences',
  url: TAB.url,
  dirty: [],
  allFieldKeys: ['name:a'],
  coverage: { tracked: 1, total: 1, skipped: 0 }
};
const chromeStub = {
  runtime: {
    lastError: null,
    onMessage: { addListener(fn) { fieldsListener = fn; } },
    sendMessage() { return Promise.resolve(); }
  },
  tabs: {
    query() { return Promise.resolve([TAB]); },
    get(id) { return Promise.resolve(id === TAB.id ? TAB : null); },
    sendMessage(tabId, msg) {
      if (msg?.type === 'PING') return Promise.resolve({ ok: true });
      if (msg && msg.type === 'GET_FIELDS') return Promise.resolve(getFieldsResponse);
      return Promise.resolve({ success: true });
    },
    onActivated: { addListener(fn) { activatedListener = fn; } },
    onUpdated: { addListener(fn) { updatedListener = fn; } }
  },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener(fn) { focusListener = fn; } } },
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
console.log('\nsameLogicalPage: URL settle vs a different form');
{
  const prefs = 'https://agentreshta.example/member/profile/preferences';
  check('identical keys match', I.sameLogicalPage(prefs, prefs));
  check('added query after load is still the same page',
    I.sameLogicalPage(prefs, prefs + '?tab=alerts'));
  check('trailing-slash canonicalize is already equal',
    I.sameLogicalPage(I.canonicalizePageUrl(prefs + '/'), prefs));
  check('distinct formId queries stay separate',
    I.sameLogicalPage('https://ex.com/form?formId=1', 'https://ex.com/form?formId=2') === false);
  check('different paths stay separate',
    I.sameLogicalPage(prefs, 'https://agentreshta.example/member/profile/account') === false);
}

/* ------------------------------------------------------------------ */
console.log('\nKeep restore survives post-reload scan/hydration (no flash-then-clear)');
{
  const prefs = 'https://agentreshta.example/member/profile/preferences';
  const kept = [{ key: 'name:tz', label: 'Timezone', type: 'select', was: 'UTC', now: 'ET' }];
  const hostInfo = dom.window.document.getElementById('hostInfo');
  const changesBody = dom.window.document.getElementById('changesBody');
  const tick = () => new Promise((r) => setTimeout(r, 0));

  await I.saveDetections({
    host: 'agentreshta.example',
    path: '/member/profile/preferences',
    url: prefs,
    dirty: kept
  }, I.createFingerprint(prefs, ['name:tz']));

  I.setActiveTabId(TAB.id);
  I.setJustReloaded(true);
  getFieldsResponse = {
    host: 'agentreshta.example', path: '/member/profile/preferences', url: prefs,
    dirty: [], allFieldKeys: ['name:tz'], coverage: { tracked: 1, total: 1, skipped: 0 }
  };
  await I.refreshData(TAB.id);
  await tick();
  check('reload restores Keep rows', I.isShowingRestored() === true && changesBody.querySelectorAll('tr').length === 1,
    `restored=${I.isShowingRestored()} rows=${changesBody.querySelectorAll('tr').length}`);

  // Empty baseline scan (content script snapshot after reload).
  await fieldsListener({
    type: 'FIELDS_UPDATE',
    data: {
      host: 'agentreshta.example', path: '/member/profile/preferences', url: prefs,
      dirty: [], allFieldKeys: ['name:tz'], coverage: { tracked: 1, total: 1, skipped: 0 },
      trigger: 'scan'
    }
  }, { tab: TAB });
  await tick();
  check('empty scan does not clear restored rows',
    I.isShowingRestored() === true && changesBody.querySelectorAll('tr').length === 1);

  // Hydration scan that looks dirty (the 1–2s flash Ali saw).
  await fieldsListener({
    type: 'FIELDS_UPDATE',
    data: {
      host: 'agentreshta.example', path: '/member/profile/preferences', url: prefs + '?tab=1',
      dirty: [
        { key: 'name:a', label: 'A', was: '(new field)', now: '1', type: 'text' },
        { key: 'name:b', label: 'B', was: '(new field)', now: '2', type: 'text' }
      ],
      allFieldKeys: ['name:a', 'name:b'], coverage: { tracked: 2, total: 2, skipped: 0 },
      trigger: 'scan'
    }
  }, { tab: TAB });
  await tick();
  check('hydration dirty scan does not replace Keep rows',
    I.isShowingRestored() === true && changesBody.querySelectorAll('tr').length === 1,
    `rows=${changesBody.querySelectorAll('tr').length} restored=${I.isShowingRestored()}`);
  check('Keep snapshot is not overwritten by hydration',
    I.getPersistedData()?.dirty?.length === 1);

  // 2s poll equivalent: live still empty / dirty scan.
  getFieldsResponse = {
    host: 'agentreshta.example', path: '/member/profile/preferences', url: prefs + '?tab=1',
    dirty: [{ key: 'name:a', label: 'A', was: '(new field)', now: '1', type: 'text' }],
    allFieldKeys: ['name:a'], coverage: { tracked: 1, total: 1, skipped: 0 }
  };
  await I.refreshData(TAB.id);
  await tick();
  check('refreshData poll on settled URL still holds Keep rows',
    I.isShowingRestored() === true && changesBody.querySelectorAll('tr').length === 1);

  // Trusted user edit ends restore and shows live dirty.
  await fieldsListener({
    type: 'FIELDS_UPDATE',
    data: {
      host: 'agentreshta.example', path: '/member/profile/preferences', url: prefs,
      dirty: [{ key: 'name:tz', label: 'Timezone', was: 'UTC', now: 'PT', type: 'select' }],
      allFieldKeys: ['name:tz'], coverage: { tracked: 1, total: 1, skipped: 0 },
      trigger: 'user-input'
    }
  }, { tab: TAB });
  await tick();
  check('trusted user-input ends Keep restore and shows the live row',
    I.isShowingRestored() === false && /Timezone/.test(changesBody.textContent),
    `restored=${I.isShowingRestored()} text=${changesBody.textContent}`);
}

/* ------------------------------------------------------------------ */
{
  getFieldsResponse = {
    host: 'agentreshta.example', path: '/member/profile/preferences', url: TAB.url,
    dirty: [{ key: 'name:tz', label: 'Timezone', was: 'UTC', now: 'PT', type: 'select' }],
    allFieldKeys: ['name:tz'], coverage: { tracked: 1, total: 1, skipped: 0 }
  };
  I.setJustReloaded(false);
  await I.refreshData(TAB.id);
  const reapply = document.getElementById('reapplyRow');
  // Opening the panel with existing edits while Keep is off is a live session.
  I.setPersistEnabled(false);
  I.setJustReloaded(true);
  await I.refreshData(TAB.id);
  const keepToggle = document.getElementById('persistToggle');
  const confirmToggle = document.getElementById('confirmToggle');
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  for (const enabled of [true, false, true]) {
    keepToggle.checked = enabled;
    keepToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    await I.refreshData(TAB.id);
    check('Keep setting ' + enabled + ' preserves the live session', !I.isShowingRestored() && reapply.classList.contains('hidden'));
    confirmToggle.checked = !confirmToggle.checked;
    confirmToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    await I.refreshData(TAB.id);
    check('Confirm setting does not offer Reapply for live edits', !I.isShowingRestored() && reapply.classList.contains('hidden'));
  }
  const downloads = [];
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  for (const id of ['downloadCsv', 'downloadMarkdown']) {
    document.getElementById(id).click();
    await focusListener(-1);
    await focusListener(TAB.windowId);
    check(id + ' focus return keeps live changes without Reapply', !I.isShowingRestored() && reapply.classList.contains('hidden'));
  }
  check('both exports create downloads', downloads.length === 2 && downloads[0].endsWith('.csv') && downloads[1].endsWith('.md'));
  await activatedListener({ tabId: TAB.id });
  check('same-tab activation does not trigger restore', !I.isShowingRestored() && reapply.classList.contains('hidden'));
  // The same edited document survives switching away and back, even with no
  // dirty rows after Undo. A genuine reload returns a fresh session instead.
  getFieldsResponse.hasLiveSession = true;
  for (const dirty of [getFieldsResponse.dirty, []]) {
    getFieldsResponse = { ...getFieldsResponse, dirty };
    await activatedListener({ tabId: 99 });
    await activatedListener({ tabId: TAB.id });
    check('returning to a live tab does not offer Reapply (' + dirty.length + ' edits)', !I.isShowingRestored() && reapply.classList.contains('hidden'));
    await activatedListener({ tabId: 99 });
    await focusListener(TAB.windowId);
    check('returning to a live window does not offer Reapply', !I.isShowingRestored() && reapply.classList.contains('hidden'));
  }
  await updatedListener(TAB.id, { status: 'loading' });
  getFieldsResponse = { ...getFieldsResponse, hasLiveSession: false, dirty: [] };
  await updatedListener(TAB.id, { status: 'complete' });
  check('actual reload still offers saved changes', I.isShowingRestored() && !reapply.classList.contains('hidden'));
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
