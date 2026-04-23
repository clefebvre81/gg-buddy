# GG Buddy 🎮💰

A Chrome extension that automatically compares PC game prices across 17+ stores using [GG.deals](https://gg.deals). Never overpay for a game again.

![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-2.6.2-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Chrome Web Store listing

Copy the full store description from [`chrome-store-description.txt`](chrome-store-description.txt) into the Chrome Web Store “Detailed description” field when publishing.

## Features

🔍 **Auto-Detection** — Works on Steam, Epic, GOG, Humble, Fanatical, GMG, CDKeys, Kinguin, Eneba, G2A, AllKeyShop, Instant Gaming, IsThereAnyDeal, and more

💰 **Inline Price Overlay** — Floating bar on store pages shows the best price; with **Official Stores Only**, keyshops are hidden and only official retail is shown

🏆 **Deal Score & Historical Charts** — Smart rating based on discount depth and visual sparkline charts inside the dashboard

📊 **Smart Dashboard** — Shows price drops, micro-charts, and historical lows for your wishlisted games

💜 **Wishlist & Alerts** — Track games and get notified when prices drop below your target. Export your list to the clipboard

📦 **Bundle Finder & Calculator** — Discover active bundles and instantly see your exact percentage savings vs buying individually

🎛️ **Bundle Filters & Sorting** — Filter active bundles by store and sort by ending soon, price, or title

🧠 **Wishlist Bundle Callouts** — Wishlisted games now show whether an active bundle tier is worth considering vs standalone price

🖼️ **Custom Game Images** — Set or reset game artwork overrides from wishlist details, reused across views

🛡️ **Official Stores Only** — Filters keyshops from the popup (dashboard, search, wishlist, deal scores), the **inline overlay**, and **wishlist price alerts**; comparisons use official retailer pricing only

✅ **Buy Legit Nudges** — Encourages legit game purchases on piracy sites when prices hit historical lows

🎨 **Full Customization** — 4 themes (Light/Dark/OLED/System), 7 accent colors, compact mode

☁️ **Cross-Device Sync** — Wishlist and settings sync across Chrome instances

🌐 **18 Languages** — Full UI localization (Czech, Danish, German, English, Spanish, Finnish, French, Italian, Japanese, Korean, Norwegian, Polish, Portuguese, Russian, Swedish, Ukrainian, Chinese Simplified)

## Installation

### From Chrome Web Store
*(Coming soon)*

### Manual Install (Developer Mode)
1. Download or clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the project folder
5. The extension icon appears in your toolbar

## Screenshots

*(Coming soon)*

## Tech Stack

- **Frontend:** HTML, CSS, Vanilla JavaScript
- **API:** [GG.deals Prices API](https://gg.deals/api/prices/)
- **Storage:** Chrome Storage API (local + sync)
- **Manifest:** V3

## Privacy

- No personal data collected
- All data stored locally in your browser
- No tracking or analytics
- [Privacy Policy](privacy-policy.html)

## License

MIT License — see [LICENSE](LICENSE) for details.

## Credits

- Price data powered by [GG.deals](https://gg.deals)
- Icons and design inspired by GG.deals branding
