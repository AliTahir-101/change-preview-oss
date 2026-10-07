/**
 * ChangePreview Side Panel
 * Displays dirty fields, copy Markdown/CSV, re-snapshot.
 */

const elements = {
  hostInfo: document.getElementById('hostInfo'),
  changeCount: document.getElementById('changeCount'),
  coverage: document.getElementById('coverage'),
  coverageText: document.getElementById('coverageText'),
  emptyState: document.getElementById('emptyState'),
  changesTable: document.getElementById('changesTable'),
  changesBody: document.getElementById('changesBody'),
  copyMarkdown: document.getElementById('copyMarkdown'),
  downloadMarkdown: document.getElementById('downloadMarkdown'),
  copyCsv: document.getElementById('copyCsv'),
  downloadCsv: document.getElementById('downloadCsv'),
  persistToggle: document.getElementById('persistToggle'),
  reapplyRow: document.getElementById('reapplyRow'),
  reapplyChanges: document.getElementById('reapplyChanges'),
  clearDetections: document.getElementById('clearDetections'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmCancel: document.getElementById('confirmCancel'),
  confirmClear: document.getElementById('confirmClear'),
  toast: document.getElementById('toast')
};

const COPY_ICON_SVG = '<rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" fill="none"/>';
const EXPAND_ICON_SVG = '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
const COLLAPSE_ICON_SVG = '<path d="M18 15l-6-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';

const LONG_VALUE_THRESHOLD = 60;
const STORAGE_PREFIX = 'cp_detections:';
const CLEARED_PREFIX = 'cp_cleared:';

let currentData = null;
let persistEnabled = false;
let currentFingerprint = null;
let persistedData = null;
let isShowingRestoredData = false;
let formLooksReset = false;

/**
 * Flag set true on page load/reload, cleared when first live dirty detected.
 * Prevents restoring from persisted after user undoes edits (vs after reload).
 * Reapply case: justReloaded=true + no live dirty + persisted exists.
 * Undo case: justReloaded=false + no live dirty = clean state, not Reapply.
 */
let justReloaded = true;

/**
 * Timestamp until which Clear is in effect (short-term protection).
 */
let clearedUntil = 0;

/**
 * Panel-side cleared session flag. Mirrors content script's clearedSession.
 * Set to true after Clear, prevents any restore from storage.
 * Reset to false on first real dirty detection from content script.
 */
let panelClearedSession = false;

/**
 * The host+path that was cleared. Used to check the persistent marker.
 */
let clearedPageKey = null;

/**
 * Check if we're in the short-term cleared window (5 seconds after Clear).
 * This blocks stale updates from Reapply, but does NOT block real new edits.
 * panelClearedSession is checked separately to control storage saves.
 */
function isCleared() {
  return Date.now() < clearedUntil;
}

function setClearedFor(ms) {
  clearedUntil = Date.now() + ms;
}

/**
 * Get the cleared marker key for a host/path.
 */
function getClearedMarkerKey(host, path) {
  const normalizedPath = (path || '/').replace(/\/+$/, '') || '/';
  return CLEARED_PREFIX + host + normalizedPath;
}

/**
 * Check if a page has an ACTIVE cleared marker.
 * A marker is active only if:
 * 1. It exists with untilEdit: true
 * 2. There's no saved detection data AFTER the clearedAt timestamp
 * 
 * If there's newer saved data, the marker is stale (user made new edits)
 * and we should restore normally.
 */
async function hasPageClearedMarker(host, path) {
  if (!host) return false;
  try {
    const markerKey = getClearedMarkerKey(host, path);
    const all = await chrome.storage.local.get(null);
    const marker = all[markerKey];
    
    if (!marker?.untilEdit) {
      return false;
    }
    
    // Check if there's any saved detection data AFTER clearedAt
    const clearedAt = marker.clearedAt || 0;
    const normalizedPath = (path || '/').replace(/\/+$/, '') || '/';
    
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      
      // Check if this is data for the same page
      const valueHost = value?.host || '';
      const valuePath = (value?.path || '/').replace(/\/+$/, '') || '/';
      
      if (valueHost === host && valuePath === normalizedPath) {
        // Found saved data for this page - check timestamp
        const savedAt = value?.savedAt || 0;
        if (savedAt > clearedAt) {
          // Newer data exists, marker is stale - remove it and allow restore
          await chrome.storage.local.remove(markerKey);
          return false;
        }
      }
    }
    
    // Marker is active, no newer data exists
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the cleared marker for a page.
 */
async function setPageClearedMarker(host, path) {
  if (!host) return;
  try {
    const key = getClearedMarkerKey(host, path);
    await chrome.storage.local.set({ 
      [key]: { clearedAt: Date.now(), untilEdit: true } 
    });
    clearedPageKey = key;
  } catch (err) {
    console.error('Failed to set cleared marker:', err);
  }
}

/**
 * Remove the cleared marker for a page (on first real edit).
 */
async function removePageClearedMarker(host, path) {
  if (!host) return;
  try {
    const key = getClearedMarkerKey(host, path);
    await chrome.storage.local.remove(key);
    clearedPageKey = null;
    panelClearedSession = false;
  } catch (err) {
    console.error('Failed to remove cleared marker:', err);
  }
}

const TYPE_LABELS = {
  'text': 'Text',
  'email': 'Email',
  'number': 'Number',
  'tel': 'Phone',
  'url': 'URL',
  'date': 'Date',
  'time': 'Time',
  'datetime-local': 'Date & Time',
  'month': 'Month',
  'week': 'Week',
  'textarea': 'Multi-line text',
  'select': 'Dropdown',
  'select-one': 'Dropdown',
  'select-multiple': 'Multi-select',
  'radio': 'Choice',
  'checkbox': 'Checkbox',
  'checkbox-group': 'Checkboxes',
  'contenteditable': 'Rich text',
  'color': 'Color',
  'range': 'Range',
  'search': 'Search'
};

const INFO_ICON_SVG = '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="8" r="1" fill="currentColor"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

function getTypeLabel(type) {
  if (!type) return 'Field';
  const normalized = type.toLowerCase();
  return TYPE_LABELS[normalized] || (type.charAt(0).toUpperCase() + type.slice(1));
}

function createTypeInfoIcon(type) {
  const label = getTypeLabel(type);
  
  const wrapper = document.createElement('span');
  wrapper.className = 'field-type-icon';
  wrapper.setAttribute('data-tooltip', label);
  wrapper.setAttribute('aria-label', `Field type: ${label}`);
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute('tabindex', '0');
  
  wrapper.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none">${INFO_ICON_SVG}</svg>`;
  
  return wrapper;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, len = 50) {
  if (!str) return '(empty)';
  str = String(str);
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function formatDate() {
  const now = new Date();
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  };
  return now.toLocaleString(undefined, options);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, 2000);
}

function updateUI(data) {
  currentData = data;
  
  elements.hostInfo.textContent = data.host || '—';
  elements.hostInfo.title = `${data.host}${data.path}`;
  
  const count = data.dirty?.length || 0;
  elements.changeCount.textContent = `${count} change${count === 1 ? '' : 's'}`;
  elements.changeCount.classList.toggle('has-changes', count > 0);
  
  const { tracked = 0, total = 0, skipped = 0 } = data.coverage || {};
  elements.coverageText.textContent = `Reading ${tracked}/${total} fields`;
  
  const coverageRatio = total > 0 ? tracked / total : 1;
  elements.coverage.classList.remove('full', 'partial');
  if (coverageRatio >= 0.9) {
    elements.coverage.classList.add('full');
  } else {
    elements.coverage.classList.add('partial');
  }
  elements.coverage.title = `Tracking ${tracked} of ${total} fields (${skipped} sensitive skipped)`;
  
  const hasChanges = count > 0;
  elements.emptyState.classList.toggle('hidden', hasChanges);
  elements.changesTable.classList.toggle('hidden', !hasChanges);
  elements.copyMarkdown.disabled = !hasChanges;
  elements.downloadMarkdown.disabled = !hasChanges;
  elements.copyCsv.disabled = !hasChanges;
  elements.downloadCsv.disabled = !hasChanges;
  
  elements.changesBody.innerHTML = '';
  
  if (hasChanges) {
    let rowNum = 0;
    for (const field of data.dirty) {
      rowNum++;
      const row = document.createElement('tr');
      
      const numCell = document.createElement('td');
      numCell.className = 'row-number-cell';
      const numSpan = document.createElement('span');
      numSpan.className = 'row-number';
      numSpan.textContent = rowNum;
      numCell.appendChild(numSpan);
      
      const labelCell = document.createElement('td');
      const labelWrapper = document.createElement('div');
      labelWrapper.className = 'field-label-wrapper';
      
      const labelSpan = document.createElement('span');
      labelSpan.className = 'field-label field-label-copyable';
      labelSpan.textContent = field.label;
      labelSpan.title = 'Click to copy field name';
      labelSpan.addEventListener('click', () => copyValue(field.label, 'Field name'));
      labelWrapper.appendChild(labelSpan);
      
      const typeIcon = createTypeInfoIcon(field.type);
      labelWrapper.appendChild(typeIcon);
      
      labelCell.appendChild(labelWrapper);
      
      const wasCell = createValueCell(field.was, 'field-was', 'Previous value');
      const nowCell = createValueCell(field.now, 'field-now', 'Current value');
      
      row.appendChild(numCell);
      row.appendChild(labelCell);
      row.appendChild(wasCell);
      row.appendChild(nowCell);
      elements.changesBody.appendChild(row);
    }
  }
}

function createValueCell(value, className, copyLabel) {
  const cell = document.createElement('td');
  const wrapper = document.createElement('div');
  wrapper.className = 'value-cell-wrapper';
  
  const displayValue = value || '(empty)';
  const isLong = displayValue.length > LONG_VALUE_THRESHOLD;
  
  const valueSpan = document.createElement('span');
  valueSpan.className = `${className} value-text`;
  valueSpan.dataset.full = displayValue;
  valueSpan.dataset.expanded = 'false';
  
  if (isLong) {
    valueSpan.textContent = truncate(displayValue, LONG_VALUE_THRESHOLD);
    valueSpan.classList.add('truncated');
  } else {
    valueSpan.textContent = displayValue;
  }
  
  wrapper.appendChild(valueSpan);
  
  const actionsWrapper = document.createElement('div');
  actionsWrapper.className = 'value-actions';
  
  if (isLong) {
    const expandBtn = document.createElement('button');
    expandBtn.className = 'value-action-btn expand-btn';
    expandBtn.title = 'Expand';
    expandBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none">${EXPAND_ICON_SVG}</svg>`;
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpand(valueSpan, expandBtn);
    });
    actionsWrapper.appendChild(expandBtn);
  }
  
  const copyBtn = document.createElement('button');
  copyBtn.className = 'value-action-btn copy-btn';
  copyBtn.title = `Copy ${copyLabel.toLowerCase()}`;
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none">${COPY_ICON_SVG}</svg>`;
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyValue(value, copyLabel);
  });
  actionsWrapper.appendChild(copyBtn);
  
  wrapper.appendChild(actionsWrapper);
  cell.appendChild(wrapper);
  
  valueSpan.addEventListener('click', () => copyValue(value, copyLabel));
  
  return cell;
}

function toggleExpand(valueSpan, expandBtn) {
  const isExpanded = valueSpan.dataset.expanded === 'true';
  
  if (isExpanded) {
    valueSpan.textContent = truncate(valueSpan.dataset.full, LONG_VALUE_THRESHOLD);
    valueSpan.dataset.expanded = 'false';
    valueSpan.classList.add('truncated');
    expandBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none">${EXPAND_ICON_SVG}</svg>`;
    expandBtn.title = 'Expand';
  } else {
    valueSpan.textContent = valueSpan.dataset.full;
    valueSpan.dataset.expanded = 'true';
    valueSpan.classList.remove('truncated');
    expandBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none">${COLLAPSE_ICON_SVG}</svg>`;
    expandBtn.title = 'Collapse';
  }
}

async function copyValue(value, label) {
  const text = value || '(empty)';
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
  } catch (err) {
    console.error('Copy failed:', err);
    showToast('Copy failed');
  }
}

function generateMarkdown() {
  if (!currentData || !currentData.dirty?.length) return '';
  
  const lines = [
    `## Change pack — ${currentData.host}${currentData.path} — ${formatDate()}`,
    '',
    '| Field | Was | Now |',
    '|-------|-----|-----|'
  ];
  
  for (const field of currentData.dirty) {
    const was = (field.was || '(empty)').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const now = (field.now || '(empty)').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${field.label} | ${was} | ${now} |`);
  }
  
  lines.push('');
  lines.push('_Generated by ChangePreview · not yet saved_');
  
  return lines.join('\n');
}

function generateCsv() {
  if (!currentData || !currentData.dirty?.length) return '';
  
  const escCsv = (str) => {
    str = String(str || '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  
  const lines = ['Field,Was,Now'];
  
  for (const field of currentData.dirty) {
    lines.push(`${escCsv(field.label)},${escCsv(field.was)},${escCsv(field.now)}`);
  }
  
  return lines.join('\n');
}

async function copyToClipboard(text, format) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${format} copied to clipboard`);
  } catch (err) {
    console.error('Copy failed:', err);
    showToast('Copy failed');
  }
}

async function refreshData() {
  if (isCleared()) {
    return;
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FIELDS' });
    if (response) {
      const fieldKeys = (response.dirty || []).map(f => f.key);
      const allFieldKeys = response.allFieldKeys || fieldKeys;
      const newFingerprint = createFingerprint(response.host, response.path, allFieldKeys);
      
      const liveHasChanges = response.dirty?.length > 0;
      
      // Check for persistent cleared marker - NEVER restore if page was cleared
      const pageCleared = await hasPageClearedMarker(response.host, response.path);
      
      if (persistEnabled && liveHasChanges) {
        // Real live changes detected - this is a new edit session
        // Mark that we've seen live changes, so we don't restore from persisted later
        justReloaded = false;
        
        if (pageCleared || panelClearedSession) {
          // First real edit after Clear - remove the marker, allow saving
          await removePageClearedMarker(response.host, response.path);
        }
        currentFingerprint = newFingerprint;
        await saveDetections(response, currentFingerprint);
        persistedData = { dirty: response.dirty, fingerprint: currentFingerprint };
        isShowingRestoredData = false;
        formLooksReset = false;
      }
      
      // RESTORE FROM PERSISTED: Only after reload, never after user undoes edits
      // justReloaded must be true - meaning no live edits detected this session yet
      // If user edited and then undid, justReloaded is false → clean state, not Reapply
      if (persistEnabled && !liveHasChanges && justReloaded && !isCleared() && !pageCleared && !panelClearedSession) {
        let persisted = await loadPersistedDetections(newFingerprint);
        if (!persisted) {
          const fallback = await loadPersistedByHostPath(response.host, response.path);
          if (fallback?.data) {
            persisted = fallback.data;
          }
        }
        
        if (persisted?.dirty?.length > 0) {
          persistedData = persisted;
          currentFingerprint = persisted.fingerprint || newFingerprint;
          isShowingRestoredData = true;
          formLooksReset = true;
          
          updateUI({
            host: response.host,
            path: response.path,
            dirty: persisted.dirty,
            coverage: response.coverage,
            fromPersisted: true
          });
          updateReapplyVisibility();
          return;
        }
      }
      
      // Either live changes, or no persisted to restore, or user undid (justReloaded=false)
      // When dirty is empty after undo (justReloaded=false), this is clean state
      if (!liveHasChanges && !justReloaded) {
        // User undid all changes - clear restored state
        isShowingRestoredData = false;
        formLooksReset = false;
      }
      
      currentFingerprint = newFingerprint;
      if (liveHasChanges) {
        isShowingRestoredData = false;
        formLooksReset = false;
      }
      updateUI(response);
      updateReapplyVisibility();
    }
  } catch (err) {
    console.error('Failed to get fields:', err);
    
    // Don't restore from storage if cleared or not just reloaded
    if (isCleared() || panelClearedSession || !justReloaded) return;
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && persistEnabled) {
      try {
        const url = new URL(tab.url);
        
        // Check for cleared marker before loading
        const pageCleared = await hasPageClearedMarker(url.host, url.pathname);
        if (pageCleared) return;
        
        const fallback = await loadPersistedByHostPath(url.host, url.pathname);
        if (fallback?.data?.dirty?.length > 0) {
          persistedData = fallback.data;
          currentFingerprint = fallback.data.fingerprint;
          isShowingRestoredData = true;
          formLooksReset = true;
          
          updateUI({
            host: url.host,
            path: url.pathname,
            dirty: persistedData.dirty,
            coverage: { tracked: 0, total: 0, skipped: 0 },
            fromPersisted: true
          });
          updateReapplyVisibility();
          return;
        }
      } catch (urlErr) {}
    }
    
    isShowingRestoredData = false;
    formLooksReset = false;
    updateUI({
      host: '—',
      path: '',
      dirty: [],
      coverage: { tracked: 0, total: 0, skipped: 0 }
    });
    updateReapplyVisibility();
  }
}

function showConfirmDialog() {
  elements.confirmDialog.classList.remove('hidden');
}

function hideConfirmDialog() {
  elements.confirmDialog.classList.add('hidden');
}

/**
 * Form fingerprint: creates a durable identity for persisted detections.
 * Uses origin + normalized pathname + field signature hash.
 * Field signature = sorted list of field keys, hashed for compactness.
 */
function createFingerprint(host, path, fieldKeys) {
  const normalizedPath = (path || '/').replace(/\/+$/, '') || '/';
  const keySignature = (fieldKeys || []).slice().sort().join('|');
  const hash = simpleHash(keySignature);
  return `${host}${normalizedPath}#${hash}`;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function getStorageKey(fingerprint) {
  return STORAGE_PREFIX + fingerprint;
}

async function loadPersistedDetections(fingerprint) {
  if (!fingerprint) return null;
  try {
    const key = getStorageKey(fingerprint);
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  } catch (err) {
    console.error('Failed to load persisted detections:', err);
    return null;
  }
}

async function loadPersistedByHostPath(host, path) {
  if (!host) return null;
  try {
    const normalizedPath = (path || '/').replace(/\/+$/, '') || '/';
    const prefix = STORAGE_PREFIX + host + normalizedPath;
    const all = await chrome.storage.local.get(null);
    
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        return { key, data: value };
      }
    }
    return null;
  } catch (err) {
    console.error('Failed to load persisted by host/path:', err);
    return null;
  }
}

async function saveDetections(data, fingerprint) {
  if (!persistEnabled || !fingerprint || !data?.dirty?.length) return;
  try {
    const key = getStorageKey(fingerprint);
    const toStore = {
      fingerprint: fingerprint,
      host: data.host,
      path: data.path,
      dirty: data.dirty.map(f => ({
        key: f.key,
        label: f.label,
        type: f.type,
        was: f.was,
        now: f.now
      })),
      savedAt: Date.now()
    };
    await chrome.storage.local.set({ [key]: toStore });
    persistedData = toStore;
  } catch (err) {
    console.error('Failed to save detections:', err);
  }
}

/**
 * Aggressively clear ALL detection storage keys for a page.
 * Uses multiple matching strategies to ensure no leftovers:
 * 1. Current fingerprint key
 * 2. Keys with matching prefix (host + normalized path)
 * 3. Keys where stored value.host/value.path match this page
 * 4. Set persistent cleared marker
 */
async function clearPersistedDetections(host, path) {
  try {
    const keysToRemove = [];
    const normalizedPath = (path || '/').replace(/\/+$/, '') || '/';
    
    // Strategy 1: Current fingerprint
    if (currentFingerprint) {
      keysToRemove.push(getStorageKey(currentFingerprint));
    }
    
    // Get all storage
    const all = await chrome.storage.local.get(null);
    
    if (host) {
      // Strategy 2: Key prefix matching (host + path variations)
      const prefixes = [
        STORAGE_PREFIX + host + normalizedPath,
        STORAGE_PREFIX + host + path,  // Original path
        STORAGE_PREFIX + host + normalizedPath.toLowerCase(),
      ];
      
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(STORAGE_PREFIX)) continue;
        if (keysToRemove.includes(key)) continue;
        
        // Check prefix match
        const matchesPrefix = prefixes.some(p => key.startsWith(p));
        
        // Strategy 3: Value match (stored host/path)
        const valueHost = value?.host || '';
        const valuePath = (value?.path || '/').replace(/\/+$/, '') || '/';
        const matchesValue = valueHost === host && valuePath === normalizedPath;
        
        // Strategy 4: Host-only match with path similarity
        const matchesHost = valueHost === host && key.includes(normalizedPath);
        
        if (matchesPrefix || matchesValue || matchesHost) {
          keysToRemove.push(key);
        }
      }
    }
    
    // Remove all matched keys
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
    
    // Set persistent cleared marker for this page
    await setPageClearedMarker(host, normalizedPath);
    
    // Clear memory
    persistedData = null;
    currentFingerprint = null;
    panelClearedSession = true;
    
  } catch (err) {
    console.error('Failed to clear persisted detections:', err);
  }
}

async function loadPersistSetting() {
  try {
    const result = await chrome.storage.local.get('persistEnabled');
    persistEnabled = result.persistEnabled || false;
    elements.persistToggle.checked = persistEnabled;
  } catch (err) {
    console.error('Failed to load persist setting:', err);
  }
}

async function savePersistSetting(enabled) {
  try {
    await chrome.storage.local.set({ persistEnabled: enabled });
    persistEnabled = enabled;
    if (!enabled) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let host = null;
      let path = null;
      if (tab?.url) {
        try {
          const url = new URL(tab.url);
          host = url.host;
          path = url.pathname;
        } catch {}
      }
      await clearPersistedDetections(host, path);
      isShowingRestoredData = false;
      formLooksReset = false;
      updateReapplyVisibility();
    }
  } catch (err) {
    console.error('Failed to save persist setting:', err);
  }
}

/**
 * Clear detections for the current form.
 * 
 * REGRESSION FIX for Keep→Reload→Reapply→Clear resurrection bug:
 * After Clear, detections MUST stay at 0 until user makes new edits.
 * 
 * Order of operations (critical for preventing phantom rows):
 * 1. Set clearedUntil timestamp to block ALL updates for 5 seconds
 * 2. Clear persisted storage for this form (fingerprint + host/path fallbacks)
 * 3. Tell content script to CLEAR_BASELINE (re-snapshot current values as baseline)
 * 4. Reset all panel state flags
 * 5. Update UI to show 0 changes immediately
 * 
 * The clearedUntil window blocks:
 * - Stale FIELDS_UPDATE messages from content script
 * - The periodic refreshData interval (2000ms)
 * - MutationObserver-triggered updates
 * - Debounced input events from previous Reapply operation
 * - Any storage load/save operations
 * 
 * After the window expires, the list stays empty because:
 * - Content script baseline === current form values
 * - Storage is cleared
 * - Only new real user edits will create new dirty entries
 */
async function clearDetections() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    
    let host = null;
    let path = null;
    if (tab.url) {
      try {
        const url = new URL(tab.url);
        host = url.host;
        path = url.pathname;
      } catch {}
    }
    
    // Block ALL updates for 5 seconds to prevent resurrection
    setClearedFor(5000);
    
    // Clear storage for this form
    await clearPersistedDetections(host, path);
    
    // Tell content script to re-baseline from current live values
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_BASELINE' });
    
    // Reset all panel state
    isShowingRestoredData = false;
    formLooksReset = false;
    persistedData = null;
    currentData = null;
    currentFingerprint = null;
    // After Clear, treat as if just reloaded so next page reload can restore
    // (though storage is cleared, so nothing to restore until user edits again)
    justReloaded = true;
    
    // Update UI to show empty state immediately
    const coverage = response?.baselineSize 
      ? { tracked: response.baselineSize, total: response.baselineSize, skipped: 0 }
      : { tracked: 0, total: 0, skipped: 0 };
    
    updateUI({
      host: host || '—',
      path: path || '',
      dirty: [],
      coverage: coverage
    });
    updateReapplyVisibility();
    
    showToast('Detections cleared');
  } catch (err) {
    console.error('Failed to clear detections:', err);
    showToast('Failed to clear');
  }
}

async function reapplyChanges() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    
    const persisted = persistedData || await loadPersistedDetections(currentFingerprint);
    if (!persisted?.dirty?.length) {
      showToast('No changes to reapply');
      return;
    }
    
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'APPLY_CHANGES',
      changes: persisted.dirty
    });
    
    if (response) {
      const { applied, failed, total } = response;
      if (failed > 0) {
        showToast(`Reapplied ${applied} of ${total} (${failed} failed)`);
      } else {
        showToast(`Reapplied ${applied} change${applied === 1 ? '' : 's'}`);
      }
      
      // After Reapply:
      // - Content script set baseline[key] = was for each change
      // - Form now has "now" values
      // - getDirtyFields() will return all restored changes (now vs was baseline)
      // - Hide Reapply button since values are now applied
      // - Mark that we've seen edits this session (prevents Reapply on later undo)
      isShowingRestoredData = false;
      formLooksReset = false;
      justReloaded = false;
      updateReapplyVisibility();
      
      // CRITICAL: Refresh the table with LIVE data from content script.
      // Without this, the table shows OLD persisted `now` values instead of live DOM values.
      // Wait briefly for content script's suppress window to clear, then get fresh data.
      setTimeout(async () => {
        const freshResponse = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FIELDS' });
        if (freshResponse?.dirty?.length > 0) {
          const fieldKeys = (freshResponse.dirty || []).map(f => f.key);
          const allFieldKeys = freshResponse.allFieldKeys || fieldKeys;
          currentFingerprint = createFingerprint(freshResponse.host, freshResponse.path, allFieldKeys);
          
          // Save fresh data to storage
          if (persistEnabled) {
            persistedData = { dirty: freshResponse.dirty };
            saveDetections(freshResponse, currentFingerprint);
          }
          
          updateUI(freshResponse);
          updateReapplyVisibility();
        }
      }, 1200);
    }
  } catch (err) {
    console.error('Failed to reapply changes:', err);
    showToast('Failed to reapply');
  }
}

function updateReapplyVisibility() {
  const shouldShow = persistEnabled && isShowingRestoredData && formLooksReset && persistedData?.dirty?.length > 0;
  if (shouldShow) {
    elements.reapplyRow.classList.remove('hidden');
  } else {
    elements.reapplyRow.classList.add('hidden');
  }
}


function generateFilename(ext = 'csv') {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const host = currentData?.host?.replace(/[^a-zA-Z0-9]/g, '-') || 'page';
  return `change-preview-${host}-${date}.${ext}`;
}

function downloadCsv() {
  const csv = generateCsv();
  if (!csv) return;
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = generateFilename('csv');
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('CSV downloaded');
}

function downloadMarkdown() {
  const md = generateMarkdown();
  if (!md) return;
  
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = generateFilename('md');
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('Markdown downloaded');
}

elements.copyMarkdown.addEventListener('click', () => {
  const md = generateMarkdown();
  if (md) copyToClipboard(md, 'Markdown');
});

elements.downloadMarkdown.addEventListener('click', downloadMarkdown);

elements.copyCsv.addEventListener('click', () => {
  const csv = generateCsv();
  if (csv) copyToClipboard(csv, 'CSV');
});

elements.downloadCsv.addEventListener('click', downloadCsv);

elements.clearDetections.addEventListener('click', showConfirmDialog);

elements.confirmCancel.addEventListener('click', hideConfirmDialog);

elements.confirmClear.addEventListener('click', () => {
  hideConfirmDialog();
  clearDetections();
});

elements.persistToggle.addEventListener('change', (e) => {
  savePersistSetting(e.target.checked);
  updateReapplyVisibility();
});

elements.reapplyChanges.addEventListener('click', reapplyChanges);

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'FIELDS_UPDATE') {
    const data = message.data;
    const hasDirtyData = data.dirty?.length > 0;
    
    // During the short-term cleared window (5s), only accept updates with real dirty data
    // This blocks stale empty updates but allows real new edits through
    if (isCleared() && !hasDirtyData) {
      return;
    }
    
    const fieldKeys = (data.dirty || []).map(f => f.key);
    const allFieldKeys = data.allFieldKeys || fieldKeys;
    currentFingerprint = createFingerprint(data.host, data.path, allFieldKeys);
    
    if (hasDirtyData) {
      // Real dirty data = user made an edit
      // Mark that we've seen live edits - prevents Reapply on later undo
      justReloaded = false;
      
      // If we're in cleared session, this is the first edit after Clear
      if (panelClearedSession) {
        // Remove the cleared marker, unlock saves
        await removePageClearedMarker(data.host, data.path);
        // panelClearedSession is now false (set by removePageClearedMarker)
      }
      
      isShowingRestoredData = false;
      formLooksReset = false;
      
      // Save to storage if persist is ON (panelClearedSession was just reset above)
      if (persistEnabled) {
        persistedData = { dirty: data.dirty };
        saveDetections(data, currentFingerprint);
      }
    } else if (!justReloaded) {
      // Dirty is empty AND we've seen edits this session = user undid all changes
      // This is clean state, NOT Reapply case. Clear restored flags.
      isShowingRestoredData = false;
      formLooksReset = false;
    }
    
    updateUI(data);
    updateReapplyVisibility();
  }
});

chrome.tabs.onActivated.addListener(async () => {
  // New tab activated - treat as a fresh session for Reapply logic
  justReloaded = true;
  await refreshData();
  await updateReapplyVisibility();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    // Page reloaded - reset to allow Reapply if persisted data exists
    justReloaded = true;
    await refreshData();
    await updateReapplyVisibility();
  }
});

async function init() {
  await loadPersistSetting();
  await refreshData();
  updateReapplyVisibility();
}

init();
setInterval(refreshData, 2000);
