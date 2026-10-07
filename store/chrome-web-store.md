# Chrome Web Store listing — ChangePreview

Ready-to-paste fields for the Chrome Web Store (CWS) developer dashboard. CWS strips
Markdown from the description fields, so the "Detailed description" below is written as
plain text with line breaks only. Copy the sections into the matching dashboard fields.

---

## Extension name

ChangePreview

---

## Short description (≤132 characters)

Identical to the `description` field in `manifest.json`:

```
Review form changes before you save. Compare old and new values, recover saved edits after a refresh, and export your changes.
```

(126 characters.)

---

## Detailed description (paste as plain text)

Changed several fields and lost track of what you edited?

ChangePreview gives you a second look before you save. It shows the original value next to your new value, so you can review changes without searching through a long form or trying to remember what was there before.

Useful when you are:
- Entering or checking information in application forms.
- Updating customer contact details or support records.
- Changing order details or admin settings.
- Testing a form and recording what you changed.

Work normally. Review when you are ready.
On websites you allow, ChangePreview starts when the page loads. You do not need to click the extension icon before making edits. Open the side panel whenever you want to see your change list. With Confirm on save enabled, supported Save/Submit actions also show a review dialog.

What you can do:
- Compare old and new values in a clear Was / Now table.
- Click the numbered button beside a change to find and highlight its field on the page. Copy field names and values with their copy buttons.
- Turn on Keep after reload to save edits locally, then use Reapply my changes on compatible forms after a refresh.
- Clear the current page's change list to start a fresh comparison.
- Copy or download changes as Markdown or CSV for a support ticket, spreadsheet, or handover.

Getting started:
1. Allow site access in Chrome. Choose all sites or only the sites you use.
2. Load or refresh your form page, then make your edits.
3. Open ChangePreview to review them before saving.

Free, with your form data kept on your device.
No account, subscription, license key, or in-app purchase is required. Form values are processed locally, with no uploads or analytics. Keep after reload stores saved changes in your browser. Website access is needed to capture original values before you edit them; you control that access in Chrome.

Works with many standard web forms.
Some custom controls, restricted browser pages, closed Shadow DOM, and frames without site access cannot be read. Save confirmation does not work with every custom submission flow. Changes made before tracking started cannot be reconstructed. Password fields and fields recognized as sensitive are skipped, but sensitive information in a general text field may not be recognized. Always review important edits before submitting.

Built by NextGen Folks.
Support: info@nextgenfolks.com
Privacy: https://nextgenfolks.com/privacy

---

## Suggested category

Productivity

---

## Suggested language

English

---

## Keyword guidance

Use these as natural, in-context phrases in the description and listing — not as a
keyword list, and without repeating any single word more than ~5 times:

- data entry / data-entry forms
- form editing and form changes
- admin forms and settings pages
- change review before saving
- local privacy / stays on your device

The detailed description above already weaves these in naturally. Avoid keyword-stuffed
blocks; CWS can reject listings for keyword spam.

---

## Single-purpose statement (for the CWS dashboard)

ChangePreview lets you preview and export the changes you made to a web form before you
save, keeping all data local to your browser.

---

## Pricing / IAP (for the CWS dashboard)

- Price: Free
- Contains in-app purchases: **No**

Do not mark this listing as paid and do not enable Chrome Web Store IAP. There is
no Buy button, license key, or payment flow in the extension.

---

## Privacy practices summary (for the CWS dashboard)

Use these bullets when completing the dashboard's privacy / data-use disclosures:

- Local storage only: change detections and settings are stored with
  chrome.storage.local on the user's device.
- No remote collection: the extension does not transmit form values or any personal
  data to NextGen Folks or any third party. It makes no license or payment API calls.
- No analytics or tracking, and no user accounts.
- Sensitive data minimization: password fields and fields recognized by the extension as sensitive are skipped.
  General text fields may contain sensitive information that cannot be identified automatically.
- Permissions support automatic form tracking and the review panel: activeTab, scripting, storage, sidePanel. Static content scripts automatically run on permitted HTTP/HTTPS pages to capture original values before editing. The toolbar provides a fallback for pages already open during an extension update.

Single purpose (dashboard): see the Single-purpose statement above.

---

## Host permission justification (CWS dashboard)

ChangePreview needs access to HTTP and HTTPS pages to automatically capture original form values when a page loads, detect subsequent edits, and show a local Was/Now comparison before Save/Submit. Waiting for a toolbar click would miss original values and defeat this core feature. Forms may appear on arbitrary websites and within frames, so the content-script match patterns cover HTTP/HTTPS sites. Chrome site-access controls let users restrict this to chosen sites. Password and other recognized sensitive fields are skipped. Form values are processed locally; this functionality does not transmit them to a server.

The manifest has no separate `host_permissions` key, but its broad `content_scripts.matches` patterns still request website access and must be disclosed. Do not describe this release as activeTab-only.

---

## Packaging the CWS zip / unpacked stage folder

**Pitfall (0.4.1):** a copy of only `manifest.json`, `background.js`, `content/`,
`panel/`, and `icons/` omits `ensure-content-script.js`. `panel/panel.js` imports
that root ES module. Include it in every zip / unpacked stage folder.

**Service worker (0.4.2):** `background.js` is a **classic** script. Do not set
`background.type` to `"module"` and do not `import` from the worker. A module
worker that cannot fetch a static import shows “An unknown error occurred when
fetching the script”. MV3 still requires `background.js` — do not remove it.

Ship every file listed in `scripts/extension-files.mjs` (`SHIP_ROOT_FILES` +
`SHIP_DIRS`). From this repo:

```
npm run stage
```

That copies the complete package to `dist/extension` (ready to zip or to point
Load unpacked at). Confirm `ensure-content-script.js` sits next to `background.js`
in the staged tree before zipping.

Do not include `tests/`, `fixtures/`, `worker/`, `node_modules/`, or docs in the
store zip.

Support / feedback contact: info@nextgenfolks.com

---

## Store URLs

| Field | URL |
|-------|-----|
| Homepage | https://nextgenfolks.com/products/change-preview |
| Support | mailto:info@nextgenfolks.com |
| Privacy Policy | https://nextgenfolks.com/privacy |

## Release 0.4.5

Automatic HTTP/HTTPS page-load tracking is restored. The panel need not be opened before editing. Toolbar fallback and packaging fixes remain. Automated regression suites pass; Ali confirmed live behavior. The upload directory contains versioned package, detailed description, permission justifications, and reviewer test instructions. The corrected website privacy policy is live. Header, tooltips, explicit copy controls, and Keep/reload regressions are covered in this release.
