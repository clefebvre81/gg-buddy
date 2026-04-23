# Changelog

All notable changes to GG Buddy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [2.6.2] - 2026-04-23

### Changed

- **Support link** — Buy Me a Coffee now points to `https://buymeacoffee.com/gg.buddy`.

---

## [2.6.1] - 2026-04-22

### Fixed

- **Bundle Store Normalization** — Active Bundles store filters now correctly group title variants under canonical stores (for example, Fanatical "Build/BundleFest" and Humble variants like "Humble Choice"/promo names all map to the right store).
- **Changelog Viewer UX** — The Settings changelog action now opens an in-extension viewer page instead of navigating directly to the raw Markdown file.

---

## [2.6.0] - 2026-04-22

### Added

- **Historical-Low Price Alerts** — Wishlist "Alert below" now auto-fills with the game's historical low (retail-only when Official Stores Only is enabled, otherwise the lowest of retail/keyshop) in the currency of your selected region, and fires when the current best price is _at or below_ that threshold.
- **Alert Currency Safety** — Custom alert thresholds now show a mismatch warning and auto-convert when your selected region/currency changes.
- **Custom Game Images** — You can set or reset a custom image per game from wishlist details, and that override is used consistently across all card views that render that game image.
- **Bundles Filters & Sorting** — The Active Bundles tab now supports filtering by store (e.g., Fanatical, Humble) and sorting by ending soon, price (low/high), or title.
- **Wishlist Bundle Callout** — Expanded wishlist details now show a bundle callout that checks active bundles for the game and flags when a bundle tier is cheaper than the game's current best standalone price.
- **Settings Changelog Button** — Added a Maintenance action to open and view `CHANGELOG.md` directly from the extension.

### Changed

- **Popup Tab Stability** — Improved tab bar behavior on constrained popup widths to avoid clipping/flicker while preserving icon+label mode whenever it fits.

---

## [2.5.0]

### Added

- **Historical Price Charts** — Added SVG sparkline charts directly into the popup dashboard to verify if a deal is an actual historical low.
- **Bundle Savings Calculator** — Now actively calculates and highlights how much you're saving in a bundle vs individual game prices on keyshops or retail.
- **Official Stores Only** — A highly requested setting! Enable this in preferences to completely ignore grey-market keyshops in price calculations, alerts, and dashboard info.
- **Export Wishlist** — Easily copy your entire wishlist and known prices to your clipboard for sharing with friends.
- **Legitimacy Nudge** — For users tracking game prices, GG Buddy now introduces a "Buy Legit" banner when visiting popular piracy sites if the game is found to be exceptionally cheap on official or trusted stores to encourage supporting developers.

### Technical

- **Code Modularization** — Refactored massive frontend script monolithic blocks into modular configurations (e.g., extracted all hardcoded DOM selectors).

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

[2.6.2]: https://github.com/ggbuddy/GameDealFinder/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/ggbuddy/GameDealFinder/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/ggbuddy/GameDealFinder/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/ggbuddy/GameDealFinder/compare/v2.3.0...v2.5.0
[2.3.0]: https://github.com/ggbuddy/GameDealFinder/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/ggbuddy/GameDealFinder/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/ggbuddy/GameDealFinder/releases/tag/v2.1.0
