/**
 * Automated harness for ChangePreview's save/submit confirmation dialog.
 *
 * Runs content.js inside jsdom (top frame) and asserts:
 *   - With "Confirm on save" ON (default), clicking a Save button with pending
 *     changes shows the confirmation dialog and prevents the raw submit.
 *   - The dialog is rendered inside an isolated Shadow DOM, and its Cancel button
 *     has explicit background/colour styling (so host-page CSS cannot wash it
 *     out). Cancelling dismisses the dialog.
 *   - With "Confirm on save" OFF (persisted preference), clicking Save does NOT
 *     show the dialog and lets the action proceed — while detection still works.
 *
 * No network, no real extension APIs: chrome is stubbed (including a minimal
 * chrome.storage) and offsetParent is shimmed because jsdom does not lay out.
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

const FORM_HTML = `<!DOCTYPE html><html><body>
  <form id="f">
    <label for="field1">Display name</label>
    <input type="text" id="field1" name="field1" value="before">
    <button type="button" id="saveBtn">Save</button>
  </form>
</body></html>`;

/**
 * Load the form fixture + content.js with a stubbed chrome (including storage),
 * returning the window, internals, and a handle to the captured storage-change
 * listener so tests can flip the confirm-on-save preference live.
 */
function loadHarness(initialConfirmPref) {
  const dom = new JSDOM(FORM_HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://admin.example.com/settings' });
  const { window } = dom;

  window.__CHANGEPREVIEW_TEST__ = true;

  if (!window.CSS || typeof window.CSS.escape !== 'function') {
    window.CSS = window.CSS || {};
    window.CSS.escape = (value) => String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => `\\${ch}`);
  }

  const changeListeners = [];
  const stored = {};
  if (initialConfirmPref !== undefined) stored.confirmOnSaveEnabled = initialConfirmPref;

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage() { return { catch() {} }; }
    },
    storage: {
      local: {
        get(key, cb) {
          const out = {};
          if (typeof key === 'string') {
            if (key in stored) out[key] = stored[key];
          }
          cb(out);
        },
        set(obj, cb) { Object.assign(stored, obj); if (cb) cb(); }
      },
      onChanged: {
        addListener(fn) { changeListeners.push(fn); }
      }
    }
  };

  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.isConnected ? (this.parentNode || window.document.body) : null; }
  });

  window.eval(CONTENT_JS);

  const internals = window.__changePreviewInternals;
  if (!internals) throw new Error('content.js did not expose test internals');

  function setConfirmPref(enabled) {
    stored.confirmOnSaveEnabled = enabled;
    for (const fn of changeListeners) {
      fn({ confirmOnSaveEnabled: { newValue: enabled } }, 'local');
    }
  }

  return { window, document: window.document, internals, setConfirmPref };
}

let changeCounter = 0;
function makeDirtyAndClickSave(window, document, internals) {
  const input = document.getElementById('field1');
  // Reset to a known baseline value, snapshot, then make a fresh change so the
  // field is reliably dirty even when this helper is called multiple times.
  input.value = 'before';
  internals.snapshotBaseline();
  input.value = `after-${++changeCounter}`;
  const saveBtn = document.getElementById('saveBtn');
  const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  saveBtn.dispatchEvent(evt);
  return evt;
}

/* ------------------------------------------------------------------ */
console.log('\nconfirm-dialog: ON (default)');
{
  const { window, document, internals } = loadHarness(undefined);

  const dirty = internals.getDirtyFields();
  check('detection still works (one dirty field)', dirty.length === 1,
    `got ${dirty.length}`);

  const evt = makeDirtyAndClickSave(window, document, internals);

  check('save click is intercepted (default-prevented)', evt.defaultPrevented === true);

  const host = document.getElementById('changepreview-overlay-host');
  check('dialog host element is added', !!host);
  check('dialog is isolated in a Shadow DOM', !!(host && host.shadowRoot));

  const shadow = host && host.shadowRoot;
  const cancelBtn = shadow && shadow.querySelector('.cp-btn-cancel');
  check('Cancel button exists inside the dialog', !!cancelBtn);
  check('Cancel button is labelled "Cancel"', !!cancelBtn && cancelBtn.textContent.trim() === 'Cancel');

  const styleText = shadow ? (shadow.querySelector('style')?.textContent || '') : '';
  check('Cancel button has explicit background in scoped CSS',
    /\.cp-btn-cancel\s*\{[^}]*background:/i.test(styleText));
  check('Cancel button has explicit text colour in scoped CSS',
    /\.cp-btn-cancel\s*\{[^}]*color:/i.test(styleText));
  check('dialog resets inheritance via :host { all: initial }',
    /:host\s*\{\s*all:\s*initial/i.test(styleText));

  // Cancelling dismisses the dialog.
  if (cancelBtn) {
    cancelBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  check('Cancel dismisses the dialog', !document.getElementById('changepreview-overlay-host'));
}

/* ------------------------------------------------------------------ */
console.log('\nconfirm-dialog: OFF (persisted preference)');
{
  const { window, document, internals } = loadHarness(false);

  const evt = makeDirtyAndClickSave(window, document, internals);

  check('save click is NOT intercepted when confirm is off',
    evt.defaultPrevented === false);
  check('no dialog is shown when confirm is off',
    !document.getElementById('changepreview-overlay-host'));
  check('detection still works while dialog is off',
    internals.getDirtyFields().length === 1);
}

/* ------------------------------------------------------------------ */
console.log('\nconfirm-dialog: live toggle via storage change');
{
  const { window, document, internals, setConfirmPref } = loadHarness(undefined);

  // Turn it off live, then clicking Save must not intercept.
  setConfirmPref(false);
  const evtOff = makeDirtyAndClickSave(window, document, internals);
  check('live-disabled: save not intercepted', evtOff.defaultPrevented === false);
  check('live-disabled: no dialog', !document.getElementById('changepreview-overlay-host'));

  // Turn it back on live, then clicking Save intercepts again.
  setConfirmPref(true);
  const evtOn = makeDirtyAndClickSave(window, document, internals);
  check('live-enabled: save intercepted again', evtOn.defaultPrevented === true);
  check('live-enabled: dialog shown again', !!document.getElementById('changepreview-overlay-host'));
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
