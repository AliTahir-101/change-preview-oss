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
  
  const GENERIC_TYPE_STRINGS = new Set([
    'text', 'multi-line text', 'multiline text', 'multi line text',
    'single-line text', 'single line text', 'singleline text',
    'short text', 'long text', 'short answer', 'long answer',
    'choice', 'multiple choice', 'single choice',
    'checkbox', 'checkboxes', 'radio', 'radio button', 'radio buttons',
    'dropdown', 'drop-down', 'drop down', 'select', 'selection',
    'date', 'date picker', 'time', 'date and time', 'datetime',
    'number', 'numeric', 'integer', 'decimal',
    'email', 'email address', 'phone', 'phone number', 'telephone',
    'rating', 'star rating', 'likert', 'likert scale',
    'ranking', 'rank', 'order',
    'file upload', 'file', 'attachment', 'upload',
    'section', 'section header', 'heading',
    'input', 'textarea', 'textbox', 'text box', 'text field',
    'net promoter score', 'nps',
    'required', 'optional'
  ]);
  
  const TYPE_WORDS = [
    'multi[- ]?line\\s*text', 'single[- ]?line\\s*text', 'multiline', 'singleline',
    'short\\s*(text|answer)', 'long\\s*(text|answer)',
    'multiple\\s*choice', 'single\\s*choice', 'choice',
    'check\\s*box(es)?', 'radio\\s*button(s)?', 'radio',
    'drop[- ]?down', 'dropdown', 'selection', 'select',
    'date(\\s*(and|&)?\\s*time)?', 'date\\s*picker', 'time', 'datetime',
    'number', 'numeric', 'integer', 'decimal',
    'email(\\s*address)?', 'phone(\\s*number)?', 'telephone',
    'star\\s*rating', 'rating', 'likert(\\s*scale)?',
    'ranking', 'rank', 'order',
    'file(\\s*upload)?', 'attachment', 'upload',
    'section(\\s*header)?', 'heading',
    'text\\s*(box|field|area)?', 'textarea', 'textbox', 'input',
    'net\\s*promoter\\s*score', 'nps',
    'required', 'optional', 'text'
  ].join('|');
  
  const TYPE_SUFFIX_PATTERN = new RegExp(
    '[.·•\\-–—|:,;\\s]*(' + TYPE_WORDS + ')[.·•\\-–—|:,;\\s]*$',
    'i'
  );
  
  const POINTS_SUFFIX_PATTERN = /[.·•\-–—|:,;\s]*\(?\s*\d+\s*points?\s*\)?[.\s]*$/i;
  
  const GLUED_TYPE_PATTERN = new RegExp(
    '\\.(' + TYPE_WORDS + ')[\\.\\s]*$',
    'i'
  );

  /**
   * Container selectors that bound a checkbox/radio "group" (one question with
   * several options). Kept in a single constant so detection (collectFields),
   * value reading, and Reapply (findCheckboxGroup) all agree on the boundary.
   */
  const CHECKBOX_GROUP_CONTAINER_SELECTOR =
    '[class*="question"], [class*="Question"], [role="group"], fieldset, [class*="form-group"]';
  const RADIO_GROUP_CONTAINER_SELECTOR =
    '[class*="question"], [class*="Question"], [role="group"], [role="radiogroup"], fieldset, [class*="form-group"]';

  let baseline = new Map();
  let radioGroupLabels = new Map();
  let checkboxGroupLabels = new Map();
  let totalFieldsScanned = 0;
  let skippedSensitive = 0;
  let saveInterceptEnabled = true;
  let modalOpen = false;
  let pendingSaveTarget = null;
  
  /**
   * Timestamp when notifications were last suppressed.
   * Used to prevent phantom dirty rows from racing with clear/reapply operations.
   * We use a timestamp instead of a boolean to handle overlapping suppression windows.
   */
  let suppressUntil = 0;
  
  /**
   * CRITICAL: Flag set after Clear to block ALL dirty detection.
   * This ensures zero detections after Clear until real user input.
   * 
   * The problem it solves:
   * After Reapply, baseline has "was" values. After Clear, snapshotBaseline sets
   * baseline to current values. But timing/async issues can cause the old baseline
   * to be used, making getDirtyFields() return the full reapplied set again.
   * 
   * With this flag:
   * - CLEAR_BASELINE sets clearedSession = true
   * - getDirtyFields() returns [] while clearedSession is true
   * - First REAL user input (not programmatic) sets clearedSession = false
   * - Only then do we start tracking dirty fields again
   */
  let clearedSession = false;
  
  /**
   * Flag to distinguish programmatic changes (from Reapply) vs real user input.
   * Set to true during APPLY_CHANGES, prevents clearedSession from being reset.
   */
  let applyingChanges = false;
  
  function isSuppressed() {
    return Date.now() < suppressUntil;
  }
  
  function suppressFor(ms) {
    suppressUntil = Math.max(suppressUntil, Date.now() + ms);
  }

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
  
  function isGenericTypeString(text) {
    if (!text) return false;
    return GENERIC_TYPE_STRINGS.has(text.toLowerCase().trim());
  }
  
  function stripTypeSuffix(text) {
    if (!text) return text;
    let cleaned = text.trim();
    let prevLength;
    
    do {
      prevLength = cleaned.length;
      
      cleaned = cleaned.replace(POINTS_SUFFIX_PATTERN, '');
      cleaned = cleaned.replace(TYPE_SUFFIX_PATTERN, '');
      cleaned = cleaned.replace(GLUED_TYPE_PATTERN, '.');
      cleaned = cleaned.replace(/[·•\-–—|:,;\s]+$/, '');
      cleaned = cleaned.trim();
      
    } while (cleaned.length < prevLength && cleaned.length > 0);
    
    if (cleaned.length === 0) {
      return text.trim();
    }
    
    return cleaned;
  }
  
  function cleanLabel(text) {
    if (!text) return text;
    let cleaned = stripTypeSuffix(text);
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^\*\s*/, '');
    cleaned = cleaned.replace(/\s*\*$/, '');
    
    cleaned = cleaned.replace(/\.{2,}\s*$/, match => match.trimEnd());
    
    return cleaned;
  }
  
  function isValidLabelText(text) {
    if (!text) return false;
    text = text.trim();
    if (text.length === 0 || text.length > 200) return false;
    if (isGenericTypeString(text)) return false;
    if (/^[0-9.]+$/.test(text)) return false;
    return true;
  }
  
  function getQuestionContainerLabel(el) {
    const questionSelectors = [
      '[class*="question-title"]',
      '[class*="questionTitle"]',
      '[class*="question_title"]',
      '[class*="QuestionTitle"]',
      '[class*="field-label"]',
      '[class*="fieldLabel"]',
      '[class*="form-label"]',
      '[class*="formLabel"]',
      '[data-automation-id*="questionTitle"]',
      '[data-automation-id*="question-title"]',
      '[role="heading"]',
      'legend',
      '.office-form-question-title',
      '.question-title-box',
      '.freebirdFormviewerComponentsQuestionBaseTitle',
      '.freebirdFormviewerComponentsQuestionBaseHeader',
      '[class*="question"] [class*="title"]',
      '[class*="question"] [class*="header"]',
      '[class*="question"] h1',
      '[class*="question"] h2',
      '[class*="question"] h3',
      '[class*="question"] h4'
    ];
    
    const containerSelectors = [
      '[class*="question"]',
      '[class*="Question"]',
      '[class*="form-group"]',
      '[class*="formGroup"]',
      '[class*="field-container"]',
      '[class*="fieldContainer"]',
      '[role="group"]',
      '[role="radiogroup"]',
      'fieldset',
      '[data-automation-id*="question"]',
      '.office-form-question',
      '.freebirdFormviewerComponentsQuestionBase'
    ];
    
    for (const containerSel of containerSelectors) {
      const container = el.closest(containerSel);
      if (!container) continue;
      
      for (const titleSel of questionSelectors) {
        const titleEl = container.querySelector(titleSel);
        if (titleEl && titleEl !== el) {
          const text = titleEl.textContent.trim();
          if (isValidLabelText(text)) {
            return text;
          }
        }
      }
      
      const heading = container.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading && heading !== el) {
        const text = heading.textContent.trim();
        if (isValidLabelText(text)) {
          return text;
        }
      }
    }
    
    return null;
  }
  
  function getLegendOrFieldsetLabel(el) {
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) {
        const text = legend.textContent.trim();
        if (isValidLabelText(text)) {
          return text;
        }
      }
    }
    return null;
  }
  
  /**
   * Derive the GROUP question title for a set of checkbox/radio options when the
   * title is a plain heading/label that sits alongside the options rather than
   * inside a recognised "question-title" container.
   *
   * This is the common "House type" / admin-settings pattern:
   *   <div class="form-group">
   *     <label>House type</label>            <-- group question (what we want)
   *     <div class="checkbox-group">
   *       <label><input type="checkbox"> Block of flats</label>  <-- option label
   *       ...
   *
   * We deliberately EXCLUDE each option's own label (via <label for> / wrapping
   * <label>) so we never return an individual option ("Block of flats") as the
   * group title. Prefers explicit group semantics (aria-labelledby/-label,
   * legend) before falling back to a bare label/heading.
   *
   * @param {Element} container  the element that bounds the whole group
   * @param {Element[]} groupInputs  the option inputs inside the group
   * @returns {string|null}
   */
  function getBareGroupLabel(container, groupInputs) {
    if (!container) return null;

    const labelledBy = container.getAttribute && container.getAttribute('aria-labelledby');
    if (labelledBy) {
      const texts = [];
      for (const id of labelledBy.split(/\s+/)) {
        const le = document.getElementById(id);
        if (le) texts.push(le.textContent.trim());
      }
      const combined = texts.join(' ').trim();
      if (isValidLabelText(combined)) return combined;
    }

    const ariaLabel = container.getAttribute && container.getAttribute('aria-label');
    if (ariaLabel && isValidLabelText(ariaLabel)) return ariaLabel;

    const legend = container.querySelector('legend');
    if (legend && isValidLabelText(legend.textContent.trim())) {
      return legend.textContent.trim();
    }

    // Build the set of elements that are an option's OWN label, so we can skip
    // them and never mistake an option for the group question.
    const optionLabels = new Set();
    for (const inp of groupInputs) {
      if (inp.id) {
        const l = container.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
        if (l) optionLabels.add(l);
      }
      const wrap = inp.closest('label');
      if (wrap) optionLabels.add(wrap);
    }

    const groupInputIds = new Set(groupInputs.map(i => i.id).filter(Boolean));
    const labels = container.querySelectorAll('label');
    for (const lab of labels) {
      if (optionLabels.has(lab)) continue;
      if (lab.querySelector('input, select, textarea')) continue;
      const forId = lab.getAttribute('for');
      if (forId && groupInputIds.has(forId)) continue;
      const text = lab.textContent.trim();
      if (isValidLabelText(text)) return text;
    }

    const heading = container.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    if (heading && isValidLabelText(heading.textContent.trim())) {
      return heading.textContent.trim();
    }

    return null;
  }

  function getRadioGroupLabel(el) {
    if (el.type !== 'radio') return null;
    const name = el.name;
    if (!name) return null;
    
    if (radioGroupLabels.has(name)) {
      return radioGroupLabels.get(name);
    }
    
    const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
    if (radios.length === 0) return null;
    
    const firstRadio = radios[0];
    
    const groupContainer = firstRadio.closest('[role="radiogroup"]');
    if (groupContainer) {
      const labelledBy = groupContainer.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) {
          const text = labelEl.textContent.trim();
          if (isValidLabelText(text)) {
            radioGroupLabels.set(name, text);
            return text;
          }
        }
      }
      const groupLabel = groupContainer.getAttribute('aria-label');
      if (groupLabel && isValidLabelText(groupLabel)) {
        radioGroupLabels.set(name, groupLabel);
        return groupLabel;
      }
    }
    
    const legendLabel = getLegendOrFieldsetLabel(firstRadio);
    if (legendLabel) {
      radioGroupLabels.set(name, legendLabel);
      return legendLabel;
    }
    
    const questionLabel = getQuestionContainerLabel(firstRadio);
    if (questionLabel) {
      radioGroupLabels.set(name, questionLabel);
      return questionLabel;
    }
    
    const container = firstRadio.closest(RADIO_GROUP_CONTAINER_SELECTOR);
    if (container) {
      const groupRadios = Array.from(container.querySelectorAll('input[type="radio"]'));
      const bare = getBareGroupLabel(container, groupRadios);
      if (bare) {
        radioGroupLabels.set(name, bare);
        return bare;
      }
    }
    
    return null;
  }
  
  function getCheckboxGroupLabel(el) {
    if (el.type !== 'checkbox') return null;
    
    const questionLabel = getQuestionContainerLabel(el);
    if (questionLabel) {
      return questionLabel;
    }
    
    const legendLabel = getLegendOrFieldsetLabel(el);
    if (legendLabel) {
      return legendLabel;
    }
    
    // Fall back to a group-level heading/label alongside the options (the common
    // admin-settings / "House type" pattern) but only when this really is a
    // multi-option group, so a lone checkbox keeps its own option label.
    const container = el.closest(CHECKBOX_GROUP_CONTAINER_SELECTOR);
    if (container) {
      const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
      if (checkboxes.length > 1) {
        const bare = getBareGroupLabel(container, checkboxes);
        if (bare) return bare;
      }
    }
    
    return null;
  }
  
  function getAssociatedLabelText(el) {
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) {
        const clone = labelEl.cloneNode(true);
        clone.querySelectorAll('input, select, textarea, [type="hidden"]').forEach(c => c.remove());
        const text = clone.textContent.trim();
        if (isValidLabelText(text)) {
          return text;
        }
      }
    }
    
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, [type="hidden"]').forEach(c => c.remove());
      const text = clone.textContent.trim();
      if (isValidLabelText(text)) {
        return text;
      }
    }
    
    return null;
  }
  
  function getAriaLabel(el) {
    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      const ids = ariaLabelledBy.split(/\s+/);
      const texts = [];
      for (const id of ids) {
        const labelEl = document.getElementById(id);
        if (labelEl) {
          texts.push(labelEl.textContent.trim());
        }
      }
      const combined = texts.join(' ').trim();
      if (isValidLabelText(combined)) {
        return combined;
      }
    }
    
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && isValidLabelText(ariaLabel)) {
      return ariaLabel;
    }
    
    return null;
  }
  
  function getNearbyHeadingOrText(el) {
    let current = el;
    let maxDepth = 5;
    
    while (current && maxDepth > 0) {
      const parent = current.parentElement;
      if (!parent) break;
      
      let sibling = current.previousElementSibling;
      let siblingCount = 0;
      while (sibling && siblingCount < 3) {
        if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(sibling.tagName)) {
          const text = sibling.textContent.trim();
          if (isValidLabelText(text)) {
            return text;
          }
        }
        
        if (['SPAN', 'DIV', 'P', 'TD', 'TH', 'DT'].includes(sibling.tagName)) {
          const text = sibling.textContent.trim();
          if (isValidLabelText(text) && text.length < 100) {
            return text;
          }
        }
        
        sibling = sibling.previousElementSibling;
        siblingCount++;
      }
      
      current = parent;
      maxDepth--;
    }
    
    return null;
  }
  
  function humanizeName(name) {
    if (!name) return null;
    const humanized = name
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
    
    if (isValidLabelText(humanized)) {
      return humanized;
    }
    return null;
  }

  function getFieldLabel(el, isForGroup = false) {
    let label = null;
    
    if (el.type === 'radio' && !isForGroup) {
      label = getRadioGroupLabel(el);
      if (label) return cleanLabel(label);
    }
    
    if (el.type === 'checkbox' && !isForGroup) {
      label = getCheckboxGroupLabel(el);
      if (label) return cleanLabel(label);
    }
    
    label = getQuestionContainerLabel(el);
    if (label) return cleanLabel(label);
    
    label = getLegendOrFieldsetLabel(el);
    if (label) return cleanLabel(label);
    
    label = getAssociatedLabelText(el);
    if (label) return cleanLabel(label);
    
    label = getAriaLabel(el);
    if (label) return cleanLabel(label);
    
    label = getNearbyHeadingOrText(el);
    if (label) return cleanLabel(label);
    
    label = humanizeName(el.name || el.id);
    if (label) return cleanLabel(label);
    
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && isValidLabelText(placeholder)) {
      return `(placeholder) ${cleanLabel(placeholder)}`;
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

  function getRadioOptionLabel(radio) {
    if (radio.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (labelEl) {
        const text = labelEl.textContent.trim();
        if (text && !isGenericTypeString(text)) {
          return text;
        }
      }
    }
    
    const wrappingLabel = radio.closest('label');
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll('input').forEach(c => c.remove());
      const text = clone.textContent.trim();
      if (text && !isGenericTypeString(text)) {
        return text;
      }
    }
    
    const nextSibling = radio.nextSibling;
    if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
      const text = nextSibling.textContent.trim();
      if (text && !isGenericTypeString(text)) {
        return text;
      }
    }
    
    if (radio.value && !isGenericTypeString(radio.value)) {
      return radio.value;
    }
    
    return '(option)';
  }
  
  function getCheckboxOptionLabel(checkbox) {
    if (checkbox.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(checkbox.id)}"]`);
      if (labelEl) {
        const text = labelEl.textContent.trim();
        if (text && !isGenericTypeString(text)) {
          return text;
        }
      }
    }
    
    const wrappingLabel = checkbox.closest('label');
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll('input').forEach(c => c.remove());
      const text = clone.textContent.trim();
      if (text && !isGenericTypeString(text)) {
        return text;
      }
    }
    
    const nextSibling = checkbox.nextSibling;
    if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
      const text = nextSibling.textContent.trim();
      if (text && !isGenericTypeString(text)) {
        return text;
      }
    }
    
    return checkbox.value || '(option)';
  }

  function getFieldValue(el) {
    const tag = el.tagName.toLowerCase();
    
    if (tag === 'input') {
      if (el.type === 'checkbox') {
        const groupLabel = getCheckboxGroupLabel(el);
        if (groupLabel) {
          return el.checked ? getCheckboxOptionLabel(el) : '(unchecked)';
        }
        return el.checked ? 'Checked' : 'Unchecked';
      }
      if (el.type === 'radio') {
        const name = el.name;
        const checked = document.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
        if (checked) {
          return getRadioOptionLabel(checked);
        }
        return '(none selected)';
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

  function getCheckboxGroupKey(checkbox) {
    const groupLabel = getCheckboxGroupLabel(checkbox);
    if (!groupLabel) return null;
    
    const container = checkbox.closest(CHECKBOX_GROUP_CONTAINER_SELECTOR);
    if (container) {
      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      if (checkboxes.length > 1) {
        return `checkbox-group:${groupLabel}`;
      }
    }
    return null;
  }
  
  function getCheckboxGroupValue(checkbox) {
    const container = checkbox.closest(CHECKBOX_GROUP_CONTAINER_SELECTOR);
    if (!container) return checkbox.checked ? 'Checked' : 'Unchecked';
    
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    const selected = [];
    for (const cb of checkboxes) {
      if (cb.checked) {
        selected.push(getCheckboxOptionLabel(cb));
      }
    }
    return selected.length > 0 ? selected.join(', ') : '(none selected)';
  }

  function collectFields() {
    const selectors = 'input, select, textarea, [contenteditable="true"]';
    const elements = deepQueryAll(document, selectors);
    const fields = [];
    let total = 0;
    let skipped = 0;
    
    const seenRadios = new Set();
    const seenCheckboxGroups = new Set();
    
    radioGroupLabels.clear();
    checkboxGroupLabels.clear();
    
    for (const el of elements) {
      if (!el.offsetParent && el.type !== 'hidden') continue;
      
      if (el.type === 'radio') {
        if (seenRadios.has(el.name)) continue;
        seenRadios.add(el.name);
      }
      
      if (el.type === 'checkbox') {
        const groupKey = getCheckboxGroupKey(el);
        if (groupKey) {
          if (seenCheckboxGroups.has(groupKey)) continue;
          seenCheckboxGroups.add(groupKey);
          
          total++;
          if (shouldSkipField(el)) {
            skipped++;
            continue;
          }
          
          fields.push({
            element: el,
            key: groupKey,
            label: cleanLabel(getCheckboxGroupLabel(el)),
            type: 'checkbox-group',
            value: getCheckboxGroupValue(el)
          });
          continue;
        }
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

  /**
   * Captures current form field values as the baseline for dirty detection.
   * 
   * @param {boolean} silent - If true, skip notifying panel (used after Clear
   *   to prevent phantom dirty rows from racing with the clear operation).
   * 
   * Clear → Baseline order:
   * 1. Panel sends CLEAR_BASELINE
   * 2. Content script clears baseline map
   * 3. Content script captures ALL current field values as new baseline
   * 4. Since baseline === current, getDirtyFields() returns empty array
   * 5. In silent mode, we skip notifyPanel to avoid any race conditions
   * 6. Panel will query GET_FIELDS when ready and get clean state
   * 
   * REGRESSION NOTE (Keep→Reload→Reapply→Clear sequence):
   * After Clear, baseline MUST equal current live form values.
   * This ensures getDirtyFields() returns empty until next REAL user edit.
   * The suppressFor() call blocks notifications during the transition window.
   */
  function snapshotBaseline(silent = false) {
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
    if (!silent && !isSuppressed()) {
      notifyPanel();
    }
  }

  /**
   * Values that represent "empty" or "default" state.
   * Changes between these are not meaningful and should be filtered out.
   */
  const EMPTY_VALUES = new Set([
    '', '(none)', '(none selected)', '(unchecked)', 'Unchecked', '(empty)',
    undefined, null
  ]);
  
  function isEmptyValue(val) {
    if (val === undefined || val === null) return true;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      return trimmed === '' || EMPTY_VALUES.has(trimmed);
    }
    return false;
  }
  
  function getDirtyFields() {
    // CRITICAL: After Clear, return empty until real user input
    // This prevents resurrection of detections from stale baseline/timing issues
    if (clearedSession) {
      return [];
    }
    
    const currentFields = collectFields();
    const dirty = [];
    
    for (const field of currentFields) {
      const original = baseline.get(field.key);
      if (!original) {
        // New field appeared - only count if it has a meaningful value
        if (!isEmptyValue(field.value)) {
          dirty.push({
            key: field.key,
            label: field.label,
            type: field.type,
            was: '(new field)',
            now: field.value
          });
        }
      } else if (original.value !== field.value) {
        // Value changed - filter out empty↔empty noise
        const wasEmpty = isEmptyValue(original.value);
        const nowEmpty = isEmptyValue(field.value);
        
        // Skip if both are empty variants (e.g., "" vs "(none)")
        if (wasEmpty && nowEmpty) continue;
        
        dirty.push({
          key: field.key,
          label: field.label,
          type: field.type || original.type,
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
    // After Clear/Reapply, suppress notifications to prevent phantom dirty rows
    if (isSuppressed()) return;
    
    const dirty = getDirtyFields();
    chrome.runtime.sendMessage({
      type: 'FIELDS_UPDATE',
      data: {
        host: location.hostname,
        path: location.pathname,
        dirty: dirty,
        // Include ALL field keys so the panel builds a STABLE fingerprint.
        // Without this, save (dirty keys only) and restore (all keys) mismatch.
        allFieldKeys: Array.from(baseline.keys()),
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

  /**
   * Guard so we never run more than one post-submit success watcher at a time.
   */
  let successWatcherActive = false;

  /**
   * Does the form (or page) still show outstanding validation errors?
   *
   * Covers native HTML5 constraint validation (`:invalid`) and common
   * framework/ARIA error markers used by MS Forms, Google Forms, React, etc.
   * If this is true, the submit clearly did NOT succeed and the user is still
   * on the same form, so we must keep the baseline/detections.
   */
  function hasOutstandingValidationErrors(form) {
    const scope = (form && document.contains(form)) ? form : document;
    try {
      if (scope.querySelector('input:invalid, select:invalid, textarea:invalid')) {
        return true;
      }
    } catch {}
    try {
      if (scope.querySelector('[aria-invalid="true"]')) return true;
    } catch {}
    return false;
  }

  /**
   * After a confirmed Save/Submit we must NOT assume the submit succeeded.
   * Many submits fail (required field empty, server-side validation) and leave
   * the user on the SAME form. Re-baselining in that case would wipe the user's
   * Was/Now detections even though nothing was actually saved.
   *
   * Instead, watch for concrete evidence that the form actually succeeded or the
   * user left it, and ONLY then re-baseline (which clears detections):
   *   - the URL changes (SPA route change / navigation to a thank-you page)
   *   - the submitted <form> is detached / replaced in the DOM
   *   - every tracked field is detached and the form was replaced by non-form
   *     success content (thank-you page), with no validation errors
   *
   * A full-page navigation tears down this content script entirely, so the fresh
   * page gets a fresh baseline automatically; this watcher only needs to handle
   * in-page (SPA / DOM-swap) success and, crucially, the "stayed on the same
   * form" case where it deliberately does nothing.
   *
   * Soft SPA re-renders that keep an equivalent editable form are NOT treated as
   * success: we require the editable fields to have (mostly) disappeared before
   * clearing, so we never false-clear a form the user is still editing.
   */
  function watchForSubmitSuccess(contextForm) {
    if (successWatcherActive) return;
    successWatcherActive = true;

    const startUrl = location.href;
    const form = (contextForm && document.contains(contextForm)) ? contextForm : null;

    const trackedEls = [];
    for (const entry of baseline.values()) {
      if (entry.element) trackedEls.push(entry.element);
    }
    const trackedCount = trackedEls.length;

    const WATCH_MS = 6000;
    const POLL_MS = 250;
    const deadline = Date.now() + WATCH_MS;

    let settled = false;
    let pollTimer = null;

    function finish(didLeaveOrSucceed) {
      if (settled) return;
      settled = true;
      successWatcherActive = false;
      if (pollTimer) clearInterval(pollTimer);
      window.removeEventListener('pagehide', onPageHide, true);
      // Only re-baseline (which clears detections) when the form truly left or
      // succeeded. When the user stayed on the same form we intentionally do
      // nothing, so Was/Now detections and Keep storage remain untouched.
      if (didLeaveOrSucceed) {
        snapshotBaseline();
      }
    }

    // A real form-submit navigation fires pagehide and then tears down this
    // script; stop polling so we don't act on a dying page. We do NOT clear on
    // pagehide itself to avoid wiping detections for bfcache-restored forms.
    function onPageHide() {
      if (settled) return;
      settled = true;
      successWatcherActive = false;
      if (pollTimer) clearInterval(pollTimer);
      window.removeEventListener('pagehide', onPageHide, true);
    }

    function poll() {
      if (settled) return;

      // Strong signal: SPA route change / navigation to a different URL.
      if (location.href !== startUrl) {
        finish(true);
        return;
      }

      // DOM-replacement signals. Guard against soft SPA re-renders that keep an
      // equivalent editable form by requiring the editable fields to be (mostly)
      // gone and no validation errors to be outstanding before we clear.
      const formDetached = !!form && !document.contains(form);
      let connected = 0;
      for (const el of trackedEls) {
        if (el && el.isConnected) connected++;
      }
      const allTrackedGone = trackedCount > 0 && connected === 0;

      if ((formDetached || allTrackedGone) && !hasOutstandingValidationErrors(form)) {
        const currentFieldCount = collectFields().length;
        const replacedBySuccessContent =
          currentFieldCount <= Math.max(1, Math.floor(trackedCount * 0.25));
        if (replacedBySuccessContent) {
          finish(true);
          return;
        }
      }

      if (Date.now() >= deadline) {
        finish(false);
      }
    }

    window.addEventListener('pagehide', onPageHide, true);
    pollTimer = setInterval(poll, POLL_MS);
    // Immediate check too, for very fast SPA transitions.
    setTimeout(poll, 50);
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
        // Capture the form context BEFORE we clear pendingSaveTarget so the
        // success watcher can tell whether we actually left this form.
        const contextForm = pendingSaveTarget ? pendingSaveTarget.closest('form') : null;
        if (pendingSaveTarget) {
          pendingSaveTarget.click();
        }
        setTimeout(() => {
          saveInterceptEnabled = true;
          pendingSaveTarget = null;
          // Do NOT assume success. Only re-baseline if the form really leaves or
          // succeeds; a failed submit (e.g. required field empty) keeps detections.
          watchForSubmitSuccess(contextForm);
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
    
    /**
     * On real user input, reset clearedSession so dirty detection resumes.
     * Do NOT reset if applyingChanges is true (programmatic input from Reapply).
     * This is what allows new detections after Clear.
     */
    /**
     * Handle real user input to unlock detection after Clear.
     * 
     * CRITICAL: Do NOT call snapshotBaseline() here!
     * By the time this handler runs, the field value has ALREADY changed.
     * If we re-baseline now, we'd capture the new value as baseline,
     * making getDirtyFields() return empty (new == baseline).
     * 
     * The baseline was set during CLEAR_BASELINE to the form state at that moment.
     * We just need to reset clearedSession so getDirtyFields() starts working again.
     * The user's edit will then be detected as a diff vs the Clear-time baseline.
     */
    function handleUserInput(e) {
      // Only reset clearedSession on real user input, not programmatic changes
      if (clearedSession && !applyingChanges && e.isTrusted) {
        clearedSession = false;
        // DO NOT re-baseline here - baseline stays from Clear time
        // This edit will be the first dirty row vs that baseline
      }
      debouncedUpdate();
    }
    
    document.addEventListener('input', handleUserInput, true);
    document.addEventListener('change', handleUserInput, true);
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
          // requestSubmit() re-runs HTML5 constraint validation, so a required
          // empty field keeps the user on the same form and fires no navigation.
          if (form.requestSubmit) {
            form.requestSubmit();
          } else {
            form.submit();
          }
          setTimeout(() => {
            saveInterceptEnabled = true;
            // Do NOT assume success. Only re-baseline if the form really leaves or
            // succeeds; a failed submit (e.g. required field empty) keeps detections.
            watchForSubmitSuccess(form);
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

  /**
   * Apply stored "Now" values to matching fields.
   * Match strategy: uses the same field key system as tracking:
   * - name:fieldName — matches by form field name attribute
   * - id:fieldId — matches by element id
   * - path:css>path — matches by DOM path (less reliable after page changes)
   * Only applies when we have high confidence match. Skips if:
   * - Field not found
   * - Field type incompatible (e.g., select without matching option)
   * - Field is password/sensitive (already filtered in tracking)
   */
  function applyChanges(changes) {
    const results = { applied: 0, failed: 0, total: changes.length, failures: [] };
    
    for (const change of changes) {
      const success = applyOneChange(change);
      if (success) {
        results.applied++;
      } else {
        results.failed++;
        results.failures.push(change.label || change.key);
      }
    }
    
    return results;
  }
  
  /**
   * Apply changes while preserving the original baseline (Was values).
   * 
   * This is used after Reapply to keep the full detection list intact.
   * For each change:
   * 1. Set baseline[key] = was (original value before user edited)
   * 2. Apply "now" value to the form field
   * 
   * This way getDirtyFields() will continue showing all restored changes,
   * not just fields edited after Reapply.
   */
  function applyChangesWithBaseline(changes) {
    const results = { applied: 0, failed: 0, total: changes.length, failures: [] };
    
    for (const change of changes) {
      // Checkbox groups (multi-select) span multiple elements - handle specially.
      // There is no single element to key on, so match by the group key/label.
      if (isCheckboxGroupChange(change)) {
        try {
          const ok = applyCheckboxGroupChange(change);
          if (ok) {
            // Preserve "was" as baseline under the group key so it stays in the list
            const groupEl = findCheckboxGroup(change)?.checkboxes?.[0] || null;
            baseline.set(change.key, {
              label: change.label,
              type: change.type,
              value: change.was,
              element: groupEl
            });
            results.applied++;
          } else {
            results.failed++;
            results.failures.push(change.label || change.key);
          }
        } catch (err) {
          console.error('Failed to apply checkbox group:', change.key, err);
          results.failed++;
          results.failures.push(change.label || change.key);
        }
        continue;
      }
      
      const el = findFieldForChange(change);
      if (!el) {
        results.failed++;
        results.failures.push(change.label || change.key);
        continue;
      }
      
      if (shouldSkipField(el)) {
        results.failed++;
        results.failures.push(change.label || change.key);
        continue;
      }
      
      // Set baseline to the "was" value so this field stays in dirty list.
      // getFieldKey returns name:<name> for radios (all options share the name),
      // matching how collectFields keys the group.
      const fieldKey = getFieldKey(el);
      baseline.set(fieldKey, {
        label: change.label,
        type: change.type,
        value: change.was,
        element: el
      });
      
      // Apply the "now" value to the form
      try {
        const success = setFieldValue(el, change.now, change.type);
        if (success) {
          results.applied++;
        } else {
          results.failed++;
          results.failures.push(change.label || change.key);
        }
      } catch (err) {
        console.error('Failed to apply change:', change.key, err);
        results.failed++;
        results.failures.push(change.label || change.key);
      }
    }
    
    // Update badge to reflect the restored dirty count
    updateBadge();
    
    return results;
  }
  
  /**
   * Applies one change. Uses prioritized field matching:
   * 1. Direct key match (name:*, id:*, path:*)
   * 2. Fallback to name attribute from stored key
   * 3. Fallback to id attribute from stored key
   * 4. Fallback to label text match
   */
  function applyOneChange(change) {
    // Checkbox groups span multiple elements - handle specially
    if (isCheckboxGroupChange(change)) {
      try {
        return applyCheckboxGroupChange(change);
      } catch (err) {
        console.error('Failed to apply checkbox group:', change.key, err);
        return false;
      }
    }
    
    const el = findFieldForChange(change);
    if (!el) return false;
    
    if (shouldSkipField(el)) return false;
    
    try {
      return setFieldValue(el, change.now, change.type);
    } catch (err) {
      console.error('Failed to apply change:', change.key, err);
      return false;
    }
  }
  
  function findFieldForChange(change) {
    if (!change) return null;
    
    let el = findFieldByKey(change.key);
    if (el) return el;
    
    if (change.key) {
      if (change.key.startsWith('name:')) {
        const name = change.key.slice(5);
        el = document.querySelector(`[name="${CSS.escape(name)}"]`);
        if (el) return el;
      }
      if (change.key.startsWith('id:')) {
        const id = change.key.slice(3);
        el = document.getElementById(id);
        if (el) return el;
      }
    }
    
    if (change.label && change.label !== 'Unlabeled field') {
      el = findFieldByLabel(change.label, change.type);
      if (el) return el;
    }
    
    return null;
  }
  
  function findFieldByKey(key) {
    if (!key) return null;
    
    if (key.startsWith('name:')) {
      const name = key.slice(5);
      return document.querySelector(`[name="${CSS.escape(name)}"]`);
    }
    
    if (key.startsWith('id:')) {
      const id = key.slice(3);
      return document.getElementById(id);
    }
    
    if (key.startsWith('path:')) {
      try {
        const path = key.slice(5);
        return document.querySelector(path);
      } catch {
        return null;
      }
    }
    
    if (key.startsWith('checkbox-group:')) {
      return null;
    }
    
    return null;
  }
  
  function findFieldByLabel(targetLabel, targetType) {
    const normalizedTarget = targetLabel.toLowerCase().trim();
    const selectors = 'input, select, textarea, [contenteditable="true"]';
    const elements = deepQueryAll(document, selectors);
    
    for (const el of elements) {
      if (!el.offsetParent && el.type !== 'hidden') continue;
      if (shouldSkipField(el)) continue;
      
      if (targetType && el.type !== targetType && el.tagName.toLowerCase() !== targetType) {
        continue;
      }
      
      const label = getFieldLabel(el);
      if (label && label.toLowerCase().trim() === normalizedTarget) {
        return el;
      }
    }
    
    return null;
  }
  
  /**
   * Set an input/textarea value via the native property setter so that
   * framework-controlled inputs (React, etc.) actually register the change.
   * React patches the element's value setter and tracks the last value it set;
   * assigning el.value directly is ignored on re-render. Calling the native
   * prototype setter bypasses that tracker so the dispatched input event sticks.
   */
  function setNativeValue(el, value) {
    const v = value == null ? '' : value;
    try {
      const proto = el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, v);
        return;
      }
    } catch {}
    el.value = v;
  }

  /**
   * Set a checkbox/radio checked state via the native setter (React bypass).
   */
  function setNativeChecked(el, checked) {
    try {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
      if (desc && desc.set) {
        desc.set.call(el, checked);
        return;
      }
    } catch {}
    el.checked = checked;
  }

  /**
   * Drive a checkbox/radio to a target checked state in a way that works for
   * native inputs AND framework-controlled custom controls (Microsoft Forms,
   * Google Forms, React, etc.).
   *
   * Strategy (stop as soon as the state matches the target):
   * 1. Real click() on the input — fires the native toggle and the framework's
   *    onClick/onChange, which is what MS Forms/React rely on.
   * 2. Click the associated/wrapping <label> — some UIs wire the handler there.
   * 3. Fallback: native setter + full synthetic event sequence.
   */
  function applyCheckedState(el, shouldCheck) {
    if (el.checked === shouldCheck) return true;

    try { el.focus?.(); } catch {}
    try { el.click(); } catch {}
    if (el.checked === shouldCheck) return true;

    const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
    if (label) {
      try { label.click(); } catch {}
      if (el.checked === shouldCheck) return true;
    }

    setNativeChecked(el, shouldCheck);
    el.dispatchEvent(new Event('click', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.checked === shouldCheck;
  }

  /**
   * Parse a stored multi-value string ("A, B, C") into a Set of option labels.
   * Returns an empty Set for empty/placeholder markers.
   */
  function parseSelectedValues(stored) {
    const set = new Set();
    if (!stored) return set;
    const trimmed = String(stored).trim();
    if (EMPTY_VALUES.has(trimmed) || trimmed === '(none)') return set;
    for (const part of trimmed.split(',')) {
      const t = part.trim();
      if (t) set.add(t);
    }
    return set;
  }

  /**
   * Find the container + checkboxes for a checkbox-group change.
   * Returns { container, checkboxes } or null if the group can't be located.
   */
  function findCheckboxGroup(change) {
    const prefix = 'checkbox-group:';
    const groupLabel = (change.key && change.key.startsWith(prefix))
      ? change.key.slice(prefix.length)
      : change.label;
    if (!groupLabel) return null;

    const allCheckboxes = deepQueryAll(document, 'input[type="checkbox"]');
    for (const cb of allCheckboxes) {
      if (!cb.offsetParent) continue;
      if (shouldSkipField(cb)) continue;
      if (getCheckboxGroupLabel(cb) === groupLabel) {
        const container = cb.closest(CHECKBOX_GROUP_CONTAINER_SELECTOR);
        if (container) {
          const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
          if (checkboxes.length > 0) return { container, checkboxes };
        }
      }
    }
    return null;
  }

  /**
   * Apply a checkbox-group (multi-select) change: check options whose label
   * (or value) is in the stored "now" set, uncheck the rest.
   */
  function applyCheckboxGroupChange(change) {
    const group = findCheckboxGroup(change);
    if (!group) return false;

    const desired = parseSelectedValues(change.now);
    for (const cb of group.checkboxes) {
      const optLabel = getCheckboxOptionLabel(cb);
      const shouldCheck = desired.has(optLabel) || desired.has(cb.value);
      applyCheckedState(cb, shouldCheck);
    }
    return true;
  }

  function isCheckboxGroupChange(change) {
    return change.type === 'checkbox-group' ||
      (typeof change.key === 'string' && change.key.startsWith('checkbox-group:'));
  }

  function setFieldValue(el, value, type) {
    const tag = el.tagName.toLowerCase();
    
    if (tag === 'input') {
      if (el.type === 'checkbox') {
        // Single checkbox: stored value is "Checked" / option label (checked) vs unchecked markers
        const nowEmpty = isEmptyValue(value);
        const shouldCheck = !nowEmpty && value !== 'Unchecked';
        return applyCheckedState(el, shouldCheck);
      }
      
      if (el.type === 'radio') {
        const name = el.name;
        const radios = name
          ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`))
          : [el];
        for (const radio of radios) {
          const optionLabel = getRadioOptionLabel(radio);
          if (optionLabel === value || radio.value === value) {
            return applyCheckedState(radio, true);
          }
        }
        return false;
      }
      
      // Text-like inputs: native setter + input/change for framework compatibility
      setNativeValue(el, value || '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    
    if (tag === 'select') {
      if (el.multiple) {
        const desired = parseSelectedValues(value);
        let anyMatched = false;
        for (const opt of el.options) {
          const shouldSelect = desired.has(opt.text) || desired.has(opt.value) ||
            desired.has((opt.text || '').trim());
          opt.selected = shouldSelect;
          if (shouldSelect) anyMatched = true;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return anyMatched;
      } else {
        for (const opt of el.options) {
          if (opt.text === value || opt.value === value || (opt.text || '').trim() === value) {
            setNativeValue(el, opt.value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }
    }
    
    if (tag === 'textarea') {
      setNativeValue(el, value || '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    
    if (el.isContentEditable) {
      el.innerText = value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    
    return false;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'GET_FIELDS':
        const dirty = getDirtyFields();
        sendResponse({
          host: location.hostname,
          path: location.pathname,
          dirty: dirty,
          allFieldKeys: Array.from(baseline.keys()),
          coverage: {
            tracked: baseline.size,
            total: totalFieldsScanned,
            skipped: skippedSensitive
          }
        });
        break;
        
      case 'CLEAR_BASELINE':
        /**
         * Clear detections: re-establish baseline from current live form values.
         * 
         * CRITICAL FIX for Keep→Reload→Reapply→Clear resurrection:
         * 1. Set clearedSession = true so getDirtyFields() returns [] until real user input
         * 2. Re-baseline from current form values
         * 3. Suppress notifications
         * 
         * The clearedSession flag is the definitive fix - it ensures ZERO detections
         * after Clear regardless of timing, baseline state, or async issues.
         * Only a real user input (not programmatic) will reset the flag.
         */
        clearedSession = true;
        suppressFor(3000);
        snapshotBaseline(true);
        sendResponse({ success: true, baselineSize: baseline.size });
        break;
        
      case 'SET_INTERCEPT':
        saveInterceptEnabled = message.enabled;
        sendResponse({ success: true });
        break;
        
      case 'APPLY_CHANGES':
        /**
         * Apply stored "Now" values back to form fields, using "Was" as baseline.
         * 
         * CRITICAL: After Reapply, we must preserve the original baseline (Was values)
         * so that getDirtyFields() continues to show all restored changes.
         * 
         * If we re-baseline to current (applied) values, then getDirtyFields() would
         * return empty, and editing one field would collapse the list to just that field.
         * 
         * Instead: set baseline[key] = was for each applied change.
         * This keeps the full detection list intact after Reapply.
         * User edits update that field's "now" value while keeping other rows.
         * 
         * Note: applyingChanges flag prevents input events from resetting clearedSession
         */
        applyingChanges = true;
        suppressFor(1000);
        const applyResults = applyChangesWithBaseline(message.changes || []);
        setTimeout(() => { applyingChanges = false; }, 500);
        sendResponse(applyResults);
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
