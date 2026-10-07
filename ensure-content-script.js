/**
 * On-demand content-script injection (activeTab + scripting).
 *
 * SHIP THIS FILE. panel/panel.js imports it as an ES module. Omitting it from
 * an unpacked folder or CWS zip breaks the side panel (inject-then-message).
 * Use `npm run stage` (see scripts/stage-extension.mjs).
 *
 * background.js is a classic (non-module) service worker and inlines the same
 * helpers — it must NOT import this file. Keep the two copies in sync.
 *
 * Automatic content scripts capture page-load baselines on permitted HTTP(S)
 * pages. This helper is a toolbar/panel fallback for pages already open during
 * an extension update; it never re-baselines an existing tracker.
 */

const CONTENT_SCRIPT_FILE = 'content/content.js';

/** In-flight ensure() calls, keyed by tabId, so a ping+inject is not doubled. */
const inFlight = new Map();

const RESTRICTED_SCHEME =
  /^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source|data|javascript):/i;
const WEBSTORE_HOST =
  /^(https:\/\/)?(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i;

export function isRestrictedTabUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return RESTRICTED_SCHEME.test(url) || WEBSTORE_HOST.test(url);
}

async function pingContentScript(tabId) {
  try {
    // Require the top-frame readiness response, not a reply from a child frame.
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function injectContentScript(tabId) {
  if (!chrome.scripting?.executeScript) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
      injectImmediately: true
    });
  } catch {
    // An inaccessible child frame must not prevent tracking the main form.
    // Chrome still enforces activeTab on this fallback; no access is broadened.
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [CONTENT_SCRIPT_FILE],
      injectImmediately: true
    });
  }
  return true;
}

/**
 * Make sure content/content.js is running in `tabId` (all frames when injecting).
 * Returns true if a content-script listener is present afterwards.
 *
 * Restricted URLs (chrome://, Web Store, …) return false without injecting.
 * Injection failures (no activeTab, cross-origin frames we cannot reach, etc.)
 * fail soft — false — so the caller can treat "no receiving end" as expected.
 *
 * @param {number} tabId
 * @param {string} [tabUrl]
 * @returns {Promise<boolean>}
 */
export async function ensureContentScript(tabId, tabUrl) {
  if (tabId == null || tabId < 0) return false;
  if (isRestrictedTabUrl(tabUrl)) return false;

  const existing = inFlight.get(tabId);
  if (existing) return existing;

  const job = (async () => {
    try {
      if (await pingContentScript(tabId)) return true;
      await injectContentScript(tabId);
      return await pingContentScript(tabId);
    } catch {
      return false;
    } finally {
      inFlight.delete(tabId);
    }
  })();

  inFlight.set(tabId, job);
  return job;
}
