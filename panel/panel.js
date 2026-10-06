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

const TYPE_ICONS = {
  'text': {
    svg: '<path d="M4 5h12M4 12h12M4 19h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    label: 'Text'
  },
  'email': {
    svg: '<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M2 7l10 7 10-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    label: 'Email'
  },
  'number': {
    svg: '<path d="M7 20l4-16M13 20l4-16M3 8h18M3 16h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    label: 'Number'
  },
  'tel': {
    svg: '<path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" stroke="currentColor" stroke-width="2" fill="none"/>',
    label: 'Phone'
  },
  'url': {
    svg: '<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    label: 'URL'
  },
  'date': {
    svg: '<rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    label: 'Date'
  },
  'time': {
    svg: '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    label: 'Time'
  },
  'datetime-local': {
    svg: '<rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="15" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/>',
    label: 'Date & Time'
  },
  'textarea': {
    svg: '<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M7 7h10M7 12h10M7 17h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    label: 'Multi-line text'
  },
  'select': {
    svg: '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    label: 'Dropdown'
  },
  'select-one': {
    svg: '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    label: 'Dropdown'
  },
  'select-multiple': {
    svg: '<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="6" r="1" fill="currentColor"/><circle cx="8" cy="12" r="1" fill="currentColor"/><circle cx="8" cy="18" r="1" fill="currentColor"/>',
    label: 'Multi-select'
  },
  'radio': {
    svg: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
    label: 'Choice'
  },
  'checkbox': {
    svg: '<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    label: 'Checkbox'
  },
  'checkbox-group': {
    svg: '<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    label: 'Checkboxes'
  },
  'contenteditable': {
    svg: '<path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    label: 'Rich text'
  },
  'color': {
    svg: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="8" r="2" fill="currentColor"/><circle cx="8" cy="14" r="2" fill="currentColor"/><circle cx="16" cy="14" r="2" fill="currentColor"/>',
    label: 'Color'
  },
  'range': {
    svg: '<path d="M4 12h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/>',
    label: 'Range'
  },
  'search': {
    svg: '<circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" fill="none"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    label: 'Search'
  },
  'default': {
    svg: '<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    label: 'Field'
  }
};

function createTypeIcon(type) {
  const typeKey = (type || '').toLowerCase();
  const info = TYPE_ICONS[typeKey] || TYPE_ICONS['default'];
  
  const wrapper = document.createElement('span');
  wrapper.className = 'field-type-icon';
  wrapper.setAttribute('title', info.label);
  wrapper.setAttribute('aria-label', `Field type: ${info.label}`);
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute('tabindex', '0');
  
  wrapper.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none">${info.svg}</svg>`;
  
  return { element: wrapper, label: info.label };
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
    for (const field of data.dirty) {
      const row = document.createElement('tr');
      
      const labelCell = document.createElement('td');
      const labelWrapper = document.createElement('div');
      labelWrapper.className = 'field-label-wrapper';
      
      const labelSpan = document.createElement('span');
      labelSpan.className = 'field-label';
      labelSpan.textContent = field.label;
      labelWrapper.appendChild(labelSpan);
      
      const { element: typeIcon } = createTypeIcon(field.type);
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
