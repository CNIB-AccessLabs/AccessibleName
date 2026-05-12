# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-11

Initial release.

### Added

- Bookmarklet (`bookmarklet/a11y-names.html`) — drag-to-install, fully self-contained, no network calls. Walks the top document and same-origin iframes plus open shadow roots.
- Firefox WebExtension (`firefox-extension/`) — MV3, uses `scripting.executeScript` with `allFrames: true` to run the scanner in every frame regardless of origin. Aggregates results in a single panel rendered in the top frame.
- Chrome / Edge / Brave WebExtension (`chrome-extension/`) — MV3 service worker variant. Byte-identical `background.js` to the Firefox version.
- Implements the common path of the W3C Accessible Name and Description Computation 1.2.
- Selector covers `a[href]`, `button`, `input` (non-hidden), `select`, `textarea`, `summary`, `details`, `[tabindex]` ≥ 0, `[contenteditable]`, `[onclick]`, and elements with interactive ARIA roles.
- Output: on-page badges, floating panel, console `console.table`, and Markdown table on clipboard for pasting into notebooks or bug reports.
