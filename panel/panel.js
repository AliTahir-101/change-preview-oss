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
  copyCsv: document.getElementById('copyCsv'),
  downloadCsv: document.getElementById('downloadCsv'),
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

let currentData = null;

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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FIELDS' });
    if (response) {
      updateUI(response);
    }
  } catch (err) {
    console.error('Failed to get fields:', err);
    updateUI({
      host: '—',
      path: '',
      dirty: [],
      coverage: { tracked: 0, total: 0, skipped: 0 }
    });
  }
}

function showConfirmDialog() {
  elements.confirmDialog.classList.remove('hidden');
}

function hideConfirmDialog() {
  elements.confirmDialog.classList.add('hidden');
}

async function clearDetections() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    
    await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_BASELINE' });
    showToast('Detections cleared');
    await refreshData();
  } catch (err) {
    console.error('Failed to clear detections:', err);
    showToast('Failed to clear');
  }
}

function generateFilename() {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const host = currentData?.host?.replace(/[^a-zA-Z0-9]/g, '-') || 'page';
  return `change-preview-${host}-${date}.csv`;
}

function downloadCsv() {
  const csv = generateCsv();
  if (!csv) return;
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = generateFilename();
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('CSV downloaded');
}

elements.copyMarkdown.addEventListener('click', () => {
  const md = generateMarkdown();
  if (md) copyToClipboard(md, 'Markdown');
});

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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'FIELDS_UPDATE') {
    updateUI(message.data);
  }
});

chrome.tabs.onActivated.addListener(refreshData);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    refreshData();
  }
});

refreshData();
setInterval(refreshData, 2000);
