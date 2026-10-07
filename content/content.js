/**
 * ChangePreview Content Script
 * Snapshots form fields on load, detects dirty fields, soft Save intercept.
 * Local-only. Skips passwords/hidden/token-ish fields.
 */

(function() {
  'use strict';

  /**
   * Is this content script running in the TOP-LEVEL browsing context (the tab's
   * real page) rather than a sub-frame / iframe?
   *
   * The extension injects into all frames (`all_frames: true`) so it can reach
   * forms rendered inside iframes (SPA dashboards, portals, embedded widgets).
   * We separate two concerns that an earlier version wrongly collapsed into one:
   *
   *   - WHERE WE COLLECT FIELDS: every frame collects its own fields, so forms
   *     the user actually edits are detected even when they live in a frame.
   *   - THE TRACKED IDENTITY (host/path shown in the panel, storage key, badge):
   *     this must stay on the real top-level page and never flit to an ephemeral
   *     CDN/widget sub-frame (e.g. b.stripecdn.com, js.stripe.com embedded in
   *     dashboard.stripe.com).
   *
   * To get both, only the TOP frame talks to the panel/background. Sub-frames
   * forward their detections to the top frame via postMessage; the top frame
   * aggregates them and reports a single, stable top-level identity. The top
   * frame also expires a sub-frame's contributions when that frame goes away
   * (iframe/modal removed), so closing a dialog clears its stale rows.
   *
   * Comparing window references never throws cross-origin, so this check is safe
   * and generic — no per-site hardcodes.
   */
  const IS_TOP_FRAME = (() => {
    try {
      return window.top === window.self;
    } catch {
      // A thrown SecurityError only happens for cross-origin access, which by
      // definition means we are NOT the top frame.
      return false;
    }
  })();

  /**
   * Cross-frame messaging constants for the top-frame aggregation protocol.
   * Messages are tagged so unrelated postMessage traffic is ignored.
   */
  const CP_FRAME_TAG = '__changepreview_frame__';
  const FRAME_UID = IS_TOP_FRAME
    ? 'top'
    : `f-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const FRAME_HEARTBEAT_MS = 1500;
  const SUBFRAME_TTL_MS = 4000;
  const FRAME_KEY_PREFIX = `frame:${FRAME_UID}:`;

  /**
   * Top frame only: latest detections forwarded by each sub-frame, keyed by the
   * sub-frame's UID, each stamped with a timestamp so stale frames (removed
   * iframes / closed modals) can be expired.
   */
  const subFrameReports = new Map();

  /** Command ids already processed, so a relayed command never runs twice. */
  const processedCmdIds = new Set();

  function isFrameNamespacedKey(key) {
    return typeof key === 'string' && key.startsWith('frame:');
  }

  const SKIP_TYPES = new Set(['password', 'hidden', 'file']);
  const SENSITIVE_PATTERN = /password|secret|token|ssn|cvv|cvc|otp|api[-_]?key|auth/i;
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc',
    'cc-name', 'cc-type', 'one-time-code', 'new-password', 'current-password'
  ]);
  
  const SAVE_BUTTON_PATTERN = /^(save|update|submit|apply|publish|confirm|create|add|store)$/i;
  const SAVE_BUTTON_CONTAINS = /(save|update|submit|apply|publish|confirm)\s*(changes?|settings?|form)?/i;
  
  /**
   * Hosts where save/submit intercept is disabled entirely.
   * These are sensitive payment/admin dashboards where intercepting buttons
   * could block critical user flows (onboarding, checkout, account management).
   * The extension still tracks fields silently; it just won't show confirm modals.
   */
  const INTERCEPT_DENYLIST_HOSTS = [
    'dashboard.stripe.com',
    'connect.stripe.com',
    'billing.stripe.com',
    'stripe.com',
    'paypal.com',
    'www.paypal.com',
    'braintreegateway.com',
    'square.com',
    'squareup.com',
    'checkout.com',
    'adyen.com',
    'authorize.net',
    'pay.google.com',
    'wallet.google.com',
    'appleid.apple.com',
    'idmsa.apple.com',
  ];
  
  /**
   * Host patterns (regex) for broader matching (e.g., subdomains).
   */
  const INTERCEPT_DENYLIST_PATTERNS = [
    /\.stripe\.com$/i,
    /\.paypal\.com$/i,
    /\.braintree.*\.com$/i,
    /\.square(up)?\.com$/i,
    /\.adyen\.com$/i,
    /^pay\./i,
    /^checkout\./i,
    /^billing\./i,
    /^wallet\./i,
  ];
  
  function isInterceptDenylisted() {
    const host = location.hostname.toLowerCase();
    if (INTERCEPT_DENYLIST_HOSTS.includes(host)) return true;
    for (const pattern of INTERCEPT_DENYLIST_PATTERNS) {
      if (pattern.test(host)) return true;
    }
    return false;
  }
  
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
  /**
   * Selectors for a MS-Forms / admin "question root" — the ancestor that wraps
   * ONE question (its title plus all of its options). On real Microsoft Forms
   * the title is NOT always inside a ".office-form-question-title"; it may live
   * in a Fluent UI tree, a data-automation-id node, or just a styled <span>.
   * We climb ancestors against this list and pick the nearest one that contains
   * BOTH a title node and all the option inputs (never the single option card).
   */
  const QUESTION_ROOT_SELECTORS = [
    '[data-automation-id*="questionContent"]',
    '[data-automation-id*="question"]',
    '[class*="office-form-question"]',
    'fieldset',
    '[role="radiogroup"]',
    '[role="group"]',
    '[class*="question"]',
    '[class*="Question"]',
    '[class*="form-group"]',
    '[class*="formGroup"]',
    '[class*="field-container"]',
    '[class*="fieldContainer"]',
    'section'
  ];
  const QUESTION_ROOT_SELECTOR = QUESTION_ROOT_SELECTORS.join(', ');

  /**
   * An option's own clickable wrapper (label / choice card / role=radio cell).
   * Used both to collect the option's visible text and to make sure we never
   * mistake an option's own text for the group question title.
   */
  const OPTION_WRAPPER_SELECTOR = [
    'label',
    '[class*="choice"]', '[class*="Choice"]',
    '[class*="option"]', '[class*="Option"]',
    '[role="radio"]', '[role="checkbox"]',
    '[class*="checkbox-item"]', '[class*="radio-item"]'
  ].join(', ');

  let baseline = new Map();
  let radioGroupLabels = new Map();
  let checkboxGroupLabels = new Map();
  let totalFieldsScanned = 0;
  let skippedSensitive = 0;
  let saveInterceptEnabled = true;
  let modalOpen = false;
  let pendingSaveTarget = null;

  /**
   * User preference: show the save/submit confirmation dialog that lists pending
   * changes before the form is submitted. Defaults to true so new installs keep
   * the current "confirm on save" behaviour. When false, the dialog is never
   * shown and submits/saves proceed normally — but change detection and the side
   * panel keep working for information only.
   *
   * Persisted in chrome.storage.local under `confirmOnSaveEnabled` and kept in
   * sync across all tabs/frames via a storage change listener.
   */
  let confirmOnSaveEnabled = true;

  const CONFIRM_ON_SAVE_KEY = 'confirmOnSaveEnabled';

  function loadConfirmOnSavePref() {
    try {
      chrome.storage?.local?.get(CONFIRM_ON_SAVE_KEY, (res) => {
        if (chrome.runtime?.lastError) return;
        // Default ON: only an explicit stored `false` disables the dialog.
        confirmOnSaveEnabled = res?.[CONFIRM_ON_SAVE_KEY] !== false;
      });
    } catch {}
  }

  function setupPrefSync() {
    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[CONFIRM_ON_SAVE_KEY]) {
          confirmOnSaveEnabled = changes[CONFIRM_ON_SAVE_KEY].newValue !== false;
        }
      });
    } catch {}
  }
  
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
  
  /**
   * Strip a leading question/ordinal index that Microsoft Forms (and similar
   * builders) sometimes glue onto the front of a question title — the MCQ item
   * number rendered immediately before the real stem, e.g. the 3rd question
   * "He goes ....................every month." surfacing as
   * "3He goes ....................every month.".
   *
   * Handles, in order:
   *   - "Question 3" / "Question 3." / "Question 3:" / "Question 3)" prefixes
   *   - "Q3" / "Q3." / "Q3)" / "Q3:" prefixes
   *   - "3." / "3)" / "3]" / "3:" ordinals (with or without a trailing space)
   *   - "3He goes" — digits glued directly onto the real title
   *
   * Deliberately conservative so it never eats real content that merely starts
   * with a number:
   *   - a bare "3 days a week ..." (digits + space + word, no ordinal separator)
   *     is left untouched,
   *   - decimals like "3.5 miles" are not treated as an ordinal, and
   *   - glued digits are only stripped when the next char is an UPPER-case
   *     letter, so ordinal/unit words like "3rd floor" or "3km" survive.
   */
  function stripLeadingOrdinal(text) {
    if (!text) return text;
    const original = text;
    const cleaned = text.replace(/^\s+/, '');

    const patterns = [
      // "Question 3" + optional separator + required space before the title.
      /^question\s*\d+\s*[.):\]\-–—]?\s+(?=\S)(.+)$/i,
      // "Q3" + optional separator + required space before the title.
      /^q\s*\d+\s*[.):\]\-–—]?\s+(?=\S)(.+)$/i,
      // "3." / "3)" / "3]" / "3:" ordinal, separator then a letter (optional
      // space). The letter lookahead keeps decimals like "3.5 miles" intact.
      /^\d+\s*[.):\]]\s*(?=[A-Za-z])(.+)$/,
      // "3He goes" — digits glued to the title, only before an upper-case letter.
      /^\d+(?=[A-Z])([A-Za-z].*)$/
    ];

    for (const pattern of patterns) {
      const m = cleaned.match(pattern);
      if (m && m[1] && m[1].trim()) {
        return m[1].trim();
      }
    }

    return original;
  }

  function cleanLabel(text) {
    if (!text) return text;
    let cleaned = stripTypeSuffix(text);
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^\*\s*/, '');
    cleaned = cleaned.replace(/\s*\*$/, '');
    cleaned = stripLeadingOrdinal(cleaned);
    
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
   * Build a CSS-queryable DOM path for an element (used as a stable key when a
   * group has no shared name/id to key on). Mirrors the path logic in
   * getFieldKey so a key produced here can be resolved later via querySelector.
   */
  function getDomPath(el) {
    const path = [];
    let current = el;
    while (current && current !== document.body && current.nodeType === 1) {
      let tag = current.tagName.toLowerCase();
      if (current.id) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const siblings = current.parentElement ? current.parentElement.children : [];
      const idx = Array.from(siblings).filter(s => s.tagName === current.tagName).indexOf(current);
      if (idx > 0) tag += `:nth-of-type(${idx + 1})`;
      path.unshift(tag);
      current = current.parentElement;
    }
    return path.join('>');
  }

  /**
   * The option input's own clickable wrapper (label / choice card / role cell).
   * Falls back to the direct parent so card-style controls still resolve.
   */
  function getOptionWrapper(input) {
    return (input.closest && input.closest(OPTION_WRAPPER_SELECTOR)) || input.parentElement;
  }

  /**
   * Lower-cased set of every text that belongs to an OPTION (its visible label
   * text + its value). The question title must never equal one of these — if a
   * candidate does, we reject it and keep looking (Yes/No/Block of flats etc.).
   */
  function buildForbiddenOptionTexts(optionInputs) {
    const set = new Set();
    const add = (t) => {
      if (t == null) return;
      const s = String(t).trim().toLowerCase();
      if (s) set.add(s);
    };
    for (const inp of optionInputs) {
      add(inp.value);
      const w = getOptionWrapper(inp);
      if (w) {
        const clone = w.cloneNode(true);
        clone.querySelectorAll('input, select, textarea').forEach(c => c.remove());
        add(clone.textContent);
      }
    }
    return set;
  }

  /**
   * All ancestor elements (nearest first) that look like a question root AND
   * contain every one of the group's option inputs. The real question container
   * is the nearest such ancestor that also yields a title; the single option
   * card is skipped because it does not contain the OTHER options.
   */
  function getMatchingRoots(el, optionInputs) {
    const roots = [];
    let cur = el.parentElement;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      if (cur.matches && cur.matches(QUESTION_ROOT_SELECTOR) &&
          optionInputs.every(i => cur.contains(i))) {
        roots.push(cur);
      }
      cur = cur.parentElement;
    }
    return roots;
  }

  /**
   * Extract the GROUP question title from a question root, rejecting anything
   * that is really an option's text, a generic type string ("Choice", "Single
   * choice"), a points marker, or a bare number. Works for real Microsoft Forms
   * where the title is a plain styled <span>/<div> (no title class, no heading
   * role) sitting as a sibling above the option cards.
   *
   * @param {Element} root
   * @param {Element[]} optionInputs
   * @returns {string|null}
   */
  function extractQuestionTitle(root, optionInputs) {
    if (!root) return null;

    const forbidden = buildForbiddenOptionTexts(optionInputs);
    const optionWrappers = optionInputs.map(getOptionWrapper).filter(Boolean);
    const optionLabelEls = new Set();
    for (const inp of optionInputs) {
      if (inp.id) {
        const l = root.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
        if (l) optionLabelEls.add(l);
      }
      const wrap = inp.closest('label');
      if (wrap) optionLabelEls.add(wrap);
    }
    const optionIds = new Set(optionInputs.map(i => i.id).filter(Boolean));

    const inAnyWrapper = (node) =>
      optionWrappers.some(w => w === node || (w.contains && w.contains(node)));
    const containsOptionInput = (node) =>
      optionInputs.some(i => node.contains && node.contains(i));

    const isBadCandidate = (raw) => {
      if (!raw) return true;
      const t = raw.trim();
      if (!isValidLabelText(t)) return true;
      if (forbidden.has(t.toLowerCase())) return true;
      if (/^[0-9.\s()]+$/.test(t)) return true;
      const cleaned = cleanLabel(t);
      if (!cleaned) return true;
      if (isGenericTypeString(cleaned)) return true;
      if (forbidden.has(cleaned.toLowerCase())) return true;
      return false;
    };

    // 1. Explicit group semantics on the root itself.
    const labelledBy = root.getAttribute && root.getAttribute('aria-labelledby');
    if (labelledBy) {
      const txt = labelledBy.split(/\s+/)
        .map(id => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; })
        .join(' ').trim();
      if (!isBadCandidate(txt)) return cleanLabel(txt);
    }
    const ariaLabel = root.getAttribute && root.getAttribute('aria-label');
    if (ariaLabel && !isBadCandidate(ariaLabel)) return cleanLabel(ariaLabel);

    // 2. Recognised title containers (MS Forms / Google Forms / common builders).
    const titleSelectors = [
      '[class*="question-title"]', '[class*="questionTitle"]',
      '[class*="question_title"]', '[class*="QuestionTitle"]',
      '[data-automation-id*="questionTitle"]', '[data-automation-id*="question-title"]',
      '[class*="field-label"]', '[class*="fieldLabel"]',
      '[class*="form-label"]', '[class*="formLabel"]',
      'legend', '[role="heading"]',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      '.section-title'
    ];
    for (const sel of titleSelectors) {
      for (const node of root.querySelectorAll(sel)) {
        if (optionLabelEls.has(node) || inAnyWrapper(node) || containsOptionInput(node)) continue;
        if (!isBadCandidate(node.textContent)) return cleanLabel(node.textContent.trim());
      }
    }

    // 3. Bare non-option <label> alongside the options (admin "House type").
    for (const lab of root.querySelectorAll('label')) {
      if (optionLabelEls.has(lab) || inAnyWrapper(lab)) continue;
      if (lab.querySelector('input, select, textarea')) continue;
      const forId = lab.getAttribute('for');
      if (forId && optionIds.has(forId)) continue;
      if (!isBadCandidate(lab.textContent)) return cleanLabel(lab.textContent.trim());
    }

    // 4. Generic fallback — real MS Forms renders the title as a plain styled
    //    span/div with no title class. Take the first text-bearing node that is
    //    not an option, not type chrome, and does not wrap any option input.
    const generic = root.querySelectorAll('span, div, p, [class*="text"], [data-automation-id]');
    for (const node of generic) {
      if (optionLabelEls.has(node) || inAnyWrapper(node) || containsOptionInput(node)) continue;
      if (!isBadCandidate(node.textContent)) return cleanLabel(node.textContent.trim());
    }

    return null;
  }

  /**
   * Resolve the question-root title for a group by climbing from the option
   * element through every candidate root (nearest first) until one yields a
   * valid title. Returns null if none do (caller falls back to other labels).
   */
  function resolveGroupTitle(el, optionInputs) {
    const roots = getMatchingRoots(el, optionInputs);
    for (const root of roots) {
      const title = extractQuestionTitle(root, optionInputs);
      if (title) return title;
    }
    return null;
  }

  /**
   * The nearest ancestor question root that holds MORE THAN ONE radio — i.e.
   * the real group when radios are NOT tied together by a shared `name`
   * (common on real MS Forms, where React manages selection). Returns null for
   * a lone radio so it keeps its own option label.
   */
  function getRadioRoot(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      if (cur.matches && cur.matches(QUESTION_ROOT_SELECTOR)) {
        if (cur.querySelectorAll('input[type="radio"]').length > 1) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * The option inputs that make up a radio's group: prefer a shared `name`;
   * otherwise fall back to every radio under the same question root.
   */
  function getRadioGroupInputs(el) {
    if (el.name) {
      return Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`));
    }
    const root = getRadioRoot(el);
    if (root) return Array.from(root.querySelectorAll('input[type="radio"]'));
    return [el];
  }

  /**
   * The group membership for a checkbox: the nearest question root that holds
   * MORE THAN ONE checkbox. Card-style UIs (clickable cards wrapping a hidden
   * checkbox) still resolve here. Returns null for a lone checkbox so it keeps
   * its own option label and Checked/Unchecked value.
   */
  function getCheckboxGroupInputs(el) {
    // ASP.NET CheckBoxList items are independent per-box rows, never a single
    // comma-joined multi-select group, even inside a Bootstrap form-group.
    if (isAspNetListItem(el)) return null;
    let cur = el.parentElement;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      if (cur.matches && cur.matches(QUESTION_ROOT_SELECTOR)) {
        const cbs = Array.from(cur.querySelectorAll('input[type="checkbox"]'));
        if (cbs.length > 1) return { root: cur, checkboxes: cbs };
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function getRadioGroupLabel(el) {
    if (el.type !== 'radio') return null;
    const name = el.name;

    if (name && radioGroupLabels.has(name)) {
      return radioGroupLabels.get(name);
    }

    const optionInputs = getRadioGroupInputs(el);
    if (optionInputs.length === 0) return null;
    const firstRadio = optionInputs[0];

    // Primary: climb to the question root and read the real title (handles real
    // MS Forms where the title is a plain span, not a recognised title node).
    let label = resolveGroupTitle(firstRadio, optionInputs);

    // Fallbacks: legacy recognised paths.
    if (!label) label = getLegendOrFieldsetLabel(firstRadio);
    if (!label) label = getQuestionContainerLabel(firstRadio);
    // ASP.NET RadioButtonList: section heading label whose `for` -> list id.
    if (!label) label = getSectionHeadingLabel(firstRadio);

    if (label) {
      if (name) radioGroupLabels.set(name, label);
      return label;
    }
    return null;
  }

  function getCheckboxGroupLabel(el) {
    if (el.type !== 'checkbox') return null;

    // Only treat as a group when the question root really holds >1 checkbox so a
    // lone checkbox keeps its own option label and Checked/Unchecked value.
    const group = getCheckboxGroupInputs(el);
    if (!group) return null;

    let label = resolveGroupTitle(el, group.checkboxes);
    if (!label) label = getLegendOrFieldsetLabel(el);
    if (!label) label = getQuestionContainerLabel(el);
    return label || null;
  }

  /**
   * Extract clean visible text from a <label>-like element: strip nested form
   * controls and convert <br> to spaces (so multi-line / machine-translated
   * headings do not glue words together), then collapse whitespace.
   */
  function extractLabelText(labelEl) {
    if (!labelEl) return '';
    const clone = labelEl.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, [type="hidden"]').forEach(c => c.remove());
    clone.querySelectorAll('br').forEach(br => {
      br.replaceWith(labelEl.ownerDocument.createTextNode(' '));
    });
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  /**
   * True when a <label> is really an OPTION's label (its `for` targets a
   * checkbox/radio, or it wraps an input) — such a label is never a section
   * heading and must be rejected when hunting for the question title.
   */
  function isOptionInputLabel(labelEl) {
    if (!labelEl) return false;
    const forId = labelEl.getAttribute && labelEl.getAttribute('for');
    if (forId) {
      const target = labelEl.ownerDocument.getElementById(forId);
      if (target && (target.type === 'checkbox' || target.type === 'radio')) return true;
    }
    if (labelEl.querySelector && labelEl.querySelector('input, select, textarea')) return true;
    return false;
  }

  /**
   * Does this element look like a WebForms / admin "form group" block that
   * wraps ONE question (its heading plus the list of options)? Purely
   * structural / class-name heuristics — no site, product, or language names.
   */
  const SECTION_CONTAINER_ID = /divcontainer|formgroup|form-group|field-?container|question/i;
  const SECTION_CONTAINER_CLASS = /\b(form-group|form-row|control-group|field-container|fieldcontainer|col-(?:xs|sm|md|lg|xl)-\d+)\b/i;
  function isSectionContainer(elm) {
    if (!elm || elm.nodeType !== 1) return false;
    if (elm.id && SECTION_CONTAINER_ID.test(elm.id)) return true;
    const cls = (elm.getAttribute && elm.getAttribute('class')) || '';
    return SECTION_CONTAINER_CLASS.test(cls);
  }

  /**
   * Resolve the SECTION heading for an independent checkbox / radio rendered by
   * an ASP.NET WebForms CheckBoxList / RadioButtonList (or a similar admin UI).
   *
   * Portable, structure-only heuristics (never keyed on site names or language):
   *   1. A <label for="<listId>"> whose `for` points at the enclosing list
   *      container (<table>/<ul>/role=list/radiogroup) id, or at the option id
   *      with its trailing "_<index>" removed, or at any ancestor id. The
   *      label's `for` targeting the LIST (not an individual option) is the
   *      defining CheckBoxList/RadioButtonList signature.
   *   2. Otherwise, climb to the nearest form-group-like container and read its
   *      heading label (h1-h6 > label / label.control-label / legend / h1-h6).
   */
  function getSectionHeadingLabel(el) {
    const doc = el.ownerDocument || document;

    // --- 1. label[for] pointing at the list container / stripped option id ---
    const candidateIds = [];
    const pushId = (id) => { if (id) candidateIds.push(id); };

    const listContainer = el.closest('table, ul, ol, [role="list"], [role="radiogroup"], [role="group"]');
    if (listContainer) pushId(listContainer.id);
    if (el.id) {
      const m = el.id.match(/^(.*?)_\d+$/);
      if (m && m[1]) pushId(m[1]);
    }
    let anc = el.parentElement;
    let ancDepth = 0;
    while (anc && anc.nodeType === 1 && anc !== document.body && ancDepth < 6) {
      pushId(anc.id);
      anc = anc.parentElement;
      ancDepth++;
    }

    const seen = new Set();
    for (const id of candidateIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let labelEl = null;
      try {
        labelEl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      } catch { labelEl = null; }
      if (!labelEl || isOptionInputLabel(labelEl)) continue;
      const text = extractLabelText(labelEl);
      if (isValidLabelText(text)) return text;
    }

    // --- 2. nearest form-group-like container's heading label ----------------
    let cur = el.parentElement;
    let depth = 0;
    while (cur && cur !== document.body && cur.nodeType === 1 && depth < 8) {
      if (isSectionContainer(cur)) {
        const headingLabel = cur.querySelector(
          'h1 label, h2 label, h3 label, h4 label, h5 label, h6 label, legend, label.control-label'
        );
        if (headingLabel && !isOptionInputLabel(headingLabel)) {
          const text = extractLabelText(headingLabel);
          if (isValidLabelText(text)) return text;
        }
        const heading = cur.querySelector('h1, h2, h3, h4, h5, h6');
        if (heading) {
          const htext = heading.textContent.replace(/\s+/g, ' ').trim();
          if (isValidLabelText(htext)) return htext;
        }
      }
      cur = cur.parentElement;
      depth++;
    }

    return null;
  }

  /**
   * True when a checkbox/radio is an item of an ASP.NET WebForms-style
   * CheckBoxList / RadioButtonList: the defining signal is a <label for="<id>">
   * whose `for` targets the ENCLOSING LIST container (<table>/<ul>/role=list…)
   * or the option id with its trailing "_<index>" removed — i.e. the section
   * label points at the LIST, not at an individual option input.
   *
   * Used to keep such checkboxes as independent per-box rows instead of folding
   * them into a single comma-joined multi-select group. Genuine MS Forms /
   * admin multi-select groups (whose section label has no `for`, or wraps the
   * options) are NOT matched here, so their grouped behaviour is preserved.
   */
  function isAspNetListItem(el) {
    if (!el || (el.type !== 'checkbox' && el.type !== 'radio')) return false;
    const doc = el.ownerDocument || document;
    const ids = [];
    const listContainer = el.closest('table, ul, ol, [role="list"], [role="radiogroup"], [role="group"]');
    if (listContainer && listContainer.id) ids.push(listContainer.id);
    if (el.id) {
      const m = el.id.match(/^(.*?)_\d+$/);
      if (m && m[1]) ids.push(m[1]);
    }
    for (const id of ids) {
      if (!id) continue;
      let lab = null;
      try { lab = doc.querySelector(`label[for="${CSS.escape(id)}"]`); } catch { lab = null; }
      if (!lab || isOptionInputLabel(lab)) continue;
      if (isValidLabelText(extractLabelText(lab))) return true;
    }
    return false;
  }

  /**
   * Field label for an INDEPENDENT checkbox (an ASP.NET CheckBoxList item, where
   * each box has its own unique name and is tracked as its own row). When a
   * section heading is found, combine it with the option text as
   * "Section · Option"; otherwise return null so the caller keeps option-only.
   */
  const SECTION_OPTION_SEPARATOR = ' \u00B7 ';
  function getIndependentChoiceFieldLabel(el, optionText) {
    const section = getSectionHeadingLabel(el);
    if (!section) return null;
    const sectionClean = cleanLabel(section);
    if (!sectionClean) return null;
    const option = cleanLabel(optionText || '');
    if (!option || sectionClean.toLowerCase() === option.toLowerCase()) {
      return sectionClean;
    }
    return `${sectionClean}${SECTION_OPTION_SEPARATOR}${option}`;
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
      // Independent checkbox (ASP.NET CheckBoxList item): "Section · Option".
      const combined = getIndependentChoiceFieldLabel(el, getCheckboxOptionLabel(el));
      if (combined) return combined;
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

    // Nameless radios that belong to a question-root group share ONE key so the
    // whole group is tracked as a single field (not one field per option).
    if (el.type === 'radio') {
      const root = getRadioRoot(el);
      if (root) return `radio-group:${getDomPath(root)}`;
    }

    if (el.id) return `id:${el.id}`;

    return `path:${getDomPath(el)}`;
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
        const group = getCheckboxGroupInputs(el);
        if (group) {
          const selected = [];
          for (const cb of group.checkboxes) {
            if (cb.checked) selected.push(getCheckboxOptionLabel(cb));
          }
          return selected.length > 0 ? selected.join(', ') : '(none selected)';
        }
        return el.checked ? 'Checked' : 'Unchecked';
      }
      if (el.type === 'radio') {
        const inputs = getRadioGroupInputs(el);
        const checked = inputs.find(r => r.checked);
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

  /**
   * Stable key base for a checkbox group: prefer the resolved question title so
   * the key survives reloads; fall back to the question-root DOM path when the
   * title can't be resolved (so the options are STILL grouped, never reported
   * individually as Checked/Unchecked).
   */
  function getCheckboxGroupKeyBase(checkbox, group) {
    const label = getCheckboxGroupLabel(checkbox);
    if (label && label !== 'Unlabeled field') return label;
    return getDomPath(group.root);
  }

  function getCheckboxGroupKey(checkbox) {
    const group = getCheckboxGroupInputs(checkbox);
    if (!group) return null;
    return `checkbox-group:${getCheckboxGroupKeyBase(checkbox, group)}`;
  }
  
  function getCheckboxGroupValue(checkbox) {
    const group = getCheckboxGroupInputs(checkbox);
    if (!group) return checkbox.checked ? 'Checked' : 'Unchecked';
    
    const selected = [];
    for (const cb of group.checkboxes) {
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
        // Dedupe by GROUP, not by raw name: nameless MS Forms radios still
        // collapse to one row via their shared question-root key.
        const radioKey = getFieldKey(el);
        if (seenRadios.has(radioKey)) continue;
        seenRadios.add(radioKey);
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
            label: cleanLabel(getCheckboxGroupLabel(el)) || 'Unlabeled field',
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

  /**
   * This frame's own detections (not yet merged with any sub-frame reports).
   */
  function getLocalReport() {
    return {
      dirty: getDirtyFields(),
      allFieldKeys: Array.from(baseline.keys()),
      coverage: {
        tracked: baseline.size,
        total: totalFieldsScanned,
        skipped: skippedSensitive
      }
    };
  }

  /**
   * Drop sub-frame reports whose heartbeat has lapsed (iframe removed / modal
   * closed). Returns true when something was pruned so the caller can refresh.
   */
  function pruneStaleSubFrames() {
    const now = Date.now();
    let changed = false;
    for (const [uid, rep] of subFrameReports) {
      if (now - rep.ts > SUBFRAME_TTL_MS) {
        subFrameReports.delete(uid);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Top frame: this frame's detections merged with every live sub-frame's, so
   * forms inside iframes still surface while the identity stays top-level.
   */
  function getAggregatedReport() {
    pruneStaleSubFrames();
    const own = getLocalReport();
    const dirty = own.dirty.slice();
    const allFieldKeys = own.allFieldKeys.slice();
    let tracked = own.coverage.tracked;
    let total = own.coverage.total;
    let skipped = own.coverage.skipped;

    for (const rep of subFrameReports.values()) {
      if (Array.isArray(rep.dirty)) dirty.push(...rep.dirty);
      if (Array.isArray(rep.allFieldKeys)) allFieldKeys.push(...rep.allFieldKeys);
      if (rep.coverage) {
        tracked += rep.coverage.tracked || 0;
        total += rep.coverage.total || 0;
        skipped += rep.coverage.skipped || 0;
      }
    }
    return { dirty, allFieldKeys, coverage: { tracked, total, skipped } };
  }

  /**
   * Forward this sub-frame's state up to the top frame. Keys are namespaced with
   * the frame UID so they never collide with other frames or the top document.
   */
  function postReportToTop(kind) {
    if (IS_TOP_FRAME) return;
    try {
      const payload = { [CP_FRAME_TAG]: true, kind, uid: FRAME_UID };
      if (kind === 'FIELDS') {
        const r = getLocalReport();
        payload.dirty = r.dirty.map((d) => ({ ...d, key: FRAME_KEY_PREFIX + d.key }));
        payload.allFieldKeys = r.allFieldKeys.map((k) => FRAME_KEY_PREFIX + k);
        payload.coverage = r.coverage;
      }
      window.top.postMessage(payload, '*');
    } catch {}
  }

  function updateBadge() {
    if (!IS_TOP_FRAME) {
      postReportToTop('FIELDS');
      return;
    }
    const count = getAggregatedReport().dirty.length;
    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      count: count
    }).catch(() => {});
  }

  function notifyPanel() {
    // After Clear/Reapply, suppress notifications to prevent phantom dirty rows.
    if (isSuppressed()) return;

    if (!IS_TOP_FRAME) {
      // Sub-frames never talk to the panel directly; they forward to the top
      // frame, which keeps the tracked identity on the real top-level page.
      postReportToTop('FIELDS');
      return;
    }

    const agg = getAggregatedReport();
    chrome.runtime.sendMessage({
      type: 'FIELDS_UPDATE',
      data: {
        host: location.hostname,
        path: location.pathname,
        dirty: agg.dirty,
        // Include ALL field keys so the panel builds a STABLE fingerprint.
        // Without this, save (dirty keys only) and restore (all keys) mismatch.
        allFieldKeys: agg.allFieldKeys,
        coverage: agg.coverage
      }
    }).catch(() => {});
  }

  /** Debounced top-frame push used when sub-frame reports arrive/expire. */
  let aggregatePushTimer = null;
  function scheduleAggregatePush() {
    if (!IS_TOP_FRAME) return;
    clearTimeout(aggregatePushTimer);
    aggregatePushTimer = setTimeout(() => {
      updateBadge();
      notifyPanel();
    }, 150);
  }

  /** Post a command down to every direct child frame (they relay further). */
  function broadcastCommandToChildFrames(payload) {
    try {
      const frames = window.frames;
      for (let i = 0; i < frames.length; i++) {
        try { frames[i].postMessage(payload, '*'); } catch {}
      }
    } catch {}
  }

  function newCommandId() {
    return `cmd-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }

  /**
   * Clear this frame's detections locally (same semantics as the CLEAR_BASELINE
   * panel command). Extracted so it can run on the top frame AND on sub-frames
   * when the command is relayed down.
   */
  function clearBaselineLocal() {
    clearedSession = true;
    suppressFor(3000);
    snapshotBaseline(true);
  }

  /**
   * Handle cross-frame messages. The top frame aggregates sub-frame detections;
   * every frame relays panel commands (currently just CLEAR) down the tree.
   *
   * Messages are only trusted when tagged with CP_FRAME_TAG and not sent by this
   * same window. This is local-only display/baseline coordination (no data ever
   * leaves the browser), so the lightweight tag check is sufficient.
   */
  function handleFrameMessage(event) {
    const d = event && event.data;
    if (!d || d[CP_FRAME_TAG] !== true) return;
    if (event.source === window.self) return;

    if (d.kind === 'FIELDS' || d.kind === 'GONE') {
      if (!IS_TOP_FRAME) return; // reports always go straight to the top frame
      if (typeof d.uid !== 'string') return;
      if (d.kind === 'GONE') {
        if (subFrameReports.delete(d.uid)) scheduleAggregatePush();
        return;
      }
      subFrameReports.set(d.uid, {
        dirty: Array.isArray(d.dirty) ? d.dirty : [],
        allFieldKeys: Array.isArray(d.allFieldKeys) ? d.allFieldKeys : [],
        coverage: d.coverage || { tracked: 0, total: 0, skipped: 0 },
        ts: Date.now()
      });
      scheduleAggregatePush();
      return;
    }

    if (d.kind === 'CMD') {
      if (typeof d.cmdId !== 'string' || processedCmdIds.has(d.cmdId)) return;
      processedCmdIds.add(d.cmdId);
      if (d.cmd === 'CLEAR') {
        clearBaselineLocal();
        postReportToTop('FIELDS');
      }
      // Relay further down so deeply-nested frames also receive the command.
      broadcastCommandToChildFrames(d);
    }
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

  /**
   * Scoped stylesheet for the confirm dialog. Rendered inside a Shadow DOM so
   * host-page CSS cannot leak in and break the layout or wash out the buttons.
   *
   * Every button sets its own background, text color, border, padding and font
   * explicitly (and resets `appearance`) so the Cancel button in particular is
   * always clearly visible and tappable regardless of the host page's styles,
   * in both light and dark environments.
   */
  const CONFIRM_MODAL_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .cp-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .cp-modal {
      background: #ffffff;
      color: #1f2328;
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 10px;
      padding: 20px;
      max-width: 420px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
    }
    .cp-title {
      margin: 0 0 14px 0;
      font-size: 16px;
      font-weight: 600;
      line-height: 1.3;
      color: #1f2328;
    }
    .cp-list {
      margin: 0 0 16px 0;
      padding-left: 20px;
      font-size: 13px;
      line-height: 1.5;
      color: #444c56;
    }
    .cp-list li { margin-bottom: 4px; }
    .cp-list strong { font-weight: 600; }
    .cp-was { color: #b42318; text-decoration: line-through; }
    .cp-now { color: #067647; }
    .cp-more { color: #7d8590; font-style: italic; }
    .cp-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .cp-btn {
      appearance: none;
      -webkit-appearance: none;
      margin: 0;
      min-width: 84px;
      padding: 9px 16px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      line-height: 1.2;
      text-align: center;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
    }
    .cp-btn:focus-visible {
      outline: 2px solid #0969da;
      outline-offset: 2px;
    }
    .cp-btn-cancel {
      background: #f3f4f6;
      color: #1f2328;
      border-color: #d0d7de;
    }
    .cp-btn-cancel:hover { background: #e9ebef; }
    .cp-btn-review {
      background: #ffffff;
      color: #0969da;
      border-color: #0969da;
    }
    .cp-btn-review:hover { background: #f3f8ff; }
    .cp-btn-save {
      background: #0969da;
      color: #ffffff;
      border-color: #0969da;
    }
    .cp-btn-save:hover { background: #0860c4; }
    @media (prefers-color-scheme: dark) {
      .cp-modal {
        background: #1b1f24;
        color: #e6edf3;
        border-color: rgba(255, 255, 255, 0.12);
      }
      .cp-title { color: #e6edf3; }
      .cp-list { color: #adbac7; }
      .cp-was { color: #ff7b72; }
      .cp-now { color: #3fb950; }
      .cp-more { color: #768390; }
      .cp-btn-cancel {
        background: #2d333b;
        color: #e6edf3;
        border-color: #545d68;
      }
      .cp-btn-cancel:hover { background: #363c44; }
      .cp-btn-review {
        background: #1b1f24;
        color: #58a6ff;
        border-color: #58a6ff;
      }
      .cp-btn-review:hover { background: #22272e; }
      .cp-btn-save {
        background: #2f81f7;
        color: #ffffff;
        border-color: #2f81f7;
      }
      .cp-btn-save:hover { background: #4493f8; }
    }
  `;

  function showConfirmModal(dirtyFields, onConfirm, onCancel) {
    if (modalOpen) return;
    modalOpen = true;

    // Host element + Shadow DOM isolate the dialog from host-page CSS. `all:
    // initial` on the host blocks inherited properties (color/font) from leaking
    // in, so the Cancel button can never end up washed out or mis-sized.
    const host = document.createElement('div');
    host.id = 'changepreview-overlay-host';
    host.style.setProperty('all', 'initial', 'important');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CONFIRM_MODAL_CSS;
    shadow.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'cp-overlay';

    const modal = document.createElement('div');
    modal.className = 'cp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const header = document.createElement('h3');
    header.className = 'cp-title';
    header.textContent = `You're about to save ${dirtyFields.length} change${dirtyFields.length === 1 ? '' : 's'}`;
    modal.appendChild(header);

    if (dirtyFields.length > 0) {
      const list = document.createElement('ul');
      list.className = 'cp-list';

      const maxShow = 5;
      const toShow = dirtyFields.slice(0, maxShow);

      for (const field of toShow) {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${escapeHtml(field.label)}</strong>: ` +
          `<span class="cp-was">${escapeHtml(truncate(field.was, 20))}</span> \u2192 ` +
          `<span class="cp-now">${escapeHtml(truncate(field.now, 20))}</span>`;
        list.appendChild(li);
      }

      if (dirtyFields.length > maxShow) {
        const li = document.createElement('li');
        li.className = 'cp-more';
        li.textContent = `...and ${dirtyFields.length - maxShow} more`;
        list.appendChild(li);
      }

      modal.appendChild(list);
    }

    const buttons = document.createElement('div');
    buttons.className = 'cp-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cp-btn cp-btn-cancel';
    cancelBtn.textContent = 'Cancel';

    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'cp-btn cp-btn-review';
    reviewBtn.textContent = 'Review in panel';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'cp-btn cp-btn-save';
    saveBtn.textContent = 'Save anyway';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(reviewBtn);
    buttons.appendChild(saveBtn);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    shadow.appendChild(overlay);
    document.body.appendChild(host);

    function close() {
      modalOpen = false;
      host.remove();
      document.removeEventListener('keydown', onKeydown, true);
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

    function onKeydown(e) {
      if (e.key === 'Escape') {
        close();
        onCancel();
      } else if (e.key === 'Enter') {
        close();
        onConfirm();
      }
    }
    document.addEventListener('keydown', onKeydown, true);

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

    // User turned off the confirm-on-save dialog: let the save proceed normally.
    // Detection still runs (via input/change listeners) so the panel keeps
    // showing changes for information only.
    if (!confirmOnSaveEnabled) return;
    
    // Never intercept on denylisted hosts (payment/admin dashboards)
    if (isInterceptDenylisted()) return;
    
    // Only intercept if we have an active baseline (we're actually tracking this page)
    if (baseline.size === 0) return;
    
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

      // User turned off the confirm-on-save dialog: let the submit proceed
      // normally. Detection keeps running so the panel still lists changes.
      if (!confirmOnSaveEnabled) return;
      
      // Never intercept on denylisted hosts (payment/admin dashboards)
      if (isInterceptDenylisted()) return;
      
      // Only intercept if we have an active baseline (we're actually tracking this page)
      if (baseline.size === 0) return;
      
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

  /**
   * Remove baseline entries whose element has been detached from the DOM — e.g.
   * a modal/dialog/overlay closed, or a form root was unmounted (SPA portal).
   * Returns the number pruned so the caller can refresh the panel and clear the
   * now-stale rows for that closed context.
   */
  function pruneDetachedBaseline() {
    let removed = 0;
    for (const [key, entry] of baseline) {
      const el = entry && entry.element;
      if (el && el.isConnected === false) {
        baseline.delete(key);
        removed++;
      }
    }
    return removed;
  }

  function setupMutationObserver() {
    let debounceTimer = null;
    
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const currentFieldCount = collectFields().length;
        // Large structural change (e.g. a whole form mounted) → re-baseline.
        if (Math.abs(currentFieldCount - baseline.size) > baseline.size * 0.5) {
          snapshotBaseline();
          return;
        }
        // A tracked field's element left the DOM (modal/dialog/overlay closed or
        // the form root was unmounted without a full navigation). Drop it and
        // refresh so the panel stops showing stale rows for that closed context.
        if (pruneDetachedBaseline() > 0) {
          updateBadge();
          notifyPanel();
        }
      }, 400);
    });
    
    observer.observe(document.documentElement || document.body, {
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

      // Nameless radio-groups also span multiple elements and have no single
      // element to key on; match by question-root path / label.
      if (isRadioGroupChange(change)) {
        try {
          const ok = applyRadioGroupChange(change);
          if (ok) {
            const groupEl = findRadioGroupInputs(change)?.[0] || null;
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
          console.error('Failed to apply radio group:', change.key, err);
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

    if (isRadioGroupChange(change)) {
      try {
        return applyRadioGroupChange(change);
      } catch (err) {
        console.error('Failed to apply radio group:', change.key, err);
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
    const groupKeyBase = (change.key && change.key.startsWith(prefix))
      ? change.key.slice(prefix.length)
      : change.label;
    if (!groupKeyBase) return null;

    const allCheckboxes = deepQueryAll(document, 'input[type="checkbox"]');
    for (const cb of allCheckboxes) {
      if (!cb.offsetParent) continue;
      if (shouldSkipField(cb)) continue;
      const group = getCheckboxGroupInputs(cb);
      if (!group) continue;
      // Match on either the resolved label or the stable key base (path),
      // so groups whose title can't be resolved still reapply.
      const label = getCheckboxGroupLabel(cb);
      const keyBase = getCheckboxGroupKeyBase(cb, group);
      if (label === groupKeyBase || keyBase === groupKeyBase) {
        return { container: group.root, checkboxes: group.checkboxes };
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

  function isRadioGroupChange(change) {
    return typeof change.key === 'string' && change.key.startsWith('radio-group:');
  }

  /**
   * Locate the radios for a nameless radio-group change (keyed by question-root
   * DOM path). Falls back to matching the resolved group label.
   */
  function findRadioGroupInputs(change) {
    const prefix = 'radio-group:';
    const pathOrLabel = change.key && change.key.startsWith(prefix)
      ? change.key.slice(prefix.length)
      : change.label;
    if (pathOrLabel) {
      try {
        const root = document.querySelector(pathOrLabel);
        if (root) {
          const radios = Array.from(root.querySelectorAll('input[type="radio"]'));
          if (radios.length) return radios;
        }
      } catch {}
    }
    const allRadios = deepQueryAll(document, 'input[type="radio"]');
    for (const r of allRadios) {
      if (!r.offsetParent) continue;
      if (shouldSkipField(r)) continue;
      if (getRadioGroupLabel(r) === change.label) {
        const root = getRadioRoot(r);
        if (root) return Array.from(root.querySelectorAll('input[type="radio"]'));
      }
    }
    return null;
  }

  function applyRadioGroupChange(change) {
    const radios = findRadioGroupInputs(change);
    if (!radios || radios.length === 0) return false;
    const target = String(change.now).trim();
    for (const radio of radios) {
      if (getRadioOptionLabel(radio) === target || radio.value === target) {
        return applyCheckedState(radio, true);
      }
    }
    return false;
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
        const radios = getRadioGroupInputs(el);
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
    // Only the top frame answers panel requests. If sub-frames also responded to
    // GET_FIELDS, whichever frame won the race would define the tracked identity,
    // making the displayed host flit between CDN/widget iframes. Returning false
    // (not keeping the channel open) lets the top frame's response be the one the
    // panel receives.
    if (!IS_TOP_FRAME) return false;

    switch (message.type) {
      case 'GET_FIELDS': {
        const agg = getAggregatedReport();
        sendResponse({
          host: location.hostname,
          path: location.pathname,
          dirty: agg.dirty,
          allFieldKeys: agg.allFieldKeys,
          coverage: agg.coverage
        });
        break;
      }
        
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
         *
         * Also drop any aggregated sub-frame detections and relay the clear down
         * so fields that live in iframes are cleared too (and do not re-appear on
         * the next sub-frame heartbeat).
         */
        clearBaselineLocal();
        subFrameReports.clear();
        broadcastCommandToChildFrames({
          [CP_FRAME_TAG]: true,
          kind: 'CMD',
          cmd: 'CLEAR',
          cmdId: newCommandId()
        });
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
        // Only the top document's own changes are reapplied here. Sub-frame rows
        // carry a `frame:<uid>:` key whose UID is regenerated each load, so they
        // cannot be reliably reapplied cross-frame; skip them instead of counting
        // them as failures.
        const ownChanges = (message.changes || []).filter((c) => !isFrameNamespacedKey(c.key));
        const applyResults = applyChangesWithBaseline(ownChanges);
        setTimeout(() => { applyingChanges = false; }, 500);
        sendResponse(applyResults);
        break;
        
      default:
        sendResponse({ error: 'Unknown message type' });
    }
    return true;
  });

  function init() {
    // Every frame collects fields so forms inside iframes are still detected, but
    // only the top frame talks to the panel. Sub-frames forward their detections
    // to the top frame, which aggregates them under a single top-level identity.
    window.addEventListener('message', handleFrameMessage, false);

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

    loadConfirmOnSavePref();
    setupPrefSync();

    if (IS_TOP_FRAME) {
      // Expire sub-frame detections whose frame has gone away (iframe/modal
      // removed) so their rows clear even if the frame never fired `pagehide`.
      setInterval(() => {
        if (pruneStaleSubFrames()) {
          updateBadge();
          notifyPanel();
        }
      }, FRAME_HEARTBEAT_MS);
    } else {
      // Heartbeat keeps this sub-frame's detections alive in the top frame; a
      // final GONE on teardown clears them immediately when the frame is removed.
      setInterval(() => { postReportToTop('FIELDS'); }, FRAME_HEARTBEAT_MS);
      const sayGone = () => postReportToTop('GONE');
      window.addEventListener('pagehide', sayGone, true);
      window.addEventListener('unload', sayGone, true);
      setTimeout(() => postReportToTop('FIELDS'), 400);
    }
  }

  /**
   * Test-only hook. Exposes internal label/value/apply functions to an
   * automated jsdom harness ONLY when window.__CHANGEPREVIEW_TEST__ is set.
   * This has no effect in the extension (the flag is never set in production).
   */
  if (typeof window !== 'undefined' && window.__CHANGEPREVIEW_TEST__) {
    window.__changePreviewInternals = {
      collectFields,
      getDirtyFields,
      snapshotBaseline,
      applyChangesWithBaseline,
      applyOneChange,
      getFieldLabel,
      getFieldValue,
      getFieldKey,
      cleanLabel,
      stripLeadingOrdinal,
      getRadioGroupLabel,
      getCheckboxGroupLabel,
      getSectionHeadingLabel,
      isAspNetListItem,
      isInterceptDenylisted,
      getBaseline: () => baseline,
      // Frame identity / aggregation / lifecycle hooks for tests.
      IS_TOP_FRAME,
      FRAME_UID,
      getLocalReport,
      getAggregatedReport,
      pruneDetachedBaseline,
      pruneStaleSubFrames,
      handleFrameMessage,
      clearBaselineLocal,
      getSubFrameReports: () => subFrameReports
    };
  }

  init();
})();
