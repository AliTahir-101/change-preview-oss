/**
 * ChangePreview Content Script
 * Snapshots form fields on load, detects dirty fields, soft Save intercept.
 * Local-only. Skips passwords/hidden/token-ish fields.
 */

(function() {
  'use strict';

  const SKIP_TYPES = new Set(['password', 'hidden', 'file']);
  const SENSITIVE_PATTERN = /password|secret|token|ssn|cvv|cvc|otp|api[-_]?key|auth/i;
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc',
    'cc-name', 'cc-type', 'one-time-code', 'new-password', 'current-password'
  ]);
  
  const SAVE_BUTTON_PATTERN = /^(save|update|submit|apply|publish|confirm|create|add|store)$/i;
  const SAVE_BUTTON_CONTAINS = /(save|update|submit|apply|publish|confirm)\s*(changes?|settings?|form)?/i;

  let baseline = new Map();
  let totalFieldsScanned = 0;
  let skippedSensitive = 0;
  let saveInterceptEnabled = true;
  let modalOpen = false;
  let pendingSaveTarget = null;

  function shouldSkipField(el) {
    if (SKIP_TYPES.has(el.type)) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    
    const name = el.name || '';
    const id = el.id || '';
    if (SENSITIVE_PATTERN.test(name) || SENSITIVE_PATTERN.test(id)) return true;
    
    const autocomplete = el.getAttribute('autocomplete') || '';
    if (SENSITIVE_AUTOCOMPLETE.has(autocomplete)) return true;
    
    return false;
  }

  function getFieldLabel(el) {
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl && labelEl.textContent.trim()) {
        return labelEl.textContent.trim();
      }
    }
    
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(c => c.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }
    
    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      const labelEl = document.getElementById(ariaLabelledBy);
      if (labelEl && labelEl.textContent.trim()) {
        return labelEl.textContent.trim();
      }
    }
    
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    
    const prevSibling = el.previousElementSibling;
    if (prevSibling && ['SPAN', 'LABEL', 'DIV', 'TD', 'TH'].includes(prevSibling.tagName)) {
      const text = prevSibling.textContent.trim();
      if (text && text.length < 60) return text;
    }
    
    const name = el.name || el.id || '';
    if (name) {
      return name.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
    }
    
    return 'Unlabeled field';
  }

  function getFieldKey(el) {
    if (el.name) return `name:${el.name}`;
    if (el.id) return `id:${el.id}`;
    
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let tag = current.tagName.toLowerCase();
      if (current.id) {
        path.unshift(`#${current.id}`);
        break;
      }
      const siblings = current.parentElement?.children || [];
      const idx = Array.from(siblings).filter(s => s.tagName === current.tagName).indexOf(current);
      if (idx > 0) tag += `:nth-of-type(${idx + 1})`;
      path.unshift(tag);
      current = current.parentElement;
    }
    return `path:${path.join('>')}`;
  }

  function getFieldValue(el) {
    const tag = el.tagName.toLowerCase();
    
    if (tag === 'input') {
      if (el.type === 'checkbox') {
        return el.checked ? 'Checked' : 'Unchecked';
      }
      if (el.type === 'radio') {
        const name = el.name;
        const checked = document.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
        return checked ? (checked.labels?.[0]?.textContent.trim() || checked.value) : '(none)';
      }
      return el.value;
    }
    
    if (tag === 'select') {
      if (el.multiple) {
        const selected = Array.from(el.selectedOptions).map(o => o.text);
        return selected.length ? selected.join(', ') : '(none)';
      }
      return el.selectedOptions[0]?.text || '(none)';
    }
    
    if (tag === 'textarea') {
      return el.value;
    }
    
    if (el.isContentEditable) {
      return el.innerText.trim();
    }
    
    return el.value || '';
  }

  function deepQueryAll(root, selector) {
    const results = Array.from(root.querySelectorAll(selector));
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        results.push(...deepQueryAll(el.shadowRoot, selector));
      }
    });
    return results;
  }

  function collectFields() {
    const selectors = 'input, select, textarea, [contenteditable="true"]';
    const elements = deepQueryAll(document, selectors);
    const fields = [];
    let total = 0;
    let skipped = 0;
    
    const seenRadios = new Set();
    
    for (const el of elements) {
      if (!el.offsetParent && el.type !== 'hidden') continue;
      
      if (el.type === 'radio') {
        if (seenRadios.has(el.name)) continue;
        seenRadios.add(el.name);
      }
      
      total++;
      
      if (shouldSkipField(el)) {
        skipped++;
        continue;
      }
      
      fields.push({
        element: el,
        key: getFieldKey(el),
        label: getFieldLabel(el),
        type: el.type || el.tagName.toLowerCase(),
        value: getFieldValue(el)
      });
    }
    
    totalFieldsScanned = total;
    skippedSensitive = skipped;
    
    return fields;
  }

  function snapshotBaseline() {
    baseline.clear();
    const fields = collectFields();
    for (const field of fields) {
      baseline.set(field.key, {
        label: field.label,
        type: field.type,
        value: field.value,
        element: field.element
      });
    }
    updateBadge();
    notifyPanel();
  }

  function getDirtyFields() {
    const currentFields = collectFields();
    const dirty = [];
    
    for (const field of currentFields) {
      const original = baseline.get(field.key);
      if (!original) {
        dirty.push({
          key: field.key,
          label: field.label,
          was: '(new field)',
          now: field.value
        });
      } else if (original.value !== field.value) {
        dirty.push({
          key: field.key,
          label: field.label,
          was: original.value,
          now: field.value
        });
      }
    }
    
    return dirty;
  }

  function updateBadge() {
    const dirty = getDirtyFields();
    const count = dirty.length;
    
    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      count: count
    }).catch(() => {});
  }

  function notifyPanel() {
    const dirty = getDirtyFields();
    chrome.runtime.sendMessage({
      type: 'FIELDS_UPDATE',
      data: {
        host: location.hostname,
        path: location.pathname,
        dirty: dirty,
        coverage: {
          tracked: baseline.size,
          total: totalFieldsScanned,
          skipped: skippedSensitive
        }
      }
    }).catch(() => {});
  }

  function isSaveButton(el) {
    if (el.type === 'submit') return true;
    
    const text = (el.textContent || '').trim();
    if (SAVE_BUTTON_PATTERN.test(text) || SAVE_BUTTON_CONTAINS.test(text)) return true;
    
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (SAVE_BUTTON_PATTERN.test(ariaLabel) || SAVE_BUTTON_CONTAINS.test(ariaLabel)) return true;
    
    const role = el.getAttribute('role');
    if (role === 'button') {
      if (SAVE_BUTTON_PATTERN.test(text) || SAVE_BUTTON_CONTAINS.test(text)) return true;
    }
    
    return false;
  }

  function showConfirmModal(dirtyFields, onConfirm, onCancel) {
    if (modalOpen) return;
    modalOpen = true;
    
    const overlay = document.createElement('div');
    overlay.id = 'changepreview-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 2147483646;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    
    const modal = document.createElement('div');
    modal.style.cssText = `
      background: white;
      border-radius: 8px;
      padding: 20px;
      max-width: 420px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;
    
    const header = document.createElement('h3');
    header.textContent = `You're about to save ${dirtyFields.length} change${dirtyFields.length === 1 ? '' : 's'}`;
    header.style.cssText = 'margin: 0 0 16px 0; font-size: 16px; color: #333;';
    modal.appendChild(header);
    
    if (dirtyFields.length > 0) {
      const list = document.createElement('ul');
      list.style.cssText = 'margin: 0 0 16px 0; padding-left: 20px; color: #555; font-size: 13px;';
      
      const maxShow = 5;
      const toShow = dirtyFields.slice(0, maxShow);
      
      for (const field of toShow) {
        const li = document.createElement('li');
        li.style.cssText = 'margin-bottom: 4px;';
        li.innerHTML = `<strong>${escapeHtml(field.label)}</strong>: 
          <span style="color: #c00; text-decoration: line-through;">${escapeHtml(truncate(field.was, 20))}</span> → 
          <span style="color: #080;">${escapeHtml(truncate(field.now, 20))}</span>`;
        list.appendChild(li);
      }
      
      if (dirtyFields.length > maxShow) {
        const li = document.createElement('li');
        li.style.cssText = 'color: #888; font-style: italic;';
        li.textContent = `...and ${dirtyFields.length - maxShow} more`;
        list.appendChild(li);
      }
      
      modal.appendChild(list);
    }
    
    const buttons = document.createElement('div');
    buttons.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      border: 1px solid #ccc;
      background: white;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;
    
    const reviewBtn = document.createElement('button');
    reviewBtn.textContent = 'Review in panel';
    reviewBtn.style.cssText = `
      padding: 8px 16px;
      border: 1px solid #0066cc;
      background: white;
      color: #0066cc;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;
    
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save anyway';
    saveBtn.style.cssText = `
      padding: 8px 16px;
      border: none;
      background: #0066cc;
      color: white;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;
    
    buttons.appendChild(cancelBtn);
    buttons.appendChild(reviewBtn);
    buttons.appendChild(saveBtn);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    function close() {
      modalOpen = false;
      overlay.remove();
    }
    
    cancelBtn.addEventListener('click', () => {
      close();
      onCancel();
    });
    
    reviewBtn.addEventListener('click', () => {
      close();
      chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }).catch(() => {});
      onCancel();
    });
    
    saveBtn.addEventListener('click', () => {
      close();
      onConfirm();
    });
    
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        close();
        onCancel();
      }
    });
    
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') {
        close();
        onCancel();
        document.removeEventListener('keydown', handler);
      } else if (e.key === 'Enter') {
        close();
        onConfirm();
        document.removeEventListener('keydown', handler);
      }
    });
    
    saveBtn.focus();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, len) {
    if (!str) return '';
    str = String(str);
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function handleSaveClick(e) {
    if (!saveInterceptEnabled) return;
    if (modalOpen) return;
    
    const target = e.target.closest('button, input[type="submit"], [role="button"], a');
    if (!target || !isSaveButton(target)) return;
    
    const dirty = getDirtyFields();
    if (dirty.length === 0) return;
    
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    pendingSaveTarget = target;
    
    showConfirmModal(
      dirty,
      () => {
        saveInterceptEnabled = false;
        if (pendingSaveTarget) {
          pendingSaveTarget.click();
        }
        setTimeout(() => {
          saveInterceptEnabled = true;
          pendingSaveTarget = null;
          setTimeout(() => snapshotBaseline(), 500);
        }, 100);
      },
      () => {
        pendingSaveTarget = null;
      }
    );
  }

  function setupInputListeners() {
    const debounce = (fn, ms) => {
      let timer;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
      };
    };
    
    const debouncedUpdate = debounce(() => {
      updateBadge();
      notifyPanel();
    }, 300);
    
    document.addEventListener('input', debouncedUpdate, true);
    document.addEventListener('change', debouncedUpdate, true);
  }

  function setupSaveIntercept() {
    document.addEventListener('click', handleSaveClick, true);
    
    document.addEventListener('submit', (e) => {
      if (!saveInterceptEnabled) return;
      if (modalOpen) return;
      
      const dirty = getDirtyFields();
      if (dirty.length === 0) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      const form = e.target;
      
      showConfirmModal(
        dirty,
        () => {
          saveInterceptEnabled = false;
          if (form.requestSubmit) {
            form.requestSubmit();
          } else {
            form.submit();
          }
          setTimeout(() => {
            saveInterceptEnabled = true;
            setTimeout(() => snapshotBaseline(), 500);
          }, 100);
        },
        () => {}
      );
    }, true);
  }

  function setupMutationObserver() {
    let debounceTimer = null;
    
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const currentFieldCount = collectFields().length;
        if (Math.abs(currentFieldCount - baseline.size) > baseline.size * 0.5) {
          snapshotBaseline();
        }
      }, 500);
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'GET_FIELDS':
        const dirty = getDirtyFields();
        sendResponse({
          host: location.hostname,
          path: location.pathname,
          dirty: dirty,
          coverage: {
            tracked: baseline.size,
            total: totalFieldsScanned,
            skipped: skippedSensitive
          }
        });
        break;
        
      case 'CLEAR_BASELINE':
        snapshotBaseline();
        sendResponse({ success: true });
        break;
        
      case 'SET_INTERCEPT':
        saveInterceptEnabled = message.enabled;
        sendResponse({ success: true });
        break;
        
      default:
        sendResponse({ error: 'Unknown message type' });
    }
    return true;
  });

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(snapshotBaseline, 300);
      });
    } else {
      setTimeout(snapshotBaseline, 300);
    }
    
    setupInputListeners();
    setupSaveIntercept();
    setupMutationObserver();
  }

  init();
})();
