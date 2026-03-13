// ── DOM refs ─────────────────────────────────────────────────────────────────
const searchBtn = document.getElementById('searchBtn');
const gameIdInput = document.getElementById('gameId');
const regionSelect = document.getElementById('region');
const searchResults = document.getElementById('searchResults');
const detectedResults = document.getElementById('detectedResults');
const scanBadge = document.getElementById('scanBadge');
const toastContainer = document.getElementById('toastContainer');
const rateLimitEl = document.getElementById('rateLimit');
const regionSettingSelect = document.getElementById('regionSetting');

let wishlist = [];
let priceHistory = {};
let notificationSettings = { enabled: false };
let recentSearches = [];
let syncEnabled = true; // chrome.storage.sync for cross-device
let userPrefs = {
  theme: 'light',
  accent: 'blue',
  compact: false,
  dealScores: true,
  overlay: true,
  autoCheckWishlist: false,
  checkFreq: 360,
  syncEnabled: true,
  region: 'us',
};

// ── i18n helper ──────────────────────────────────────────────────────────────

function t(key, ...subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

function initI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-placeholder'));
    if (msg) el.placeholder = msg;
  });
}
initI18n();

// ── Utility helpers ──────────────────────────────────────────────────────────

function escapeHtml(t) {
  const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
}
function escapeAttr(t) {
  return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ── Toast notifications ──────────────────────────────────────────────────────

function showToast(message, type = 'info', duration = 2500) {
  const icons = { success: '✓', info: 'ℹ', warn: '⚠', error: '✕' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => { toast.classList.add('toast-out'); toast.addEventListener('animationend', () => toast.remove()); }, duration);
}

// ── Loading helpers ──────────────────────────────────────────────────────────

function showSkeleton(container, count = 3) {
  let h = ''; for (let i = 0; i < count; i++) h += '<div class="skeleton skeleton-card"></div>';
  container.innerHTML = h;
}

function showLoadingSpinner(container, text = null) {
  if (text === null) text = t('loading');
  container.innerHTML = `<div class="loading"><div class="spinner"></div><div class="loading-text">${escapeHtml(text)}</div></div>`;
}

// ── Rate limit ───────────────────────────────────────────────────────────────

function updateRateLimit(info) {
  if (!rateLimitEl || !info) return;
  const r = info.remaining;
  if (r === undefined || r === null) return;

  let resetText = '';
  if (info.reset) {
    const resetTime = info.reset * 1000;
    const now = Date.now();
    const diffMs = resetTime - now;
    if (diffMs > 0) {
      const mins = Math.ceil(diffMs / 60000);
      resetText = mins <= 1 ? '' : '';
    }
  }

  let apiText;
  if (info.reset) {
    const resetTime = info.reset * 1000;
    const diffMs = resetTime - Date.now();
    if (diffMs > 0) {
      const mins = Math.ceil(diffMs / 60000);
      apiText = mins <= 1 ? t('apiCallsLeftResetSoon', String(r)) : t('apiCallsLeftReset', String(r), String(mins));
    } else {
      apiText = t('apiCallsLeft', String(r));
    }
  } else {
    apiText = t('apiCallsLeft', String(r));
  }

  if (r < 10) {
    rateLimitEl.className = 'rate-limit low';
    rateLimitEl.innerHTML = `⚠️ ${escapeHtml(apiText)}. <a href="#" onclick="switchTab('settings')" style="color:inherit;text-decoration:underline">${escapeHtml(t('addKey'))}</a>`;
  } else if (r < 100) {
    rateLimitEl.className = 'rate-limit warn';
    rateLimitEl.textContent = apiText;
  } else {
    rateLimitEl.className = 'rate-limit ok';
    rateLimitEl.textContent = apiText;
  }
}

// ── Theme System ─────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-oled');
  if (theme === 'dark') document.body.classList.add('theme-dark');
  else if (theme === 'oled') document.body.classList.add('theme-oled');
  else if (theme === 'system') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.body.classList.add('theme-dark');
  }
}

function applyAccent(accent) {
  document.body.className = document.body.className.replace(/accent-\w+/g, '');
  if (accent && accent !== 'blue') document.body.classList.add(`accent-${accent}`);
}

function applyCompact(on) {
  document.body.classList.toggle('compact', on);
}

function applyAllPrefs() {
  applyTheme(userPrefs.theme);
  applyAccent(userPrefs.accent);
  applyCompact(userPrefs.compact);
}

function savePrefs() {
  chrome.storage.local.set({ userPrefs });
  if (userPrefs.syncEnabled) {
    try { chrome.storage.sync.set({ userPrefs }).catch(() => {}); } catch { /* sync unavailable */ }
  }
}

// ── Initialisation ───────────────────────────────────────────────────────────

// Load local data first (fast), then merge synced data on top
chrome.storage.local.get(
  ['wishlist', 'priceHistory', 'notificationSettings', 'lastRegion', 'apiKey', 'contextMenuAppId', 'rateLimitInfo', 'recentSearches', 'userPrefs'],
  (localResult) => {
    if (localResult.priceHistory) priceHistory = localResult.priceHistory;
    if (localResult.lastRegion) {
      regionSelect.value = localResult.lastRegion;
      if (regionSettingSelect) regionSettingSelect.value = localResult.lastRegion;
      userPrefs.region = localResult.lastRegion;
    } else if (userPrefs.region) {
      regionSelect.value = userPrefs.region;
      if (regionSettingSelect) regionSettingSelect.value = userPrefs.region;
    }
    if (localResult.rateLimitInfo) updateRateLimit(localResult.rateLimitInfo);
    if (localResult.recentSearches) recentSearches = localResult.recentSearches;
    if (localResult.userPrefs) userPrefs = { ...userPrefs, ...localResult.userPrefs };
    if (localResult.wishlist) wishlist = localResult.wishlist;
    if (localResult.notificationSettings) notificationSettings = localResult.notificationSettings;
    if (localResult.apiKey) document.getElementById('apiKeyInput').value = localResult.apiKey;

    // Merge synced cross-device data (wishlist, prefs, notifications, apiKey)
    try {
      chrome.storage.sync.get(['wishlist', 'notificationSettings', 'userPrefs', 'apiKey'], (syncResult) => {
        if (chrome.runtime.lastError) { finishInit(localResult); return; }

        // Sync preferences override local
        if (syncResult.userPrefs) userPrefs = { ...userPrefs, ...syncResult.userPrefs };

        // Merge wishlists: combine, deduplicate by ID, keep latest addedDate
        if (syncResult.wishlist && Array.isArray(syncResult.wishlist)) {
          const merged = new Map();
          for (const item of wishlist) merged.set(item.id, item);
          for (const item of syncResult.wishlist) {
            const existing = merged.get(item.id);
            if (!existing || new Date(item.addedDate) > new Date(existing.addedDate)) {
              merged.set(item.id, item);
            }
          }
          wishlist = Array.from(merged.values());
          // Save merged wishlist back to local
          chrome.storage.local.set({ wishlist });
        }

        if (syncResult.notificationSettings) notificationSettings = { ...notificationSettings, ...syncResult.notificationSettings };
        if (syncResult.apiKey) document.getElementById('apiKeyInput').value = syncResult.apiKey;

        finishInit(localResult);
      });
    } catch {
      finishInit(localResult);
    }
  }
);

function finishInit(result) {
  applyAllPrefs();

  if (result.contextMenuAppId) {
    chrome.storage.local.remove('contextMenuAppId');
    gameIdInput.value = result.contextMenuAppId;
    switchTab('search');
    performSearch();
  } else {
    loadDetectedGames();
  }
  loadRecentSearches();
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (userPrefs.theme === 'system') applyTheme('system');
});

// ── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((el) => el.classList.remove('active'));
  const panel = document.getElementById(tab + 'Tab');
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');

  if (tab === 'wishlist') displayWishlist();
  if (tab === 'settings') displaySettings();
  if (tab === 'bundles') loadActiveBundles();
  if (tab === 'search') loadRecentSearches();
}

// ── Detected games (auto-scan) ───────────────────────────────────────────────

/** Parse game title from repack-site URL when content script didn't run or returned nothing */
function parseRepackUrlGame(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.includes('fitgirl-repacks') && !host.includes('igg-games.com') && !host.includes('gog-games.com')) return null;
    const path = u.pathname || '';
    const segments = path.split('/').filter(Boolean);
    const skip = /^(games?|repack|download|category|tag|page|index|search)$/i;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!seg || skip.test(seg) || seg.length < 3) continue;
      const slug = seg.replace(/-repack$/i, '').replace(/-download$/i, '').replace(/-\d{4,}$/, '');
      const title = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
      if (title.length > 2) return { type: 'titles', titles: [title], store: host };
    }
  } catch (_) { }
  return null;
}

function loadDetectedGames() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id || !tab.url || tab.url.startsWith('chrome://')) {
        showDashboard();
        return;
      }
      showSkeleton(detectedResults, 2);
      let data = null;
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { action: 'scanPage' });
        if (resp) data = resp;
      } catch { /* content script not injected */ }
      // Fallback: detect from URL on repack sites (works when content script isn't loaded or fails)
      if (!data || ((!data.ids || data.ids.length === 0) && (!data.titles || data.titles.length === 0))) {
        const urlFallback = parseRepackUrlGame(tab.url);
        if (urlFallback) data = urlFallback;
      }
      if (data) {
        chrome.runtime.sendMessage({ action: 'gamesDetected', data, fromPopup: true }, () => { });
      }

      // For wishlist pages, wait for the full async fetch to complete
      const isWishlistPage = data?.pageType === 'wishlist' || tab.url.includes('/wishlist/');
      if (isWishlistPage) {
        showLoadingSpinner(detectedResults, t('loadingWishlist'));
        await waitForWishlistFetch(tab.id);
      } else {
        await waitForDetection(tab.id, data ? 1 : 0);
      }
      chrome.runtime.sendMessage({ action: 'getDetectedGames', tabId: tab.id }, (resp) => {
        if (!resp || !resp.appIds || resp.appIds.length === 0) {
          showDashboard();
          return;
        }
        const storeName = formatStoreName(resp.store);
        const isWishlist = resp.pageType === 'wishlist';
        const totalIds = resp.appIds;
        scanBadge.style.display = '';
        scanBadge.textContent = isWishlist
          ? (totalIds.length > 1 ? t('wishlistGamesCount', String(totalIds.length)) : t('wishlistGameCount', String(totalIds.length)))
          : (totalIds.length > 1 ? t('gamesFoundCount', String(totalIds.length)) : t('gameFoundCount', String(totalIds.length)));
        scanBadge.classList.remove('empty');

        // For large wishlists (50+ games), show a quick import option
        // instead of fetching all prices first (saves API calls)
        if (isWishlist && totalIds.length > 50) {
          renderLargeWishlistImport(totalIds, storeName, tab.id);
          return;
        }

        showLoadingSpinner(detectedResults, t('fetchingPrices'));
        chrome.runtime.sendMessage(
          { action: 'lookupByIds', ids: totalIds, region: regionSelect.value },
          (priceResp) => {
            if (priceResp && priceResp.rateLimit) updateRateLimit(priceResp.rateLimit);
            if (!priceResp || !priceResp.success) {
              detectedResults.innerHTML = `<div class="error"><span class="error-icon">⚠️</span><div><div>${friendlyError(priceResp?.error)}</div><div class="error-actions"><button class="btn-sm btn-outline" data-action="retryDetected">Retry</button></div></div></div>`;
              return;
            }
            const validEntries = Object.entries(priceResp.data).filter(([, v]) => v && v.prices);
            const validCount = validEntries.length;
            if (validCount !== totalIds.length) {
              scanBadge.textContent = isWishlist
                ? (validCount !== 1 ? t('wishlistGamesCount', String(validCount)) : t('wishlistGameCount', String(validCount)))
                : (validCount !== 1 ? t('gamesFoundCount', String(validCount)) : t('gameFoundCount', String(validCount)));
            }
            if (validCount === 0) {
              detectedResults.innerHTML = `<div class="empty"><span class="empty-icon">🔍</span>${escapeHtml(t('noPricingData'))}</div>`;
              return;
            }
            renderDetectedResults(validEntries, isWishlist, storeName);
          }
        );
      });
    });
  } catch (e) {
    showDashboard();
  }
}

function waitForWishlistFetch(tabId) {
  return new Promise((resolve) => {
    let attempts = 0;
    let lastCount = 0;
    let stableChecks = 0;

    const check = () => {
      // Ask the content script if the fetch is still running
      chrome.tabs.sendMessage(tabId, { action: 'getWishlistStatus' }, (status) => {
        if (chrome.runtime.lastError) { resolve(); return; }
        attempts++;

        // Update loading text with progress
        const count = status?.cachedCount || 0;
        if (count > 0) {
          showLoadingSpinner(detectedResults, t('loadingWishlistProgress', String(count)));
        }

        // Check if fetch is done
        if (status && !status.fetchInProgress && count > 0) {
          // Fetch complete — send the final data to background
          chrome.runtime.sendMessage({ action: 'getDetectedGames', tabId }, (resp) => {
            // If background has the updated count, we're done
            if (resp && resp.appIds && resp.appIds.length >= count * 0.9) {
              resolve();
            } else {
              // Background hasn't processed yet, wait a bit
              setTimeout(resolve, 1000);
            }
          });
          return;
        }

        // Track stability — if count hasn't changed for 3 checks, fetch may be stalled
        if (count === lastCount && count > 0) {
          stableChecks++;
          if (stableChecks >= 5) { resolve(); return; }
        } else {
          stableChecks = 0;
          lastCount = count;
        }

        if (attempts >= 60) { resolve(); return; } // Max 60 seconds
        setTimeout(check, 1000);
      });
    };

    setTimeout(check, 1500); // Initial delay for fetch to start
  });
}

function waitForDetection(tabId, expectedCount) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      chrome.runtime.sendMessage({ action: 'getDetectedGames', tabId }, (resp) => {
        attempts++;
        if (resp && resp.appIds && resp.appIds.length > 0) resolve();
        else if (attempts >= 30) resolve();
        else setTimeout(check, 1000);
      });
    };
    setTimeout(check, 500);
  });
}

function showDetectedEmpty(icon, message) {
  scanBadge.style.display = '';
  scanBadge.textContent = t('noPageScanned');
  scanBadge.classList.add('empty');
  detectedResults.innerHTML = `<div class="empty"><span class="empty-icon">${icon}</span>${escapeHtml(message)}</div>`;
}

function formatStoreName(store) {
  const names = { steam: t('storeSteam'), 'gg.deals': t('storeGgDeals'), 'store.epicgames.com': t('storeEpic'), 'www.gog.com': t('storeGog'), 'www.humblebundle.com': t('storeHumble'), 'www.fanatical.com': t('storeFanatical'), 'www.greenmangaming.com': t('storeGmg') };
  return names[store] || store || 'Unknown';
}

function friendlyError(err) {
  if (!err) return escapeHtml(t('errorGeneric'));
  const lower = err.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return escapeHtml(t('errorTimeout'));
  if (lower.includes('rate limit') || lower.includes('429')) return `<strong>${escapeHtml(t('errorRateLimit'))}</strong><br><br>${escapeHtml(t('errorRateLimitDesc'))}`;
  if (lower.includes('authentication') || lower.includes('401')) return escapeHtml(t('errorInvalidKey'));
  if (lower.includes('not found') || lower.includes('404')) return escapeHtml(t('errorNotFound'));
  return escapeHtml(t('errorGeneric'));
}

// ── Large wishlist import (50+ games) ────────────────────────────────────────

function renderLargeWishlistImport(allIds, storeName, tabId) {
  const alreadyInWishlist = allIds.filter((id) => wishlist.some((w) => w.id === id));
  const newIds = allIds.filter((id) => !wishlist.some((w) => w.id === id));

  let html = `<div class="detected-header">
    <h3>${escapeHtml(t('yourWishlist'))}</h3>
    <span class="detected-store">${escapeHtml(storeName)}</span>
  </div>
  <div style="padding:12px 0">
    <div style="font-size:0.85rem;margin-bottom:12px">
      ${escapeHtml(t('foundGamesInWishlist', String(allIds.length)))}
      ${alreadyInWishlist.length > 0 ? `<br><span style="color:var(--gg-text-muted)">${escapeHtml(t('alreadyTracked', String(alreadyInWishlist.length)))}</span>` : ''}
    </div>`;

  if (newIds.length > 0) {
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button class="btn-sm btn-green" id="importAllWishlistBtn">${escapeHtml(t('importAllToWishlist', String(newIds.length)))}</button>
      <button class="btn-sm btn-outline" id="previewWishlistBtn">${escapeHtml(t('previewWithPrices', String(Math.ceil(allIds.length / 100))))}</button>
    </div>`;
  } else {
    html += `<div style="font-size:0.8rem;color:var(--gg-green);margin-bottom:12px">${escapeHtml(t('allAlreadyInWishlist', String(allIds.length)))}</div>
    <button class="btn-sm btn-outline" id="previewWishlistBtn">${escapeHtml(t('viewPrices', String(Math.ceil(allIds.length / 100))))}</button>`;
  }

  html += `</div>`;
  detectedResults.innerHTML = html;

  // Import button — adds all IDs to wishlist without fetching prices
  const importBtn = document.getElementById('importAllWishlistBtn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      let added = 0;
      for (const id of newIds) {
        wishlist.push({
          id: String(id),
          title: `Steam App ${id}`,
          addedPrice: null,
          addedDate: new Date().toISOString(),
          alertEnabled: false,
          alertThreshold: null,
        });
        added++;
      }
      saveData();
      importBtn.disabled = true;
      importBtn.textContent = t('importedGames', String(added));
      importBtn.classList.remove('btn-green');
      importBtn.classList.add('btn-outline');
      showToast(t('importedGoToWishlist', String(added)), 'success', 4000);
    });
  }

  // Preview button — fetches prices for all detected games
  const previewBtn = document.getElementById('previewWishlistBtn');
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      previewBtn.disabled = true;
      previewBtn.textContent = t('loadingPrices');
      showLoadingSpinner(detectedResults, t('fetchingPricesCount', String(allIds.length)));
      chrome.runtime.sendMessage(
        { action: 'lookupByIds', ids: allIds, region: regionSelect.value },
        (priceResp) => {
          if (priceResp && priceResp.rateLimit) updateRateLimit(priceResp.rateLimit);
          if (!priceResp || !priceResp.success) {
            detectedResults.innerHTML = `<div class="error"><span class="error-icon">⚠️</span><div><div>${friendlyError(priceResp?.error)}</div><div class="error-actions"><button class="btn-sm btn-outline" data-action="retryDetected">Retry</button></div></div></div>`;
            return;
          }
          const validEntries = Object.entries(priceResp.data).filter(([, v]) => v && v.prices);
          if (validEntries.length === 0) {
            detectedResults.innerHTML = `<div class="empty"><span class="empty-icon">🔍</span>${escapeHtml(t('noPricingDataShort'))}</div>`;
            return;
          }
          // Update any imported items with real titles
          for (const [id, game] of validEntries) {
            const wl = wishlist.find((w) => w.id === id);
            if (wl && wl.title.startsWith('Steam App ') && game.title) {
              wl.title = game.title;
              const best = getBestPrice(game.prices);
              if (wl.addedPrice === null) { wl.addedPrice = best; wl.alertThreshold = best; }
            }
          }
          saveData();
          scanBadge.textContent = validEntries.length !== 1 ? t('wishlistGamesCount', String(validEntries.length)) : t('wishlistGameCount', String(validEntries.length));
          renderDetectedResults(validEntries, true, storeName);
        }
      );
    });
  }
}

function renderDetectedResults(validEntries, isWishlistPage, storeName) {
  const headerTitle = isWishlistPage ? t('yourWishlist') : t('detectedOnPage');

  const notInWishlist = validEntries.filter(([id]) => !wishlist.some((w) => w.id === id));
  const importBtnHtml = isWishlistPage && notInWishlist.length > 0
    ? `<button class="btn-sm btn-green" id="importAllWishlistBtn">${escapeHtml(t('importToWishlist', String(notInWishlist.length)))}</button>`
    : isWishlistPage && notInWishlist.length === 0
      ? `<span style="font-size:0.75rem;color:var(--gg-text-muted)">${escapeHtml(t('allInWishlist'))}</span>`
      : '';

  let html = `<div class="detected-header">
    <h3>${escapeHtml(headerTitle)}</h3>
    <div style="display:flex;align-items:center;gap:8px">
      ${importBtnHtml}
      <span class="detected-store">${escapeHtml(storeName)}</span>
    </div>
  </div>`;
  for (const [id, game] of validEntries) html += renderGameCard(id, game);
  detectedResults.innerHTML = html;
  attachCardListeners(detectedResults);

  const importBtn = document.getElementById('importAllWishlistBtn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      let added = 0;
      for (const [id, game] of validEntries) {
        if (wishlist.some((w) => w.id === id)) continue;
        const best = getBestPrice(game.prices);
        wishlist.push({
          id: String(id),
          title: game.title || 'Unknown',
          addedPrice: best,
          addedDate: new Date().toISOString(),
          alertEnabled: false,
          alertThreshold: best,
        });
        added++;
      }
      saveData();
      importBtn.disabled = true;
      importBtn.textContent = t('importedGames', String(added));
      importBtn.classList.remove('btn-green');
      importBtn.classList.add('btn-outline');
      showToast(t('importedToWishlist', String(added)), 'success');

      detectedResults.querySelectorAll('.add-wl-btn').forEach((btn) => {
        if (wishlist.some((w) => w.id === btn.dataset.id)) {
          btn.textContent = `♥ ${t('wishlisted')}`;
          btn.classList.remove('btn-green', 'add-wl-btn');
          btn.classList.add('btn-danger', 'remove-wl-btn');
        }
      });
      attachCardListeners(detectedResults);
    });
  }
}

// ── Smart Deal Dashboard ─────────────────────────────────────────────────────

function showDashboard() {
  scanBadge.style.display = 'none';

  if (wishlist.length === 0) {
    detectedResults.innerHTML = `
      <div class="empty">
        <span class="empty-icon">🎮</span>
        ${escapeHtml(t('emptyDashboard'))}<br>
        ${escapeHtml(t('emptyDashboardHint'))}
      </div>`;
    return;
  }

  // Check rate limit before attempting to load — don't waste a call if we're at 0
  chrome.storage.local.get(['rateLimitInfo'], (stored) => {
    const rl = stored.rateLimitInfo;
    if (rl && rl.remaining !== undefined && rl.remaining <= 0) {
      renderCachedDashboard(rl);
      return;
    }
    loadDashboardData();
  });
}

function renderCachedDashboard(rl) {
  const gamesWithPrices = wishlist.filter((w) => w.lastPrice != null);

  let resetMsg = '';
  if (rl && rl.reset) {
    const mins = Math.ceil((rl.reset * 1000 - Date.now()) / 60000);
    if (mins > 0) resetMsg = ' ' + t('resetsIn', String(mins));
  }
  if (rl) updateRateLimit(rl);

  let html = `<div class="dashboard-section">
    <div class="dashboard-section-header" style="color:var(--gg-orange)">
      <span class="dash-icon">⏳</span> ${escapeHtml(t('rateLimitReached'))}${escapeHtml(resetMsg)}
      <button class="btn-sm btn-outline" data-action="retryDashboard" style="margin-left:auto">${escapeHtml(t('retry'))}</button>
    </div>
  </div>`;

  if (gamesWithPrices.length === 0) {
    html += `<div class="empty"><span class="empty-icon">📊</span>
      ${escapeHtml(t('noCachedData'))}<br>${escapeHtml(t('noCachedDataDesc'))}</div>`;
    detectedResults.innerHTML = html;
    return;
  }

  html += `<div class="dashboard-section">
    <div class="dashboard-section-header"><span class="dash-icon">📊</span> ${escapeHtml(t('trackedGamesOf', String(gamesWithPrices.length), String(wishlist.length)))}</div>`;

  for (const g of gamesWithPrices) {
    let statusTag = '';
    if (g.addedPrice != null && g.lastPrice != null) {
      const diff = g.lastPrice - g.addedPrice;
      if (diff < -0.01) {
        const pct = ((Math.abs(diff) / g.addedPrice) * 100).toFixed(0);
        statusTag = `<span class="pill-badge pill-discount">▼ ${pct}%</span>`;
      } else if (diff > 0.01) {
        statusTag = `<span class="pill-badge pill-higher">▲ ${escapeHtml(t('pillHigher'))}</span>`;
      } else {
        statusTag = `<span class="pill-badge pill-same">— ${escapeHtml(t('pillSame'))}</span>`;
      }
    }

    const imgSrc = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.id}/header.jpg`;
    const priceStr = `${g.lastPrice} ${g.lastCurrency || 'USD'}`;

    html += `<div class="dashboard-mini-card" data-action="searchGame" data-id="${g.id}">
      <img class="dashboard-mini-img" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(g.title)}">
      <div class="dashboard-mini-info">
        <div class="dashboard-mini-title">${escapeHtml(g.title)}</div>
        <div class="dashboard-mini-prices">
          <div class="dashboard-mini-price">${escapeHtml(priceStr)}</div>
        </div>
        <div class="dashboard-mini-meta">${statusTag}</div>
      </div>
    </div>`;
  }
  html += '</div>';

  detectedResults.innerHTML = html;
}

function loadDashboardData() {
  showLoadingSpinner(detectedResults, t('buildingDashboard'));

  const ids = wishlist.map((w) => w.id);
  chrome.runtime.sendMessage({ action: 'lookupByIds', ids, region: regionSelect.value }, (resp) => {
    if (resp && resp.rateLimit) updateRateLimit(resp.rateLimit);
    if (!resp || !resp.success) {
      // Fall back to cached data if available
      const gamesWithPrices = wishlist.filter((w) => w.lastPrice != null);
      if (gamesWithPrices.length > 0) {
        renderCachedDashboard(resp?.rateLimit || null);
        return;
      }
      const errMsg = friendlyError(resp?.error);
      detectedResults.innerHTML = `
        <div class="empty"><span class="empty-icon">⚠️</span>
        ${errMsg}<br>
        <button class="btn-sm btn-outline" data-action="retryDashboard" style="margin-top:8px">Retry</button></div>`;
      return;
    }

    const priceDrops = [];
    const historicalLows = [];
    const allGames = [];

    for (const item of wishlist) {
      const game = resp.data[item.id];
      if (!game || !game.prices) continue;
      const best = getBestPrice(game.prices);
      const currency = game.prices.currency || 'USD';
      if (best === null) continue;

      const score = calculateDealScore(game.prices, false);

      // Update stored price
      item.lastPrice = best;
      item.lastCurrency = currency;

      const entry = { ...item, currentPrice: best, currency, game, score };

      // Check price drop
      if (item.addedPrice != null && best < item.addedPrice - 0.01) {
        entry.diff = item.addedPrice - best;
        priceDrops.push(entry);
      }

      // Check historical low
      const histLow = Math.min(
        game.prices.historicalRetail ? parseFloat(game.prices.historicalRetail) : Infinity,
        game.prices.historicalKeyshops ? parseFloat(game.prices.historicalKeyshops) : Infinity
      );
      if (histLow !== Infinity && best <= histLow * 1.05) {
        entry.histLow = histLow;
        entry.isHistLow = true;
        historicalLows.push(entry);
      }

      allGames.push(entry);
    }
    saveData(); // persist updated prices

    let html = '';

    // Section 1: Price Drops
    if (priceDrops.length > 0) {
      priceDrops.sort((a, b) => b.diff - a.diff);
      html += `<div class="dashboard-section">
        <div class="dashboard-section-header"><span class="dash-icon">📉</span> ${escapeHtml(t('priceDropsSinceAdded'))}</div>`;
      for (const d of priceDrops.slice(0, 5)) {
        const pct = ((d.diff / d.addedPrice) * 100).toFixed(0);
        let scoreHtml = '';
        if (userPrefs.dealScores && d.score !== null) {
          scoreHtml = `
            <div class="dashboard-mini-score-col">
              <span class="dashboard-mini-score-label">${escapeHtml(t('dealScoreLabel'))}</span>
              ${dealScoreBadge(d.score)}
            </div>
          `;
        }

        const p = d.game.prices;
        const retail = p.currentRetail ? parseFloat(p.currentRetail) : null;
        const keyshop = p.currentKeyshops ? parseFloat(p.currentKeyshops) : null;
        let sub = '';
        if (retail !== null && keyshop !== null) sub = `<div class="dashboard-mini-subprice">🏪 ${retail} · 🔑 ${keyshop} ${d.currency}</div>`;

        const imgSrc = (d.game && d.game.info && d.game.info.image) ? d.game.info.image : 'images/icon-48.png';

        html += `<div class="dashboard-mini-card" data-action="searchGame" data-id="${d.id}">
          <img class="dashboard-mini-img" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(d.title)}">
          <div class="dashboard-mini-info">
            <div class="dashboard-mini-title">${escapeHtml(d.title)}</div>
            <div class="dashboard-mini-prices">
              <div class="dashboard-mini-price">${d.currentPrice} ${d.currency}</div>
              ${sub}
            </div>
            <div class="dashboard-mini-meta">
              <span class="pill-badge pill-discount">▼ ${pct}%</span>
              <span style="font-size:0.65rem;color:var(--gg-text-muted)">${escapeHtml(t('wasPrice', String(d.addedPrice)))}</span>
            </div>
          </div>
          ${scoreHtml}
        </div>`;
      }
      html += '</div>';
    }

    // Section 2: Historical Lows
    if (historicalLows.length > 0) {
      html += `<div class="dashboard-section">
        <div class="dashboard-section-header"><span class="dash-icon">⭐</span> ${escapeHtml(t('atHistoricalLow'))}</div>`;
      for (const h of historicalLows.slice(0, 5)) {
        let scoreHtml = '';
        if (userPrefs.dealScores && h.score !== null) {
          scoreHtml = `
            <div class="dashboard-mini-score-col">
              <span class="dashboard-mini-score-label">${escapeHtml(t('dealScoreLabel'))}</span>
              ${dealScoreBadge(h.score)}
            </div>
          `;
        }

        const p = h.game.prices;
        const retail = p.currentRetail ? parseFloat(p.currentRetail) : null;
        const keyshop = p.currentKeyshops ? parseFloat(p.currentKeyshops) : null;
        let sub = '';
        if (retail !== null && keyshop !== null) sub = `<div class="dashboard-mini-subprice">🏪 ${retail} · 🔑 ${keyshop} ${h.currency}</div>`;

        const imgSrc = (h.game && h.game.info && h.game.info.image) ? h.game.info.image : 'images/icon-48.png';

        html += `<div class="dashboard-mini-card" data-action="searchGame" data-id="${h.id}">
          <img class="dashboard-mini-img" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(h.title)}">
          <div class="dashboard-mini-info">
            <div class="dashboard-mini-title">${escapeHtml(h.title)}</div>
            <div class="dashboard-mini-prices">
              <div class="dashboard-mini-price">${h.currentPrice} ${h.currency}</div>
              ${sub}
            </div>
            <div class="dashboard-mini-meta">
              <span class="pill-badge pill-low">⭐ Low</span>
              <span style="font-size:0.65rem;color:var(--gg-text-muted)">${escapeHtml(t('histLow', String(h.histLow)))}</span>
            </div>
          </div>
          ${scoreHtml}
        </div>`;
      }
      html += '</div>';
    }

    // Section 3: All tracked games with current prices — ALWAYS shown
    html += `<div class="dashboard-section">
      <div class="dashboard-section-header"><span class="dash-icon">📊</span> ${escapeHtml(t('trackedGames', String(allGames.length)))}</div>`;
    for (const g of allGames) {
      let statusTag = '';
      if (g.diff && g.diff > 0) {
        const pct = ((g.diff / g.addedPrice) * 100).toFixed(0);
        statusTag = `<span class="pill-badge pill-discount">▼ ${pct}%</span>`;
      } else if (g.addedPrice != null && g.currentPrice > g.addedPrice + 0.01) {
        statusTag = `<span class="pill-badge pill-higher">▲ ${escapeHtml(t('pillHigher'))}</span>`;
      } else if (g.addedPrice != null) {
        statusTag = `<span class="pill-badge pill-same">— ${escapeHtml(t('pillSame'))}</span>`;
      }
      if (g.isHistLow) {
        statusTag += `<span class="pill-badge pill-low">⭐ ${escapeHtml(t('pillLow'))}</span>`;
      }

      let scoreHtml = '';
      if (userPrefs.dealScores && g.score !== null) {
        scoreHtml = `
          <div class="dashboard-mini-score-col">
            <span class="dashboard-mini-score-label">${escapeHtml(t('dealScoreLabel'))}</span>
            ${dealScoreBadge(g.score)}
          </div>
        `;
      }

      // Get official + keyshop prices for breakdown
      const p = g.game.prices;
      const retail = p.currentRetail ? parseFloat(p.currentRetail) : null;
      const keyshop = p.currentKeyshops ? parseFloat(p.currentKeyshops) : null;

      let subpriceHtml = '';
      if (retail !== null && keyshop !== null) {
        subpriceHtml = `<div class="dashboard-mini-subprice">🏪 ${retail} · 🔑 ${keyshop} ${g.currency}</div>`;
      } else if (retail !== null) {
        subpriceHtml = `<div class="dashboard-mini-subprice">🏪 ${escapeHtml(t('official'))}: ${retail} ${g.currency}</div>`;
      } else if (keyshop !== null) {
        subpriceHtml = `<div class="dashboard-mini-subprice">🔑 ${escapeHtml(t('keyshop'))}: ${keyshop} ${g.currency}</div>`;
      }

      // Extract image URL from GG.deals API response, or fallback to exact Steam cover art
      const imgSrc = (g.game && g.game.info && g.game.info.image)
        ? g.game.info.image
        : `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.id}/header.jpg`;

      html += `<div class="dashboard-mini-card" data-action="searchGame" data-id="${g.id}">
        <img class="dashboard-mini-img" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(g.title)}">
        <div class="dashboard-mini-info">
          <div class="dashboard-mini-title">${escapeHtml(g.title)}</div>
          <div class="dashboard-mini-prices">
            <div class="dashboard-mini-price">${g.currentPrice} ${g.currency}</div>
            ${subpriceHtml}
          </div>
          <div class="dashboard-mini-meta">
            ${statusTag}
          </div>
        </div>
        ${scoreHtml}
      </div>`;
    }
    html += '</div>';

    detectedResults.innerHTML = html;
  });
}
window.showDashboard = showDashboard;

// ── Manual search ────────────────────────────────────────────────────────────

let searchDebounce = null;
searchBtn.addEventListener('click', performSearch);
gameIdInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') performSearch(); });
gameIdInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  if (gameIdInput.value.trim().length >= 3) searchDebounce = setTimeout(performSearch, 800);
});

function loadRecentSearches() {
  const container = document.getElementById('recentSearchesContainer');
  if (!container) return;
  if (recentSearches.length === 0) {
    container.innerHTML = `<div style="font-size:0.78rem;color:var(--gg-text-muted);padding:4px 0">${escapeHtml(t('noRecentSearches'))}</div>`;
    return;
  }
  let h = '';
  for (const item of recentSearches.slice(0, 6)) {
    h += `<button class="quick-btn recent-search-btn" data-query="${escapeAttr(item)}">${escapeHtml(item)}</button>`;
  }
  container.innerHTML = h;
  container.querySelectorAll('.recent-search-btn').forEach((btn) => {
    btn.addEventListener('click', () => { gameIdInput.value = btn.dataset.query; performSearch(); });
  });
}

function addRecentSearch(query) {
  recentSearches = recentSearches.filter((s) => s.toLowerCase() !== query.toLowerCase());
  recentSearches.unshift(query);
  recentSearches = recentSearches.slice(0, 10);
  chrome.storage.local.set({ recentSearches });
  loadRecentSearches();
}

async function performSearch() {
  clearTimeout(searchDebounce);
  const query = gameIdInput.value.trim();
  if (!query) { searchResults.innerHTML = `<div class="error"><span class="error-icon">✏️</span><span>${escapeHtml(t('errorEnterQuery'))}</span></div>`; return; }
  if (query.length > 200) { searchResults.innerHTML = `<div class="error"><span class="error-icon">⚠️</span><span>${escapeHtml(t('errorQueryTooLong'))}</span></div>`; return; }

  chrome.storage.local.set({ lastRegion: regionSelect.value });
  showLoadingSpinner(searchResults, t('searching'));
  searchBtn.disabled = true;
  addRecentSearch(query);

  const region = regionSelect.value;
  const isNumeric = /^\d+$/.test(query);

  if (isNumeric) {
    chrome.runtime.sendMessage({ action: 'lookupByIds', ids: [query], region }, handleSearchCb);
  } else {
    chrome.runtime.sendMessage({ action: 'searchSteam', query, region }, handleSearchCb);
  }
}

function handleSearchCb(resp) {
  searchBtn.disabled = false;
  if (resp && resp.rateLimit) updateRateLimit(resp.rateLimit);
  handleSearchResponse(resp);
}

function handleSearchResponse(resp) {
  if (!resp || !resp.success) {
    searchResults.innerHTML = `<div class="error"><span class="error-icon">⚠️</span><div><div>${friendlyError(resp?.error)}</div><div class="error-actions"><button class="btn-sm btn-outline" data-action="retrySearch">Retry</button></div></div></div>`;
    return;
  }
  const entries = Object.entries(resp.data || {}).filter(([, v]) => v && v.prices);
  if (entries.length === 0) {
    searchResults.innerHTML = `<div class="empty"><span class="empty-icon">🔍</span>${escapeHtml(t('noSearchResults'))}</div>`;
    return;
  }
  let html = '';
  for (const [id, game] of entries) html += renderGameCard(id, game);
  searchResults.innerHTML = html;
  attachCardListeners(searchResults);
}

window.performSearch = performSearch;
window.loadDetectedGames = loadDetectedGames;
window.switchTab = switchTab;

// ── Deal Score ───────────────────────────────────────────────────────────────

function calculateDealScore(prices, hasBundles) {
  let score = 0;
  const retail = prices.currentRetail ? parseFloat(prices.currentRetail) : null;
  const keyshop = prices.currentKeyshops ? parseFloat(prices.currentKeyshops) : null;
  const histRetail = prices.historicalRetail ? parseFloat(prices.historicalRetail) : null;
  const histKey = prices.historicalKeyshops ? parseFloat(prices.historicalKeyshops) : null;
  const best = (retail !== null && keyshop !== null) ? Math.min(retail, keyshop) : (retail ?? keyshop);
  if (best === null) return null;

  // Discount weight (40%): how much cheaper vs retail
  if (retail !== null && keyshop !== null && keyshop < retail) {
    const discountPct = ((retail - keyshop) / retail);
    score += Math.min(discountPct * 100, 40);
  } else if (retail !== null && histRetail !== null && retail < histRetail) {
    const discountPct = ((histRetail - retail) / histRetail);
    score += Math.min(discountPct * 80, 40);
  }

  // Historical comparison (30%): how close to all-time low
  const histLow = Math.min(histRetail ?? Infinity, histKey ?? Infinity);
  if (histLow !== Infinity && best > 0) {
    const ratio = histLow / best;
    if (ratio >= 0.95) score += 30; // at or near historical low
    else if (ratio >= 0.7) score += 20;
    else if (ratio >= 0.5) score += 10;
  }

  // Price level (15%): absolute value perception
  if (best <= 1) score += 15;
  else if (best <= 5) score += 12;
  else if (best <= 15) score += 8;
  else if (best <= 30) score += 4;

  // Bundle bonus (15%)
  if (hasBundles) score += 15;

  return Math.min(Math.round(score), 100);
}

function dealScoreBadge(score) {
  if (!userPrefs.dealScores || score === null) return '';
  let cls = 'score-wait', label = t('dealScoreWait');
  if (score >= 86) { cls = 'score-amazing'; label = t('dealScoreAmazing'); }
  else if (score >= 61) { cls = 'score-good'; label = t('dealScoreGood'); }
  else if (score >= 31) { cls = 'score-ok'; label = t('dealScoreOk'); }
  return `<div class="deal-score ${cls}" title="${escapeHtml(t('dealScoreTitle', String(score), label))}">
    ${score}<span class="deal-score-label">${escapeHtml(label)}</span></div>`;
}

// ── Render game card ─────────────────────────────────────────────────────────

function renderGameCard(id, game) {
  const p = game.prices;
  const currency = p.currency || 'USD';
  const currentRetail = p.currentRetail ? parseFloat(p.currentRetail) : null;
  const currentKey = p.currentKeyshops ? parseFloat(p.currentKeyshops) : null;
  const histRetail = p.historicalRetail ? parseFloat(p.historicalRetail) : null;
  const histKey = p.historicalKeyshops ? parseFloat(p.historicalKeyshops) : null;

  let retailDiscount = '', keyDiscount = '', bestDealIsKey = false;
  if (currentRetail !== null && histRetail !== null && currentRetail < histRetail) {
    const pct = (((histRetail - currentRetail) / histRetail) * 100).toFixed(0);
    if (parseFloat(pct) >= 1) retailDiscount = pct;
  }
  if (currentKey !== null && currentRetail !== null && currentKey < currentRetail) {
    const pct = (((currentRetail - currentKey) / currentRetail) * 100).toFixed(0);
    if (parseFloat(pct) >= 1) keyDiscount = pct;
    bestDealIsKey = true;
  }

  const score = calculateDealScore(p, false);

  function priceCol(label, value, discPct, isBest) {
    if (value === null || value === undefined) return `<div class="price-col"><div class="price-col-label">${label}</div><div class="price-col-value na">—</div></div>`;
    let badges = '';
    if (discPct) badges += `<span class="discount-badge">-${discPct}%</span>`;
    if (isBest) badges += `<span class="best-deal-tag">${escapeHtml(t('bestDeal'))}</span>`;
    return `<div class="price-col"><div class="price-col-label">${label}</div><div class="price-col-value has-price">${value} ${currency}${badges}</div></div>`;
  }

  let histHtml = '';
  if (histRetail !== null || histKey !== null) {
    histHtml = `<div class="historical-row">
      <div class="hist-col"><div class="hist-label">${escapeHtml(t('historicalLowRetail'))}</div><div class="hist-value${histRetail === null ? ' na' : ''}">${histRetail !== null ? histRetail + ' ' + currency : '—'}</div></div>
      <div class="hist-col"><div class="hist-label">${escapeHtml(t('historicalLowKeyshop'))}</div><div class="hist-value${histKey === null ? ' na' : ''}">${histKey !== null ? histKey + ' ' + currency : '—'}</div></div>
    </div>`;
  }

  const isHistLow = (histRetail !== null && currentRetail !== null && currentRetail <= histRetail) ||
    (histKey !== null && currentKey !== null && currentKey <= histKey);
  const histLowTag = isHistLow ? `<div class="historical-low-tag">⭐ ${escapeHtml(t('atHistoricalLowTag'))}</div>` : '';

  const history = priceHistory[id] || [];
  const chartHtml = history.length > 1 ? generateChart(history, currency) : '';
  const inWishlist = wishlist.some((w) => w.id === id);

  const imgSrc = (game.info && game.info.image)
    ? game.info.image
    : `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;

  return `<div class="game-card" data-game-id="${id}">
    <div class="game-card-body">
      <img class="game-card-img" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(game.title || '')}">
      <div class="game-card-content">
        <div class="game-title-row">
          <div class="game-title">${escapeHtml(game.title || 'Unknown')}</div>
          ${dealScoreBadge(score)}
        </div>
        <div class="price-section">
          ${priceCol(t('officialStores'), p.currentRetail, retailDiscount, !bestDealIsKey && retailDiscount)}
          ${priceCol(t('keyshops'), p.currentKeyshops, keyDiscount, bestDealIsKey)}
        </div>
        ${histHtml}${histLowTag}${chartHtml}
      </div>
    </div>
    <div class="game-actions">
      <button class="btn-sm ${inWishlist ? 'btn-danger remove-wl-btn' : 'btn-green add-wl-btn'}" data-id="${id}" data-title="${escapeAttr(game.title || '')}" data-price="${getBestPrice(p) || ''}">
        ${inWishlist ? `♥ ${escapeHtml(t('wishlisted'))}` : `♡ ${escapeHtml(t('wishlistBtn'))}`}
      </button>
      <button class="btn-sm btn-outline bundle-btn" data-id="${id}">📦 ${escapeHtml(t('bundlesBtn'))}</button>
      ${game.url ? `<a class="game-link" href="${game.url}" target="_blank" rel="noopener">${escapeHtml(t('viewOnGgDeals'))}</a>` : ''}
    </div>
    <div class="bundle-container" id="bundleContainer_${id}"></div>
  </div>`;
}

function generateChart(history, currency) {
  if (!history || history.length < 2) return '';
  const prices = history.map((h) => h.price);
  const max = Math.max(...prices), min = Math.min(...prices);
  const range = max - min || 1;
  let bars = '';
  for (const h of history.slice(-20)) {
    const pct = ((h.price - min) / range) * 100;
    bars += `<div class="chart-bar" style="height:${Math.max(pct, 8)}%" title="${h.price} ${currency}"></div>`;
  }
  return `<div class="chart-container"><div class="chart-label">${escapeHtml(t('priceHistory'))}</div><div class="chart-bars">${bars}</div><div class="chart-range">${min} — ${max} ${currency}</div></div>`;
}

// ── Card event listeners ─────────────────────────────────────────────────────

function attachCardListeners(container) {
  container.querySelectorAll('.add-wl-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      addToWishlist(btn.dataset.id, btn.dataset.title, parseFloat(btn.dataset.price) || null);
      btn.textContent = `♥ ${t('wishlisted')}`;
      btn.classList.remove('btn-green', 'add-wl-btn');
      btn.classList.add('btn-danger', 'remove-wl-btn');
      showToast(t('addedToWishlist', btn.dataset.title), 'success');
    });
  });
  container.querySelectorAll('.remove-wl-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      removeFromWishlist(btn.dataset.id);
      btn.textContent = `♡ ${t('wishlistBtn')}`;
      btn.classList.remove('btn-danger', 'remove-wl-btn');
      btn.classList.add('btn-green', 'add-wl-btn');
      showToast(t('removedFromWishlist'), 'info');
    });
  });
  container.querySelectorAll('.bundle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const bc = document.getElementById(`bundleContainer_${id}`);
      if (!bc) return;
      if (bc.innerHTML.trim()) { bc.innerHTML = ''; return; }
      bc.innerHTML = '<div class="loading" style="padding:8px"><div class="spinner"></div></div>';
      chrome.runtime.sendMessage({ action: 'getBundles', ids: [id], region: regionSelect.value }, (resp) => {
        if (!resp || !resp.success || !resp.data?.[id]?.bundles?.length) {
          bc.innerHTML = `<div style="font-size:0.78rem;color:var(--gg-text-muted);padding:8px 0">${escapeHtml(t('noActiveBundlesGame'))}</div>`;
          return;
        }
        let h = '';
        for (const b of resp.data[id].bundles.slice(0, 3)) {
          h += `<div class="bundle-card"><div class="bundle-title">${escapeHtml(b.title)}</div>`;
          for (const tr of b.tiers) h += `<div class="bundle-tier"><span class="bundle-price">${tr.price} ${tr.currency}</span> · ${tr.gamesCount || '?'} ${t('games')}</div>`;
          if (b.url) h += `<a class="game-link" href="${b.url}" target="_blank" rel="noopener" style="display:block;margin-top:4px">${escapeHtml(t('viewBundle'))}</a>`;
          h += '</div>';
        }
        bc.innerHTML = h;
      });
    });
  });
}

// ── Active Bundles tab ───────────────────────────────────────────────────────

let bundlesLoaded = false;
function loadActiveBundles() {
  const container = document.getElementById('bundlesContent');
  if (bundlesLoaded && container.innerHTML.trim()) return;
  showLoadingSpinner(container, t('loadingBundles'));
  chrome.runtime.sendMessage({ action: 'getActiveBundles', region: regionSelect.value }, (resp) => {
    if (resp && resp.rateLimit) updateRateLimit(resp.rateLimit);
    if (!resp || !resp.success) {
      container.innerHTML = `<div class="error"><span class="error-icon">⚠️</span><div><div>${friendlyError(resp?.error)}</div><div class="error-actions"><button class="btn-sm btn-outline" data-action="retryBundles">Retry</button></div></div></div>`;
      return;
    }
    const bundles = resp.data || [];
    if (bundles.length === 0) {
      container.innerHTML = `<div class="empty"><span class="empty-icon">📦</span>${escapeHtml(t('noActiveBundlesNow'))}</div>`;
      return;
    }
    let h = `<div class="section-label" style="margin-bottom:10px">${escapeHtml(bundles.length !== 1 ? t('activeBundlesCount', String(bundles.length)) : t('activeBundleCount', String(bundles.length)))}</div>`;
    for (const b of bundles) {
      let expiryHtml = '';
      if (b.dateTo) {
        const days = Math.ceil((new Date(b.dateTo + ' UTC') - new Date()) / 86400000);
        if (days > 0) expiryHtml = `<div class="bundle-expiry">⏰ ${escapeHtml(days !== 1 ? t('daysLeft', String(days)) : t('dayLeft', String(days)))}</div>`;
      }

      // The API embeds the store name in the title: "Fanatical - Build your own bundle"
      let shopName = 'Store';
      let bundleTitle = b.title;
      const titleParts = b.title.split(' - ');
      if (titleParts.length > 1) {
        shopName = titleParts[0].trim();
        bundleTitle = titleParts.slice(1).join(' - ').trim();
      } else {
        // Fallback for titles without dashes
        shopName = b.title.split(' ')[0];
      }

      // Map common store keywords to their actual domains for accurate favicon fetching
      let domain = null;
      // GG.deals URLs often contain the retailer name even if the shopName acts as a publisher/tier name
      const s = shopName.toLowerCase() + ' ' + (b.url || '').toLowerCase();

      if (s.includes('humble')) domain = 'humblebundle.com';
      else if (s.includes('fanatical')) domain = 'fanatical.com';
      else if (s.includes('indiegala')) domain = 'indiegala.com';
      else if (s.includes('steam')) domain = 'steampowered.com';
      else if (s.includes('epic')) domain = 'epicgames.com';
      else if (s.includes('gog')) domain = 'gog.com';
      else if (s.includes('digiphile')) domain = 'digiphile.co';
      else if (s.includes('cdkeys')) domain = 'cdkeys.com';
      else if (s.includes('greenman') || s.includes('gmg')) domain = 'greenmangaming.com';

      // Use Google's S2 Favicon service if domain is mapped, otherwise fallback to our clean branded icon
      // This prevents Google S2 from returning low-res blurry globes for unrecognized string guesses
      const storeLogoUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : 'images/icon-128.png';

      // Use the crisp store logo as the main image
      const imgSrc = b.image || storeLogoUrl;

      // Also create a tiny badge (only show the icon badge if we have a valid domain)
      const storeBadgeHtml = domain
        ? `<div class="active-bundle-store" style="display:flex;align-items:center;gap:4px;"><img src="${storeLogoUrl}" style="width:12px;height:12px;border-radius:2px;">${escapeHtml(shopName)}</div>`
        : `<div class="active-bundle-store">${escapeHtml(shopName)}</div>`;

      h += `<div class="active-bundle-card">
        <div class="active-bundle-body">
          <img class="active-bundle-img" style="background:#fff; padding:4px;" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(shopName)}">
          <div class="active-bundle-content">
            <div class="active-bundle-header"><div class="active-bundle-title" style="margin-right:8px">${escapeHtml(bundleTitle)}</div>${storeBadgeHtml}</div>
            <div class="active-bundle-tiers">`;

      if (b.tiers) for (const tr of b.tiers) h += `<div class="bundle-tier"><span class="bundle-price">${tr.price} ${tr.currency}</span> · ${tr.gamesCount || '?'} ${(tr.gamesCount || 0) > 1 ? t('games') : t('game')}</div>`;

      h += `</div>${expiryHtml}`;
      if (b.url) h += `<a class="game-link" href="${b.url}" target="_blank" rel="noopener" style="display:block;margin-top:6px">${escapeHtml(t('viewBundle'))}</a>`;
      h += `</div>
        </div>
      </div>`;
    }
    container.innerHTML = h;
    bundlesLoaded = true;
  });
}
window.loadActiveBundles = loadActiveBundles;

// ── Wishlist ─────────────────────────────────────────────────────────────────

function addToWishlist(id, title, price) {
  if (wishlist.some((w) => w.id === id)) return;
  wishlist.push({ id, title, addedPrice: price, addedDate: new Date().toISOString(), alertEnabled: false, alertThreshold: price });
  saveData();
}

function removeFromWishlist(id) {
  wishlist = wishlist.filter((w) => w.id !== id);
  saveData();
}

function displayWishlist() {
  const el = document.getElementById('wishlistContent');
  const headerEl = document.getElementById('wishlistHeader');

  if (wishlist.length === 0) {
    headerEl.innerHTML = '';
    el.innerHTML = `<div class="empty"><span class="empty-icon">♡</span>${escapeHtml(t('noWishlistGames'))}<br>${escapeHtml(t('noWishlistGamesHint'))}</div>`;
    return;
  }

  headerEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:6px;flex-wrap:wrap">
    <div class="section-label" style="margin-bottom:0">${escapeHtml(t('yourWishlistCount', String(wishlist.length)))}</div>
    <div style="display:flex;gap:6px">
      <button class="btn-sm btn-outline" id="exportWlBtn">📤 ${escapeHtml(t('exportBtn'))}</button>
      <button class="btn-sm btn-outline" id="importWlBtn">📥 ${escapeHtml(t('importBtn'))}</button>
      <button class="btn-sm btn-green" id="checkAllPricesBtn">${escapeHtml(t('checkAllPrices'))}</button>
    </div>
  </div>`;

  let html = '';
  for (const item of wishlist) {
    const dateStr = new Date(item.addedDate).toLocaleDateString();
    const lastKnown = item.lastPrice != null ? `${item.lastPrice} ${item.lastCurrency || 'USD'}` : null;

    // Use Steam CDN for crisp, guaranteed game cover art
    const imgSrc = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${item.id}/header.jpg`;

    html += `<div class="wishlist-item" data-wl-id="${item.id}">
      <div class="wishlist-header" data-wl-expand="${item.id}">
        <img class="wishlist-img" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(item.title)}">
        <div class="wishlist-header-info">
          <div class="wishlist-title">${escapeHtml(item.title)}</div>
          <div class="wishlist-meta"><span>${escapeHtml(t('addedOn', dateStr))}</span>${item.addedPrice != null ? `<span>${escapeHtml(t('atPrice', String(item.addedPrice)))}</span>` : ''}</div>
        </div>
        <div class="wishlist-price-badge ${lastKnown ? '' : 'unknown'}" id="wlPrice_${item.id}">${lastKnown || escapeHtml(t('clickToCheck'))}</div>
        <div class="wishlist-expand-icon">▼</div>
      </div>
      <div class="wishlist-detail"><div class="wishlist-detail-inner" id="wlDetail_${item.id}">
        <div class="loading" style="padding:12px"><div class="spinner"></div><div class="loading-text">Loading prices…</div></div>
      </div></div>
    </div>`;
  }
  el.innerHTML = html;

  // Expand/collapse
  el.querySelectorAll('.wishlist-header').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const id = hdr.dataset.wlExpand;
      const card = el.querySelector(`.wishlist-item[data-wl-id="${id}"]`);
      if (!card) return;
      const wasExpanded = card.classList.contains('expanded');
      card.classList.toggle('expanded');
      if (!wasExpanded) loadWishlistItemDetail(id);
    });
  });

  // Check All
  document.getElementById('checkAllPricesBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('checkAllPricesBtn');
    btn.disabled = true; btn.textContent = t('checking');
    chrome.runtime.sendMessage({ action: 'lookupByIds', ids: wishlist.map((w) => w.id), region: regionSelect.value }, (resp) => {
      btn.disabled = false; btn.textContent = t('checkAllPrices');
      if (resp?.rateLimit) updateRateLimit(resp.rateLimit);
      if (resp?.success) {
        let n = 0;
        let titlesUpdated = 0;
        for (const [id, game] of Object.entries(resp.data)) {
          if (!game?.prices) continue;
          n++;
          const best = getBestPrice(game.prices);
          const cur = game.prices.currency || 'USD';
          const badge = document.getElementById(`wlPrice_${id}`);
          if (badge && best !== null) { badge.textContent = `${best} ${cur}`; badge.classList.remove('unknown'); }
          const w = wishlist.find((w) => w.id === id);
          if (w) {
            w.lastPrice = best;
            w.lastCurrency = cur;
            // Update placeholder titles with real game names from GG.deals
            if (game.title && (w.title.startsWith('Steam App ') || w.title === 'Unknown')) {
              w.title = game.title;
              titlesUpdated++;
            }
            if (w.addedPrice === null && best !== null) {
              w.addedPrice = best;
              w.alertThreshold = best;
            }
          }
        }
        saveData();
        showToast(titlesUpdated > 0 ? t('pricesUpdatedTitles', String(n), String(titlesUpdated)) : t('pricesUpdated', String(n)), 'success');
        // Re-render the wishlist to show updated titles
        if (titlesUpdated > 0) displayWishlist();
      } else showToast(t('failedCheckPrices'), 'error');
    });
  });

  // Export
  document.getElementById('exportWlBtn')?.addEventListener('click', exportWishlist);
  // Import
  document.getElementById('importWlBtn')?.addEventListener('click', () => document.getElementById('importFileInput')?.click());
  document.getElementById('importFileInput')?.addEventListener('change', importWishlist);

  // Auto-check if enabled
  if (userPrefs.autoCheckWishlist) {
    document.getElementById('checkAllPricesBtn')?.click();
  }
}

function loadWishlistItemDetail(id) {
  const detailEl = document.getElementById(`wlDetail_${id}`);
  if (!detailEl) return;
  if (detailEl.querySelector('.price-section')) return; // already loaded

  detailEl.innerHTML = '<div class="loading" style="padding:12px"><div class="spinner"></div><div class="loading-text">Loading prices…</div></div>';

  chrome.runtime.sendMessage({ action: 'lookupByIds', ids: [id], region: regionSelect.value }, (resp) => {
    if (resp?.rateLimit) updateRateLimit(resp.rateLimit);
    if (!resp?.success || !resp.data[id]) {
      detailEl.innerHTML = `<div style="padding:8px 0"><div class="error" style="margin:0"><span class="error-icon">⚠️</span><div><div>${friendlyError(resp?.error)}</div><div class="error-actions"><button class="btn-sm btn-outline" data-action="retryWishlistDetail" data-id="${id}">Retry</button></div></div></div><div class="wishlist-actions"><button class="btn-sm btn-danger" data-action="removeWishlist" data-id="${id}">✕ Remove</button></div></div>`;
      return;
    }

    const game = resp.data[id], p = game.prices, currency = p.currency || 'USD';
    const currentRetail = p.currentRetail ? parseFloat(p.currentRetail) : null;
    const currentKey = p.currentKeyshops ? parseFloat(p.currentKeyshops) : null;
    const histRetail = p.historicalRetail ? parseFloat(p.historicalRetail) : null;
    const histKey = p.historicalKeyshops ? parseFloat(p.historicalKeyshops) : null;
    const best = getBestPrice(p);

    const badge = document.getElementById(`wlPrice_${id}`);
    if (badge && best !== null) { badge.textContent = `${best} ${currency}`; badge.classList.remove('unknown'); }

    const wl = wishlist.find((w) => w.id === id);
    if (wl) {
      wl.lastPrice = best;
      wl.lastCurrency = currency;
      if (game.title && (wl.title.startsWith('Steam App ') || wl.title === 'Unknown')) {
        wl.title = game.title;
        // Update the title in the header too
        const titleEl = document.querySelector(`.wishlist-item[data-wl-id="${id}"] .wishlist-title`);
        if (titleEl) titleEl.textContent = game.title;
      }
      if (wl.addedPrice === null && best !== null) {
        wl.addedPrice = best;
        wl.alertThreshold = best;
      }
      saveData();
    }

    let changeHtml = '';
    if (wl?.addedPrice != null && best !== null) {
      const diff = best - wl.addedPrice;
      if (diff < -0.01) changeHtml = `<span class="wishlist-price-change down">▼ ${escapeHtml(t('lowerBy', Math.abs(diff).toFixed(2)))}</span>`;
      else if (diff > 0.01) changeHtml = `<span class="wishlist-price-change up">▲ ${escapeHtml(t('higherBy', diff.toFixed(2)))}</span>`;
      else changeHtml = `<span class="wishlist-price-change same">— ${escapeHtml(t('samePrice'))}</span>`;
    }

    let retailDisc = '', keyDisc = '', bestIsKey = false;
    if (currentRetail !== null && histRetail !== null && currentRetail < histRetail) { const pct = (((histRetail - currentRetail) / histRetail) * 100).toFixed(0); if (+pct >= 1) retailDisc = pct; }
    if (currentKey !== null && currentRetail !== null && currentKey < currentRetail) { const pct = (((currentRetail - currentKey) / currentRetail) * 100).toFixed(0); if (+pct >= 1) keyDisc = pct; bestIsKey = true; }

    const pc = (lbl, val, disc, isBest) => {
      if (val == null) return `<div class="price-col"><div class="price-col-label">${lbl}</div><div class="price-col-value na">—</div></div>`;
      let b = ''; if (disc) b += `<span class="discount-badge">-${disc}%</span>`; if (isBest) b += `<span class="best-deal-tag">${escapeHtml(t('bestDeal'))}</span>`;
      return `<div class="price-col"><div class="price-col-label">${lbl}</div><div class="price-col-value has-price">${val} ${currency}${b}</div></div>`;
    };

    let histHtml = '';
    if (histRetail !== null || histKey !== null) {
      histHtml = `<div class="historical-row"><div class="hist-col"><div class="hist-label">${escapeHtml(t('historicalLowRetail'))}</div><div class="hist-value${histRetail === null ? ' na' : ''}">${histRetail != null ? histRetail + ' ' + currency : '—'}</div></div><div class="hist-col"><div class="hist-label">${escapeHtml(t('historicalLowKeyshop'))}</div><div class="hist-value${histKey === null ? ' na' : ''}">${histKey != null ? histKey + ' ' + currency : '—'}</div></div></div>`;
    }

    const score = calculateDealScore(p, false);
    const threshold = wl?.alertThreshold ?? best ?? '';

    detailEl.innerHTML = `<div style="padding-top:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">${changeHtml}${dealScoreBadge(score)}</div>
      <div class="price-section">${pc(t('officialStores'), p.currentRetail, retailDisc, !bestIsKey && retailDisc)}${pc(t('keyshops'), p.currentKeyshops, keyDisc, bestIsKey)}</div>
      ${histHtml}
      <div class="wishlist-alert-row">
        <input type="checkbox" class="toggle-switch" id="wlAlert_${id}" ${wl?.alertEnabled ? 'checked' : ''} />
        <label for="wlAlert_${id}" style="cursor:pointer">${escapeHtml(t('alertBelow'))}</label>
        <input type="number" id="wlThreshold_${id}" value="${threshold}" step="0.01" min="0" placeholder="Price" />
        <span style="color:var(--gg-text-muted);font-size:0.72rem">${currency}</span>
      </div>
      <div class="wishlist-actions">
        <button class="btn-sm btn-outline" id="wlBundleBtn_${id}">📦 ${escapeHtml(t('bundlesBtn'))}</button>
        ${game.url ? `<a class="game-link" href="${game.url}" target="_blank" rel="noopener">${escapeHtml(t('viewOnGgDeals'))}</a>` : ''}
        <button class="btn-sm btn-danger" style="margin-left:auto" data-action="removeWishlist" data-id="${id}">✕ ${escapeHtml(t('removeBtn'))}</button>
      </div>
      <div id="wlBundleContainer_${id}"></div>
    </div>`;

    document.getElementById(`wlAlert_${id}`)?.addEventListener('change', () => saveWishlistAlert(id));
    document.getElementById(`wlThreshold_${id}`)?.addEventListener('change', () => saveWishlistAlert(id));
    document.getElementById(`wlBundleBtn_${id}`)?.addEventListener('click', () => {
      const c = document.getElementById(`wlBundleContainer_${id}`);
      if (!c) return;
      if (c.innerHTML.trim()) { c.innerHTML = ''; return; }
      c.innerHTML = '<div class="loading" style="padding:8px"><div class="spinner"></div></div>';
      chrome.runtime.sendMessage({ action: 'getBundles', ids: [id], region: regionSelect.value }, (bR) => {
        if (!bR?.success || !bR.data?.[id]?.bundles?.length) { c.innerHTML = `<div style="font-size:0.78rem;color:var(--gg-text-muted);padding:8px 0">${escapeHtml(t('noActiveBundles'))}</div>`; return; }
        let h = '';
        for (const b of bR.data[id].bundles.slice(0, 3)) {
          h += `<div class="bundle-card"><div class="bundle-title">${escapeHtml(b.title)}</div>`;
          for (const tr of b.tiers) h += `<div class="bundle-tier"><span class="bundle-price">${tr.price} ${tr.currency}</span></div>`;
          if (b.url) h += `<a class="game-link" href="${b.url}" target="_blank" rel="noopener">${escapeHtml(t('viewArrow'))}</a>`;
          h += '</div>';
        }
        c.innerHTML = h;
      });
    });
  });
}

function saveWishlistAlert(id) {
  const w = wishlist.find((w) => w.id === id);
  if (!w) return;
  const chk = document.getElementById(`wlAlert_${id}`);
  const inp = document.getElementById(`wlThreshold_${id}`);
  if (chk) w.alertEnabled = chk.checked;
  if (inp) w.alertThreshold = parseFloat(inp.value) || 0;
  saveData();
  showToast(chk?.checked ? t('alertEnabled') : t('alertDisabled'), 'success');
}

function getBestPrice(prices) {
  const r = prices.currentRetail ? parseFloat(prices.currentRetail) : null;
  const k = prices.currentKeyshops ? parseFloat(prices.currentKeyshops) : null;
  if (r !== null && k !== null) return Math.min(r, k);
  return r ?? k;
}

window.loadWishlistItemDetail = loadWishlistItemDetail;
window.removeWishlistItem = function (id) {
  const item = wishlist.find((w) => w.id === id);
  removeFromWishlist(id);
  displayWishlist();
  if (item) showToast(t('removed', item.title), 'info');
};

// ── Wishlist Export / Import ─────────────────────────────────────────────────

function exportWishlist() {
  const data = JSON.stringify({ version: 1, exported: new Date().toISOString(), wishlist }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `gg-deals-wishlist-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(t('exportedGames', String(wishlist.length)), 'success');
}

function importWishlist(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      const items = parsed.wishlist || parsed;
      if (!Array.isArray(items)) throw new Error('Invalid format');
      let added = 0;
      for (const item of items) {
        if (!item.id || !item.title) continue;
        if (wishlist.some((w) => w.id === item.id)) continue;
        wishlist.push({
          id: String(item.id), title: String(item.title),
          addedPrice: item.addedPrice ?? null, addedDate: item.addedDate || new Date().toISOString(),
          alertEnabled: false, alertThreshold: item.alertThreshold || item.addedPrice || 0,
        });
        added++;
      }
      saveData();
      displayWishlist();
      showToast(t('importedWithDupes', String(added), String(items.length - added)), 'success');
    } catch (err) {
      showToast(t('invalidWishlistFile'), 'error');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// ── Settings ─────────────────────────────────────────────────────────────────

function displaySettings() {
  // Sync UI to current prefs
  document.getElementById('notifEnabled').checked = notificationSettings.enabled;
  document.getElementById('wishlistCount').textContent = wishlist.length;
  document.getElementById('historyCount').textContent = Object.keys(priceHistory).length;
  document.getElementById('compactMode').checked = userPrefs.compact;
  document.getElementById('dealScoresEnabled').checked = userPrefs.dealScores;
  document.getElementById('overlayEnabled').checked = userPrefs.overlay;
  document.getElementById('autoCheckWishlist').checked = userPrefs.autoCheckWishlist;
  document.getElementById('syncEnabled').checked = userPrefs.syncEnabled !== false;
  document.getElementById('checkFreq').value = String(userPrefs.checkFreq || 360);
  if (regionSettingSelect) {
    regionSettingSelect.value = userPrefs.region || 'us';
  }

  chrome.storage.local.get(['priceCache'], (r) => {
    document.getElementById('cacheCount').textContent = Object.keys(r.priceCache || {}).length;
  });

  // Theme picker
  document.querySelectorAll('#themePicker .theme-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === userPrefs.theme);
  });

  // Accent picker
  document.querySelectorAll('#accentPicker .accent-opt').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.accent === userPrefs.accent);
  });
}

// Settings event listeners (once)
let settingsWired = false;
function wireSettings() {
  if (settingsWired) return;
  settingsWired = true;

  // Theme picker
  document.querySelectorAll('#themePicker .theme-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      userPrefs.theme = btn.dataset.theme;
      applyTheme(userPrefs.theme);
      document.querySelectorAll('#themePicker .theme-opt').forEach((b) => b.classList.toggle('active', b === btn));
      savePrefs();
      showToast(t('themeToast', btn.textContent.trim()), 'info');
    });
  });

  // Accent picker
  document.querySelectorAll('#accentPicker .accent-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      userPrefs.accent = opt.dataset.accent;
      applyAccent(userPrefs.accent);
      document.querySelectorAll('#accentPicker .accent-opt').forEach((o) => o.classList.toggle('active', o === opt));
      savePrefs();
      showToast(t('accentToast', opt.title), 'info');
    });
  });

  // Toggle switches
  document.getElementById('compactMode').addEventListener('change', (e) => {
    userPrefs.compact = e.target.checked;
    applyCompact(userPrefs.compact);
    savePrefs();
  });
  document.getElementById('dealScoresEnabled').addEventListener('change', (e) => {
    userPrefs.dealScores = e.target.checked;
    savePrefs();
    showToast(e.target.checked ? t('dealScoresEnabled') : t('dealScoresHidden'), 'info');
  });
  document.getElementById('overlayEnabled').addEventListener('change', (e) => {
    userPrefs.overlay = e.target.checked;
    savePrefs();
  });
  document.getElementById('autoCheckWishlist').addEventListener('change', (e) => {
    userPrefs.autoCheckWishlist = e.target.checked;
    savePrefs();
  });
  document.getElementById('checkFreq').addEventListener('change', (e) => {
    userPrefs.checkFreq = parseInt(e.target.value) || 360;
    savePrefs();
  });

  // Default region / currency
  if (regionSettingSelect) {
    regionSettingSelect.addEventListener('change', (e) => {
      const region = e.target.value || 'us';
      userPrefs.region = region;
      // Keep search tab selector in sync
      if (regionSelect) regionSelect.value = region;
      chrome.storage.local.set({ lastRegion: region });
      savePrefs();
      showToast(t('regionToast', region.toUpperCase()), 'info');
    });
  }

  // Notification toggle
  document.getElementById('notifEnabled').addEventListener('change', (e) => {
    notificationSettings.enabled = e.target.checked;
    saveData();
    showToast(e.target.checked ? t('notificationsEnabled') : t('notificationsDisabled'), 'info');
  });

  // API Key
  document.getElementById('apiKeyInput').addEventListener('change', (e) => {
    const key = e.target.value.trim();
    chrome.storage.local.set({ apiKey: key || null });
    if (userPrefs.syncEnabled) { try { chrome.storage.sync.set({ apiKey: key || null }).catch(() => {}); } catch { } }
    showToast(key ? t('apiKeySaved') : t('usingDefaultKey'), 'success');
  });

  // Sync toggle
  document.getElementById('syncEnabled').addEventListener('change', (e) => {
    userPrefs.syncEnabled = e.target.checked;
    savePrefs();
    if (e.target.checked) {
      saveData(); // Push current data to sync
      showToast(t('cloudSyncEnabled'), 'success');
    } else {
      showToast(t('cloudSyncDisabled'), 'info');
    }
  });

  // Clear cache
  document.getElementById('clearCacheBtn').addEventListener('click', () => {
    chrome.storage.local.remove(['priceCache']);
    document.getElementById('cacheCount').textContent = '0';
    showToast(t('cacheCleared'), 'success');
  });

  // Clear history
  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    priceHistory = {};
    chrome.storage.local.set({ priceHistory: {} });
    document.getElementById('historyCount').textContent = '0';
    showToast(t('priceHistoryCleared'), 'success');
  });
}
wireSettings();

// ── Delegated click handler for CSP-safe data-action buttons ─────────────

document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'retryDetected': loadDetectedGames(); break;
    case 'retryDashboard': showDashboard(); break;
    case 'retrySearch': performSearch(); break;
    case 'retryBundles': bundlesLoaded = false; loadActiveBundles(); break;
    case 'retryWishlistDetail': loadWishlistItemDetail(id); break;
    case 'removeWishlist': removeWishlistItem(id); break;
    case 'searchGame':
      gameIdInput.value = id;
      switchTab('search');
      performSearch();
      break;
  }
});

// ── Data persistence ─────────────────────────────────────────────────────────

function saveData() {
  // Local: everything (fast, no size limit)
  chrome.storage.local.set({ wishlist, priceHistory, notificationSettings });

  // Sync: only small data (chrome.storage.sync has 8KB per-item limit)
  if (userPrefs.syncEnabled) {
    try {
      chrome.storage.sync.set({ notificationSettings }).catch(() => {});
      // Only sync wishlist if it fits within the 8KB item limit
      const wlStr = JSON.stringify(wishlist);
      if (wlStr.length < 7000) {
        chrome.storage.sync.set({ wishlist }).catch(() => {});
      }
    } catch { /* sync unavailable */ }
  }
}

// ── Global Image Error Fallback (Manifest V3 CSP-Safe) ──────────────────────
// Listen for all image load errors (must use capture phase since error events do not bubble)
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') {
    // If it's a tiny store logo badge that failed, simply hide it
    if (e.target.closest('.active-bundle-store') || e.target.classList.contains('active-bundle-store-logo')) {
      e.target.style.display = 'none';
      return;
    }
    // Prevent infinite loops if default icon itself is somehow missing
    if (e.target.src && !e.target.src.endsWith('images/icon-128.png')) {
      e.target.src = 'images/icon-128.png';
    }
  }
}, true);
