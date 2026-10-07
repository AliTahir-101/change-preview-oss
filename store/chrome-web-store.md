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
See form changes before you save: compare Was vs Now, export to Markdown or CSV, keep edits locally. Private, nothing uploaded.
```

(127 characters.)

---

## Detailed description (paste as plain text)

ChangePreview shows you exactly what you changed on a web form before you hit Save.

It opens a side panel that lists every edited field in a simple table — number, Field,
Was, and Now — so you can review your edits at a glance instead of scrolling back
through a long form trying to remember what you touched.

Who it's for:

- Data-entry and operations people who fill in long or repetitive forms
- Anyone who edits large admin or settings pages and wants a second look before saving
- People working in sensitive admin forms who need to double-check every change

What you can do:

- Preview changes: see a clear Was vs Now comparison of only the fields you edited,
  before you submit.
- Keep detections after a reload, then "Reapply my changes" to recover your edits after
  an accidental refresh or a failed submit — so you don't have to retype everything.
- Clear detections whenever you want a fresh baseline.
- Export your change list: copy or download it as Markdown or CSV for tickets, reviews,
  or your own records.
- Stay private: everything is stored locally in your browser. Nothing is uploaded, and
  password and other sensitive fields are skipped.

Where it works:

ChangePreview is built to work across many standard HTML and admin forms, including
Microsoft Forms–style layouts and ASP.NET CheckBoxList-style controls. It is not
guaranteed to work on every form — some sites use custom widgets, closed Shadow DOM,
or cross-origin iframes that it can't read. When it can't track everything, it tells
you rather than pretending it captured more than it did. Please treat coverage with a
healthy grain of salt and verify important changes before saving.

Pricing:

Free to install. Preview mode shows you what changed at no cost. Full features require
a €9.99 one-time purchase via Stripe. This unlocks Keep after reload, Reapply changes,
Clear detections, and Export to Markdown or CSV. The purchase is handled outside the
extension through Stripe — NextGen Folks is the seller, not Google.

Privacy:

Your data stays on your device. ChangePreview uses local browser storage only
(chrome.storage.local). It does not send your field values anywhere, has no accounts,
and does no remote tracking. Passwords and sensitive fields are intentionally skipped.
License activation requests are sent to our license server, but no form data is included.

Built by NextGen Folks. Questions or feedback? Email info@nextgenfolks.com.

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

## Pricing note

Intended price: €9.99 EUR, one-time, via Stripe Payment Link (not Chrome Web Store payments).

The purchase is handled outside the extension through Stripe. NextGen Folks is the
seller, not Google. This is disclosed in the detailed description above.

Features gated behind the paid unlock:
- Keep detections after reload
- Reapply saved changes
- Clear detections
- Export to Markdown & CSV

Free features (always available):
- Preview Was vs Now changes
- Save confirmation modal
- Dark mode

---

## Privacy practices summary (for the CWS dashboard)

Use these bullets when completing the dashboard's privacy / data-use disclosures:

- Local storage only: change detections and settings are stored with
  chrome.storage.local on the user's device.
- No remote collection: the extension does not transmit form values or any personal
  data to NextGen Folks or any third party.
- License activation: when activating a license key, the extension sends only the
  license key and a random instance ID to our license server. No form data is included.
- No analytics or tracking, and no user accounts (beyond optional license activation).
- Sensitive data minimization: password and other sensitive fields are skipped and not
  recorded.
- Permissions are limited to what's needed to read the current form and show the panel
  (activeTab, storage, sidePanel); host_permissions for redacted.example.invalid is used only for
  license activation/validation.

Single purpose (dashboard): see the Single-purpose statement above.

Support / feedback contact: info@nextgenfolks.com

---

## Store URLs

| Field | URL |
|-------|-----|
| Homepage | https://nextgenfolks.com/products/change-preview |
| Support | mailto:info@nextgenfolks.com |
| Privacy Policy | https://nextgenfolks.com/privacy |
