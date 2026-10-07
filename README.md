# ChangePreview

**Before you save an admin form, see exactly what changed — then copy it or save with confidence.**

ChangePreview is a Chrome extension that snapshots form fields when you load a page, then shows you a clear "Field | Was | Now" diff before you hit Save. Copy the changes as Markdown or CSV for your CAB tickets, Slack threads, or Jira issues.

> Chrome Web Store listing copy (name, descriptions, category, privacy practices, free / IAP = No) lives in [`store/chrome-web-store.md`](store/chrome-web-store.md).

ChangePreview is **free**. Every feature works with no license key, Buy button, or payment.

## Features

- **Side panel UI** — Shows only dirty fields with old vs new values
- **Soft Save confirm** — Modal appears when you click Save/Submit/Update with pending changes
- **Confirm on save toggle** — A header checkbox turns the save/submit confirmation dialog off; change detection and the side panel keep working for information only
- **Click to locate** — Click the numbered button beside a change to scroll to and briefly highlight that control on the page (works in same-origin frames too). Use the copy buttons for field names and Was/Now values; text stays selectable
- **Copy Markdown / CSV** — One-click export for change documentation
- **Coverage meter** — Honest about what fields are being tracked
- **Privacy-first** — All data stays local; passwords and sensitive fields are skipped
- **Dark mode** — Follows your OS preference
- **Discreet credit** — Side-panel footer: “Made with ♥ by NextGen Folks”, linking to the products section on nextgenfolks.com

## Installation (Load Unpacked)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the repository folder (the one containing `manifest.json`)
6. The ChangePreview icon (Δ) should appear in your toolbar

To build a zip or a `change-preview-release/stage` folder, run `npm run stage` and pack `dist/extension`. Do **not** copy only `manifest.json`, `background.js`, `content/`, `panel/`, and `icons/` — `panel/panel.js` imports `ensure-content-script.js` from the repo root. The service worker (`background.js`) is a classic script with **no** `import` and **no** `background.type: module`; keep it. Omitting the helper file still breaks the side panel.

## Usage

1. Navigate to any form-based page (or open `fixtures/plain-admin.html` for testing)
2. The extension automatically snapshots visible form fields on permitted web pages
3. Make changes to the form; the panel does not need to be open
4. The badge shows the number of changed fields
5. Open the side panel with the toolbar icon (or `Alt+Shift+C`) whenever you want to review
6. Review changes in the "Field | Was | Now" table
7. Click **Copy Markdown** or **Copy CSV** to export
8. When you click Save/Submit, a confirmation modal shows what's about to change

Automatic tracking runs on HTTP/HTTPS pages where Chrome grants site access, including matching frames and fresh navigations. Set Chrome site access to all sites for automatic tracking throughout normal browsing, or choose specific sites. Restricted browser pages cannot be tracked. After updating the extension, refresh already-open pages before editing. Local file URLs are not included; serve fixtures over localhost.

## Test Fixtures

Two test pages are included:

### `fixtures/plain-admin.html` — Basic Admin Settings
A traditional admin settings page with standard form fields.

### `fixtures/submit-validation.html` — Submit vs. validation
A profile form with a **required** email field. Use it to verify that a *failed*
submit (required field empty → HTML5 validation keeps you on the form) does **not**
wipe detections, while a *successful* submit (valid field → the form is replaced by
a thank-you message, simulating real success) clears them. Turn **Keep** on first to
confirm Keep-after-reload storage also survives a failed submit.

### `fixtures/ms-forms-like.html` — Microsoft Forms-like
Mimics Microsoft Forms' DOM structure to test label resolution. Verifies that:
- Question titles like "What is your name?" are used as labels
- Generic type indicators like "Multi-line text" are ignored
- Radio option values like "Three by one" don't become field labels
- **Apartment Yes/No (real MS Forms Choice)** — the question title is a plain
  styled `<span>` (no `question-title` class, no heading role) and the Yes/No
  radios are clickable cards. Field must be the full question; Was/Now = Yes/No.
- **House type (card checkboxes)** — a multi-select rendered as clickable cards
  whose checkboxes don't share a `name`. Field must be "House type"; Was/Now =
  the selected option labels (never bare Checked/Unchecked).

### `fixtures/aspnet-checkboxlist.html` — ASP.NET WebForms CheckBoxList / RadioButtonList
Reproduces the portable structural pattern used by ASP.NET WebForms (and similar
admin UIs): the list renders as a `<table>` whose id is referenced by a section
heading `<h2><label class="control-label" for="<listId>">`, each option has its
own unique id/name (`…_0`/`…$0`, `…_1`/`…$1`), and options do **not** share a
name for a CheckBoxList. Verifies that:
- **Independent checkboxes** stay one row per box (Was/Now = Unchecked/Checked),
  never folded into a single comma-joined multi-select group.
- The checkbox **Field** combines the section heading and option text, e.g.
  `House type · Block of flats` — not just `Block of flats`.
- **RadioButtonList** (options share a `name`) collapses to one row whose Field
  is the full section question and whose Was/Now are the option labels (Yes/No).
- Detection is **structural** (section label `for` → list/table id, `divContainer_*`
  / Bootstrap form-group wrappers) — no site, product, or language names.

### Automated harness

`tests/label-resolution.test.mjs` runs `content/content.js` inside jsdom against
the fixtures and asserts the above (plus that Reapply restores the correct
checks). Run it with:

```bash
npm install
npm test
```

**To test:**
1. Open the fixture file in Chrome (`file:///path/to/fixtures/ms-forms-like.html`)
2. Make some changes (edit text, select different radio options, toggle checkboxes)
3. Open the side panel (click icon or `Alt+Shift+C`)
4. Verify labels show the question text, not type indicators or option values
5. Click "Submit" to see the confirmation modal
6. Copy the Markdown and paste it somewhere to verify the format

## Sample Markdown Output

```markdown
## Change pack — localhost/settings — 10/07/2026, 12:30 PM EEST

| Field | Was | Now |
|-------|-----|-----|
| Organization name | Acme Corp | Acme Industries |
| Session timeout | 30 | 60 |
| Default language | English | Finnish |
| Require two-factor authentication | Unchecked | Checked |

_Generated by ChangePreview · not yet saved_
```

## Privacy

- **Local only** — Field values never leave your browser
- **No accounts** — Works immediately, no sign-up required
- **No analytics** — We don't track what you type
- **Sensitive fields skipped** — Passwords, credit card fields, tokens, and other sensitive inputs are automatically ignored

## Label Resolution

The extension uses a sophisticated label resolution algorithm to find the human-readable question/field name:

**Priority order:**
1. **Question container title** — Looks for `.question-title`, `[role="heading"]`, `legend`, and similar patterns used by form builders (Microsoft Forms, Google Forms, etc.)
2. **Fieldset legend** — For grouped fields
3. **Associated `<label>`** — Via `for` attribute or wrapping label
4. **ARIA labels** — `aria-labelledby` (resolved to visible text), `aria-label`
5. **Nearby heading/text** — Previous siblings that look like labels
6. **Humanized name/id** — `billing_email` → "Billing Email"
7. **Placeholder** — Only as last resort, prefixed with "(placeholder)"

**What it avoids:**
- Generic type strings like "Multi-line text", "Choice", "Dropdown" are never used as labels
- Option values (e.g., "Three by one") are never used as the field name — they belong in Was/Now only
- For radio/checkbox groups, the question text is the label, and selected options are the values

## Known Limitations

- **Shadow DOM** — Fields inside closed Shadow DOM roots (e.g., some Salesforce Lightning components) cannot be accessed. The coverage meter shows partial coverage when this occurs.
- **Iframes** — The tracked URL, badge, and save-confirm identity are always driven by the real top-level page, so the tracked identity stays on the page host instead of hopping to a sub-frame/CDN URL. Forms rendered inside same-origin iframes (e.g. dashboard panels/overlays) are still detected: each frame reports its fields up to the top frame, which aggregates them under the top-level identity. Cross-origin iframes remain inaccessible to the content script and cannot be tracked.
- **Page identity for Keep/Reapply** — Detections are stored per *form page*, keyed on the canonical full URL (origin + path + meaningful query) with the hash (`#…`) and common tracking params (`utm_*`, `gclid`, `fbclid`, …) stripped. So the same form survives different campaign/share links, while two different forms on the same domain (e.g. two Tally forms, or `?formId=123` vs `?formId=456`) stay separate. Keep holds **one snapshot per canonical page** — fingerprint/legacy host+path siblings and remounted-iframe `frame:<uid>:` copies of the same field are collapsed on save/restore so a reload cannot stack duplicate rows. After reload the restored snapshot **stays on screen**: live scans (empty baseline, hydration dirty, URL query settling) cannot flash-then-clear it; only a trusted user edit, Clear, Keep-off, or a real navigation to a different path/form ends restore. The side-panel header still shows a short host for readability. One consequence: single-page apps that distinguish routes **only** by the URL hash (`example.com/app#/form/1` vs `#/form/2`) share one identity, since the hash is stripped. Apps that change the path or a query param on navigation are keyed separately as expected.
- **Custom widgets** — Non-standard form widgets (custom React/Vue components that don't use native inputs) may not be detected
- **Async loading** — If form values are populated after page load, the baseline may be incomplete. Use the "Re-snapshot" button to capture the current state.
- **Form builder variations** — While tested with Microsoft Forms and Google Forms patterns, some form builders may use unique DOM structures that aren't recognized.

The extension uses fail-soft behavior: when it can't track everything, it tells you what it can track rather than claiming false coverage.

## Permissions

- `activeTab` — Access the current tab after you click the icon / shortcut
- `scripting` — Inject `content/content.js` into that tab (all frames) on demand
- `storage` — Store settings locally
- `sidePanel` — Display the side panel UI

Automatic `content_scripts` match HTTP/HTTPS pages and require Chrome site access. This is broad website access even though there is no separate `host_permissions` key. It is needed to capture original values before the first edit without a toolbar click. Data remains local. The toolbar injection helper is only a fallback.

## Development

This is a Manifest V3 Chrome extension. The structure is:

```
├── manifest.json              # Extension manifest (automatic HTTP(S) content scripts)
├── background.js              # Classic MV3 service worker (no import; helper inlined)
├── ensure-content-script.js   # Panel ES module — MUST be in every zip / unpacked load
├── content/
│   └── content.js             # Content script (automatic page-load tracking, all frames)
├── panel/
│   ├── panel.html      # Side panel markup
│   ├── panel.css       # Side panel styles
│   └── panel.js        # Side panel logic
├── icons/              # Extension icons
├── scripts/
│   ├── extension-files.mjs    # Canonical ship list (includes ensure-content-script.js)
│   └── stage-extension.mjs    # Copies the ship list to dist/extension
└── fixtures/
    ├── plain-admin.html         # Basic admin settings test page
    ├── ms-forms-like.html       # Microsoft Forms-like test page
    ├── submit-validation.html   # Submit vs. validation test page
    └── aspnet-checkboxlist.html # ASP.NET CheckBoxList/RadioButtonList test page
```

## Free

ChangePreview is fully free. There is no payment, license key, unlock screen, or in-app purchase. Keep after reload, Reapply, Clear, export, click-to-highlight, and Confirm on save all work as soon as you load the extension.

The `worker/` directory is **legacy / unused**. It is leftover Stripe + Cloudflare Worker license-API code kept as archived reference. The shipped extension does not call it.

## License

MIT

## 0.4.4 automatic tracking restored

Version 0.4.1 removed automatic page-load tracking, making it impossible to compare edits made before a toolbar click. Static HTTP/HTTPS content scripts now capture baselines and detect edits with the panel closed, including on fresh navigations and in matching frames. The 0.4.3 toolbar startup fixes remain as a fallback. Opening the panel does not reset an existing baseline.

After updating an unpacked installation, reload ChangePreview in `chrome://extensions`, approve the site access requested by Chrome, and refresh existing pages before editing. Keep the panel closed, edit a field, then open it or click Save to review the captured change.

## 0.4.5 tab-switch recovery fix

The page tracker now remembers a live editing session across tab/window switches and after undo. Returning to an unchanged document no longer offers Reapply for edits already on the form. A genuine reload creates a fresh tracker and retains saved-change recovery. Reload the extension and refresh existing pages after updating.
