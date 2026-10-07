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

const TABS = {
  [FORMS_TAB]: { id: FORMS_TAB, url: 'https://forms.cloud.microsoft/formedit', windowId: 1 },
  [GMAIL_TAB]: { id: GMAIL_TAB, url: 'https://mail.google.com/mail/u/0', windowId: 1 }
};

// The tab chrome.tabs.query reports as active. Mutable so we can simulate switch.
let activeTabForQuery = TABS[FORMS_TAB];
let queryCount = 0;

let fieldsListener = null;
let onActivatedListener = null;
let onUpdatedListener = null;
let onFocusChangedListener = null;

const sentMessages = [];

const chromeStub = {
  runtime: {
    lastError: null,
    onMessage: { addListener(fn) { fieldsListener = fn; } },
    sendMessage() { return Promise.resolve(); }
  },
  tabs: {
    query() { queryCount++; return Promise.resolve([activeTabForQuery]); },
    get(tabId) { return Promise.resolve(TABS[tabId] || null); },
    sendMessage(tabId, msg) {
      sentMessages.push({ tabId, type: msg && msg.type });
      if (msg && msg.type === 'PING') return Promise.resolve({ ok: true });
      if (msg && msg.type === 'GET_FIELDS') return Promise.resolve(fieldResponses[tabId] || null);
      return Promise.resolve({ success: true });
    },
    onActivated: { addListener(fn) { onActivatedListener = fn; } },
    onUpdated: { addListener(fn) { onUpdatedListener = fn; } }
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener(fn) { onFocusChangedListener = fn; } }
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
const firstPing = sentMessages.findIndex((m) => m.type === 'PING' && m.tabId === FORMS_TAB);
const firstGet = sentMessages.findIndex((m) => m.type === 'GET_FIELDS' && m.tabId === FORMS_TAB);
check('refresh pings the content script before GET_FIELDS (inject-then-message)',
  firstPing !== -1 && firstGet !== -1 && firstPing < firstGet,
  `order=${JSON.stringify(sentMessages)}`);
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

await onUpdatedListener(FORMS_TAB, { status: 'complete' });
await tick();
check('host stays on Forms after active-tab reload', hostInfo.textContent === 'forms.cloud.microsoft',
  `host=${hostInfo.textContent}`);

/* ------------------------------------------------------------------ */
console.log('\nswitching tabs rebinds the panel to the newly active tab');

// Activate the Gmail tab: the panel must switch its host/detections to Gmail.
await onActivatedListener({ tabId: GMAIL_TAB });
await tick();
check('activating Gmail switches the displayed host', hostInfo.textContent === 'mail.google.com',
  `host=${hostInfo.textContent}`);
check('switching to Gmail clears the previous tab rows', changesBody.querySelectorAll('tr').length === 0,
  `rows=${changesBody.querySelectorAll('tr').length}`);

// Now Forms is the background tab — its pushes must be ignored.
await fieldsListener({
  type: 'FIELDS_UPDATE',
  data: {
    host: 'forms.cloud.microsoft', path: '/formedit',
    dirty: [{ key: 'q1', label: 'Question 1', was: 'x', now: 'y', type: 'text' }],
    allFieldKeys: ['q1'], coverage: { tracked: 1, total: 1, skipped: 0 }
  }
}, { tab: { id: FORMS_TAB } });
await tick();
check('after switch, old active tab (Forms) push is ignored', hostInfo.textContent === 'mail.google.com',
  `host=${hostInfo.textContent}`);
check('old tab push does not inject rows after switch', changesBody.querySelectorAll('tr').length === 0,
  `rows=${changesBody.querySelectorAll('tr').length}`);

// Gmail (now active) pushes real edits — they must be applied.
await fieldsListener({
  type: 'FIELDS_UPDATE',
  data: {
    host: 'mail.google.com', path: '/mail/u/0',
    dirty: [{ key: 'to', label: 'To', was: '', now: 'a@b.com', type: 'text' }],
    allFieldKeys: ['to'], coverage: { tracked: 1, total: 1, skipped: 0 }
  }
}, { tab: { id: GMAIL_TAB } });
await tick();
check('newly active tab (Gmail) push is applied', changesBody.querySelectorAll('tr').length === 1,
  `rows=${changesBody.querySelectorAll('tr').length}`);
check('Gmail push updates the change count', /1 change/.test(changeCount.textContent),
  `count=${changeCount.textContent}`);

/* ------------------------------------------------------------------ */
console.log('\nwindow focus change rebinds to the focused window\'s active tab');

check('panel registered an onFocusChanged listener', typeof onFocusChangedListener === 'function');

// Focus a window whose active tab is Forms → panel rebinds to Forms.
activeTabForQuery = TABS[FORMS_TAB];
await onFocusChangedListener(1);
await tick();
check('focusing a window rebinds the host to its active tab',
  hostInfo.textContent === 'forms.cloud.microsoft', `host=${hostInfo.textContent}`);

// WINDOW_ID_NONE (all windows blurred) must be ignored (no throw, no rebind).
await onFocusChangedListener(-1);
await tick();
check('WINDOW_ID_NONE focus event is ignored', hostInfo.textContent === 'forms.cloud.microsoft',
  `host=${hostInfo.textContent}`);

/* ------------------------------------------------------------------ */
const originalSendMessage = chromeStub.tabs.sendMessage;
chromeStub.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist'); };
await onActivatedListener({ tabId: FORMS_TAB });
check('missing access shows an actionable tracking status',
  document.getElementById('trackingStatus').textContent.includes('Allow ChangePreview access to this site'));
chromeStub.tabs.sendMessage = originalSendMessage;
await onActivatedListener({ tabId: FORMS_TAB });
check('tracking status recovers after toolbar access',
  document.getElementById('trackingStatus').textContent.startsWith('Tracking this page'));
fieldResponses[FORMS_TAB].dirty = [{ key: 'choice', label: 'Choice', was: 'No', now: 'Yes', type: 'checkbox' }];
await onActivatedListener({ tabId: FORMS_TAB });
const choiceIcon = document.querySelector('.field-type-icon');
choiceIcon.getBoundingClientRect = () => ({ top: 200, left: 40, width: 16, height: 16, right: 56, bottom: 216 });
choiceIcon.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
const tooltip = document.getElementById('fieldTooltip');
check('choice tooltip appears above its target', !tooltip.hidden && parseFloat(tooltip.style.top) < 200);
check('choice row has no competing native tooltip', !choiceIcon.closest('tr').hasAttribute('title'));
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
check('Escape dismisses choice tooltip', tooltip.hidden);
let copied = [];
Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
const firstRow = document.querySelector('.change-row');
firstRow.querySelector('.field-label').click();
firstRow.querySelector('.value-text').click();
await tick();
check('clicking plain text does not copy or locate', copied.length === 0 && !firstRow.classList.contains('row-locating'));
firstRow.querySelector('.field-label-wrapper .copy-btn').click();
firstRow.querySelector('.value-cell-wrapper .copy-btn').click();
await tick();
check('explicit copy buttons copy the field name and value', copied.join('|') === 'Choice|No');
firstRow.querySelector('.locate-btn').click();
await tick();
check('dedicated locate button highlights the row', firstRow.classList.contains('row-locating'));
check('tracking status occurs once inside the header', document.querySelectorAll('#trackingStatus').length === 1 && !!document.querySelector('header #trackingStatus'));
fieldResponses[FORMS_TAB].url = 'https://forms.cloud.microsoft/formedit?form=example#section';
await onActivatedListener({ tabId: FORMS_TAB });
hostInfo.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
check('page reference exposes the full URL on keyboard focus', !tooltip.hidden && tooltip.textContent === fieldResponses[FORMS_TAB].url);
console.log('');
if (failed === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
} else {
  console.log(`${failed} FAILED, ${passed} passed.`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
