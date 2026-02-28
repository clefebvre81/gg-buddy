const DEFAULT_API_KEY = 'sqz5OjdsyxNW2e0i3aF5BA0p5rpd0fHU';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PRICES_ENDPOINT = 'https://api.gg.deals/v1/prices/by-steam-app-id/';
const BUNDLES_ENDPOINT = 'https://api.gg.deals/v1/bundles/by-steam-app-id/';
const ACTIVE_BUNDLES_ENDPOINT = 'https://api.gg.deals/v1/bundles/active/';
const STEAM_SEARCH_URL = 'https://store.steampowered.com/api/storesearch/';

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15000;

// In-memory caches
let priceCache = {};
let detectedGamesPerTab = {};
let activeBundlesCache = { data: null, timestamp: 0 };

// ── Startup ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'searchPrice',
    title: 'Look up game price on GG.deals',
    contexts: ['selection'],
  });
});

chrome.storage.local.get(['priceCache'], (result) => {
  if (result.priceCache) {
    const now = Date.now();
    for (const [key, entry] of Object.entries(result.priceCache)) {
      if (now - entry.timestamp < CACHE_TTL_MS) {
        priceCache[key] = entry;
      }
    }
  }
});

// ── Fetch with timeout + retry + rate limit tracking ─────────────────────────

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      // Track rate limit headers
      trackRateLimit(resp);

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '5', 10);
        const waitMs = Math.min(retryAfter * 1000, 30000);
        await delay(waitMs);
        continue;
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`API authentication error (${resp.status}). Check your API key.`);
      }
      if (resp.status === 404) {
        throw new Error(`Resource not found (404).`);
      }
      if (resp.status >= 500) {
        lastError = new Error(`Server error (${resp.status})`);
        await delay(getBackoffMs(attempt));
        continue;
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const json = await resp.json();
      return json;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        lastError = new Error('Request timed out');
      } else if (e.message.includes('authentication') || e.message.includes('not found')) {
        throw e;
      } else {
        lastError = e;
      }
      if (attempt < retries - 1) {
        await delay(getBackoffMs(attempt));
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

function trackRateLimit(resp) {
  try {
    const remaining = resp.headers.get('x-ratelimit-remaining');
    const reset = resp.headers.get('x-ratelimit-reset');
    if (remaining !== null) {
      const info = {
        remaining: parseInt(remaining, 10),
        reset: reset ? parseInt(reset, 10) : null,
        timestamp: Date.now(),
      };
      chrome.storage.local.set({ rateLimitInfo: info });
    }
  } catch { /* ignore */ }
}

function getRateLimitInfo() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['rateLimitInfo'], (result) => {
      resolve(result.rateLimitInfo || null);
    });
  });
}

function getBackoffMs(attempt) {
  return Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Response validation ──────────────────────────────────────────────────────

function validatePriceResponse(json) {
  if (!json || typeof json !== 'object') return false;
  if (!json.hasOwnProperty('success')) return false;
  if (json.success && !json.data) return false;
  return true;
}

// ── Message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'gamesDetected') {
    if (message.fromPopup) {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (tabId) await handleDetectedGames(message.data, tabId);
        sendResponse({ ok: true });
      });
      return true;
    }
    handleDetectedGames(message.data, sender.tab?.id);
  }

  if (message.action === 'getDetectedGames') {
    handleGetDetected(message.tabId, sendResponse);
    return true;
  }

  if (message.action === 'lookupByIds') {
    handleLookupByIds(message.ids, message.region, sendResponse);
    return true;
  }

  if (message.action === 'lookupByTitles') {
    handleLookupByTitles(message.titles, message.region, sendResponse);
    return true;
  }

  if (message.action === 'getBundles') {
    handleGetBundles(message.ids, message.region, sendResponse);
    return true;
  }

  if (message.action === 'getActiveBundles') {
    handleGetActiveBundles(message.region, sendResponse);
    return true;
  }

  if (message.action === 'searchSteam') {
    handleSearchSteam(message.query, message.region, sendResponse);
    return true;
  }
});

// ── Context menu ─────────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'searchPrice') {
    const text = (info.selectionText || '').trim();
    if (!text) return;

    // Open a new tab querying GG.deals search directly with the highlighted text
    const searchUrl = `https://gg.deals/games/?title=${encodeURIComponent(text)}`;
    chrome.tabs.create({ url: searchUrl });
  }
});

// ── Detected games per tab ───────────────────────────────────────────────────

async function handleDetectedGames(data, tabId) {
  if (!tabId || !data) return;

  let appIds = [];
  if (data.type === 'steam_ids' && Array.isArray(data.ids)) {
    appIds = data.ids.filter((id) => /^\d+$/.test(id));
  } else if (data.type === 'titles' && Array.isArray(data.titles)) {
    try {
      const mapping = await resolveTitlesToSteamIds(data.titles);
      appIds = Object.values(mapping).filter(Boolean);
    } catch (e) {
      console.warn('Title resolution failed:', e);
      return;
    }
  }

  if (appIds.length === 0) return;

  detectedGamesPerTab[tabId] = {
    appIds,
    store: data.store || 'unknown',
    timestamp: Date.now(),
  };

  const count = appIds.length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#048044', tabId });
}

function handleGetDetected(tabId, sendResponse) {
  const entry = detectedGamesPerTab[tabId];
  if (entry && Date.now() - entry.timestamp < 10 * 60 * 1000) {
    sendResponse({ appIds: entry.appIds, store: entry.store });
  } else {
    sendResponse({ appIds: [], store: null });
  }
}

// ── Price lookups ────────────────────────────────────────────────────────────

async function handleLookupByIds(ids, region, sendResponse) {
  try {
    if (!Array.isArray(ids) || ids.length === 0) {
      sendResponse({ success: false, error: 'No IDs provided' });
      return;
    }
    const cleanIds = ids.map(String).filter((id) => /^\d+$/.test(id));
    if (cleanIds.length === 0) {
      sendResponse({ success: false, error: 'No valid IDs provided' });
      return;
    }
    const results = await fetchPricesBatch(cleanIds, region);
    const rateLimit = await getRateLimitInfo();
    sendResponse({ success: true, data: results, rateLimit });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function handleLookupByTitles(titles, region, sendResponse) {
  try {
    if (!Array.isArray(titles) || titles.length === 0) {
      sendResponse({ success: false, error: 'No titles provided' });
      return;
    }
    const cleanTitles = titles.map((t) => String(t).trim()).filter((t) => t.length > 0 && t.length < 300);
    if (cleanTitles.length === 0) {
      sendResponse({ success: false, error: 'No valid titles provided' });
      return;
    }
    const mapping = await resolveTitlesToSteamIds(cleanTitles);
    const resolvedIds = Object.values(mapping).filter(Boolean);
    if (resolvedIds.length === 0) {
      sendResponse({ success: true, data: {}, mapping });
      return;
    }
    const results = await fetchPricesBatch(resolvedIds, region);
    const rateLimit = await getRateLimitInfo();
    sendResponse({ success: true, data: results, mapping, rateLimit });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// Multi-result Steam search: returns ALL matching games with prices
async function handleSearchSteam(query, region, sendResponse) {
  try {
    if (!query || query.trim().length === 0) {
      sendResponse({ success: false, error: 'No query provided' });
      return;
    }
    const term = query.trim();
    const url = `${STEAM_SEARCH_URL}?term=${encodeURIComponent(term)}&l=english&cc=us`;
    const json = await fetchWithRetry(url, 2);

    if (!json.items || json.items.length === 0) {
      sendResponse({ success: true, data: {} });
      return;
    }

    // Get all result IDs (up to 10)
    const ids = json.items.map((item) => String(item.id));
    const results = await fetchPricesBatch(ids, region || 'us');
    const rateLimit = await getRateLimitInfo();
    sendResponse({ success: true, data: results, rateLimit });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function handleGetBundles(ids, region, sendResponse) {
  try {
    if (!Array.isArray(ids) || ids.length === 0) {
      sendResponse({ success: false, error: 'No IDs provided' });
      return;
    }
    const apiKey = await getApiKey();
    const url = `${BUNDLES_ENDPOINT}?ids=${ids.join(',')}&key=${apiKey}&region=${region || 'us'}`;
    const json = await fetchWithRetry(url);
    const rateLimit = await getRateLimitInfo();
    sendResponse({ ...json, rateLimit });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// ── Active Bundles ───────────────────────────────────────────────────────────

async function handleGetActiveBundles(region, sendResponse) {
  try {
    // Cache active bundles for 15 minutes
    if (activeBundlesCache.data && Date.now() - activeBundlesCache.timestamp < 15 * 60 * 1000) {
      const rateLimit = await getRateLimitInfo();
      sendResponse({ success: true, data: activeBundlesCache.data, rateLimit });
      return;
    }

    const apiKey = await getApiKey();
    const url = `${ACTIVE_BUNDLES_ENDPOINT}?key=${apiKey}&region=${region || 'us'}`;
    const json = await fetchWithRetry(url);
    const rateLimit = await getRateLimitInfo();

    if (json.success && json.data) {
      // API returns { data: { totalCount, bundles: [...] } }
      const bundles = json.data.bundles || [];
      activeBundlesCache = { data: bundles, timestamp: Date.now() };
      sendResponse({ success: true, data: bundles, rateLimit });
    } else {
      sendResponse({ success: false, error: json.error || 'Unknown error', rateLimit });
    }
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// ── Price batch fetching ─────────────────────────────────────────────────────

async function fetchPricesBatch(ids, region) {
  const apiKey = await getApiKey();
  region = region || 'us';
  const cacheKeyPrefix = `${region}:`;
  const results = {};
  const uncachedIds = [];

  for (const id of ids) {
    const cached = priceCache[cacheKeyPrefix + id];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      results[id] = cached.data;
    } else {
      uncachedIds.push(id);
    }
  }

  if (uncachedIds.length > 0) {
    for (let i = 0; i < uncachedIds.length; i += 100) {
      const batch = uncachedIds.slice(i, i + 100);
      const url = `${PRICES_ENDPOINT}?ids=${batch.join(',')}&key=${apiKey}&region=${region}`;

      const json = await fetchWithRetry(url);

      if (!validatePriceResponse(json)) {
        console.warn('Invalid price response shape:', json);
        continue;
      }

      if (json.success && json.data) {
        for (const [id, gameData] of Object.entries(json.data)) {
          results[id] = gameData;
          priceCache[cacheKeyPrefix + id] = { data: gameData, timestamp: Date.now() };
        }
      }
    }

    persistCache();
  }

  return results;
}

function persistCache() {
  const entries = Object.entries(priceCache)
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, 500);
  chrome.storage.local.set({ priceCache: Object.fromEntries(entries) });
}

// ── Title → Steam App ID resolution ─────────────────────────────────────────

let titleCache = {};

async function resolveTitlesToSteamIds(titles) {
  const mapping = {};
  const uncached = [];

  for (const title of titles) {
    const key = title.toLowerCase();
    if (titleCache[key] !== undefined) {
      mapping[title] = titleCache[key];
    } else {
      uncached.push(title);
    }
  }

  if (uncached.length === 0) return mapping;

  const BATCH_SIZE = 5;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (title) => {
        try {
          const url = `${STEAM_SEARCH_URL}?term=${encodeURIComponent(title)}&l=english&cc=us`;
          const json = await fetchWithRetry(url, 2);
          if (json.total > 0 && json.items && json.items.length > 0) {
            return { title, id: String(json.items[0].id) };
          }
          return { title, id: null };
        } catch {
          return { title, id: null };
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { title, id } = result.value;
        mapping[title] = id;
        titleCache[title.toLowerCase()] = id;
      }
    }
  }

  return mapping;
}

// ── API key helper ───────────────────────────────────────────────────────────

function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey'], (result) => {
      resolve(result.apiKey || DEFAULT_API_KEY);
    });
  });
}

// ── Wishlist background price checking ───────────────────────────────────────

chrome.alarms.create('checkWishlistPrices', { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkWishlistPrices') {
    checkWishlistPrices();
  }
});

async function checkWishlistPrices() {
  try {
    const result = await chrome.storage.local.get(['wishlist', 'notificationSettings']);
    const wishlist = result.wishlist || [];
    const settings = result.notificationSettings || { enabled: false };

    if (!settings.enabled) return;

    const alertItems = wishlist.filter((w) => w.alertEnabled);
    if (alertItems.length === 0) return;

    const ids = alertItems.map((w) => w.id);
    const prices = await fetchPricesBatch(ids, 'us');

    for (const item of alertItems) {
      const game = prices[item.id];
      if (!game || !game.prices) continue;

      const price = game.prices.currentRetail
        ? parseFloat(game.prices.currentRetail)
        : game.prices.currentKeyshops
          ? parseFloat(game.prices.currentKeyshops)
          : null;

      if (price !== null && !isNaN(price) && price < item.alertThreshold) {
        chrome.notifications.create(`price-drop-${item.id}-${Date.now()}`, {
          type: 'basic',
          iconUrl: 'images/icon-128.png',
          title: `Price Drop: ${game.title}`,
          message: `Now ${price} ${game.prices.currency} (Alert: ${item.alertThreshold})`,
        });
      }
    }
  } catch (e) {
    console.error('Wishlist price check failed:', e);
  }
}

// Clean up tab data when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete detectedGamesPerTab[tabId];
});
