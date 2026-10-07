/**
 * On-demand injection: ping if the content script is already there, otherwise
 * chrome.scripting.executeScript({ allFrames: true }) under activeTab.
 *
 * No real Chrome: chrome.tabs / chrome.scripting are stubbed.
 */

import { ensureContentScript, isRestrictedTabUrl } from '../ensure-content-script.js';

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

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function installChrome({ pingOk = false, pingDelayMs = 0, injectImpl } = {}) {
  const calls = { pings: 0, injects: [] };
  globalThis.chrome = {
    tabs: {
      sendMessage(tabId, msg) {
        if (msg && msg.type === 'PING') {
          calls.pings++;
          if (!pingOk) {
            return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
          }
          if (pingDelayMs) {
            return new Promise((r) => setTimeout(() => r({ ok: true }), pingDelayMs));
          }
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve(null);
      }
    },
    scripting: {
      executeScript(opts) {
        calls.injects.push(opts);
        if (injectImpl) return injectImpl(opts);
        return Promise.resolve([{ frameId: 0, result: undefined }]);
      }
    }
  };
  return calls;
}

console.log('\nisRestrictedTabUrl');
check('http(s) pages are not restricted', !isRestrictedTabUrl('https://admin.example.com/settings'));
check('chrome:// is restricted', isRestrictedTabUrl('chrome://extensions'));
check('Chrome Web Store is restricted', isRestrictedTabUrl('https://chromewebstore.google.com/detail/x'));
check('legacy webstore URL is restricted', isRestrictedTabUrl('https://chrome.google.com/webstore/detail/x'));
check('missing url is not treated as restricted (try inject, fail soft)', !isRestrictedTabUrl(undefined));

console.log('\nensureContentScript: ping hits, skip inject');
{
  const calls = installChrome({ pingOk: true });
  const ok = await ensureContentScript(11, 'https://forms.example/edit');
  eq('returns true when already injected', ok, true);
  eq('pinged once', calls.pings, 1);
  eq('did not inject', calls.injects.length, 0);
}

console.log('\nensureContentScript: no ping → inject all frames, then ping');
{
  let pinged = 0;
  const injects = [];
  globalThis.chrome = {
    tabs: {
      sendMessage(tabId, msg) {
        if (msg && msg.type === 'PING') {
          pinged++;
          // First ping fails (not injected); after executeScript, ping succeeds.
          if (injects.length === 0) {
            return Promise.reject(new Error('Receiving end does not exist.'));
          }
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve(null);
      }
    },
    scripting: {
      executeScript(opts) {
        injects.push(opts);
        return Promise.resolve([{ frameId: 0 }]);
      }
    }
  };
  const ok = await ensureContentScript(22, 'https://admin.example.com/form');
  eq('returns true after inject', ok, true);
  eq('injected once', injects.length, 1);
  eq('injected content/content.js', injects[0]?.files?.[0], 'content/content.js');
  eq('allFrames is true (iframe forms under activeTab)', injects[0]?.target?.allFrames, true);
  eq('target tabId matches', injects[0]?.target?.tabId, 22);
  check('pinged before and after inject', pinged >= 2, `pings=${pinged}`);
}

console.log('\nensureContentScript: restricted URL fails soft, no inject');
{
  const calls = installChrome({ pingOk: false });
  const ok = await ensureContentScript(33, 'chrome://settings');
  eq('returns false on chrome://', ok, false);
  eq('did not ping a restricted tab', calls.pings, 0);
  eq('did not inject a restricted tab', calls.injects.length, 0);
}

console.log('\nensureContentScript: inject throws (no activeTab) fails soft');
{
  installChrome({
    pingOk: false,
    injectImpl() {
      return Promise.reject(new Error('Cannot access contents of the page. Extension manifest must request permission.'));
    }
  });
  const ok = await ensureContentScript(44, 'https://example.com');
  eq('returns false when executeScript is denied', ok, false);
}

console.log('\nensureContentScript: coalesces concurrent calls for the same tab');
{
  let injects = 0;
  let pingCount = 0;
  globalThis.chrome = {
    tabs: {
      sendMessage() {
        pingCount++;
        if (injects === 0) {
          return Promise.reject(new Error('Receiving end does not exist.'));
        }
        return Promise.resolve({ ok: true });
      }
    },
    scripting: {
      executeScript() {
        injects++;
        return new Promise((r) => setTimeout(() => r([{ frameId: 0 }]), 20));
      }
    }
  };
  const [a, b] = await Promise.all([
    ensureContentScript(55, 'https://example.com/a'),
    ensureContentScript(55, 'https://example.com/a')
  ]);
  eq('both callers see success', a && b, true);
  eq('inject ran once for concurrent ensure()', injects, 1);
}

console.log('\nensureContentScript: missing tabId fails soft');
{
  const calls = installChrome({ pingOk: false });
  const ok = await ensureContentScript(undefined, 'https://example.com');
  eq('returns false without a tabId', ok, false);
  eq('did not inject without a tabId', calls.injects.length, 0);
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
