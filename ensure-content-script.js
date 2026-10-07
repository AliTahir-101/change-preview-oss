/**
 * On-demand content-script injection (activeTab + scripting).
 *
 * ChangePreview does not declare host_permissions or a static content_scripts
 * match pattern. The content script is injected only after the user opens the
 * extension on a page. Subsequent messages reuse the injected script until the
 * tab navigates (activeTab is then revoked; the user opens ChangePreview again).
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
    // Any response means a listener is present. PING is handled by the top frame;
    // unknown types on an older build still prove the script is already there.
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch {
    return false;
  }
}

async function injectContentScript(tabId) {
  if (!chrome.scripting?.executeScript) return false;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [CONTENT_SCRIPT_FILE],
    injectImmediately: true
  });
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
