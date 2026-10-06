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
  clearBaseline: document.getElementById('clearBaseline'),
  toast: document.getElementById('toast')
};

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
      labelSpan.className = 'field-label';
      labelSpan.textContent = field.label;
      labelWrapper.appendChild(labelSpan);
      
      const typeIcon = createTypeInfoIcon(field.type);
      labelWrapper.appendChild(typeIcon);
      
      labelCell.appendChild(labelWrapper);
      
      const wasCell = document.createElement('td');
      const wasSpan = document.createElement('span');
      wasSpan.className = 'field-was value-copyable';
      wasSpan.textContent = truncate(field.was);
      wasSpan.title = 'Click to copy previous value';
      wasSpan.dataset.value = field.was || '';
      wasSpan.addEventListener('click', () => copyValue(field.was, 'Previous value'));
      wasCell.appendChild(wasSpan);
      
      const nowCell = document.createElement('td');
      const nowSpan = document.createElement('span');
      nowSpan.className = 'field-now value-copyable';
      nowSpan.textContent = truncate(field.now);
      nowSpan.title = 'Click to copy current value';
      nowSpan.dataset.value = field.now || '';
      nowSpan.addEventListener('click', () => copyValue(field.now, 'Current value'));
      nowCell.appendChild(nowSpan);
      
      row.appendChild(numCell);
      row.appendChild(labelCell);
      row.appendChild(wasCell);
      row.appendChild(nowCell);
      elements.changesBody.appendChild(row);
    }
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

async function clearBaseline() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    
    await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_BASELINE' });
    showToast('Baseline re-snapshotted');
    await refreshData();
  } catch (err) {
    console.error('Failed to clear baseline:', err);
    showToast('Failed to re-snapshot');
  }
}

elements.copyMarkdown.addEventListener('click', () => {
  const md = generateMarkdown();
  if (md) copyToClipboard(md, 'Markdown');
});

elements.copyCsv.addEventListener('click', () => {
  const csv = generateCsv();
  if (csv) copyToClipboard(csv, 'CSV');
});

elements.clearBaseline.addEventListener('click', clearBaseline);

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
