# Changelog

All notable changes to GG Buddy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [2.3.0] - 2025-03-09

### Added

- **Wishlist support for Steam and Epic** — Import games from your Steam and Epic Games Store wishlists into GG Buddy’s deal tracker; detect wishlisted games on store pages and add them to your list in one click.
- **Internationalization (i18n)** — The extension UI now supports 18 languages. The popup, settings, and all user-facing strings use Chrome’s built-in locale system and follow the browser’s language when available.
  - **Locales:** Czech (cs), Danish (da), German (de), English (en), Spanish (es), Finnish (fi), French (fr), Italian (it), Japanese (ja), Korean (ko), Norwegian (no), Polish (pl), Portuguese – Brazil (pt_BR), Russian (ru), Swedish (sv), Ukrainian (uk), Chinese Simplified (zh_CN).
- Manifest `default_locale` set to `en` for consistent behavior across locales.

### Changed

- Extension name and description are now localized via `_locales/*/messages.json` (e.g. “GG Buddy (Beta)” and store description).
- Popup HTML uses `data-i18n` and `data-i18n-placeholder` for translatable labels and placeholders.
- Background, content, and popup scripts use `chrome.i18n.getMessage()` for dynamic strings (notifications, toasts, errors, etc.).

### Technical

- New `_locales/<locale>/messages.json` files with shared message keys and placeholders for counts, prices, and labels.

---

## [2.2.0] - (beta)

- Previous beta release (feature updates and fixes leading to 2.3.0).

---

## [2.1.0]

- Auto-detection on multiple store pages.
- Inline price overlay, deal scores, wishlist, alerts, bundle finder.
- Themes (Light/Dark/OLED/System), accent colors, compact mode.
- Cross-device sync via Chrome storage.

[2.3.0]: https://github.com/ggbuddy/GameDealFinder/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/ggbuddy/GameDealFinder/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/ggbuddy/GameDealFinder/releases/tag/v2.1.0
