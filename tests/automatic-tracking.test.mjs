import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
async function loadPage() {
  const dom = new JSDOM('<form><label for="size">Min m2</label><input id="size" name="size" value="30"><button type="button" id="save">Save</button></form>', { url: 'https://hakemus.tampuuri.fi/JVA/?hakemustyyppi=1', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let listener;
  const messages = [];
  let inputHandler;
  const addListener = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, handler, options) => {
    if (type === 'input') inputHandler = handler;
    return addListener(type, handler, options);
  };
  w.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c) };
  Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.isConnected ? this.parentElement : null; } });
  w.chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage(msg) { messages.push(msg); return Promise.resolve(); } },
    storage: { local: { get(_key, cb) { cb({}); } }, onChanged: { addListener() {} } }
  };
  // Simulate Chrome's page-load script registration. No toolbar, side panel,
  // test-only internals, or manual snapshotBaseline call is used.
  w.eval(source);
  await new Promise(resolve => setTimeout(resolve, 450));
  const report = () => { let result; listener({ type: 'GET_FIELDS' }, {}, value => { result = value; }); return result; };
  return { dom, w, messages, report, trustedEdit: () => inputHandler({ isTrusted: true }) };
}
for (const phase of ['initial navigation', 'reload / next navigation']) {
  const { dom, w, messages, report, trustedEdit } = await loadPage();
  try {
    assert.equal(report().dirty.length, 0);
    assert.equal(report().hasLiveSession, false, 'new documents start without a live edit session');
    const input = w.document.getElementById('size');
    input.value = '45';
    trustedEdit();
    assert.equal(report().hasLiveSession, true, 'trusted input records a live session before the panel opens');
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(report().dirty[0].was, '30');
    assert.equal(report().dirty[0].now, '45');
    assert.ok(messages.some(message => message.type === 'UPDATE_BADGE' && message.count === 1));
    // Toolbar fallback or panel opening must not discard the original baseline.
    w.eval(source);
    assert.equal(report().dirty[0].was, '30');
    const event = new w.MouseEvent('click', { bubbles: true, cancelable: true });
    w.document.getElementById('save').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.ok(w.document.getElementById('changepreview-overlay-host'));
    input.value = '30';
    trustedEdit();
    assert.equal(report().hasLiveSession, true, 'undo keeps the current live session');
    console.log('PASS: ' + phase + ' captures edits, updates badge and confirms Save with panel closed');
  } finally { dom.window.close(); }
}

for (const mode of ['synchronous invalidation', 'rejected invalidation', 'missing runtime id']) {
  const { dom, w } = await loadPage();
  const errors = [];
  dom.virtualConsole.on('jsdomError', error => errors.push(error));
  try {
    if (mode === 'missing runtime id') w.chrome.runtime.id = undefined;
    else w.chrome.runtime.sendMessage = () => {
      const error = new Error('Extension context invalidated.');
      if (mode === 'synchronous invalidation') throw error;
      return Promise.reject(error);
    };
    const input = w.document.getElementById('size');
    input.value = '55';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 350));
    input.value = '60';
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(errors.length, 0, 'stale scripts must not throw from delayed input callbacks');
    const click = new w.MouseEvent('click', { bubbles: true, cancelable: true });
    w.document.getElementById('save').dispatchEvent(click);
    assert.equal(click.defaultPrevented, false, 'retired tracker must not intercept Save');
    assert.equal(w.document.getElementById('changepreview-overlay-host'), null);
    console.log('PASS: ' + mode + ' stops cleanly and leaves Save available');
  } finally { dom.window.close(); }
}
