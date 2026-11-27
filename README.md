# ChangePreview

Review form changes before you save. ChangePreview is a browser extension that snapshots the fields on a page while you edit, then shows a clear "Was / Now" comparison so you can check your work before you hit Save. You can recover edits after a refresh and export the comparison as Markdown or CSV.

ChangePreview is free. There is no subscription, license key, unlock screen, or in-app purchase. Form values are processed locally in your browser and are never uploaded to the developer or any third party.

This repository holds the open-source Chrome (Manifest V3) source for ChangePreview, published by [NextGen Folks](https://nextgenfolks.com).

## Install

ChangePreview is published on both major stores:

- Chrome Web Store: https://chromewebstore.google.com/detail/changepreview/pnpkfgjcmmhhpnfbfeoakpbgoecifedm
- Firefox Add-ons (AMO): https://addons.mozilla.org/en-US/firefox/addon/changepreview/

The store builds are the easiest way to use ChangePreview. To run this source directly, see [Build and run from source](#build-and-run-from-source).

## What it does

You edit several fields on an admin page, a customer record, or an application form, and lose track of what you changed. ChangePreview keeps the original value beside your new value, so you can review every change in one place before saving.

On sites you allow in the browser, tracking starts when the page loads, even with the side panel closed. Open the panel when you want to review, or enable Confirm on save to get a review dialog when you click a supported Save or Submit control.

## Features

- Was / Now table: compare field names, original values, and current values at a glance.
- Click to locate: use the numbered button beside a change to scroll to and briefly highlight that control on the page, including same-origin frames.
- Copy and export: copy a single field name or value, or export the whole comparison as Markdown or CSV for a ticket, chat thread, or issue tracker.
- Keep after reload and Reapply: optionally store your changes on this device, then review or reapply them on compatible forms after a refresh.
- Confirm on save: an optional dialog that shows pending changes when you click Save or Submit. It can be turned off while change detection keeps working for information only.
- Coverage meter: an honest view of which fields are being tracked rather than a false claim of full coverage.
- Smart label resolution: resolves human-readable field names from form-builder markup (Microsoft Forms, Google Forms, ASP.NET WebForms, and similar), and avoids generic type strings or option values as labels.
- Privacy first: all data stays local, and passwords and recognized sensitive fields are skipped.
- Dark mode: follows your operating system preference.

## Privacy

- Local only: field values never leave your browser.
- No account: ChangePreview works immediately, with no sign-up.
- No analytics: there is no tracking of what you type and no upload of form contents.
- Sensitive fields skipped: password fields and recognized sensitive inputs are ignored.
- No license or payment code: this open-source version contains no license, unlock, or payment logic of any kind. Every feature is available immediately.

Full privacy policy: https://nextgenfolks.com/privacy

Note: forms can contain personal or sensitive information. Sensitive content in ordinary (non-password) fields may still be processed locally so it can be compared. Limit the extension's site access to the sites where you actually want to use it, and review important changes before submitting.

## Build and run from source

ChangePreview is a Manifest V3 extension and ships as plain JavaScript, so there is no bundler step for the extension itself.

### Load unpacked (development)

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable Developer mode (toggle in the top right).
4. Click Load unpacked.
5. Select the repository folder (the one containing `manifest.json`).
6. The ChangePreview icon appears in your toolbar.

Important: load the whole repository folder. Do not copy only `manifest.json`, `background.js`, `content/`, `panel/`, and `icons/`. The side panel (`panel/panel.js`) imports `ensure-content-script.js` from the repository root, and omitting that helper breaks the panel. The service worker (`background.js`) is a classic script with no `import` and no `background.type: module`; keep it as is.

### Build a packaged folder or zip

```bash
npm install
npm run stage
```

This copies the canonical ship list into `dist/extension`, which you can load unpacked or zip for distribution.

### Run the tests

```bash
npm install
npm test
```

The test suite runs `content/content.js` inside jsdom against the fixtures in `fixtures/` and verifies label resolution, keep and restore behavior, save confirmation, frame identity, and the packaging rules.

## Project structure

```
manifest.json              Extension manifest (automatic HTTP/HTTPS content scripts)
background.js              Classic MV3 service worker (no import; helper inlined)
ensure-content-script.js   Panel helper module; must be present in every unpacked load or zip
content/content.js         Content script (automatic page-load tracking, all frames)
panel/                     Side panel markup, styles, and logic
icons/                     Extension icons
scripts/                   Canonical ship list and the staging script
fixtures/                  Standalone HTML pages used by the tests
tests/                     Automated jsdom test suite
store/                     Store listing copy and reviewer notes
```

## Permissions

- `activeTab`: access the current tab after you click the icon or press the shortcut.
- `scripting`: inject the content script into the active tab on demand.
- `storage`: store settings and optional Keep snapshots locally.
- `sidePanel`: display the side panel interface.

The automatic content scripts match HTTP and HTTPS pages and require browser site access. This is broad site access, granted so original values can be captured before your first edit without a toolbar click. All captured data stays local.

## Contributing

Contributions are welcome. To propose a change:

1. Fork the repository and create a feature branch.
2. Make your change and add or update tests under `tests/` where it makes sense.
3. Run `npm test` and confirm the suite passes.
4. Open a pull request with a clear description of the change and the reason for it.

For bugs and feature ideas, please open an issue with steps to reproduce or a short description of the use case. Keep the extension free of license, payment, and tracking code: this version is intentionally free and local only.

## License

Released under the MIT License. See [LICENSE](LICENSE) for the full text.

## About NextGen Folks

ChangePreview is built and published by [NextGen Folks](https://nextgenfolks.com), a Jyväskylä-based software company that builds practical AI products and software, operated by Ali Tahir as a private entrepreneur in Finland.

- Website: https://nextgenfolks.com
- Support: info@nextgenfolks.com
