# ChangePreview

**Before you save an admin form, see exactly what changed — then copy it or save with confidence.**

ChangePreview is a Chrome extension that snapshots form fields when you load a page, then shows you a clear "Field | Was | Now" diff before you hit Save. Copy the changes as Markdown or CSV for your CAB tickets, Slack threads, or Jira issues.

> Chrome Web Store listing copy (name, descriptions, category, privacy practices, pricing note) lives in [`store/chrome-web-store.md`](store/chrome-web-store.md).

## Features

- **Side panel UI** — Shows only dirty fields with old vs new values
- **Soft Save confirm** — Modal appears when you click Save/Submit/Update with pending changes
- **Confirm on save toggle** — A header checkbox turns the save/submit confirmation dialog off; change detection and the side panel keep working for information only
- **Copy Markdown / CSV** — One-click export for change documentation
- **Coverage meter** — Honest about what fields are being tracked
- **Privacy-first** — All data stays local; passwords and sensitive fields are skipped
- **Dark mode** — Follows your OS preference

## Installation (Load Unpacked)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the repository folder (the one containing `manifest.json`)
6. The ChangePreview icon (Δ) should appear in your toolbar

## Usage

1. Navigate to any form-based page (or open `fixtures/plain-admin.html` for testing)
2. The extension automatically snapshots all visible form fields
3. Make changes to the form
4. The badge shows the number of changed fields
5. Click the extension icon (or press `Alt+Shift+C`) to open the side panel
6. Review changes in the "Field | Was | Now" table
7. Click **Copy Markdown** or **Copy CSV** to export
8. When you click Save/Submit, a confirmation modal shows what's about to change

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
- **Custom widgets** — Non-standard form widgets (custom React/Vue components that don't use native inputs) may not be detected
- **Async loading** — If form values are populated after page load, the baseline may be incomplete. Use the "Re-snapshot" button to capture the current state.
- **Form builder variations** — While tested with Microsoft Forms and Google Forms patterns, some form builders may use unique DOM structures that aren't recognized.

The extension uses fail-soft behavior: when it can't track everything, it tells you what it can track rather than claiming false coverage.

## Permissions

- `activeTab` — Access the current tab to read form fields
- `storage` — Store settings locally
- `sidePanel` — Display the side panel UI

No network permissions required.

## Development

This is a Manifest V3 Chrome extension. The structure is:

```
├── manifest.json       # Extension manifest
├── background.js       # Service worker
├── content/
│   └── content.js      # Content script (field detection, save intercept)
├── panel/
│   ├── panel.html      # Side panel markup
│   ├── panel.css       # Side panel styles
│   └── panel.js        # Side panel logic
├── icons/              # Extension icons
└── fixtures/
    ├── plain-admin.html         # Basic admin settings test page
    ├── ms-forms-like.html       # Microsoft Forms-like test page
    ├── submit-validation.html   # Submit vs. validation test page
    └── aspnet-checkboxlist.html # ASP.NET CheckBoxList/RadioButtonList test page
```

## Paid Unlock

ChangePreview is **free to install**. Preview mode (seeing what changed) works without a license.

**Full features require a €9.99 one-time purchase:**
- Keep changes after reload
- Reapply saved changes
- Clear detections
- Export to Markdown & CSV

The purchase is handled via Stripe, sold by **NextGen Folks** (not Google).

### License API

The license server is a Cloudflare Worker in the `worker/` directory. See [`worker/README.md`](worker/README.md) for deployment instructions.

**Required setup for deployment:**
1. Create Cloudflare KV namespace
2. Set secrets:
   - `STRIPE_SECRET_KEY` — Stripe API key
   - `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
   - `ENGINEMAILER_API_KEY` — Enginemailer API key for license emails
3. Deploy with `wrangler deploy`
4. Create Stripe Payment Link (€9.99 one-time)
5. Configure Stripe webhook to point to `/stripe/webhook`
6. Update `panel/config.js` with your worker URL and Payment Link URL

## License

MIT
