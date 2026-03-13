(function () {
  'use strict';

  const STORE_DETECTORS = {
    // Official stores
    'store.steampowered.com': detectSteamGames,
    'gg.deals': detectGGDealsGames,
    'store.epicgames.com': detectEpicGames,
    'www.gog.com': detectGOGGames,
    'www.humblebundle.com': detectHumbleGames,
    'www.fanatical.com': detectFanaticalGames,
    'www.greenmangaming.com': detectGMGGames,
    // Keyshops
    'www.cdkeys.com': detectCDKeys,
    'www.kinguin.net': detectKinguin,
    'www.eneba.com': detectEneba,
    'www.g2a.com': detectG2A,
    'www.allkeyshop.com': detectAllKeyShop,
    'www.instant-gaming.com': detectInstantGaming,
    'isthereanydeal.com': detectIsThereAnyDeal,
    'www.gamersgate.com': detectGamersGate,
    'www.wingamestore.com': detectWinGameStore,
    'www.dlgamer.com': detectDLGamer,
    'digiphile.co': detectDigiphile,
    // Sites where we show legitimate deals to encourage buying (discourage piracy)
    'fitgirl-repacks.site': detectGamePageSteamThenTitle,
    'igg-games.com': detectGamePageSteamThenTitle,
    'gog-games.com': detectGamePageSteamThenTitle,
  };

  // ── Steam ──────────────────────────────────────────────────────────────────

  // Cached wishlist IDs (persists for the lifetime of the content script)
  let cachedSteamWishlistIds = null;
  let wishlistFetchInProgress = false;

  function detectSteamGames() {
    const path = window.location.pathname;

    // Wishlist page: /wishlist/profiles/<id>/ or /wishlist/id/<name>/
    if (path.includes('/wishlist/')) {
      // Return cached results immediately if available
      if (cachedSteamWishlistIds && cachedSteamWishlistIds.length > 0) {
        return { type: 'steam_ids', ids: cachedSteamWishlistIds, store: 'steam', pageType: 'wishlist' };
      }

      // Start collecting from DOM while the full fetch runs in background
      const domIds = collectSteamWishlistIdsFromDOM();

      // Kick off the full API fetch (runs async, sends results via message)
      if (!wishlistFetchInProgress) {
        wishlistFetchInProgress = true;
        fetchAllSteamWishlistIds().then((allIds) => {
          wishlistFetchInProgress = false;
          if (allIds.length > 0) {
            cachedSteamWishlistIds = allIds;
            chrome.runtime.sendMessage({
              action: 'gamesDetected',
              data: { type: 'steam_ids', ids: allIds, store: 'steam', pageType: 'wishlist' },
            });
          }
        });
      }

      // Return whatever we have from the DOM right now (may be partial)
      if (domIds.length > 0) {
        return { type: 'steam_ids', ids: domIds, store: 'steam', pageType: 'wishlist' };
      }

      observeSteamWishlist();
      return null;
    }

    const singleMatch = path.match(/\/app\/(\d+)/);
    if (singleMatch) {
      return { type: 'steam_ids', ids: [singleMatch[1]], store: 'steam' };
    }

    const bundleMatch = path.match(/\/(bundle|sub)\/(\d+)/);
    if (bundleMatch) {
      const appIds = extractSteamAppIdsFromLinks();
      if (appIds.length > 0) {
        return { type: 'steam_ids', ids: appIds, store: 'steam' };
      }
    }

    const appIds = extractSteamAppIdsFromDOM();
    if (appIds.length > 0) {
      return { type: 'steam_ids', ids: appIds, store: 'steam' };
    }

    return null;
  }

  // Fetches ALL wishlist app IDs using multiple strategies, not just what's visible
  async function fetchAllSteamWishlistIds() {
    const ids = new Set();

    // Strategy 1 (PRIMARY): Steam's dynamic store userdata endpoint
    // Returns rgWishlist — an array of ALL wishlisted app IDs in one request
    try {
      const resp = await fetch('/dynamicstore/userdata/', {
        credentials: 'include',
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.rgWishlist && Array.isArray(data.rgWishlist)) {
          for (const appId of data.rgWishlist) {
            if (appId && /^\d+$/.test(String(appId))) ids.add(String(appId));
          }
        }
      }
    } catch { /* endpoint may not be available */ }

    if (ids.size > 0) return [...ids];

    // Strategy 2: Try embedded wishlist data in the page's script tags
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        const text = script.textContent || '';
        if (text.includes('g_rgWishlistData')) {
          const match = text.match(/g_rgWishlistData\s*=\s*(\[[\s\S]*?\]);/);
          if (match) {
            const data = JSON.parse(match[1]);
            for (const item of data) {
              const appId = String(item.appid || item.appId || item.id);
              if (/^\d+$/.test(appId)) ids.add(appId);
            }
          }
        }
        const jsonMatch = text.match(/g_Wishlist\s*=\s*new\s+CWishlist\s*\(\s*(\[[\s\S]*?\])/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[1]);
          for (const appId of data) {
            if (/^\d+$/.test(String(appId))) ids.add(String(appId));
          }
        }
      }
    } catch { /* parse errors are expected */ }

    if (ids.size > 0) return [...ids];

    // Strategy 3: Legacy paginated wishlist API (deprecated but may still work)
    const path = window.location.pathname;
    const profileMatch = path.match(/\/wishlist\/profiles\/(\d+)/);
    const vanityMatch = path.match(/\/wishlist\/id\/([^/]+)/);

    if (profileMatch || vanityMatch) {
      const base = profileMatch
        ? `/wishlist/profiles/${profileMatch[1]}/wishlistdata/`
        : `/wishlist/id/${vanityMatch[1]}/wishlistdata/`;

      try {
        let page = 0;
        let consecutiveEmpty = 0;

        while (page < 30) {
          const resp = await fetch(`${base}?p=${page}`, {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });

          if (!resp.ok) break;

          const text = await resp.text();
          if (!text || text.trim() === '[]' || text.trim() === '{}' || text.trim().length < 5) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 2) break;
            page++;
            continue;
          }

          const data = JSON.parse(text);
          const pageIds = Object.keys(data).filter((k) => /^\d+$/.test(k));
          if (pageIds.length === 0) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 2) break;
            page++;
            continue;
          }

          consecutiveEmpty = 0;
          for (const id of pageIds) ids.add(id);
          page++;
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch { /* API might be deprecated */ }
    }

    if (ids.size > 0) return [...ids];

    // Strategy 4: Fall back to DOM scraping (gets only visible items)
    return collectSteamWishlistIdsFromDOM();
  }

  // Collects Steam App IDs from currently visible DOM elements
  function collectSteamWishlistIdsFromDOM() {
    const ids = new Set();

    document.querySelectorAll('[data-app-id]').forEach((el) => {
      const id = el.getAttribute('data-app-id');
      if (id && /^\d+$/.test(id)) ids.add(id);
    });

    document.querySelectorAll('.wishlist_row').forEach((el) => {
      const id = el.dataset.appId || el.getAttribute('data-app-id');
      if (id && /^\d+$/.test(id)) ids.add(id);
    });

    if (ids.size === 0) {
      const container = document.querySelector('#wishlist_items, .wishlist_items_ctn, [class*="WishlistPage"]');
      if (container) {
        container.querySelectorAll('a[href*="/app/"]').forEach((a) => {
          const m = a.href.match(/\/app\/(\d+)/);
          if (m) ids.add(m[1]);
        });
      }
    }

    if (ids.size === 0) {
      extractSteamAppIdsFromLinks().forEach((id) => ids.add(id));
    }

    return [...ids];
  }

  // MutationObserver for Steam's lazy-loaded wishlist — updates detected games
  // as new items appear when the user scrolls down
  let steamWishlistObserver = null;
  let steamWishlistTimer = null;

  function observeSteamWishlist() {
    if (steamWishlistObserver) return;

    const target = document.querySelector('#wishlist_items, .wishlist_items_ctn, [class*="WishlistPage"]') || document.body;

    steamWishlistObserver = new MutationObserver(() => {
      if (steamWishlistTimer) clearTimeout(steamWishlistTimer);
      steamWishlistTimer = setTimeout(() => {
        const domIds = collectSteamWishlistIdsFromDOM();
        // Merge with any cached API results
        const merged = new Set(cachedSteamWishlistIds || []);
        for (const id of domIds) merged.add(id);
        const allIds = [...merged];
        if (allIds.length > 0) {
          cachedSteamWishlistIds = allIds;
          chrome.runtime.sendMessage({
            action: 'gamesDetected',
            data: { type: 'steam_ids', ids: allIds, store: 'steam', pageType: 'wishlist' },
          });
        }
      }, 800);
    });

    steamWishlistObserver.observe(target, { childList: true, subtree: true });
  }

  function extractSteamAppIdsFromDOM() {
    const ids = new Set();
    try {
      document.querySelectorAll('[data-ds-appid]').forEach((el) => {
        const val = el.getAttribute('data-ds-appid');
        if (val) val.split(',').forEach((id) => {
          const trimmed = id.trim();
          if (/^\d+$/.test(trimmed)) ids.add(trimmed);
        });
      });
    } catch { /* defensive */ }
    if (ids.size === 0) {
      extractSteamAppIdsFromLinks().forEach((id) => ids.add(id));
    }
    return [...ids].slice(0, 100);
  }

  function extractSteamAppIdsFromLinks() {
    const ids = new Set();
    try {
      document.querySelectorAll('a[href*="/app/"]').forEach((a) => {
        const m = a.href?.match(/\/app\/(\d+)/);
        if (m) ids.add(m[1]);
      });
    } catch { /* defensive */ }
    return [...ids];
  }

  // ── GG.deals ───────────────────────────────────────────────────────────────

  function detectGGDealsGames() {
    const path = window.location.pathname;

    if (path.match(/^\/game\/.+/)) {
      const steamLink = safeQuerySelector('a[href*="store.steampowered.com/app/"]');
      if (steamLink) {
        const m = steamLink.href?.match(/\/app\/(\d+)/);
        if (m) return { type: 'steam_ids', ids: [m[1]], store: 'gg.deals' };
      }
      const title = safeTextContent('h1');
      if (title) return { type: 'titles', titles: [title], store: 'gg.deals' };
    }

    const steamIds = new Set();
    try {
      document.querySelectorAll('a[href*="store.steampowered.com/app/"]').forEach((a) => {
        const m = a.href?.match(/\/app\/(\d+)/);
        if (m) steamIds.add(m[1]);
      });
    } catch { /* defensive */ }
    if (steamIds.size > 0) {
      return { type: 'steam_ids', ids: [...steamIds].slice(0, 100), store: 'gg.deals' };
    }

    const titles = safeCollectTitles('.game-info-title, [data-game-title]', 20);
    if (titles.length > 0) {
      return { type: 'titles', titles, store: 'gg.deals' };
    }

    return null;
  }

  // ── Epic Games Store ───────────────────────────────────────────────────────

  function detectEpicGames() {
    const path = window.location.pathname;

    // Wishlist page: /wishlist or /en-US/wishlist
    if (path.match(/\/wishlist\/?$/i)) {
      return detectEpicWishlist();
    }

    const titles = [];

    // Strategy 1: URL slug
    const productMatch = path.match(/\/p\/([^/?#]+)/);
    const bundleMatch = path.match(/\/bundles\/([^/?#]+)/);
    const slug = productMatch?.[1] || bundleMatch?.[1];

    if (slug) {
      const cleaned = slug.replace(/-[a-f0-9]{6,}$/i, '');
      const titleFromSlug = slugToTitle(cleaned);
      if (titleFromSlug) titles.push(titleFromSlug);
    }

    // Strategy 2: document.title
    const docTitle = document.title;
    if (docTitle) {
      let cleaned = docTitle
        .replace(/\s*[-|–—]\s*(Epic Games( Store)?|Download|Buy).*$/i, '')
        .trim();
      cleaned = cleaned
        .replace(/^(Pre-Purchase\s*[&+]?\s*Pre-Order|Pre-Purchase|Pre-Order|Buy|Get)\s+/i, '')
        .trim();
      if (cleaned.length > 1 && cleaned.length < 200 && !titles.includes(cleaned)) {
        titles.push(cleaned);
      }
    }

    // Strategy 3: Epic DOM selectors
    const epicSelectors = [
      '[data-testid="offer-title-info-title"]',
      'h1[class*="NavigationVertical"]',
      'div[class*="ProductName"]',
      'span[data-component="Message"]',
    ];
    for (const sel of epicSelectors) {
      const t = safeTextContent(sel);
      if (t && t.length > 1 && t.length < 200 && !titles.includes(t)) {
        titles.push(t);
        break;
      }
    }

    // Strategy 4: JSON-LD
    const jsonLd = extractJsonLdTitle();
    if (jsonLd && !titles.includes(jsonLd)) titles.push(jsonLd);

    // Strategy 5: URL path fallback
    if (titles.length === 0) {
      const segments = path.split('/').filter(Boolean);
      const lastSeg = segments.filter((s) => !s.match(/^[a-z]{2}(-[A-Z]{2})?$/))[segments.length > 1 ? segments.length - 2 : 0];
      if (lastSeg && lastSeg.length > 2) {
        const cleaned = lastSeg
          .replace(/^(pre-purchase|pre-order|buy|get)[-_&+\s]*/i, '')
          .replace(/[-_]+/g, ' ')
          .trim();
        const titleFromPath = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
        if (titleFromPath.length > 1 && !titles.includes(titleFromPath)) {
          titles.push(titleFromPath);
        }
      }
    }

    if (titles.length > 0) {
      return { type: 'titles', titles: titles.slice(0, 5), store: 'store.epicgames.com' };
    }

    return detectGenericTitles('store.epicgames.com');
  }

  function detectEpicWishlist() {
    const titles = [];

    // Epic wishlist uses card-based layout — try multiple selectors
    const wishlistSelectors = [
      '[data-testid="wishlist-item"] [data-testid="offer-title-info-title"]',
      '[data-testid="wishlist-item"] h6',
      '[data-testid="wishlist-item"] span[data-component="Message"]',
      '.wishlist-item .product-name',
      '[class*="WishlistItem"] [class*="Title"]',
      '[class*="WishlistItem"] h6',
      '[class*="wishlist"] [class*="GameTitle"]',
    ];

    for (const sel of wishlistSelectors) {
      const collected = safeCollectTitles(sel, 200);
      if (collected.length > 0) {
        titles.push(...collected);
        break;
      }
    }

    // Fallback: grab all game card titles on the page
    if (titles.length === 0) {
      const cardSelectors = [
        'a[href*="/p/"] span', 'a[href*="/p/"] h6',
        '[data-testid="offer-title-info-title"]',
      ];
      for (const sel of cardSelectors) {
        const collected = safeCollectTitles(sel, 200);
        if (collected.length > 0) {
          titles.push(...collected);
          break;
        }
      }
    }

    // Also try document.title as a hint that we're on the wishlist
    if (titles.length === 0) {
      // On Epic wishlist, the page title is typically just "Wishlist"
      // so look at the rendered card content more aggressively
      document.querySelectorAll('a[href*="/p/"]').forEach((a) => {
        const slug = a.href.match(/\/p\/([^/?#]+)/)?.[1];
        if (slug) {
          const cleaned = slug.replace(/-[a-f0-9]{6,}$/i, '');
          const title = slugToTitle(cleaned);
          if (title && title.length > 1 && !titles.includes(title)) titles.push(title);
        }
      });
    }

    if (titles.length > 0) {
      // Start observing for lazy-loaded items
      observeEpicWishlist();
      return { type: 'titles', titles: titles.slice(0, 200), store: 'store.epicgames.com', pageType: 'wishlist' };
    }

    // May not have loaded yet — set up observer
    observeEpicWishlist();
    return null;
  }

  let epicWishlistObserver = null;
  let epicWishlistTimer = null;

  function observeEpicWishlist() {
    if (epicWishlistObserver) return;

    epicWishlistObserver = new MutationObserver(() => {
      if (epicWishlistTimer) clearTimeout(epicWishlistTimer);
      epicWishlistTimer = setTimeout(() => {
        const result = detectEpicWishlist();
        if (result && result.titles && result.titles.length > 0) {
          chrome.runtime.sendMessage({ action: 'gamesDetected', data: result });
        }
      }, 1000);
    });

    const target = document.querySelector('[class*="Wishlist"], [class*="wishlist"], main, #app') || document.body;
    epicWishlistObserver.observe(target, { childList: true, subtree: true });
  }

  // ── GOG ────────────────────────────────────────────────────────────────────

  function detectGOGGames() {
    const path = window.location.pathname;
    const titles = [];

    const gameMatch = path.match(/\/game\/([^/?#]+)/);
    if (gameMatch) {
      const titleFromSlug = slugToTitle(gameMatch[1].replace(/_/g, '-'));
      if (titleFromSlug) titles.push(titleFromSlug);
    }

    const gogSelectors = [
      '.productcard-basics__title',
      '[class*="productTitle"]',
      'h1.productcard-basics__title',
    ];
    for (const sel of gogSelectors) {
      const t = safeTextContent(sel);
      if (t && t.length > 1 && t.length < 200 && !titles.includes(t)) {
        titles.push(t);
        break;
      }
    }

    const docTitle = document.title?.split('|')[0]?.split(' - ')[0]?.split(' on GOG')[0]?.trim();
    if (docTitle && docTitle.length > 1 && !titles.includes(docTitle)) {
      titles.push(docTitle);
    }

    const jsonLd = extractJsonLdTitle();
    if (jsonLd && !titles.includes(jsonLd)) titles.push(jsonLd);

    if (titles.length > 0) {
      return { type: 'titles', titles: titles.slice(0, 5), store: 'www.gog.com' };
    }

    return detectGenericTitles('www.gog.com');
  }

  // ── Humble Bundle ──────────────────────────────────────────────────────────

  function detectHumbleGames() {
    const path = window.location.pathname;

    // Step 1: Steam App IDs
    const steamIds = new Set();
    try {
      document.querySelectorAll('a[href*="store.steampowered.com/app/"]').forEach((a) => {
        const m = a.href?.match(/\/app\/(\d+)/);
        if (m) steamIds.add(m[1]);
      });
      document.querySelectorAll('[data-steam-appid], [data-appid]').forEach((el) => {
        const id = el.getAttribute('data-steam-appid') || el.getAttribute('data-appid');
        if (id && /^\d+$/.test(id)) steamIds.add(id);
      });
    } catch { /* defensive */ }
    if (steamIds.size > 0) {
      return { type: 'steam_ids', ids: [...steamIds].slice(0, 100), store: 'www.humblebundle.com' };
    }

    // Step 2: Item titles
    const titles = [];
    const bundleItemSelectors = [
      '.item-title',
      '.content-choice-title',
      '.entity-title',
      '.tier-item-view .item-title',
      'td.game-name h4',
      '.dd-image-box-caption',
      '.human_name-view',
    ];
    for (const sel of bundleItemSelectors) {
      const collected = safeCollectTitles(sel, 50);
      if (collected.length > 0) {
        titles.push(...collected);
        break;
      }
    }

    // Step 3: Main product title
    if (titles.length === 0) {
      const storeMatch = path.match(/\/store\/([^/?#]+)/);
      if (storeMatch) {
        const titleFromSlug = slugToTitle(storeMatch[1]);
        if (titleFromSlug) titles.push(titleFromSlug);
      }

      const headerSelectors = [
        '.product-header-view .human_name-view',
        '.hero-content .heading-text h1',
        '.bundle-logo-text',
      ];
      for (const sel of headerSelectors) {
        const t = safeTextContent(sel);
        if (t && t.length > 1 && t.length < 200 && !titles.includes(t)) {
          titles.push(t);
          break;
        }
      }
    }

    // Step 4: document.title
    if (titles.length === 0) {
      const docTitle = document.title;
      if (docTitle) {
        let cleaned = docTitle
          .replace(/\s*[-|–—]\s*(Humble Bundle|Humble).*$/i, '')
          .replace(/^(Best of|Pay What You Want for)\s+/i, '')
          .trim();
        if (cleaned.length > 1 && cleaned.length < 200) {
          titles.push(cleaned);
        }
      }
    }

    // Step 5: JSON-LD
    const jsonLd = extractJsonLdTitle();
    if (jsonLd && !titles.includes(jsonLd)) titles.push(jsonLd);

    if (titles.length > 0) {
      return { type: 'titles', titles: titles.slice(0, 50), store: 'www.humblebundle.com' };
    }
    return null;
  }

  // ── Fanatical ──────────────────────────────────────────────────────────────

  function detectFanaticalGames() {
    const path = window.location.pathname;

    // Steam links
    const steamIds = new Set();
    try {
      document.querySelectorAll('a[href*="store.steampowered.com/app/"]').forEach((a) => {
        const m = a.href?.match(/\/app\/(\d+)/);
        if (m) steamIds.add(m[1]);
      });
    } catch { /* defensive */ }
    if (steamIds.size > 0) {
      return { type: 'steam_ids', ids: [...steamIds].slice(0, 100), store: 'www.fanatical.com' };
    }

    const titles = [];
    const isBundle = path.includes('/bundle/');
    if (isBundle) {
      const bundleSelectors = [
        '.bundle-item-title', '.card-title', '.product-name',
        '.game-card-title', '.product-title', '.game-title',
        '.product-details-title', '[data-test-id="product-link"]',
        'h3 a', 'h4 a', 'h3'
      ];
      for (const sel of bundleSelectors) {
        const collected = safeCollectTitles(sel, 50);
        if (collected.length > 0) {
          titles.push(...collected);
          break;
        }
      }
    }

    const gameMatch = path.match(/\/(game|bundle|dlc)\/([^/?#]+)/);
    if (titles.length === 0 && gameMatch) {
      const titleFromSlug = slugToTitle(gameMatch[2]);
      if (titleFromSlug) titles.push(titleFromSlug);
    }

    const docTitle = document.title?.split('|')[0]?.split(' - ')[0]?.split(' — ')[0]?.trim();
    if (docTitle && docTitle.length > 1 && !titles.includes(docTitle)) {
      titles.push(docTitle);
    }

    const jsonLd = extractJsonLdTitle();
    if (jsonLd && !titles.includes(jsonLd)) titles.push(jsonLd);

    if (titles.length > 0) {
      return { type: 'titles', titles: titles.slice(0, 50), store: 'www.fanatical.com' };
    }
    return detectGenericTitles('www.fanatical.com');
  }

  // ── Green Man Gaming ───────────────────────────────────────────────────────

  function detectGMGGames() {
    // Rely on Universal Detector for GMG since they use standard meta/h1 tags efficiently
    const result = detectUniversalGame();
    if (result) {
      result.store = 'www.greenmangaming.com';
      return result;
    }

    // Fallback if the universal missed the metadata but we have a url slug
    const path = window.location.pathname;
    const gameMatch = path.match(/\/games\/([^/?#]+)/);
    if (gameMatch) {
      const titleFromSlug = slugToTitle(gameMatch[1]);
      if (titleFromSlug) return { type: 'titles', titles: [titleFromSlug], store: 'www.greenmangaming.com' };
    }
    return null;
  }

  // ── CDKeys ──────────────────────────────────────────────────────────────────

  function detectCDKeys() {
    return detectBySlugAndTitle(/\/([^/?#]+)(?:\?|$)/, 'www.cdkeys.com', [
      'h1.product-name', '.product-title', 'h1',
    ]);
  }

  // ── Kinguin ────────────────────────────────────────────────────────────────

  function detectKinguin() {
    return detectBySlugAndTitle(/\/([^/?#]+)-\d+$/, 'www.kinguin.net', [
      'h1[data-test-id="product-name"]', '.product-title', 'h1',
    ]);
  }

  // ── Eneba ──────────────────────────────────────────────────────────────────

  function detectEneba() {
    return detectBySlugAndTitle(/\/([^/?#]+)-\w+$/, 'www.eneba.com', [
      'h1.fUmBBG', '.product-title', 'h1',
    ]);
  }

  // ── G2A ────────────────────────────────────────────────────────────────────

  function detectG2A() {
    return detectBySlugAndTitle(/\/([^/?#]+)-i-\d+/, 'www.g2a.com', [
      'h1.product-name', '.product__title', 'h1',
    ]);
  }

  // ── AllKeyShop ─────────────────────────────────────────────────────────────

  function detectAllKeyShop() {
    return detectBySlugAndTitle(/\/buy\/([^/?#]+)/, 'www.allkeyshop.com', [
      'h1.game-title', '.content-title h1', 'h1',
    ]);
  }

  // ── Instant Gaming ─────────────────────────────────────────────────────────

  function detectInstantGaming() {
    return detectBySlugAndTitle(/\/([^/?#]+)$/, 'www.instant-gaming.com', [
      '.title.game-title', '.product-title h1', 'h1',
    ]);
  }

  // ── IsThereAnyDeal ─────────────────────────────────────────────────────────

  function detectIsThereAnyDeal() {
    return detectBySlugAndTitle(/\/game\/([^/?#]+)/, 'isthereanydeal.com', [
      '.game-header-title', 'h1', '.game-info-title',
    ]);
  }

  // ── GamersGate ─────────────────────────────────────────────────────────────

  function detectGamersGate() {
    return detectBySlugAndTitle(/\/product\/([^/?#]+)/, 'www.gamersgate.com', [
      '.product-title', 'h1', '.game-title',
    ]);
  }

  // ── WinGameStore ───────────────────────────────────────────────────────────

  function detectWinGameStore() {
    return detectBySlugAndTitle(/\/product\/\d+\/([^/?#]+)/, 'www.wingamestore.com', [
      '.product-title', 'h1',
    ]);
  }

  // ── DLGamer ────────────────────────────────────────────────────────────────

  function detectDLGamer() {
    return detectBySlugAndTitle(/\/([^/?#]+)-p-\d+/, 'www.dlgamer.com', [
      '.product_title', 'h1',
    ]);
  }

  // ── Universal helper for keyshop-style sites ───────────────────────────────

  function detectBySlugAndTitle(slugPattern, store, selectors) {
    const titles = [];
    const path = window.location.pathname;

    // Strategy 1: JSON-LD (most reliable)
    const jsonLd = extractJsonLdTitle();
    if (jsonLd) titles.push(jsonLd);

    // Strategy 2: DOM selectors
    for (const sel of selectors) {
      const t = safeTextContent(sel);
      if (t && t.length > 1 && t.length < 200 && !titles.includes(t)) {
        // Clean common suffixes like "- Steam Key", "PC Download", etc.
        const cleaned = t
          .replace(/\s*[-–—|]\s*(Steam|PC|Xbox|PS[45]|Nintendo|Switch|Global|EU|Key|Code|Download|CD Key|Digital).*$/gi, '')
          .trim();
        if (cleaned.length > 1 && !titles.includes(cleaned)) titles.push(cleaned);
        if (!titles.includes(t)) titles.push(t); // keep original too for matching
        break;
      }
    }

    // Strategy 3: URL slug
    const slugMatch = path.match(slugPattern);
    if (slugMatch) {
      const titleFromSlug = slugToTitle(slugMatch[1]);
      if (titleFromSlug && !titles.includes(titleFromSlug)) titles.push(titleFromSlug);
    }

    // Strategy 4: document.title cleanup
    const docTitle = document.title
      ?.split(/[|–—]/)[0]
      ?.replace(/\s*[-]\s*(Buy|Get|Best Price|Compare|Steam|Key|Code|Download).*$/gi, '')
      ?.trim();
    if (docTitle && docTitle.length > 1 && docTitle.length < 200 && !titles.includes(docTitle)) {
      titles.push(docTitle);
    }

    // Strategy 5: Open Graph
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
    if (ogTitle && ogTitle.length > 1 && ogTitle.length < 200) {
      const cleaned = ogTitle.replace(/\s*[-–—|]\s*.+$/, '').trim();
      if (cleaned.length > 1 && !titles.includes(cleaned)) titles.push(cleaned);
    }

    if (titles.length > 0) {
      return { type: 'titles', titles: titles.slice(0, 5), store };
    }
    return null;
  }

  // ── Digiphile ──────────────────────────────────────────────────────────────

  function detectDigiphile() {
    // Digiphile heavily relies on direct "View on Steam" links that contain the App ID
    const steamIds = extractSteamAppIdsFromLinks();
    if (steamIds.length > 0) {
      return { type: 'steam_ids', ids: steamIds.slice(0, 100), store: 'digiphile.co' };
    }

    // Fallback for game titles (covers bundles and individual pages)
    const titles = safeCollectTitles('.card-title, .game-title, .product-title, h2', 50);
    if (titles.length > 0) {
      return { type: 'titles', titles, store: 'digiphile.co' };
    }

    return detectUniversalGame();
  }

  // ── Game pages on repack/unofficial sites (show legitimate deal to discourage piracy) ──

  function cleanGameTitleFromUnofficialSite(title) {
    if (!title || typeof title !== 'string') return null;
    let t = title
      .replace(/\s*[-–—|]\s*(FitGirl|Fitgirl|Repack|Repacks).*$/gi, '')
      .replace(/\s*[-–—|]\s*(IGG|IGG-Games|IGG Games).*$/gi, '')
      .replace(/\s*[-–—|]\s*(GOG-Games|GOG Games).*$/gi, '')
      .replace(/\s*(Free\s+)?Download\s*(PC|Full)?.*$/gi, '')
      .replace(/\s*,?\s*V?\d+\.\d+.*$/i, '') // version numbers at end
      .replace(/\s*[-–—|]\s*Deluxe Edition.*$/gi, '')
      .replace(/\s*[-–—|]\s*\+?\s*\d+\s*DLCs?\/?.*$/gi, '')
      .replace(/\s*\[[^\]]*\]\s*$/g, '')
      .trim();
    if (t.length < 2 || t.length > 200) return null;
    return t;
  }

  function detectGamePageSteamThenTitle() {
    const host = window.location.hostname;
    const store = host;
    const path = window.location.pathname || '';

    // 1) URL slug first — no DOM dependency, so it can't fail on quirky pages (e.g. Greedfall)
    const skipSegments = /^(games?|repack|download|category|tag|page|index|search)$/i;
    const segments = path.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!seg || skipSegments.test(seg) || seg.length < 3) continue;
      const slug = seg
        .replace(/-repack$/i, '')
        .replace(/-download$/i, '')
        .replace(/-\d{4,}$/, '');
      const fromSlug = slugToTitle(slug);
      if (fromSlug && fromSlug.length > 2) {
        // Return immediately with slug-based title so DOM quirks can't block detection
        return { type: 'titles', titles: [fromSlug], store };
      }
    }

    // 2) No usable slug — try DOM (site names must not be used as game title)
    const siteNameTitles = /^(FitGirl Repacks?|FitGirl|IGG[- ]?Games?|GOG[- ]?Games?)$/i;
    const titles = [];
    const addCleaned = (raw) => {
      const cleaned = cleanGameTitleFromUnofficialSite(raw);
      if (cleaned && !titles.includes(cleaned) && !siteNameTitles.test(cleaned.trim())) {
        titles.push(cleaned);
      }
    };

    try {
      const h1 = safeTextContent('h1');
      if (h1) addCleaned(h1);
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
      if (ogTitle) addCleaned(ogTitle);
      const docTitle = document.title?.split(/[|–—]/)[0]?.trim();
      if (docTitle) addCleaned(docTitle);
      const selectors = ['.entry-title', '.post-title', '.game-title', '.title', 'h2.post-title', 'h1.title'];
      for (const sel of selectors) {
        const t = safeTextContent(sel);
        if (t) addCleaned(t);
      }
    } catch (_) { /* DOM may throw on some pages */ }

    if (titles.length > 0) {
      return { type: 'titles', titles: titles.slice(0, 5), store };
    }

    const steamIds = extractSteamAppIdsFromLinks();
    if (steamIds.length > 0) {
      return { type: 'steam_ids', ids: steamIds.slice(0, 10), store };
    }
    return null;
  }

  // ── Universal Detector (any website) ───────────────────────────────────────

  function detectUniversalGame() {
    const host = window.location.hostname;
    const titles = [];

    // JSON-LD structured data
    const jsonLd = extractJsonLdTitle();
    if (jsonLd) titles.push(jsonLd);

    // Open Graph
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
    if (ogTitle && ogTitle.length > 1 && ogTitle.length < 200) {
      const cleaned = ogTitle.replace(/\s*[-–—|]\s*.+$/, '').trim();
      if (cleaned.length > 1 && !titles.includes(cleaned)) titles.push(cleaned);
    }

    // h1 tag (common for product pages)
    const h1 = safeTextContent('h1');
    if (h1 && h1.length > 2 && h1.length < 150) {
      const cleaned = h1
        .replace(/\s*[-–—|]\s*(Steam|PC|Xbox|PS[45]|Key|Code|Download|Digital|CD Key).*$/gi, '')
        .trim();
      if (cleaned.length > 1 && !titles.includes(cleaned)) titles.push(cleaned);
    }

    // Only proceed if we found something that looks like a game
    if (titles.length > 0) {
      return { type: 'titles', titles: titles.slice(0, 3), store: host };
    }
    return null;
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  function slugToTitle(slug) {
    if (!slug) return null;
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Safe querySelector that won't throw */
  function safeQuerySelector(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  /** Safely get text content from first matching element */
  function safeTextContent(selector) {
    try {
      const el = document.querySelector(selector);
      return el?.textContent?.trim() || null;
    } catch {
      return null;
    }
  }

  /** Collect text values from all matching elements, deduplicated */
  function safeCollectTitles(selector, limit = 20) {
    const titles = [];
    try {
      document.querySelectorAll(selector).forEach((el) => {
        const t = el.textContent?.trim();
        if (t && t.length > 1 && t.length < 200 && !titles.includes(t)) {
          titles.push(t);
        }
      });
    } catch { /* defensive */ }
    return titles.slice(0, limit);
  }

  function extractJsonLdTitle() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        const item = Array.isArray(data) ? data[0] : data;
        if (item?.name && (item['@type'] === 'Product' || item['@type'] === 'VideoGame' || item['@type'] === 'SoftwareApplication')) {
          return item.name.trim();
        }
      }
    } catch { /* ignore parse errors */ }
    return null;
  }

  function detectGenericTitles(store) {
    const selectors = [
      '.product-title', '.game-title', '[data-component="Title"]',
      '.product-name', '.game-name', 'h2 a', 'h3 a',
    ];
    for (const sel of selectors) {
      const titles = safeCollectTitles(sel, 20);
      if (titles.length > 0) {
        return { type: 'titles', titles, store };
      }
    }
    return null;
  }

  // ── Detection runner ───────────────────────────────────────────────────────

  function getDetector() {
    const host = window.location.hostname;
    for (const [pattern, fn] of Object.entries(STORE_DETECTORS)) {
      if (host.includes(pattern)) return fn;
    }
    // Universal fallback — try to detect games on any website
    return detectUniversalGame;
  }

  function run() {
    try {
      const detector = getDetector();
      if (!detector) return;

      const result = detector();
      if (result && ((result.ids && result.ids.length > 0) || (result.titles && result.titles.length > 0))) {
        chrome.runtime.sendMessage({ action: 'gamesDetected', data: result });

        // Inject price overlay for single-game pages
        if (result.type === 'steam_ids' && result.ids.length === 1) {
          injectPriceOverlay({ id: result.ids[0], store: result.store });
        } else if (result.type === 'titles' && result.titles.length >= 1) {
          // Repack/unofficial sites: always show overlay for first (page) title; others: only when 1–2 titles
          const isRepackSite = result.store && (
            result.store.includes('fitgirl-repacks') ||
            result.store.includes('igg-games.com') ||
            result.store.includes('gog-games.com')
          );
          if (isRepackSite || result.titles.length <= 2) {
            injectPriceOverlay({ title: result.titles[0], store: result.store });
          }
        }
      }
    } catch (e) {
      console.warn('[GameDealFinder] Detection error:', e);
    }
  }

  // ── SPA navigation detection via MutationObserver ──────────────────────────

  let lastUrl = window.location.href;
  let debounceTimer = null;

  function onUrlChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    removeOverlay(); // Clean up overlay on navigation
    debounceTimer = setTimeout(run, 1000);
  }

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    if (window.location.href !== lastUrl) { lastUrl = window.location.href; onUrlChange(); }
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    if (window.location.href !== lastUrl) { lastUrl = window.location.href; onUrlChange(); }
  };

  window.addEventListener('popstate', () => {
    if (window.location.href !== lastUrl) { lastUrl = window.location.href; onUrlChange(); }
  });

  try {
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) { lastUrl = window.location.href; onUrlChange(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    setInterval(() => {
      if (window.location.href !== lastUrl) { lastUrl = window.location.href; onUrlChange(); }
    }, 2000);
  }

  // ── Initial run ────────────────────────────────────────────────────────────

  if (document.readyState === 'complete') {
    setTimeout(run, 800);
  } else {
    window.addEventListener('load', () => setTimeout(run, 800));
  }

  // Listen for re-scan requests from the popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'scanPage') {
      const host = window.location.hostname;
      const isRepackSite = host.includes('fitgirl-repacks') || host.includes('igg-games.com') || host.includes('gog-games.com');

      function doScan() {
        const detector = getDetector();
        return detector ? detector() : null;
      }

      let result = doScan();
      if (result) {
        sendResponse(result);
        return false;
      }
      // On repack sites, retry once after a short delay (DOM/URL may not be ready yet)
      if (isRepackSite) {
        setTimeout(() => {
          result = doScan();
          sendResponse(result);
        }, 500);
        return true; // keep channel open for async sendResponse
      }
      sendResponse(null);
      return false;
    }
    if (message.action === 'getWishlistStatus') {
      // Let the popup know about an ongoing wishlist fetch
      const path = window.location.pathname;
      const isWishlist = path.includes('/wishlist/');
      sendResponse({
        isWishlist,
        fetchInProgress: wishlistFetchInProgress,
        cachedCount: cachedSteamWishlistIds ? cachedSteamWishlistIds.length : 0,
      });
      return false;
    }
  });

  // ── Inline Price Overlay ───────────────────────────────────────────────────

  let overlayEl = null;
  let overlayDismissed = false;

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  async function injectPriceOverlay(opts) {
    if (overlayDismissed) return;

    // Check if user has overlay enabled
    try {
      const result = await new Promise((resolve) => chrome.storage.local.get(['userPrefs', 'lastRegion'], resolve));
      const prefs = result.userPrefs || {};
      if (prefs.overlay === false) return;
      if (!prefs.region && result.lastRegion) {
        prefs.region = result.lastRegion;
      }
      if (!prefs.region) {
        prefs.region = 'us';
      }
      opts.region = prefs.region;
    } catch { /* proceed */ }

    // Resolve: if we have a title but no id, resolve it first
    let appId = opts.id;

    if (!appId && opts.title) {
      try {
        const searchResp = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: 'searchSteam', query: opts.title, region: opts.region || 'us' }, resolve)
        );
        if (searchResp && searchResp.success && searchResp.data) {
          const firstEntry = Object.entries(searchResp.data).find(([, v]) => v && v.prices);
          if (firstEntry) {
            appId = firstEntry[0];
            renderOverlay(firstEntry[0], firstEntry[1], opts.store);
            return;
          }
        }
      } catch { /* fallback below */ }
      return; // couldn't resolve title
    }

    if (!appId) return;

    // Fetch price by ID
    chrome.runtime.sendMessage({ action: 'lookupByIds', ids: [appId], region: opts.region || 'us' }, (resp) => {
      if (!resp || !resp.success || !resp.data[appId]) return;
      renderOverlay(appId, resp.data[appId], opts.store);
    });
  }

  function renderOverlay(appId, game, detectedStore) {
    const p = game.prices;
    if (!p) return;

    const retail = p.currentRetail ? parseFloat(p.currentRetail) : null;
    const keyshop = p.currentKeyshops ? parseFloat(p.currentKeyshops) : null;
    const currency = p.currency || 'USD';
    const best = (retail !== null && keyshop !== null) ? Math.min(retail, keyshop) : (retail ?? keyshop);
    if (best === null) return;

    const histLow = Math.min(
      p.historicalRetail ? parseFloat(p.historicalRetail) : Infinity,
      p.historicalKeyshops ? parseFloat(p.historicalKeyshops) : Infinity
    );
    const isHistLow = histLow !== Infinity && best <= histLow * 1.05;

    removeOverlay();
    overlayEl = document.createElement('div');
    overlayEl.id = 'gg-deals-overlay';

    const retailStr = retail !== null ? `${retail} ${currency}` : '—';
    const keyStr = keyshop !== null ? `${keyshop} ${currency}` : '—';
    const bestStr = `${best} ${currency}`;
    const histTag = isHistLow ? `<span style="background:#048044;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700;margin-left:8px">⭐ ${escapeOverlay(chrome.i18n.getMessage('overlayHistoricalLow') || 'Historical Low')}</span>` : '';

    const isUnofficialPage = detectedStore && (
      detectedStore.includes('fitgirl-repacks') ||
      detectedStore.includes('igg-games.com') ||
      detectedStore.includes('gog-games.com')
    );
    const supportLine = isUnofficialPage
      ? `<span style="font-size:11px;color:rgba(255,255,255,0.75);margin-right:8px">${escapeOverlay(chrome.i18n.getMessage('overlaySupportDevs') || 'Support developers — get a deal:')}</span>`
      : '';

    overlayEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;max-width:960px;margin:0 auto">
        <span style="font-weight:900;font-size:14px;color:#048044">GG.deals</span>
        ${supportLine}
        <span style="color:rgba(255,255,255,0.5)">|</span>
        <span style="font-weight:700">${escapeOverlay(game.title || '')}</span>
        <span style="color:rgba(255,255,255,0.5)">|</span>
        <span>🏪 <b>${retailStr}</b></span>
        <span>🔑 <b>${keyStr}</b></span>
        <span style="color:rgba(255,255,255,0.5)">|</span>
        <span style="font-weight:900;font-size:15px;color:#4ade80">${escapeOverlay(chrome.i18n.getMessage('overlayBest', [bestStr]) || 'Best: ' + bestStr)}</span>
        ${histTag}
        ${game.url ? `<a href="${game.url}" target="_blank" style="color:#60a5fa;font-weight:700;font-size:12px;text-decoration:none;margin-left:auto">${escapeOverlay(chrome.i18n.getMessage('overlayViewOnGgDeals') || 'View on GG.deals →')}</a>` : ''}
        <button id="gg-overlay-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:18px;cursor:pointer;padding:0 4px;margin-left:4px">✕</button>
      </div>
    `;

    overlayEl.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647;
      background: rgba(15,15,26,0.96); backdrop-filter: blur(12px);
      padding: 10px 20px; font-family: 'Lato', -apple-system, sans-serif;
      font-size: 13px; color: #e8e6ef; border-top: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 -4px 20px rgba(0,0,0,0.35); animation: ggSlideUp 0.3s ease-out;
    `;

    const style = document.createElement('style');
    style.textContent = `@keyframes ggSlideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
    overlayEl.appendChild(style);

    document.body.appendChild(overlayEl);

    document.getElementById('gg-overlay-close')?.addEventListener('click', () => {
      overlayDismissed = true;
      removeOverlay();
    });
  }

  function escapeOverlay(text) {
    const d = document.createElement('div'); d.textContent = text; return d.innerHTML;
  }
})();

