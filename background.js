/**
 * ChangePreview Background Service Worker
 * Coordinates messaging, badge updates, and panel opening.
 */

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
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
