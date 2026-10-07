/**
 * ChangePreview Background Service Worker
 * Coordinates messaging, badge updates, on-demand content injection, and panel opening.
 */

import { ensureContentScript } from './ensure-content-script.js';

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

chrome.action.onClicked.addListener(async (tab) => {
  // User gesture: activeTab is granted for this page. Inject before / as the
  // panel opens so the first GET_FIELDS has a receiving end. With
  // openPanelOnActionClick this listener may not fire; the panel also ensures.
  if (tab?.id != null) {
    await ensureContentScript(tab.id, tab.url);
  }
  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
