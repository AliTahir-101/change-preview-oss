/**
 * ChangePreview Side Panel
 * Displays dirty fields, copy Markdown/CSV, re-snapshot.
 */

import {
  getLicenseState,
  isUnlocked,
  activateLicense,
  isValidKeyFormat,
  openPurchasePage,
  getUnlockInfo,
} from './license.js';

let isLicenseValid = false;

const elements = {
  // Main panel elements
  mainPanel: document.getElementById('mainPanel'),
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
  confirmToggle: document.getElementById('confirmToggle'),
  reapplyRow: document.getElementById('reapplyRow'),
  reapplyChanges: document.getElementById('reapplyChanges'),
  clearDetections: document.getElementById('clearDetections'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmCancel: document.getElementById('confirmCancel'),
  confirmClear: document.getElementById('confirmClear'),
  toast: document.getElementById('toast'),
  
  // Unlock screen elements
  unlockScreen: document.getElementById('unlockScreen'),
  unlockPrice: document.getElementById('unlockPrice'),
  buyBtn: document.getElementById('buyBtn'),
  licenseKeyInput: document.getElementById('licenseKeyInput'),
  activateBtn: document.getElementById('activateBtn'),
  unlockError: document.getElementById('unlockError'),
  sellerName: document.getElementById('sellerName'),
  sellerLink: document.getElementById('sellerLink'),
  supportLink: document.getElementById('supportLink'),
  privacyLink: document.getElementById('privacyLink'),
};

const COPY_ICON_SVG = '<rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" fill="none"/>';
const EXPAND_ICON_SVG = '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
const COLLAPSE_ICON_SVG = '<path d="M18 15l-6-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';

const LONG_VALUE_THRESHOLD = 60;
const STORAGE_PREFIX = 'cp_detections:';
const CLEARED_PREFIX = 'cp_cleared:';
const CONFIRM_ON_SAVE_KEY = 'confirmOnSaveEnabled';

/**
 * Query params that are tracking/analytics junk. They are stripped from the
 * canonical page key so the same form isn't split across campaign/share links.
 * Matched case-insensitively, plus any param whose name starts with "utm_".
 */
const TRACKING_PARAMS = new Set([
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source',
  'fbclid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'igshid', 'scid',
  'mc_cid', 'mc_eid', 'oly_anon_id', 'oly_enc_id', 'vero_id', 'vero_conv',
  '_hsenc', '_hsmi', 'mkt_tok', 'ref_src', 'ref_url', 'wickedid',
]);

function isTrackingParam(name) {
  const n = (name || '').toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
}

/**
 * Canonical identity for a form page: origin + pathname + meaningful query.
 *
 * - Drops the hash (#…) entirely.
 * - Removes tracking params (utm_*, gclid, fbclid, …) but keeps real query
 *   params (e.g. ?formId=123) so different forms on the same path stay separate.
 * - Sorts the remaining params so param order never splits one form.
 * - Normalizes a trailing slash on the pathname.
 *
 * Returns null for unparseable input. This is a storage/identity key, not a
 * URL meant to be navigated to.
 */
function canonicalizePageUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const params = new URLSearchParams(u.search);
  for (const key of [...params.keys()]) {
    if (isTrackingParam(key)) params.delete(key);
  }
  params.sort();
  const query = params.toString();
  const search = query ? `?${query}` : '';
  const pathname = (u.pathname || '/').replace(/\/+$/, '') || '/';
  return `${u.origin}${pathname}${search}`;
}

/**
 * Resolve the canonical page key for a content-script payload or a tab URL.
 *
 * Prefers the full top-level `url` (reported by the top frame only, so CDN/
 * sub-frame URLs never become the identity). Falls back to a host+path pseudo
 * URL when only host/path are available (e.g. an older content script, or the
 * no-content-script tab.url path). Returns null when nothing usable is present.
 */
function getPageKey(source) {
  if (source && typeof source.url === 'string' && source.url) {
    const canon = canonicalizePageUrl(source.url);
    if (canon) return canon;
  }
  const host = source?.host;
  if (!host) return null;
  const path = (source?.path || '/').replace(/\/+$/, '') || '/';
  return `https://${host}${path}`;
}

function searchParamsMap(search) {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const map = {};
  for (const [k, v] of p.entries()) {
    if (!map[k]) map[k] = [];
    map[k].push(v);
  }
  return map;
}

function paramsAreSubset(small, large) {
  for (const [k, vals] of Object.entries(small)) {
    if (!large[k]) return false;
    for (const v of vals) {
      if (!large[k].includes(v)) return false;
    }
  }
  return true;
}

/**
 * True when two canonical page keys are the same logical form page.
 *
 * Same origin + pathname (trailing slash already normalized by canonicalize).
 * Queries: identical, or one is a subset of the other — so a URL that settles
 * after load (`/prefs` → `/prefs?tab=1`) still hits the Keep snapshot, while
 * `?formId=1` vs `?formId=2` stay separate.
 */
function sameLogicalPage(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.origin !== ub.origin) return false;
    const pa = (ua.pathname || '/').replace(/\/+$/, '') || '/';
    const pb = (ub.pathname || '/').replace(/\/+$/, '') || '/';
    if (pa !== pb) return false;
    const qa = searchParamsMap(ua.search);
    const qb = searchParamsMap(ub.search);
    return paramsAreSubset(qa, qb) || paramsAreSubset(qb, qa);
  } catch {
    return false;
  }
}

/**
 * Strip the ephemeral `frame:<uid>:` prefix. Iframe remounts mint a new UID, so
 * Keep/restore must identity fields without it or the same change stacks as
 * several rows across reloads.
 */
function logicalFieldKey(key) {
  return typeof key === 'string' ? key.replace(/^frame:[^:]+:/, '') : '';
}

/**
 * Collapse dirty rows that represent the same logical field (last wins).
 * When stripFramePrefix is set (Keep save/restore), stored keys drop the
 * ephemeral frame UID so a later reload cannot resurrect N copies.
 */
function dedupeDirtyFields(dirty, { stripFramePrefix = false } = {}) {
  const seen = new Map();
  for (const f of Array.isArray(dirty) ? dirty : []) {
    if (!f || typeof f.key !== 'string') continue;
    const logical = logicalFieldKey(f.key);
    if (!logical) continue;
    seen.set(logical, stripFramePrefix ? { ...f, key: logical } : { ...f });
  }
  return Array.from(seen.values());
}

function getCanonicalStorageKey(pageKey) {
  return STORAGE_PREFIX + (pageKey || '');
}

function pageKeyHostPath(pageKey) {
  try {
    const u = new URL(pageKey);
    return { host: u.host, path: (u.pathname || '/').replace(/\/+$/, '') || '/' };
  } catch {
    return null;
  }
}

/**
 * True when a chrome.storage.local entry is a Keep snapshot for this page —
 * the canonical 0.3.7+ key, a 0.3.3–0.3.6 `<pageKey>#<hash>` key, or a
 * pre-0.3.3 host+path key for the same host/path.
 */
function isDetectionKeyForPage(key, value, pageKey) {
  if (!pageKey || typeof key !== 'string' || !key.startsWith(STORAGE_PREFIX)) return false;
  if ((value?.pageKey || '') === pageKey) return true;
  const canon = getCanonicalStorageKey(pageKey);
  if (key === canon || key.startsWith(`${canon}#`)) return true;
  const hp = pageKeyHostPath(pageKey);
  if (!hp) return false;
  if (value?.pageKey && sameLogicalPage(value.pageKey, pageKey)) return true;
  const valueHost = value?.host || '';
  const valuePath = (value?.path || '/').replace(/\/+$/, '') || '/';
  if (valueHost && sameLogicalPage(`https://${valueHost}${valuePath}`, pageKey)) return true;
  const legacyPrefix = STORAGE_PREFIX + hp.host + hp.path;
  return key === legacyPrefix || key.startsWith(`${legacyPrefix}#`);
}

let currentData = null;
let persistEnabled = false;

/**
 * Id of the tab the panel is currently bound to (the active tab in this window).
 *
 * Content scripts broadcast FIELDS_UPDATE via chrome.runtime.sendMessage, which
 * every tab's content script (foreground AND background) can emit — e.g. a
 * background Gmail tab whose iframes heartbeat. Without this guard the panel
 * would apply whichever tab pushed last, making the displayed host/detections
 * oscillate between tabs. We only accept pushes whose sender.tab.id matches this
 * value, so the panel always reflects the active tab alone.
 */
let activeTabId = null;
let currentFingerprint = null;
let persistedData = null;
let isShowingRestoredData = false;
let formLooksReset = false;

/**
 * Sticky Keep restore: { tabId, pageKey }. While this is set, live scans
 * (snapshot, mutation, hydration, 2s poll) must not replace or clear the
 * restored rows. Only a trusted user-input push, Clear, Keep-off, or a real
 * navigation to a different logical page ends it.
 */
let restoredKeep = null;

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
 * Detect the benign "no content script on this tab yet" error.
 *
 * chrome.tabs.sendMessage rejects with "Could not establish connection.
 * Receiving end does not exist." whenever the active tab has no content script
 * listening — e.g. chrome:// pages, the new tab page, restricted URLs, or an
 * ordinary page before injection has finished. This is expected while polling
 * and should NOT be surfaced as a console.error (Chrome shows those on
 * chrome://extensions). Real, unexpected failures are still logged.
 */
function isBenignConnectionError(err) {
  const message =
    (err && err.message) ||
    (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
    (typeof err === 'string' ? err : '') ||
    '';
  return (
    message.includes('Could not establish connection') ||
    message.includes('Receiving end does not exist') ||
    message.includes('The message port closed before a response was received')
  );
}

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
 * Get the cleared marker key for a canonical page key.
 */
function getClearedMarkerKey(pageKey) {
  return CLEARED_PREFIX + (pageKey || '');
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
async function hasPageClearedMarker(pageKey) {
  if (!pageKey) return false;
  try {
    const markerKey = getClearedMarkerKey(pageKey);
    const all = await chrome.storage.local.get(null);
    const marker = all[markerKey];
    
    if (!marker?.untilEdit) {
      return false;
    }
    
    // Check if there's any saved detection data AFTER clearedAt
    const clearedAt = marker.clearedAt || 0;
    
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      
      // Check if this is data for the same page (by canonical page key)
      if ((value?.pageKey || '') === pageKey) {
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
async function setPageClearedMarker(pageKey) {
  if (!pageKey) return;
  try {
    const key = getClearedMarkerKey(pageKey);
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
async function removePageClearedMarker(pageKey) {
  if (!pageKey) return;
  try {
    const key = getClearedMarkerKey(pageKey);
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

function endKeepRestore() {
  restoredKeep = null;
  isShowingRestoredData = false;
  formLooksReset = false;
}

function keepRestoreHolds(tabId, pageKey) {
  return !!(
    persistEnabled &&
    isShowingRestoredData &&
    restoredKeep &&
    restoredKeep.tabId === tabId &&
    sameLogicalPage(restoredKeep.pageKey, pageKey)
  );
}

function beginKeepRestore(tabId, pageKey, persisted, host, path, coverage) {
  restoredKeep = { tabId, pageKey };
  persistedData = persisted;
  currentFingerprint = persisted.fingerprint || currentFingerprint;
  isShowingRestoredData = true;
  formLooksReset = true;
  justReloaded = true;
  updateUI({
    host: host || persisted.host || '—',
    path: path || persisted.path || '',
    dirty: persisted.dirty,
    coverage: coverage || { tracked: 0, total: 0, skipped: 0 },
    fromPersisted: true
  });
  updateReapplyVisibility();
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
      // Whole-row click locates (scrolls to + highlights) the field on the page.
      // Copyable spans/buttons stopPropagation so copying never also triggers it.
      row.className = 'change-row';
      row.dataset.key = field.key;
      row.title = 'Click to find this field on the page';
      row.addEventListener('click', () => locateField(field.key, row));
      
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
      labelSpan.addEventListener('click', (e) => { e.stopPropagation(); copyValue(field.label, 'Field name'); });
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
  
  valueSpan.addEventListener('click', (e) => { e.stopPropagation(); copyValue(value, copyLabel); });
  
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

/**
 * Locate a detected field on the page: ask the active tab's content script to
 * scroll to and highlight the control for this row's key. Fields inside tracked
 * same-origin frames are forwarded there by the content script; cross-origin
 * frames fail soft (no highlight, no crash).
 */
async function locateField(key, rowEl) {
  // Brief in-panel flash so the click feels responsive even before the page scrolls.
  if (rowEl) {
    rowEl.classList.remove('row-locating');
    // reflow so the animation restarts on rapid repeated clicks
    void rowEl.offsetWidth;
    rowEl.classList.add('row-locating');
    setTimeout(() => rowEl.classList.remove('row-locating'), 900);
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'REVEAL_FIELD', key });
    // Only toast a definitive miss for a top-document field. Frame-forwarded
    // reveals resolve asynchronously in the child frame, so we can't confirm them.
    if (resp && resp.found === false && !resp.forwarded) {
      showToast('Could not find this field on the page');
    }
  } catch (err) {
    if (isBenignConnectionError(err)) {
      showToast('Open the form page to locate fields');
    } else {
      console.error('Locate failed:', err);
    }
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

async function refreshData(explicitTabId) {
  if (isCleared()) {
    return;
  }
  
  // Resolve the tab to read. When an explicit tab id is provided (tab activated
  // or window focus changed), bind to THAT tab directly rather than relying on
  // chrome.tabs.query({currentWindow:true}), which from a side-panel context can
  // resolve to the wrong window and leave the panel stuck on the previous tab.
  // activeTabId is updated here so the newly bound tab's FIELDS_UPDATE pushes are
  // accepted (and the old tab's are rejected) even if GET_FIELDS below throws.
  let tab = null;
  try {
    if (explicitTabId != null) {
      tab = await chrome.tabs.get(explicitTabId);
    } else {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
  } catch {
    tab = null;
  }
  if (!tab?.id) return;
  const tabId = tab.id;
  activeTabId = tabId;
  
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_FIELDS' });
    if (response) {
      const fieldKeys = (response.dirty || []).map(f => f.key);
      const allFieldKeys = response.allFieldKeys || fieldKeys;
      const pageKey = getPageKey(response) || getPageKey({ url: tab.url });
      const newFingerprint = createFingerprint(pageKey, allFieldKeys);
      
      const liveHasChanges = response.dirty?.length > 0;

      // Durable Keep: a live SCAN on the same logical page must not replace
      // the restored snapshot (hydration dirty or empty baseline after reload).
      if (keepRestoreHolds(tabId, pageKey)) {
        return;
      }
      if (restoredKeep && restoredKeep.tabId === tabId && pageKey
          && !sameLogicalPage(restoredKeep.pageKey, pageKey)) {
        endKeepRestore();
      }
      
      // Check for persistent cleared marker - NEVER restore if page was cleared
      const pageCleared = await hasPageClearedMarker(pageKey);

      // After reload (or tab bind), Keep snapshot wins over any live scan —
      // including a hydration scan that looks dirty for 1–2s then goes empty.
      if (persistEnabled && justReloaded && !isCleared() && !pageCleared && !panelClearedSession) {
        const fallback = await loadPersistedByPageKey(pageKey);
        if (fallback?.data?.dirty?.length > 0) {
          beginKeepRestore(tabId, pageKey, fallback.data, response.host, response.path, response.coverage);
          return;
        }
      }
      
      if (persistEnabled && liveHasChanges) {
        // Real live changes detected - this is a new edit session
        // Mark that we've seen live changes, so we don't restore from persisted later
        justReloaded = false;
        
        if (pageCleared || panelClearedSession) {
          // First real edit after Clear - remove the marker, allow saving
          await removePageClearedMarker(pageKey);
        }
        currentFingerprint = newFingerprint;
        await saveDetections(response, currentFingerprint);
        persistedData = { dirty: response.dirty, fingerprint: currentFingerprint };
        endKeepRestore();
      }
      
      // Either live changes, or no persisted to restore, or user undid (justReloaded=false)
      // When dirty is empty after undo (justReloaded=false), this is clean state
      if (!liveHasChanges && !justReloaded) {
        // User undid all changes - clear restored state
        endKeepRestore();
      }
      
      currentFingerprint = newFingerprint;
      if (liveHasChanges) {
        endKeepRestore();
      }
      updateUI(response);
      updateReapplyVisibility();
    }
  } catch (err) {
    // Benign: the active tab has no content script yet (chrome:// pages, new
    // tab, restricted URLs, or before injection). Expected while polling, so
    // stay quiet instead of spamming chrome://extensions with console.error.
    if (isBenignConnectionError(err)) {
      console.debug('ChangePreview: no content script on active tab (expected).');
    } else {
      console.error('Failed to get fields:', err);
    }
    
    // Don't clobber a Keep snapshot that's already on screen for this tab
    // (content script not injected yet is expected during reload).
    if (restoredKeep && restoredKeep.tabId === tabId) return;

    // Don't restore from storage if cleared or not just reloaded
    if (isCleared() || panelClearedSession || !justReloaded) return;
    
    // Reuse the tab resolved at the top (do NOT re-query currentWindow, which can
    // point at a different window from a side panel).
    if (tab?.url && persistEnabled) {
      try {
        const url = new URL(tab.url);
        const pageKey = getPageKey({ url: tab.url });
        
        // Check for cleared marker before loading
        const pageCleared = await hasPageClearedMarker(pageKey);
        if (pageCleared) return;
        
        const fallback = await loadPersistedByPageKey(pageKey);
        if (fallback?.data?.dirty?.length > 0) {
          beginKeepRestore(tabId, pageKey, fallback.data, url.host, url.pathname, {
            tracked: 0, total: 0, skipped: 0
          });
          return;
        }
      } catch (urlErr) {}
    }
    
    endKeepRestore();
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
 * In-memory form fingerprint (page + field-set). Storage itself is keyed only
 * by canonical pageKey (one Keep snapshot per form page); this hash is kept as
 * metadata so a field-set change is still observable, but it must not split
 * snapshots — iframe UID churn used to mint a new `<pageKey>#<hash>` key on
 * every remount and stack duplicate rows across Keep+reload.
 */
function createFingerprint(pageKey, fieldKeys) {
  const keySignature = (fieldKeys || []).map(logicalFieldKey).filter(Boolean).slice().sort().join('|');
  const hash = simpleHash(keySignature);
  return `${pageKey || ''}#${hash}`;
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

async function loadPersistedByPageKey(pageKey) {
  if (!pageKey) return null;
  try {
    const all = await chrome.storage.local.get(null);
    const candidates = [];
    for (const [key, value] of Object.entries(all)) {
      if (isDetectionKeyForPage(key, value, pageKey) && value?.dirty?.length > 0) {
        candidates.push({ key, data: value });
      }
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => (b.data.savedAt || 0) - (a.data.savedAt || 0));
    const best = candidates[0];
    const dirty = dedupeDirtyFields(best.data.dirty, { stripFramePrefix: true });
    const pageKeyHost = pageKeyHostPath(pageKey);
    const migrated = {
      ...best.data,
      pageKey,
      host: best.data.host || pageKeyHost?.host,
      path: best.data.path || pageKeyHost?.path,
      dirty
    };

    const canon = getCanonicalStorageKey(pageKey);
    const extras = candidates.map((c) => c.key).filter((k) => k !== canon);
    if (best.key !== canon) {
      await chrome.storage.local.set({ [canon]: migrated });
    } else if (dirty.length !== (best.data.dirty || []).length) {
      await chrome.storage.local.set({ [canon]: migrated });
    }
    if (extras.length > 0) {
      await chrome.storage.local.remove(extras);
    }

    return { key: canon, data: migrated };
  } catch (err) {
    console.error('Failed to load persisted by page key:', err);
    return null;
  }
}

async function saveDetections(data, fingerprint) {
  if (!persistEnabled || !fingerprint || !data?.dirty?.length) return;
  try {
    const pageKey = getPageKey(data);
    if (!pageKey) return;
    const dirty = dedupeDirtyFields(data.dirty, { stripFramePrefix: true }).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      was: f.was,
      now: f.now
    }));
    if (!dirty.length) return;

    const key = getCanonicalStorageKey(pageKey);
    const toStore = {
      fingerprint: fingerprint,
      // Canonical identity for this form page (origin + path + meaningful query).
      pageKey,
      // host/path retained for the header display of restored data.
      host: data.host,
      path: data.path,
      dirty,
      savedAt: Date.now()
    };
    await chrome.storage.local.set({ [key]: toStore });
    persistedData = toStore;

    // One snapshot per page: drop hash-suffixed / legacy host+path siblings so
    // Keep+reload cannot stack them as extra rows.
    const all = await chrome.storage.local.get(null);
    const extras = Object.keys(all).filter((k) => k !== key && isDetectionKeyForPage(k, all[k], pageKey));
    if (extras.length > 0) {
      await chrome.storage.local.remove(extras);
    }
  } catch (err) {
    console.error('Failed to save detections:', err);
  }
}

/**
 * Aggressively clear ALL detection storage keys for a page.
 * Matches the canonical pageKey slot, hash-suffixed 0.3.3–0.3.6 keys, and
 * legacy host+path keys, then sets the persistent cleared marker.
 */
async function clearPersistedDetections(pageKey) {
  try {
    const keysToRemove = [];
    
    // Strategy 1: Current fingerprint (may still be a hash-suffixed key)
    if (currentFingerprint) {
      keysToRemove.push(getStorageKey(currentFingerprint));
    }
    if (pageKey) {
      keysToRemove.push(getCanonicalStorageKey(pageKey));
    }
    
    // Get all storage
    const all = await chrome.storage.local.get(null);
    
    if (pageKey) {
      for (const [key, value] of Object.entries(all)) {
        if (keysToRemove.includes(key)) continue;
        if (isDetectionKeyForPage(key, value, pageKey)) {
          keysToRemove.push(key);
        }
      }
    }
    
    // Remove all matched keys
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
    
    // Set persistent cleared marker for this page
    await setPageClearedMarker(pageKey);
    
    // Clear memory
    persistedData = null;
    currentFingerprint = null;
    panelClearedSession = true;
    
  } catch (err) {
    console.error('Failed to clear persisted detections:', err);
  }
}

/**
 * Load the "Confirm on save" preference. Defaults to ON so the confirmation
 * dialog keeps appearing unless the user explicitly turned it off. The content
 * script reads the same storage key (and watches for changes), so toggling here
 * updates the save/submit intercept across every tab.
 */
async function loadConfirmOnSaveSetting() {
  try {
    const result = await chrome.storage.local.get(CONFIRM_ON_SAVE_KEY);
    const enabled = result[CONFIRM_ON_SAVE_KEY] !== false;
    elements.confirmToggle.checked = enabled;
  } catch (err) {
    console.error('Failed to load confirm-on-save setting:', err);
    elements.confirmToggle.checked = true;
  }
}

async function saveConfirmOnSaveSetting(enabled) {
  try {
    await chrome.storage.local.set({ [CONFIRM_ON_SAVE_KEY]: enabled });
    showToast(enabled ? 'Confirm on save: on' : 'Confirm on save: off');
  } catch (err) {
    console.error('Failed to save confirm-on-save setting:', err);
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
    
    if (enabled) {
      // CRITICAL FIX: User may have already edited the form BEFORE ticking Keep.
      // Those detections exist only in-memory (nothing was saved while Keep was OFF).
      // Immediately snapshot the current live detections to storage so they survive reload.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FIELDS' });
          if (response?.dirty?.length > 0) {
            const fieldKeys = (response.dirty || []).map(f => f.key);
            const allFieldKeys = response.allFieldKeys || fieldKeys;
            const pageKey = getPageKey(response);
            currentFingerprint = createFingerprint(pageKey, allFieldKeys);
            // We're saving fresh data, so any old cleared marker for this page is stale
            await removePageClearedMarker(pageKey);
            await saveDetections(response, currentFingerprint);
            persistedData = { dirty: response.dirty, fingerprint: currentFingerprint };
          }
        } catch (msgErr) {
          // Content script may not be ready - that's OK, future edits will save
        }
      }
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pageKey = tab?.url ? getPageKey({ url: tab.url }) : null;
      await clearPersistedDetections(pageKey);
      endKeepRestore();
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
    const pageKey = tab.url ? getPageKey({ url: tab.url }) : null;
    
    // Block ALL updates for 5 seconds to prevent resurrection
    setClearedFor(5000);
    
    // Clear storage for this form
    await clearPersistedDetections(pageKey);
    
    // Tell content script to re-baseline from current live values
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_BASELINE' });
    
    // Reset all panel state
    endKeepRestore();
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
    if (isBenignConnectionError(err)) {
      console.debug('ChangePreview: clear skipped, no content script on active tab (expected).');
    } else {
      console.error('Failed to clear detections:', err);
      showToast('Failed to clear');
    }
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
      endKeepRestore();
      justReloaded = false;
      updateReapplyVisibility();
      
      // CRITICAL: Refresh the table with LIVE data from content script.
      // Without this, the table shows OLD persisted `now` values instead of live DOM values.
      // Wait briefly for content script's suppress window to clear, then get fresh data.
      setTimeout(async () => {
        let freshResponse;
        try {
          freshResponse = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FIELDS' });
        } catch (err) {
          if (!isBenignConnectionError(err)) {
            console.error('Failed to refresh after reapply:', err);
          }
          return;
        }
        if (freshResponse?.dirty?.length > 0) {
          const fieldKeys = (freshResponse.dirty || []).map(f => f.key);
          const allFieldKeys = freshResponse.allFieldKeys || fieldKeys;
          currentFingerprint = createFingerprint(getPageKey(freshResponse), allFieldKeys);
          
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
    if (isBenignConnectionError(err)) {
      console.debug('ChangePreview: reapply skipped, no content script on active tab (expected).');
    } else {
      console.error('Failed to reapply changes:', err);
      showToast('Failed to reapply');
    }
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
  if (!isLicenseValid) {
    showToast('Unlock to use export features');
    return;
  }
  const md = generateMarkdown();
  if (md) copyToClipboard(md, 'Markdown');
});

elements.downloadMarkdown.addEventListener('click', () => {
  if (!isLicenseValid) {
    showToast('Unlock to use export features');
    return;
  }
  downloadMarkdown();
});

elements.copyCsv.addEventListener('click', () => {
  if (!isLicenseValid) {
    showToast('Unlock to use export features');
    return;
  }
  const csv = generateCsv();
  if (csv) copyToClipboard(csv, 'CSV');
});

elements.downloadCsv.addEventListener('click', () => {
  if (!isLicenseValid) {
    showToast('Unlock to use export features');
    return;
  }
  downloadCsv();
});

elements.clearDetections.addEventListener('click', () => {
  if (!isLicenseValid) {
    showToast('Unlock to clear detections');
    return;
  }
  showConfirmDialog();
});

elements.confirmCancel.addEventListener('click', hideConfirmDialog);

elements.confirmClear.addEventListener('click', () => {
  hideConfirmDialog();
  clearDetections();
});

elements.confirmToggle.addEventListener('change', (e) => {
  saveConfirmOnSaveSetting(e.target.checked);
});

elements.persistToggle.addEventListener('change', (e) => {
  if (!isLicenseValid) {
    e.target.checked = false;
    showToast('Unlock to keep changes after reload');
    return;
  }
  savePersistSetting(e.target.checked);
  updateReapplyVisibility();
});

elements.reapplyChanges.addEventListener('click', () => {
  if (!isLicenseValid) {
    showToast('Unlock to reapply changes');
    return;
  }
  reapplyChanges();
});

chrome.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === 'FIELDS_UPDATE') {
    // Bind the panel to the active tab only. FIELDS_UPDATE is a runtime broadcast
    // that any tab's content script can emit, so ignore pushes from other tabs
    // (e.g. a background Gmail tab) — otherwise they clobber the active tab's
    // identity and detections, causing the host/field list to flicker on switch.
    // If we don't yet know the active tab, drop the push; the 2s poll and
    // onActivated/onUpdated handlers will pull the correct state.
    if (!sender?.tab || activeTabId === null || sender.tab.id !== activeTabId) {
      return;
    }

    const data = message.data;
    const hasDirtyData = data.dirty?.length > 0;
    const trigger = data.trigger === 'user-input' ? 'user-input' : 'scan';
    
    // During the short-term cleared window (5s), only accept updates with real dirty data
    // This blocks stale empty updates but allows real new edits through
    if (isCleared() && !hasDirtyData) {
      return;
    }
    
    const fieldKeys = (data.dirty || []).map(f => f.key);
    const allFieldKeys = data.allFieldKeys || fieldKeys;
    const pageKey = getPageKey(data);
    currentFingerprint = createFingerprint(pageKey, allFieldKeys);

    if (keepRestoreHolds(sender.tab.id, pageKey) && trigger !== 'user-input') {
      // Keep snapshot is on screen for this page. Ignore scan/hydration/empty
      // baseline pushes so they cannot flash-then-clear the restored rows.
      return;
    }
    if (restoredKeep && restoredKeep.tabId === sender.tab.id && pageKey
        && !sameLogicalPage(restoredKeep.pageKey, pageKey)) {
      endKeepRestore();
      justReloaded = true;
    }
    
    if (hasDirtyData) {
      // Scan dirty during the reload window is hydration, not a new session —
      // prefer the Keep snapshot when one exists.
      if (trigger !== 'user-input' && persistEnabled && justReloaded) {
        const fallback = await loadPersistedByPageKey(pageKey);
        if (fallback?.data?.dirty?.length > 0) {
          beginKeepRestore(sender.tab.id, pageKey, fallback.data, data.host, data.path, data.coverage);
          return;
        }
      }

      // Real dirty data = user made an edit
      // Mark that we've seen live edits - prevents Reapply on later undo
      justReloaded = false;
      
      // If we're in cleared session, this is the first edit after Clear
      if (panelClearedSession) {
        // Remove the cleared marker, unlock saves
        await removePageClearedMarker(pageKey);
        // panelClearedSession is now false (set by removePageClearedMarker)
      }
      
      endKeepRestore();
      
      // Save to storage if persist is ON (panelClearedSession was just reset above)
      if (persistEnabled) {
        persistedData = { dirty: data.dirty };
        saveDetections(data, currentFingerprint);
      }
      
      updateUI(data);
      updateReapplyVisibility();
      return;
    }
    
    // Empty dirty update (no changes in form right now)
    
    // CRITICAL FIX: After a page reload, the content script re-snapshots and fires
    // an EMPTY FIELDS_UPDATE. If we're showing restored data, this empty update would
    // wipe it. Ignore empty updates while showing restored data - the form is reset
    // and we're intentionally displaying the saved snapshot (with Reapply offered).
    if (isShowingRestoredData) {
      return;
    }
    
    if (!justReloaded) {
      // Dirty is empty AND we've seen edits this session = user undid all changes
      // This is clean state, NOT Reapply case. Clear restored flags.
      isShowingRestoredData = false;
      formLooksReset = false;
    }
    
    updateUI(data);
    updateReapplyVisibility();
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Rebind the panel to the newly active tab BEFORE anything else so late pushes
  // from the previous tab are rejected by the FIELDS_UPDATE guard immediately.
  activeTabId = activeInfo.tabId;
  if (restoredKeep && restoredKeep.tabId !== activeInfo.tabId) {
    endKeepRestore();
  }
  // New tab activated - treat as a fresh session for Reapply logic
  justReloaded = true;
  // Bind to the exact activated tab (not a currentWindow query) so the host +
  // detections switch to it immediately.
  await refreshData(activeInfo.tabId);
  await updateReapplyVisibility();
});

// Switching browser WINDOWS also changes which page the user is looking at, but
// does not fire tabs.onActivated. Rebind to the newly focused window's active tab
// so the panel follows the user across windows too.
if (chrome.windows?.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (!tab?.id) return;
      activeTabId = tab.id;
      if (restoredKeep && restoredKeep.tabId !== tab.id) {
        endKeepRestore();
      }
      justReloaded = true;
      await refreshData(tab.id);
      await updateReapplyVisibility();
    } catch {}
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Only react to navigation of the tab the panel is bound to. A background tab
  // (e.g. Gmail) reloading must not reset the active tab's session state or pull
  // a refresh for it, which contributed to the cross-tab flicker.
  if (activeTabId !== null && tabId !== activeTabId) return;
  // Set justReloaded as EARLY as possible (on 'loading') so the periodic
  // refreshData interval can't race ahead and show empty during a reload.
  // This is the signal that the page navigated/reloaded = form will be reset,
  // so restoring from a saved snapshot is legitimate (not an undo).
  if (changeInfo.status === 'loading') {
    justReloaded = true;
  }
  if (changeInfo.status === 'complete') {
    justReloaded = true;
    await refreshData(tabId);
    await updateReapplyVisibility();
  }
});

/**
 * Show the unlock screen and hide the main panel.
 */
function showUnlockScreen() {
  elements.unlockScreen.classList.remove('hidden');
  elements.mainPanel.classList.add('hidden');
  
  const info = getUnlockInfo();
  elements.unlockPrice.textContent = info.price;
  elements.sellerName.textContent = info.seller;
  if (elements.sellerLink && info.publisherUrl) {
    elements.sellerLink.href = info.publisherUrl;
  }
  elements.supportLink.href = `mailto:${info.supportEmail}`;
  elements.privacyLink.href = info.privacyUrl;
}

/**
 * Hide the unlock screen and show the main panel.
 */
function hideUnlockScreen() {
  elements.unlockScreen.classList.add('hidden');
  elements.mainPanel.classList.remove('hidden');
}

/**
 * Show unlock error message.
 */
function showUnlockError(message) {
  elements.unlockError.textContent = message;
  elements.unlockError.classList.remove('hidden');
}

/**
 * Hide unlock error message.
 */
function hideUnlockError() {
  elements.unlockError.classList.add('hidden');
}

/**
 * Format license key input as user types (add dashes).
 */
function formatLicenseKeyInput(e) {
  const input = e.target;
  let value = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  
  const chunks = value.match(/.{1,4}/g) || [];
  input.value = chunks.slice(0, 4).join('-');
}

/**
 * Handle license activation form submission.
 */
async function handleActivate() {
  const key = elements.licenseKeyInput.value.trim();
  
  if (!key) {
    showUnlockError('Please enter a license key');
    return;
  }
  
  if (!isValidKeyFormat(key)) {
    showUnlockError('Invalid license key format (expected XXXX-XXXX-XXXX-XXXX)');
    return;
  }
  
  hideUnlockError();
  elements.activateBtn.disabled = true;
  elements.activateBtn.textContent = 'Activating...';
  
  try {
    const result = await activateLicense(key);
    
    if (result.ok) {
      isLicenseValid = true;
      hideUnlockScreen();
      updateFeatureGating();
      showToast('License activated! Full features unlocked.');
    } else {
      showUnlockError(result.error || 'Activation failed');
    }
  } catch (err) {
    console.error('Activation error:', err);
    showUnlockError('Network error - please try again');
  } finally {
    elements.activateBtn.disabled = false;
    elements.activateBtn.textContent = 'Activate';
  }
}

/**
 * Handle buy button click.
 */
function handleBuy() {
  openPurchasePage();
}

/**
 * Update feature gating based on license state.
 * When unlocked: all features available.
 * When locked: Keep, Reapply, Clear, and export are disabled.
 */
function updateFeatureGating() {
  const locked = !isLicenseValid;
  
  elements.persistToggle.disabled = locked;
  elements.persistToggle.parentElement.classList.toggle('feature-locked', locked);
  
  elements.copyMarkdown.classList.toggle('feature-locked', locked);
  elements.downloadMarkdown.classList.toggle('feature-locked', locked);
  elements.copyCsv.classList.toggle('feature-locked', locked);
  elements.downloadCsv.classList.toggle('feature-locked', locked);
  
  elements.clearDetections.classList.toggle('feature-locked', locked);
  elements.reapplyChanges.classList.toggle('feature-locked', locked);
  
  if (locked) {
    elements.persistToggle.checked = false;
    persistEnabled = false;
  }
}

/**
 * Setup unlock screen event listeners.
 */
function setupUnlockListeners() {
  elements.buyBtn.addEventListener('click', handleBuy);
  elements.activateBtn.addEventListener('click', handleActivate);
  
  elements.licenseKeyInput.addEventListener('input', formatLicenseKeyInput);
  elements.licenseKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleActivate();
    }
  });
}

async function init() {
  setupUnlockListeners();
  
  isLicenseValid = await isUnlocked();
  
  if (!isLicenseValid) {
    showUnlockScreen();
  } else {
    hideUnlockScreen();
  }
  
  updateFeatureGating();
  
  await loadConfirmOnSaveSetting();
  await loadPersistSetting();

  // Resolve the active tab up front so the FIELDS_UPDATE guard has a target even
  // if refreshData() takes an early return (e.g. during a cleared window).
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) activeTabId = tab.id;
  } catch {}

  await refreshData();
  updateReapplyVisibility();
}

// Skip auto-bootstrapping under the jsdom test harness so a test can drive the
// captured message/tab listeners deterministically. The flag is never set in the
// real extension, so production behavior is unchanged.
if (typeof window !== 'undefined' && window.__CHANGEPREVIEW_TEST__) {
  // Expose the pure identity/keying helpers so the harness can unit-test the
  // canonicalization rules without reaching into module internals.
  window.__changePreviewPanelInternals = {
    canonicalizePageUrl,
    getPageKey,
    createFingerprint,
    isTrackingParam,
    logicalFieldKey,
    dedupeDirtyFields,
    sameLogicalPage,
    getCanonicalStorageKey,
    isDetectionKeyForPage,
    saveDetections,
    loadPersistedByPageKey,
    keepRestoreHolds,
    beginKeepRestore,
    endKeepRestore,
    getRestoredKeep: () => restoredKeep,
    isShowingRestored: () => isShowingRestoredData,
    setJustReloaded(v) { justReloaded = !!v; },
    setActiveTabId(id) { activeTabId = id; },
    refreshData,
    setPersistEnabled(enabled) { persistEnabled = !!enabled; },
    getPersistedData() { return persistedData; },
  };
} else {
  init();
  setInterval(refreshData, 2000);
}
