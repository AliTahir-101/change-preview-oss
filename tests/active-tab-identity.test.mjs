/**
 * Automated harness for ChangePreview's active-tab binding in the side panel.
 *
 * FIELDS_UPDATE is a chrome.runtime broadcast that ANY tab's content script can
 * emit (foreground and background — e.g. a Gmail tab whose iframes heartbeat).
 * The panel must only apply updates from the tab the user is currently looking
 * at; otherwise the displayed host/detections oscillate between tabs.
 *
 * This loads the real panel.js module inside jsdom with a stubbed chrome +
 * panel.html DOM, captures the message/tab listeners it registers, and drives
 * them to verify:
 *   - A push from a background tab is ignored (host + rows unchanged).
 *   - A push from the active tab is applied (host + rows update).
 *   - tabs.onUpdated only reacts to the active tab, not background tabs.
 *
 * panel.js skips its auto-bootstrap when window.__CHANGEPREVIEW_TEST__ is set,
 * so the test owns when the captured listeners run.
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

const FORMS_TAB = 101;
const GMAIL_TAB = 202;

const fieldResponses = {
  [FORMS_TAB]: {
    host: 'forms.cloud.microsoft', path: '/formedit',
    dirty: [], allFieldKeys: [], coverage: { tracked: 1, total: 1, skipped: 0 }
  },
  [GMAIL_TAB]: {
    host: 'mail.google.com', path: '/mail/u/0',
    dirty: [], allFieldKeys: [], coverage: { tracked: 0, total: 0, skipped: 0 }
  }
};

// The tab chrome.tabs.query reports as active. Mutable so we can simulate switch.
let activeTabForQuery = { id: FORMS_TAB, url: 'https://forms.cloud.microsoft/formedit' };
let queryCount = 0;

let fieldsListener = null;
let onActivatedListener = null;
let onUpdatedListener = null;

const chromeStub = {
  runtime: {
    lastError: null,
    onMessage: { addListener(fn) { fieldsListener = fn; } },
    sendMessage() { return Promise.resolve(); }
  },
  tabs: {
    query() { queryCount++; return Promise.resolve([activeTabForQuery]); },
    sendMessage(tabId, msg) {
      if (msg && msg.type === 'GET_FIELDS') return Promise.resolve(fieldResponses[tabId] || null);
      return Promise.resolve({ success: true });
    },
    onActivated: { addListener(fn) { onActivatedListener = fn; } },
    onUpdated: { addListener(fn) { onUpdatedListener = fn; } }
  },
  storage: {
    local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } },
    session: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } },
    onChanged: { addListener() {} }
  }
};

const dom = new JSDOM(PANEL_HTML, { url: 'https://panel.invalid/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.chrome = chromeStub;
dom.window.chrome = chromeStub;
dom.window.__CHANGEPREVIEW_TEST__ = true;

const hostInfo = dom.window.document.getElementById('hostInfo');
const changeCount = dom.window.document.getElementById('changeCount');
const changesBody = dom.window.document.getElementById('changesBody');

// Import the real panel module (auto-bootstrap is skipped under the test flag).
await import(pathToFileURL(path.join(ROOT, 'panel', 'panel.js')).href);

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ */
console.log('\nactive-tab binding: panel only reflects the active tab');

check('panel registered a FIELDS_UPDATE listener', typeof fieldsListener === 'function');
check('panel registered an onActivated listener', typeof onActivatedListener === 'function');
check('panel registered an onUpdated listener', typeof onUpdatedListener === 'function');

// Bind the panel to the Forms tab (as if the user activated it).
await onActivatedListener({ tabId: FORMS_TAB });
await tick();
check('panel bound to the active (Forms) tab', hostInfo.textContent === 'forms.cloud.microsoft',
  `host=${hostInfo.textContent}`);
check('active tab starts with no changes', /0 changes/.test(changeCount.textContent),
  `count=${changeCount.textContent}`);

// A background Gmail tab pushes an update — it must be ignored.
await fieldsListener({
  type: 'FIELDS_UPDATE',
  data: {
    host: 'mail.google.com', path: '/mail/u/0',
    dirty: [{ key: 'subject', label: 'Subject', was: 'a', now: 'b', type: 'text' }],
    allFieldKeys: ['subject'],
    coverage: { tracked: 1, total: 1, skipped: 0 }
  }
}, { tab: { id: GMAIL_TAB } });
await tick();
check('background-tab push does NOT change the host', hostInfo.textContent === 'forms.cloud.microsoft',
  `host=${hostInfo.textContent}`);
check('background-tab push does NOT inject rows', changesBody.querySelectorAll('tr').length === 0,
  `rows=${changesBody.querySelectorAll('tr').length}`);
check('background-tab push leaves change count at zero', /0 changes/.test(changeCount.textContent),
  `count=${changeCount.textContent}`);

// The active Forms tab pushes real edits — they must be applied.
await fieldsListener({
  type: 'FIELDS_UPDATE',
  data: {
    host: 'forms.cloud.microsoft', path: '/formedit',
    dirty: [
      { key: 'q1', label: 'Question 1', was: 'x', now: 'y', type: 'text' },
      { key: 'q2', label: 'Question 2', was: '1', now: '2', type: 'text' }
    ],
    allFieldKeys: ['q1', 'q2'],
    coverage: { tracked: 2, total: 2, skipped: 0 }
  }
}, { tab: { id: FORMS_TAB } });
await tick();
check('active-tab push keeps the host on Forms', hostInfo.textContent === 'forms.cloud.microsoft',
  `host=${hostInfo.textContent}`);
check('active-tab push renders its rows', changesBody.querySelectorAll('tr').length === 2,
  `rows=${changesBody.querySelectorAll('tr').length}`);
check('active-tab push updates the change count', /2 changes/.test(changeCount.textContent),
  `count=${changeCount.textContent}`);

// A late push from the background Gmail tab must not clobber the active view.
await fieldsListener({
  type: 'FIELDS_UPDATE',
  data: {
    host: 'mail.google.com', path: '/mail/u/0',
    dirty: [], allFieldKeys: [], coverage: { tracked: 0, total: 0, skipped: 0 }
  }
}, { tab: { id: GMAIL_TAB } });
await tick();
check('late background empty push does NOT wipe active rows',
  changesBody.querySelectorAll('tr').length === 2,
  `rows=${changesBody.querySelectorAll('tr').length}`);
check('late background push keeps host on Forms', hostInfo.textContent === 'forms.cloud.microsoft',
  `host=${hostInfo.textContent}`);

/* ------------------------------------------------------------------ */
console.log('\nonUpdated only reacts to the active tab');

const beforeBg = queryCount;
await onUpdatedListener(GMAIL_TAB, { status: 'complete' });
await tick();
check('onUpdated for a background tab does not refresh', queryCount === beforeBg,
  `queryCount ${beforeBg} -> ${queryCount}`);

const beforeActive = queryCount;
await onUpdatedListener(FORMS_TAB, { status: 'complete' });
await tick();
check('onUpdated for the active tab refreshes', queryCount > beforeActive,
  `queryCount ${beforeActive} -> ${queryCount}`);
check('host stays on Forms after active-tab reload', hostInfo.textContent === 'forms.cloud.microsoft',
  `host=${hostInfo.textContent}`);

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
