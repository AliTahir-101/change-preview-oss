import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ensureContentScript } from '../ensure-content-script.js';
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
function harness() {
  let click, behavior, gesture = false, opened = false;
  const calls = [];
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    storage: { session: { set: async () => {} } },
    action: { onClicked: { addListener(fn) { click = fn; } } },
    sidePanel: {
      setPanelBehavior: async value => { behavior = value; },
      open: async () => { assert.equal(gesture, true, 'panel must open during the click'); opened = true; }
    },
    tabs: { sendMessage: async (_id, _msg, opts) => {
      assert.equal(opts?.frameId, 0, 'only top-frame readiness counts');
      if (calls.some(c => c.target.frameIds)) return { ok: true };
      throw Error('Receiving end does not exist');
    } },
    scripting: { executeScript: async opts => {
      calls.push(opts);
      if (opts.target.allFrames) throw Error('Cannot access child frame');
      return [{ frameId: 0 }];
    } }
  };
  const context = vm.createContext({ chrome, console });
  vm.runInContext(background, context);
  return { chrome, calls, context, get behavior() { return behavior; },
    click() { gesture = true; click({ id: 7, windowId: 1, url: 'https://example.com/' }); gesture = false; assert.equal(opened, true); }
  };
}
const h = harness();
assert.equal(h.behavior.openPanelOnActionClick, false, 'toolbar must dispatch the action listener');
h.click();
assert.equal(await vm.runInContext("ensureContentScript(7, 'https://example.com/')", h.context), true);
assert.equal(h.calls.length, 2);
console.log('PASS: panel opens immediately; main frame survives inaccessible child');
const moduleHarness = harness();
globalThis.chrome = moduleHarness.chrome;
assert.equal(await ensureContentScript(8, 'https://example.com/'), true);
assert.equal(moduleHarness.calls.length, 2);
console.log('PASS: panel helper also falls back to the main frame');
for (const target of ['module', 'background']) {
  const denied = harness();
  denied.chrome.scripting.executeScript = async () => { throw Error('No activeTab'); };
  globalThis.chrome = denied.chrome;
  const result = target === 'module' ? await ensureContentScript(9, 'https://example.com/') : await vm.runInContext("ensureContentScript(9, 'https://example.com/')", denied.context);
  assert.equal(result, false, target + ' must not report ready without permission');
}
console.log('PASS: both helpers respect denied page access');
const invalid = harness();
invalid.chrome.tabs.sendMessage = async () => undefined;
globalThis.chrome = invalid.chrome;
assert.equal(await ensureContentScript(10, 'https://example.com/'), false);
console.log('PASS: empty PING response does not falsely report readiness');
