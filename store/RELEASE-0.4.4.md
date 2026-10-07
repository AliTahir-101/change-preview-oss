# ChangePreview 0.4.4

- Automatically tracks form edits on permitted HTTP/HTTPS pages before the panel opens.
- Repairs toolbar startup and handles retired extension contexts after updates.
- Refines the header, page URL help, above-control tooltips, and themed scrollbar.
- Uses explicit copy buttons and numbered field-location buttons; text remains selectable.
- Prevents downloads, window-focus returns, and setting changes from falsely offering Reapply.
- Keeps saved-change recovery after a real reload.
- Updates the listing, privacy disclosures, permission justifications, and reviewer instructions.

Validation: all 11 automated suites pass; the user verified the extension in Chrome. The ZIP includes only the 11 runtime files from the canonical shipping list.

For an unpacked update, reload the extension and refresh previously open form pages before testing. Chrome Web Store review is separate from this GitHub release; this release does not indicate store approval.
