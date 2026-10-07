/**
 * ChangePreview Background Service Worker (classic script, not an ES module).
 * Coordinates messaging, badge updates, on-demand content injection, and panel opening.
 *
 * Do not add `import` / `export` here and do not set manifest background.type
 * to "module". Chrome then tries to fetch imported files as SW modules and
 * reports "An unknown error occurred when fetching the script".
 *
 * Keep the ensure* helpers below in sync with ensure-content-script.js (the
 * panel still imports that file as an ES module).
 */

const CONTENT_SCRIPT_FILE = 'content/content.js';
const inFlight = new Map();
const RESTRICTED_SCHEME =
  /^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source|data|javascript):/i;
const WEBSTORE_HOST =
  /^(https:\/\/)?(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i;

function isRestrictedTabUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return RESTRICTED_SCHEME.test(url) || WEBSTORE_HOST.test(url);
}

async function pingContentScript(tabId) {
  try {
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

async function ensureContentScript(tabId, tabUrl) {
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ interceptEnabled: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'UPDATE_BADGE':
      updateBadge(sender.tab?.id, message.count);
      break;
      
    case 'OPEN_PANEL':
      if (sender.tab?.windowId) {
        chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
      }
      break;
      
    case 'FIELDS_UPDATE':
      break;
  }
  return false;
});

function updateBadge(tabId, count) {
  if (!tabId) return;
  
  const text = count > 0 ? String(count) : '';
  const color = count > 0 ? '#e67e22' : '#888';
  const title = count > 0 
    ? `${count} change${count === 1 ? '' : 's'} on this page`
    : 'ChangePreview - No changes';
  
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
  chrome.action.setTitle({ title, tabId }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => {
  // Open synchronously while the toolbar click's user gesture is active.
  // Automatic side-panel handling can consume the click without this event.
  if (tab?.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.warn);
  }
  if (tab?.id != null) {
    void ensureContentScript(tab.id, tab.url);
  }
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.warn);
