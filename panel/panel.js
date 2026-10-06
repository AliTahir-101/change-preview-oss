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

const TYPE_INFO = {
  'text': { icon: 'T', label: 'Text' },
  'email': { icon: '@', label: 'Email' },
  'number': { icon: '#', label: 'Number' },
  'tel': { icon: '☎', label: 'Phone' },
  'url': { icon: '🔗', label: 'URL' },
  'date': { icon: '📅', label: 'Date' },
  'time': { icon: '🕐', label: 'Time' },
  'datetime-local': { icon: '📅', label: 'Date & Time' },
  'month': { icon: '📅', label: 'Month' },
  'week': { icon: '📅', label: 'Week' },
  'color': { icon: '🎨', label: 'Color' },
  'range': { icon: '⇔', label: 'Range' },
  'search': { icon: '🔍', label: 'Search' },
  'textarea': { icon: '¶', label: 'Multi-line text' },
  'select': { icon: '▼', label: 'Dropdown' },
  'select-one': { icon: '▼', label: 'Dropdown' },
  'select-multiple': { icon: '☰', label: 'Multi-select' },
  'radio': { icon: '◉', label: 'Choice' },
  'checkbox': { icon: '☑', label: 'Checkbox' },
  'checkbox-group': { icon: '☑', label: 'Checkboxes' },
  'contenteditable': { icon: '✎', label: 'Rich text' }
};

function getTypeInfo(type) {
  if (!type) return { icon: '?', label: 'Field' };
  const normalized = type.toLowerCase();
  return TYPE_INFO[normalized] || { icon: 'T', label: type.charAt(0).toUpperCase() + type.slice(1) };
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
      
      const typeInfo = getTypeInfo(field.type);
      const typeIcon = document.createElement('span');
      typeIcon.className = 'field-type-icon';
      typeIcon.textContent = typeInfo.icon;
      typeIcon.setAttribute('title', typeInfo.label);
      typeIcon.setAttribute('aria-label', `Field type: ${typeInfo.label}`);
      typeIcon.setAttribute('role', 'img');
      typeIcon.setAttribute('tabindex', '0');
      labelWrapper.appendChild(typeIcon);
      
      labelCell.appendChild(labelWrapper);
      
      const wasCell = document.createElement('td');
      const wasSpan = document.createElement('span');
      wasSpan.className = 'field-was value-expandable';
      wasSpan.textContent = truncate(field.was);
      wasSpan.title = field.was || '(empty)';
      wasSpan.dataset.full = field.was || '(empty)';
      wasSpan.addEventListener('click', toggleExpand);
      wasCell.appendChild(wasSpan);
      
      const nowCell = document.createElement('td');
      const nowSpan = document.createElement('span');
      nowSpan.className = 'field-now value-expandable';
      nowSpan.textContent = truncate(field.now);
      nowSpan.title = field.now || '(empty)';
      nowSpan.dataset.full = field.now || '(empty)';
      nowSpan.addEventListener('click', toggleExpand);
      nowCell.appendChild(nowSpan);
      
      row.appendChild(labelCell);
      row.appendChild(wasCell);
      row.appendChild(nowCell);
      elements.changesBody.appendChild(row);
    }
  }
}

function toggleExpand(e) {
  const span = e.target;
  const isExpanded = span.classList.toggle('expanded');
  if (isExpanded) {
    span.textContent = span.dataset.full;
  } else {
    span.textContent = truncate(span.dataset.full);
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
