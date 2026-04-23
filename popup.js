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
let imageOverrides = {};
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
  officialOnly: false,
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
initTabA11yLabels();
updateTabLayoutMode();
// Re-check once after fonts settle so width calculation is accurate.
if (document.fonts?.ready) {
  document.fonts.ready.then(() => updateTabLayoutMode()).catch(() => {});
}

function initTabA11yLabels() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const labelEl = btn.querySelector('.tab-label');
    const label = (labelEl?.textContent || '').trim();
    if (!label) return;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  });
}

function updateTabLayoutMode() {
  const tabs = document.querySelector('.tabs');
  if (!tabs) return;
  const wasCompact = tabs.classList.contains('compact-tabs');
  const HYSTERESIS_PX = 6;

  // Measure in full-label mode, then only apply if needed.
  if (wasCompact) tabs.classList.remove('compact-tabs');
  const overflowPx = tabs.scrollWidth - tabs.clientWidth;
  const hasOverflow = overflowPx > HYSTERESIS_PX;
  if (hasOverflow) tabs.classList.add('compact-tabs');
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function escapeHtml(t) {
  const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
}
function escapeAttr(t) {
  return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const FX_API_BASE = 'https://api.frankfurter.app';
const FX_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
let fxRateCache = {};

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function getFxRate(fromCurrency, toCurrency) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (!from || !to) throw new Error('Missing currency');
  if (from === to) return 1;

  const key = `${from}->${to}`;
  const cached = fxRateCache[key];
  if (cached && (Date.now() - cached.timestamp) < FX_CACHE_TTL_MS) return cached.rate;

  const url = `${FX_API_BASE}/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FX API ${resp.status}`);
  const json = await resp.json();
  const rate = json?.rates?.[to];
  if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) throw new Error('Invalid FX rate');

  fxRateCache[key] = { rate, timestamp: Date.now() };
  return rate;
}

async function convertCurrencyAmount(amount, fromCurrency, toCurrency) {
  const numeric = Number(amount);
  if (!isFinite(numeric)) throw new Error('Invalid amount');
  const rate = await getFxRate(fromCurrency, toCurrency);
  return roundMoney(numeric * rate);
}

function applyOfficialOnlyToData(data) {
  if (!userPrefs.officialOnly || !data || typeof data !== 'object') return data;
  const filtered = {};
  for (const [id, game] of Object.entries(data)) {
    if (!game || !game.prices) {
      filtered[id] = game;
      continue;
    }
    filtered[id] = {
      ...game,
      prices: {
        ...game.prices,
        currentKeyshops: null,
        historicalKeyshops: null,
      },
    };
  }
  return filtered;
}

/** Normalize API games array: items may be { title, url } or string like "@{title=...; url=...}" */
function getTierGames(tier, maxShow = 15) {
  const raw = tier.games;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const g of raw) {
    if (typeof g === 'object' && g != null && g.title) {
      out.push({ title: g.title, url: g.url || '' });
    } else if (typeof g === 'string') {
      const m = g.match(/title=([^;]+);\s*url=(\S+)/);
      if (m) out.push({ title: m[1].trim(), url: m[2].trim() });
    }
  }
  return out.slice(0, maxShow);
}

function renderBundleTierGames(tier, gamesLabel, maxShow = 15) {
  const games = getTierGames(tier, maxShow);
  const total = Array.isArray(tier.games) ? tier.games.length : 0;
  if (games.length === 0) return '';
  let h = '<ul class="bundle-tier-games">';
  for (const g of games) h += `<li class="bundle-game-item"><a class="game-link" href="${escapeAttr(g.url)}" target="_blank" rel="noopener">${escapeHtml(g.title)}</a></li>`;
  if (total > maxShow) h += `<li class="bundle-game-more">+${total - maxShow} more ${gamesLabel}</li>`;
  h += '</ul>';
  return h;
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
  ['wishlist', 'priceHistory', 'notificationSettings', 'lastRegion', 'apiKey', 'contextMenuAppId', 'rateLimitInfo', 'recentSearches', 'userPrefs', 'imageOverrides'],
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
    if (localResult.imageOverrides && typeof localResult.imageOverrides === 'object') imageOverrides = localResult.imageOverrides;
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
  maybeStartOnboarding(result);
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
  if (tab === 'dashboard') showDashboard();
}

// ── First-run onboarding ─────────────────────────────────────────────────────

const ONBOARDING_STEPS = [
  { title: 'onboardingWelcomeTitle', body: 'onboardingWelcomeBody' },
  { title: 'onboardingStoresTitle', body: 'onboardingStoresBody' },
  { title: 'onboardingHubTitle', body: 'onboardingHubBody' },
  { title: 'onboardingWishlistTitle', body: 'onboardingWishlistBody' },
  { title: 'onboardingPrefsTitle', body: 'onboardingPrefsBody' },
];

let onboardingStepIndex = 0;
let onboardingWired = false;
let onboardingEscapeHandler = null;

function renderOnboardingStep() {
  const backdrop = document.getElementById('onboardingBackdrop');
  const step = ONBOARDING_STEPS[onboardingStepIndex];
  if (!backdrop || !step) return;

  document.getElementById('onboardingTitle').textContent = t(step.title);
  document.getElementById('onboardingBody').textContent = t(step.body);
  document.getElementById('onboardingStepLabel').textContent = t(
    'onboardingStep',
    String(onboardingStepIndex + 1),
    String(ONBOARDING_STEPS.length)
  );

  document.getElementById('onboardingBack').classList.toggle('hidden', onboardingStepIndex === 0);
  const nextBtn = document.getElementById('onboardingNext');
  nextBtn.textContent =
    onboardingStepIndex >= ONBOARDING_STEPS.length - 1 ? t('onboardingDone') : t('onboardingNext');

  const dots = document.getElementById('onboardingDots');
  dots.innerHTML = ONBOARDING_STEPS.map(
    (_, i) => `<span class="onboarding-dot${i === onboardingStepIndex ? ' active' : ''}" role="presentation"></span>`
  ).join('');

  backdrop.classList.remove('hidden');
  backdrop.setAttribute('aria-hidden', 'false');

  if (onboardingEscapeHandler) {
    document.removeEventListener('keydown', onboardingEscapeHandler);
  }
  onboardingEscapeHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeOnboarding(true);
    }
  };
  document.addEventListener('keydown', onboardingEscapeHandler);

  nextBtn.focus();
}

function closeOnboarding(markComplete) {
  const backdrop = document.getElementById('onboardingBackdrop');
  if (!backdrop) return;
  if (onboardingEscapeHandler) {
    document.removeEventListener('keydown', onboardingEscapeHandler);
    onboardingEscapeHandler = null;
  }
  backdrop.classList.add('hidden');
  backdrop.setAttribute('aria-hidden', 'true');
  if (markComplete) chrome.storage.local.set({ onboardingComplete: true });
}

function wireOnboarding() {
  if (onboardingWired) return;
  onboardingWired = true;
  document.getElementById('onboardingSkip').addEventListener('click', () => closeOnboarding(true));
  document.getElementById('onboardingBack').addEventListener('click', () => {
    if (onboardingStepIndex > 0) {
      onboardingStepIndex--;
      renderOnboardingStep();
    }
  });
  document.getElementById('onboardingNext').addEventListener('click', () => {
    if (onboardingStepIndex >= ONBOARDING_STEPS.length - 1) {
      closeOnboarding(true);
      return;
    }
    onboardingStepIndex++;
    renderOnboardingStep();
  });
}

function maybeStartOnboarding(initResult) {
  if (initResult && initResult.contextMenuAppId) return;
  wireOnboarding();
  chrome.storage.local.get(['onboardingComplete'], (r) => {
    if (chrome.runtime.lastError || r.onboardingComplete === true) return;
    onboardingStepIndex = 0;
    renderOnboardingStep();
  });
}

function replayOnboarding() {
  wireOnboarding();
  chrome.storage.local.remove(['onboardingComplete'], () => {
    onboardingStepIndex = 0;
    renderOnboardingStep();
    showToast(t('onboardingReplayStarted'), 'info');
  });
}

// ── Detected games (auto-scan) ───────────────────────────────────────────────

/** Parse game title from repack-site URL when content script didn't run or returned nothing */
function parseRepackUrlGame(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.includes('fitgirl-repacks') && !host.includes('igg-games.com') && !host.includes('gog-games')) return null;
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
        chrome.runtime.sendMessage({ action: 'gamesDetected', data, fromPopup: true });
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
            const data = applyOfficialOnlyToData(priceResp.data);
            const validEntries = Object.entries(data).filter(([, v]) => v && v.prices);
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
            const renderDetected = (entries) => {
              const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
              if (activeTab === 'dashboard') switchTab('detected');
              renderDetectedResults(entries, isWishlist, storeName);
            };

            // On GG.deals pages, prefer the page hero image for the first detected game.
            if (storeName.toLowerCase() === 'gg.deals' && validEntries.length > 0) {
              chrome.tabs.sendMessage(tab.id, { action: 'getPrimaryImage' }, (imgResp) => {
                const pageImage = imgResp?.image;
                if (pageImage) {
                  const [firstId, firstGame] = validEntries[0];
                  validEntries[0] = [firstId, {
                    ...firstGame,
                    info: {
                      ...(firstGame.info || {}),
                      image: pageImage,
                    },
                  }];
                }
                renderDetected(validEntries);
              });
              return;
            }

            renderDetected(validEntries);
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
          alertThresholdCustom: false,
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
          const data = applyOfficialOnlyToData(priceResp.data);
          const validEntries = Object.entries(data).filter(([, v]) => v && v.prices);
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
              const histLow = getBestHistoricalLow(game.prices);
              const cur = game.prices?.currency || 'USD';
              if (wl.addedPrice === null) { wl.addedPrice = best; }
              if (!wl.alertThresholdCustom) {
                const autoThreshold = histLow ?? best;
                if (autoThreshold !== null && autoThreshold !== undefined) {
                  wl.alertThreshold = autoThreshold;
                  wl.alertThresholdCurrency = cur;
                }
              }
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
        const histLow = getBestHistoricalLow(game.prices);
        const currency = game.prices?.currency || 'USD';
        wishlist.push({
          id: String(id),
          title: game.title || 'Unknown',
          addedPrice: best,
          addedDate: new Date().toISOString(),
          alertEnabled: false,
          alertThreshold: histLow ?? best,
          alertThresholdCustom: false,
          alertThresholdCurrency: currency,
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

// ── Smart Deal Dashboard ──

function renderTrendChart(prices) {
  if (!prices || (!prices.historicalRetail && !prices.historicalKeyshops)) return '';
  const cR = parseFloat(prices.currentRetail) || Infinity;
  const cK = parseFloat(prices.currentKeyshops) || Infinity;
  const hR = parseFloat(prices.historicalRetail) || Infinity;
  const hK = parseFloat(prices.historicalKeyshops) || Infinity;
  const current = Math.min(cR, cK);
  const hist = Math.min(hR, hK);
  if (current === Infinity || hist === Infinity) return '';
  
  const isDrop = current <= hist;
  const color = isDrop ? '#048044' : '#e6a400';
  const y1 = isDrop ? 10 : 30;
  const y2 = isDrop ? 30 : 10;
  
  return `<div style="display:flex; flex-direction:column; align-items:flex-end; margin-left:auto; margin-top:8px;"><span style="font-size:0.65rem; color:var(--gg-text-muted); text-transform:uppercase; letter-spacing:0.5px;">Price Trend</span><svg class="sparkline" width="60" height="30" viewBox="0 0 60 40" style="margin-left:auto; opacity:0.8">
    <polyline points="0,${y1} 30,${y1} 60,${y2}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="60" cy="${y2}" r="4" fill="${color}" />
  </svg></div>`;
}

function showDashboard() {
  scanBadge.style.display = 'none';
  if (wishlist.length === 0) {
    const hasDetectedGames = scanBadge && !scanBadge.classList.contains('empty') && !!scanBadge.textContent.trim();
    document.getElementById('dashboardResults').innerHTML = `
      <div class="empty">
        <span class="empty-icon">🤷</span>
        ${escapeHtml(t('emptyDashboard'))}<br>
        ${escapeHtml(t('emptyDashboardHint'))}
        ${hasDetectedGames ? '<br><button class="btn-sm btn-outline" data-action="openDetectedTab" style="margin-top:8px">Open detected games</button>' : ''}
      </div>`;
    return;
  }
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
  // Use pricesCache instead of lastPrice
  const gamesWithPrices = wishlist.filter((w) => w.pricesCache != null);
  const dashboardEl = document.getElementById('dashboardResults');
  
  if (gamesWithPrices.length === 0) {
    let html = `<div class="dashboard-section">
      <div class="dashboard-section-header"><span class="dash-icon">📊</span> ${escapeHtml(t('trackedGames', String(wishlist.length)))}</div>`;
    for (const w of wishlist.slice(0, 12)) {
      html += `<div class="dashboard-mini-card" data-id="${escapeAttr(w.id)}">
        <div class="dashboard-mini-title">${escapeHtml(w.title || `Steam App ${w.id}`)}</div>
        <div class="dashboard-mini-price" style="color:var(--gg-text-muted)">—</div>
      </div>`;
    }
    html += `</div>
      <div class="empty" style="padding-top:12px">
        ${escapeHtml(t('loadingWishlist'))}<br>
        <button class="btn-sm btn-outline" data-action="retryDashboard" style="margin-top:8px">${escapeHtml(t('retry'))}</button>
      </div>`;
    dashboardEl.innerHTML = html;
    dashboardEl.querySelectorAll('.dashboard-mini-card').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const gameName = el.querySelector('.dashboard-mini-title').textContent;
        document.getElementById('gameId').value = gameName || '';
        document.getElementById('searchBtn').click();
        switchTab('search');
      });
    });
    return;
  }

  // Calculate Metrics
  let totalRetail = 0;
  let totalBest = 0;
  let histLows = [];
  let recentDrops = [];

  gamesWithPrices.forEach(g => {
    const p = g.pricesCache;
    if (!p) return;
    const cR = parseFloat(p.currentRetail) || Infinity;
    const cK = parseFloat(p.currentKeyshops) || Infinity;
    const hR = parseFloat(p.historicalRetail) || Infinity;
    const hK = parseFloat(p.historicalKeyshops) || Infinity;
    const best = Math.min(cR, cK);
    const hist = Math.min(hR, hK);
    
    // Add to savings metrics
    let retailPrice = parseFloat(p.currentRetail);
    if (isNaN(retailPrice) || retailPrice < best) retailPrice = best; // Fallback so we don't break arithmetic
    
    if (best !== Infinity && !isNaN(best)) {
       totalRetail += retailPrice;
       totalBest += best;
    }

    if (best <= hist && best !== Infinity) {
      histLows.push({ ...g, best, hist });
    } else if (best < retailPrice && best !== Infinity) {
      recentDrops.push({ ...g, best });
    }
  });

  const savingsAmount = (totalRetail - totalBest).toFixed(2);
  const savingsPct = totalRetail > 0 ? ((savingsAmount / totalRetail) * 100).toFixed(0) : 0;
  totalRetail = totalRetail.toFixed(2);
  totalBest = totalBest.toFixed(2);

  // Build the Detailed Dashboard UI!
  let html = `
    <div style="background:var(--gg-surface-bg); padding:16px; border-radius:8px; margin-bottom:16px; border:1px solid var(--gg-border); text-align:center;">
       <div style="font-size:0.75rem; color:var(--gg-text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">Total Wishlist Savings Available</div>
       <div style="font-size:1.8rem; font-weight:900; color:#4ade80;">$${savingsAmount} <span style="font-size:1rem; opacity:0.8;">(-${savingsPct}%)</span></div>
       <div style="font-size:0.85rem; color:var(--gg-text-muted); margin-top:4px;">Buy everything now for $${totalBest} instead of $${totalRetail}</div>
    </div>
  `;

  if (histLows.length > 0) {
    html += `<div class="section-label" style="display:flex; justify-content:space-between; align-items:center;"><span>⭐ At Historical Low</span><span style="border-radius:12px; background:#e6a400; color:#18181c; padding:2px 8px; font-size:11px; font-weight:bold;">${histLows.length}</span></div>`;
    html += `<div class="dashboard-grid">`;
    histLows.slice(0, 4).forEach((g) => {
      const dropPrice = g.best;
      const currency = g.pricesCache?.currency || 'USD';
      html += `
        <div class="dashboard-mini-card" data-id="${g.id}">
          <div class="dashboard-mini-title">${escapeHtml(g.title)}</div>
          <div class="dashboard-mini-price">${dropPrice} ${currency}</div>
        </div>
      `;
    });
    html += `</div>`;
  }

  if (recentDrops.length > 0) {
    html += `<div class="section-label">📉 Recent Discounts</div>`;
    html += `<div class="dashboard-grid">`;
    recentDrops.slice(0, 6).forEach((g) => {
      const dropPrice = g.best;
      const currency = g.pricesCache?.currency || 'USD';
      html += `
        <div class="dashboard-mini-card" data-id="${g.id}">
          <div class="dashboard-mini-title">${escapeHtml(g.title)}</div>
          <div class="dashboard-mini-price">${dropPrice} ${currency}</div>
        </div>
      `;
    });
    html += `</div>`;
  }

  dashboardEl.innerHTML = html;
  
  // Attach listeners
  dashboardEl.querySelectorAll('.dashboard-mini-card').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const gameName = el.querySelector('.dashboard-mini-title').textContent;
      document.getElementById('gameId').value = gameName || '';
      document.getElementById('searchBtn').click();
      switchTab('search');
    });
  });
}

function loadDashboardData() {
  const idsToLoad = wishlist.map((w) => w.id);
  const dashboardEl = document.getElementById('dashboardResults');
  showLoadingSpinner(dashboardEl, t('loadingWishlist'));
  
  chrome.runtime.sendMessage({ action: 'lookupByIds', ids: idsToLoad, region: regionSelect.value }, (resp) => {
    if (resp && resp.success) {
      const data = applyOfficialOnlyToData(resp.data);
      // Update cache
      wishlist.forEach((w) => {
        if (data[w.id]) {
            w.pricesCache = data[w.id].prices;
        }
      });
      saveData();
    }
    renderCachedDashboard(null);
  });
}


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
  const data = applyOfficialOnlyToData(resp.data || {});
  const entries = Object.entries(data).filter(([, v]) => v && v.prices);
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
  const chartHtml2 = renderTrendChart(game.prices);

  const history = priceHistory[id] || [];
  const chartHtml = history.length > 1 ? generateChart(history, currency) : '';
  const inWishlist = wishlist.some((w) => w.id === id);

  const imageInfo = getResolvedImageForGame(id, game);

  return `<div class="game-card" data-game-id="${id}">
    <div class="game-card-body">
      <img class="game-card-img" src="${escapeHtml(imageInfo.src)}" data-fallbacks="${escapeAttr(imageInfo.fallbacks)}" alt="${escapeHtml(game.title || '')}">
      <div class="game-card-content">
        <div class="game-title-row">
          <div class="game-title">${escapeHtml(game.title || 'Unknown')}</div>
          ${dealScoreBadge(score)}
        </div>
        <div class="price-section">
          ${priceCol(t('officialStores'), p.currentRetail, retailDiscount, !bestDealIsKey && retailDiscount)}
          ${priceCol(t('keyshops'), p.currentKeyshops, keyDiscount, bestDealIsKey)}
        </div>
        ${histHtml}${histLowTag}${chartHtml2}
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

function getResolvedImageForGame(id, game = null) {
  const appId = String(id);
  const custom = imageOverrides[appId];
  if (custom) {
    return { src: custom, fallbacks: '' };
  }
  const imgCandidates = [
    // Prefer Steam app artwork to match what users see on store pages.
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
    game?.info?.image,
    game?.image,
    game?.thumbnail,
    game?.cover,
  ].filter(Boolean);
  const imgSrc = imgCandidates[0];
  const fallbackSources = [
    ...imgCandidates.slice(1),
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900_2x.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_231x87.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
  ].join('|');
  return { src: imgSrc, fallbacks: fallbackSources };
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
  container.querySelectorAll('.add-wl-btn, .remove-wl-btn').forEach((btn) => {
    if (btn.dataset.wlAttached) return;
    btn.dataset.wlAttached = 'true';
    btn.addEventListener('click', () => {
      if (btn.classList.contains('remove-wl-btn')) {
        removeFromWishlist(btn.dataset.id);
        btn.textContent = `🤍 ${t('wishlistBtn')}`;
        btn.classList.remove('btn-danger', 'remove-wl-btn');
        btn.classList.add('btn-green', 'add-wl-btn');
        showToast(t('removedFromWishlist'), 'info');
      } else {
        const titleEl = btn.closest('.game-card, .dashboard-mini-card')?.querySelector('.game-title, .dashboard-mini-title');
        const title = titleEl ? titleEl.textContent : 'Unknown Game';
        addToWishlist(btn.dataset.id, title, null);
        btn.textContent = `♥ ${t('wishlisted')}`;
        btn.classList.remove('btn-green', 'add-wl-btn');
        btn.classList.add('btn-danger', 'remove-wl-btn');
        showToast(t('addedToWishlist', title), 'success');
      }
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
          for (const tr of b.tiers) {
            h += `<div class="bundle-tier"><span class="bundle-price">${tr.price} ${tr.currency}</span> · ${tr.gamesCount || '?'} ${t('games')}</div>`;
            h += renderBundleTierGames(tr, t('games'));
          }
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
let activeBundlesData = [];
let activeBundlesFilter = 'all';
let activeBundlesSort = 'expiry';

function getBundleShopAndTitle(bundle) {
  const rawTitle = String(bundle?.title || '');
  let shopName = 'Store';
  let bundleTitle = rawTitle;
  const titleParts = rawTitle.split(' - ');
  if (titleParts.length > 1) {
    shopName = titleParts[0].trim();
    bundleTitle = titleParts.slice(1).join(' - ').trim();
  } else if (rawTitle) {
    shopName = rawTitle.split(' ')[0];
  }
  return { shopName, bundleTitle };
}

function normalizeStoreName(name) {
  return String(name || '').trim().toLowerCase();
}

function getCanonicalBundleStore(bundle) {
  const { shopName } = getBundleShopAndTitle(bundle);
  const context = `${String(shopName || '').toLowerCase()} ${String(bundle?.title || '').toLowerCase()} ${String(bundle?.url || '').toLowerCase()}`;

  if (context.includes('fanatical') || context.includes('bundlefest') || context.includes('build your own')) {
    return { key: 'fanatical', label: 'Fanatical' };
  }
  if (context.includes('humble') || context.includes('humblebundle') || context.includes('humble choice')) {
    return { key: 'humblebundle', label: 'Humble Bundle' };
  }
  if (context.includes('indiegala')) return { key: 'indiegala', label: 'IndieGala' };
  if (context.includes('greenman') || context.includes('gmg')) return { key: 'greenmangaming', label: 'Green Man Gaming' };
  if (context.includes('steam') || context.includes('steampowered')) return { key: 'steam', label: 'Steam' };
  if (context.includes('epic')) return { key: 'epicgames', label: 'Epic Games' };
  if (context.includes('gog')) return { key: 'gog', label: 'GOG' };
  if (context.includes('digiphile')) return { key: 'digiphile', label: 'Digiphile' };
  if (context.includes('cdkeys')) return { key: 'cdkeys', label: 'CDKeys' };

  const fallback = String(shopName || 'Store').trim() || 'Store';
  return { key: normalizeStoreName(fallback), label: fallback };
}

function getBundleBestTierPrice(bundle) {
  if (!Array.isArray(bundle?.tiers) || bundle.tiers.length === 0) return Infinity;
  let best = Infinity;
  for (const tr of bundle.tiers) {
    const n = parseFloat(tr?.price);
    if (!isNaN(n) && n > 0) best = Math.min(best, n);
  }
  return best;
}

async function getBundleComparisonForGame(id, bestPrice, currency) {
  if (bestPrice == null || isNaN(bestPrice)) return { kind: 'none' };
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getBundles', ids: [id], region: regionSelect.value }, (resp) => {
      const bundles = resp?.success ? (resp.data?.[id]?.bundles || []) : [];
      if (!bundles.length) {
        resolve({ kind: 'none' });
        return;
      }
      let bestBundle = null;
      let bestTierPrice = Infinity;
      for (const b of bundles) {
        for (const tr of (b.tiers || [])) {
          const tierPrice = parseFloat(tr?.price);
          if (!isNaN(tierPrice) && tierPrice > 0 && tierPrice < bestTierPrice) {
            bestTierPrice = tierPrice;
            bestBundle = b;
          }
        }
      }
      if (!bestBundle || !isFinite(bestTierPrice)) {
        resolve({ kind: 'none' });
        return;
      }
      const delta = Math.round((bestPrice - bestTierPrice) * 100) / 100;
      const { shopName } = getBundleShopAndTitle(bestBundle);
      const cur = bestBundle?.tiers?.[0]?.currency || currency || 'USD';
      if (delta >= 0) {
        resolve({
          kind: 'worth',
          shopName,
          tierPrice: bestTierPrice,
          delta,
          currency: cur,
        });
      } else {
        resolve({
          kind: 'higher',
          shopName,
          tierPrice: bestTierPrice,
          delta: Math.abs(delta),
          currency: cur,
        });
      }
    });
  });
}

function renderActiveBundles() {
  const container = document.getElementById('bundlesContent');
  if (!container) return;
  const bundles = Array.isArray(activeBundlesData) ? activeBundlesData : [];
  if (bundles.length === 0) {
    container.innerHTML = `<div class="empty"><span class="empty-icon">📦</span>${escapeHtml(t('noActiveBundlesNow'))}</div>`;
    return;
  }

  const storeMap = new Map();
  for (const b of bundles) {
    const canonical = getCanonicalBundleStore(b);
    const key = canonical.key;
    if (!key) continue;
    if (!storeMap.has(key)) storeMap.set(key, canonical.label);
  }

  const filtered = bundles.filter((b) => {
    if (activeBundlesFilter === 'all') return true;
    return getCanonicalBundleStore(b).key === activeBundlesFilter;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (activeBundlesSort === 'title') {
      const at = getBundleShopAndTitle(a).bundleTitle.toLowerCase();
      const bt = getBundleShopAndTitle(b).bundleTitle.toLowerCase();
      return at.localeCompare(bt);
    }
    if (activeBundlesSort === 'price-asc') return getBundleBestTierPrice(a) - getBundleBestTierPrice(b);
    if (activeBundlesSort === 'price-desc') return getBundleBestTierPrice(b) - getBundleBestTierPrice(a);
    // default: soonest expiry first; unknown dates last
    const ad = a?.dateTo ? new Date(a.dateTo + ' UTC').getTime() : Infinity;
    const bd = b?.dateTo ? new Date(b.dateTo + ' UTC').getTime() : Infinity;
    return ad - bd;
  });

  let filterOptions = `<option value="all"${activeBundlesFilter === 'all' ? ' selected' : ''}>All stores</option>`;
  Array.from(storeMap.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([key, label]) => {
      filterOptions += `<option value="${escapeAttr(key)}"${activeBundlesFilter === key ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    });

  const countLabel = sorted.length !== 1
    ? t('activeBundlesCount', String(sorted.length))
    : t('activeBundleCount', String(sorted.length));

  let h = `<div class="bundles-controls">
      <div class="section-label bundles-count-label">${escapeHtml(countLabel)}</div>
      <div class="bundles-control-row">
        <label class="bundles-control-label">Store</label>
        <select id="activeBundleStoreFilter" class="bundles-control-select">${filterOptions}</select>
        <label class="bundles-control-label">Sort</label>
        <select id="activeBundleSort" class="bundles-control-select">
          <option value="expiry"${activeBundlesSort === 'expiry' ? ' selected' : ''}>Ending soon</option>
          <option value="price-asc"${activeBundlesSort === 'price-asc' ? ' selected' : ''}>Price: low to high</option>
          <option value="price-desc"${activeBundlesSort === 'price-desc' ? ' selected' : ''}>Price: high to low</option>
          <option value="title"${activeBundlesSort === 'title' ? ' selected' : ''}>Title A-Z</option>
        </select>
      </div>
    </div>`;

  if (sorted.length === 0) {
    h += `<div class="empty"><span class="empty-icon">🔎</span>No bundles match this filter.</div>`;
    container.innerHTML = h;
  } else {
    for (const b of sorted) {
      let expiryHtml = '';
      if (b.dateTo) {
        const days = Math.ceil((new Date(b.dateTo + ' UTC') - new Date()) / 86400000);
        if (days > 0) expiryHtml = `<div class="bundle-expiry">⏰ ${escapeHtml(days !== 1 ? t('daysLeft', String(days)) : t('dayLeft', String(days)))}</div>`;
      }

      const { shopName, bundleTitle } = getBundleShopAndTitle(b);
      const canonicalStore = getCanonicalBundleStore(b);
      const displayStoreName = canonicalStore.label;

      // Map common store keywords to their actual domains for accurate favicon fetching
      let domain = null;
      const s = displayStoreName.toLowerCase() + ' ' + shopName.toLowerCase() + ' ' + (b.url || '').toLowerCase();
      if (s.includes('humble')) domain = 'humblebundle.com';
      else if (s.includes('fanatical')) domain = 'fanatical.com';
      else if (s.includes('indiegala')) domain = 'indiegala.com';
      else if (s.includes('steam')) domain = 'steampowered.com';
      else if (s.includes('epic')) domain = 'epicgames.com';
      else if (s.includes('gog')) domain = 'gog.com';
      else if (s.includes('digiphile')) domain = 'digiphile.co';
      else if (s.includes('cdkeys')) domain = 'cdkeys.com';
      else if (s.includes('greenman') || s.includes('gmg')) domain = 'greenmangaming.com';

      const storeLogoUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : 'images/icon-128.png';
      const imgSrc = b.image || storeLogoUrl;
      const storeBadgeHtml = domain
        ? `<div class="active-bundle-store" style="display:flex;align-items:center;gap:4px;"><img src="${storeLogoUrl}" style="width:12px;height:12px;border-radius:2px;">${escapeHtml(displayStoreName)}</div>`
        : `<div class="active-bundle-store">${escapeHtml(displayStoreName)}</div>`;

      h += `<div class="active-bundle-card">
          <div class="active-bundle-body">
            <img class="active-bundle-img" style="background:#fff; padding:4px;" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(displayStoreName)}">
            <div class="active-bundle-content">
              <div class="active-bundle-header"><div class="active-bundle-title" style="margin-right:8px">${escapeHtml(bundleTitle)}</div>${storeBadgeHtml}</div>
              <div class="active-bundle-tiers">`;

      if (b.tiers) {
        for (const tr of b.tiers) {
          h += `<div class="bundle-tier"><span class="bundle-price">${tr.price} ${tr.currency}</span> · ${tr.gamesCount || '?'} ${(tr.gamesCount || 0) > 1 ? t('games') : t('game')}</div>`;
          h += renderBundleTierGames(tr, t('games'));
        }
      }

      h += `</div>${expiryHtml}`;
      if (b.url) h += `<a class="game-link" href="${b.url}" target="_blank" rel="noopener" style="display:block;margin-top:6px">${escapeHtml(t('viewBundle'))}</a>`;
      h += `</div>
          </div>
        </div>`;
    }
    container.innerHTML = h;
  }

  document.getElementById('activeBundleStoreFilter')?.addEventListener('change', (e) => {
    activeBundlesFilter = e.target.value || 'all';
    renderActiveBundles();
  });
  document.getElementById('activeBundleSort')?.addEventListener('change', (e) => {
    activeBundlesSort = e.target.value || 'expiry';
    renderActiveBundles();
  });
}

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
    activeBundlesData = resp.data || [];
    activeBundlesFilter = 'all';
    activeBundlesSort = 'expiry';
    renderActiveBundles();
    bundlesLoaded = true;
  });
}
window.loadActiveBundles = loadActiveBundles;

// ── Wishlist ─────────────────────────────────────────────────────────────────

function addToWishlist(id, title, price) {
  if (wishlist.some((w) => w.id === id)) return;
  // alertThreshold starts at the current best price; it will be auto-synced to
  // the historical low (in the current region's currency) on the next detail load
  // since alertThresholdCustom is false.
  wishlist.push({
    id,
    title,
    addedPrice: price,
    addedDate: new Date().toISOString(),
    alertEnabled: false,
    alertThreshold: price,
    alertThresholdCustom: false,
  });
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

    const imageInfo = getResolvedImageForGame(item.id);

    html += `<div class="wishlist-item" data-wl-id="${item.id}">
      <div class="wishlist-header" data-wl-expand="${item.id}">
        <img class="wishlist-img" src="${escapeHtml(imageInfo.src)}" data-fallbacks="${escapeAttr(imageInfo.fallbacks)}" alt="${escapeHtml(item.title)}">
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
        const data = applyOfficialOnlyToData(resp.data || {});
        let n = 0;
        let titlesUpdated = 0;
        for (const [id, game] of Object.entries(data)) {
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
            }
            // Keep threshold in sync with the current historical low unless the user customized it
            if (!w.alertThresholdCustom) {
              const histLow = getBestHistoricalLow(game.prices);
              const autoThreshold = histLow ?? best;
              if (autoThreshold !== null && autoThreshold !== undefined) {
                w.alertThreshold = autoThreshold;
                w.alertThresholdCurrency = cur;
              }
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

  chrome.runtime.sendMessage({ action: 'lookupByIds', ids: [id], region: regionSelect.value }, async (resp) => {
    if (resp?.rateLimit) updateRateLimit(resp.rateLimit);
    const data = applyOfficialOnlyToData(resp?.data || {});
    if (!resp?.success || !data[id]) {
      detailEl.innerHTML = `<div style="padding:8px 0"><div class="error" style="margin:0"><span class="error-icon">⚠️</span><div><div>${friendlyError(resp?.error)}</div><div class="error-actions"><button class="btn-sm btn-outline" data-action="retryWishlistDetail" data-id="${id}">Retry</button></div></div></div><div class="wishlist-actions"><button class="btn-sm btn-danger" data-action="removeWishlist" data-id="${id}">✕ Remove</button></div></div>`;
      return;
    }

    const game = data[id], p = game.prices, currency = p.currency || 'USD';
    const currentRetail = p.currentRetail ? parseFloat(p.currentRetail) : null;
    const currentKey = p.currentKeyshops ? parseFloat(p.currentKeyshops) : null;
    const histRetail = p.historicalRetail ? parseFloat(p.historicalRetail) : null;
    const histKey = p.historicalKeyshops ? parseFloat(p.historicalKeyshops) : null;
    const best = getBestPrice(p);
    const histLow = getBestHistoricalLow(p);

    const badge = document.getElementById(`wlPrice_${id}`);
    if (badge && best !== null) { badge.textContent = `${best} ${currency}`; badge.classList.remove('unknown'); }

    const wl = wishlist.find((w) => w.id === id);
    let thresholdNotice = '';
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
      }
      // Auto-sync threshold to the historical low (in the current region's
      // currency) unless the user has manually customized it.
      if (!wl.alertThresholdCustom) {
        const autoThreshold = histLow ?? best;
        if (autoThreshold !== null && autoThreshold !== undefined) {
          wl.alertThreshold = autoThreshold;
          wl.alertThresholdCurrency = currency;
        }
      } else {
        const fromCurrency = String(wl.alertThresholdCurrency || wl.lastCurrency || '').toUpperCase();
        const toCurrency = String(currency || '').toUpperCase();
        if (wl.alertThreshold != null && fromCurrency && toCurrency && fromCurrency !== toCurrency) {
          try {
            const converted = await convertCurrencyAmount(wl.alertThreshold, fromCurrency, toCurrency);
            wl.alertThreshold = converted;
            wl.alertThresholdCurrency = toCurrency;
            thresholdNotice = `Custom alert converted from ${fromCurrency} to ${toCurrency} using latest exchange rates.`;
          } catch {
            thresholdNotice = `Custom alert is set in ${fromCurrency}; current prices are in ${toCurrency}. Conversion failed, please review manually.`;
          }
        }
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
    const threshold = wl?.alertThreshold ?? histLow ?? best ?? '';
    const bundleCalloutId = `wlBundleCallout_${id}`;

    detailEl.innerHTML = `<div style="padding-top:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">${changeHtml}${dealScoreBadge(score)}</div>
      <div class="price-section">${pc(t('officialStores'), p.currentRetail, retailDisc, !bestIsKey && retailDisc)}${pc(t('keyshops'), p.currentKeyshops, keyDisc, bestIsKey)}</div>
      ${histHtml}
      <div id="${bundleCalloutId}"></div>
      <div class="wishlist-alert-row">
        <input type="checkbox" class="toggle-switch" id="wlAlert_${id}" ${wl?.alertEnabled ? 'checked' : ''} />
        <label for="wlAlert_${id}" style="cursor:pointer">${escapeHtml(t('alertBelow'))}</label>
        <input type="number" id="wlThreshold_${id}" value="${threshold}" step="0.01" min="0" placeholder="Price" />
        <span id="wlCurrency_${id}" style="color:var(--gg-text-muted);font-size:0.72rem">${currency}</span>
      </div>
      ${thresholdNotice ? `<div class="wishlist-alert-note">${escapeHtml(thresholdNotice)}</div>` : ''}
      <div class="wishlist-actions">
        <button class="btn-sm btn-outline" id="wlSetImgBtn_${id}">🖼 Set image</button>
        <button class="btn-sm btn-outline" id="wlResetImgBtn_${id}" ${imageOverrides[String(id)] ? '' : 'disabled'}>Reset image</button>
        <button class="btn-sm btn-outline" id="wlBundleBtn_${id}">📦 ${escapeHtml(t('bundlesBtn'))}</button>
        ${game.url ? `<a class="game-link" href="${game.url}" target="_blank" rel="noopener">${escapeHtml(t('viewOnGgDeals'))}</a>` : ''}
        <button class="btn-sm btn-danger" style="margin-left:auto" data-action="removeWishlist" data-id="${id}">✕ ${escapeHtml(t('removeBtn'))}</button>
      </div>
      <input type="file" id="wlImageInput_${id}" accept="image/*" class="hidden" />
      <div id="wlBundleContainer_${id}"></div>
    </div>`;

    document.getElementById(`wlAlert_${id}`)?.addEventListener('change', () => saveWishlistAlert(id));
    document.getElementById(`wlThreshold_${id}`)?.addEventListener('change', () => {
      const w = wishlist.find((w) => w.id === id);
      if (w) w.alertThresholdCustom = true;
      saveWishlistAlert(id);
    });
    document.getElementById(`wlSetImgBtn_${id}`)?.addEventListener('click', () => {
      document.getElementById(`wlImageInput_${id}`)?.click();
    });
    document.getElementById(`wlImageInput_${id}`)?.addEventListener('change', async (e) => {
      const file = e.target?.files?.[0];
      if (!file) return;
      try {
        const customImage = await buildCustomImageDataUrl(file);
        imageOverrides[String(id)] = customImage;
        saveData();
        refreshImagesForGame(id, game);
        showToast('Custom image set', 'success');
        const resetBtn = document.getElementById(`wlResetImgBtn_${id}`);
        if (resetBtn) resetBtn.disabled = false;
      } catch {
        showToast('Failed to set custom image', 'error');
      } finally {
        e.target.value = '';
      }
    });
    document.getElementById(`wlResetImgBtn_${id}`)?.addEventListener('click', () => {
      const key = String(id);
      if (!imageOverrides[key]) return;
      delete imageOverrides[key];
      saveData();
      refreshImagesForGame(id, game);
      showToast('Custom image removed', 'info');
      const resetBtn = document.getElementById(`wlResetImgBtn_${id}`);
      if (resetBtn) resetBtn.disabled = true;
    });
    const calloutEl = document.getElementById(bundleCalloutId);
    if (calloutEl) {
      calloutEl.innerHTML = `<div class="bundle-worth-callout loading">Checking active bundles for this game…</div>`;
      const cmp = await getBundleComparisonForGame(id, best, currency);
      if (cmp.kind === 'worth') {
        calloutEl.innerHTML = `<div class="bundle-worth-callout worth">📦 Bundle watch: ${escapeHtml(cmp.shopName)} has a tier at <b>${cmp.tierPrice} ${cmp.currency}</b>, which is <b>${cmp.delta} ${cmp.currency}</b> below this game's current best price.</div>`;
      } else if (cmp.kind === 'higher') {
        calloutEl.innerHTML = `<div class="bundle-worth-callout higher">📦 Bundle watch: cheapest matching tier is <b>${cmp.tierPrice} ${cmp.currency}</b> at ${escapeHtml(cmp.shopName)}, about <b>${cmp.delta} ${cmp.currency}</b> above this game's current best price.</div>`;
      } else {
        calloutEl.innerHTML = `<div class="bundle-worth-callout neutral">📦 Bundle watch: no active bundle includes this game right now.</div>`;
      }
    }
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
          for (const tr of b.tiers) {
            h += `<div class="bundle-tier"><span class="bundle-price">${tr.price} ${tr.currency}</span> · ${tr.gamesCount || '?'} ${t('games')}</div>`;
            h += renderBundleTierGames(tr, t('games'));
          }
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
  const currencyEl = document.getElementById(`wlCurrency_${id}`);
  if (chk) w.alertEnabled = chk.checked;
  if (inp) w.alertThreshold = parseFloat(inp.value) || 0;
  if (currencyEl) w.alertThresholdCurrency = currencyEl.textContent.trim().toUpperCase();
  saveData();
  showToast(chk?.checked ? t('alertEnabled') : t('alertDisabled'), 'success');
}

function getBestPrice(prices) {
  const r = prices.currentRetail ? parseFloat(prices.currentRetail) : null;
  if (userPrefs.officialOnly) return r;
  const k = prices.currentKeyshops ? parseFloat(prices.currentKeyshops) : null;
  if (r !== null && k !== null) return Math.min(r, k);
  return r ?? k;
}

// Lowest historical low respecting the Official Stores Only preference.
// Returns null if no historical data is available for the relevant source(s).
function getBestHistoricalLow(prices) {
  if (!prices) return null;
  const r = prices.historicalRetail ? parseFloat(prices.historicalRetail) : null;
  if (userPrefs.officialOnly) return (r !== null && !isNaN(r)) ? r : null;
  const k = prices.historicalKeyshops ? parseFloat(prices.historicalKeyshops) : null;
  if (r !== null && k !== null) return Math.min(r, k);
  return (r !== null) ? r : (k !== null) ? k : null;
}

window.loadWishlistItemDetail = loadWishlistItemDetail;
window.removeWishlistItem = function (id) {
  const item = wishlist.find((w) => w.id === id);
  removeFromWishlist(id);
  displayWishlist();
  if (item) showToast(t('removed', item.title), 'info');
};

// ── Wishlist Export / Import ──

document.getElementById('exportWishlistBtn')?.addEventListener('click', () => {
    const text = wishlist.map(w => `[${w.lastPrice} ${w.lastCurrency||'USD'}] ${w.title} - https://store.steampowered.com/app/${w.id}`).join('\n');
    navigator.clipboard.writeText(text).then(() => showToast(t('exportedCopied') || 'Copied to clipboard!', 'success'));
});

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
          alertEnabled: false,
          alertThreshold: item.alertThreshold || item.addedPrice || 0,
          alertThresholdCustom: !!item.alertThreshold,
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
  document.getElementById('officialOnly').checked = userPrefs.officialOnly;
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
  document.getElementById('officialOnly').addEventListener('change', (e) => {
    userPrefs.officialOnly = e.target.checked;
    savePrefs();
    showToast(e.target.checked ? 'Official stores only enabled' : 'All stores enabled', 'info');
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
      // Force bundles refresh for the new region's pricing/currency.
      bundlesLoaded = false;
      activeBundlesData = [];
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

  document.getElementById('viewChangelogBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('changelog.html') });
  });

  document.getElementById('replayOnboardingBtn').addEventListener('click', () => replayOnboarding());
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
    case 'openDetectedTab': switchTab('detected'); loadDetectedGames(); break;
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
  chrome.storage.local.set({ wishlist, priceHistory, notificationSettings, imageOverrides });

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

function refreshImagesForGame(id, game = null) {
  const appId = String(id);
  const imageInfo = getResolvedImageForGame(appId, game);
  document.querySelectorAll(`.game-card[data-game-id="${appId}"] .game-card-img`).forEach((img) => {
    img.src = imageInfo.src;
    img.dataset.fallbacks = imageInfo.fallbacks || '';
  });
  document.querySelectorAll(`.wishlist-item[data-wl-id="${appId}"] .wishlist-img`).forEach((img) => {
    img.src = imageInfo.src;
    img.dataset.fallbacks = imageInfo.fallbacks || '';
  });
}

function buildCustomImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('file-read-failed'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const maxW = 460;
          const maxH = 215;
          const scale = Math.min(maxW / img.width, maxH / img.height, 1);
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('canvas-failed')); return; }
          ctx.drawImage(img, 0, 0, w, h);
          // JPEG keeps storage smaller than PNG for covers.
          resolve(canvas.toDataURL('image/jpeg', 0.88));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('image-load-failed'));
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
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
    // Try alternate CDNs/assets first before falling back to extension icon.
    const queue = (e.target.dataset?.fallbacks || '').split('|').filter(Boolean);
    if (queue.length > 0) {
      const next = queue.shift();
      e.target.dataset.fallbacks = queue.join('|');
      e.target.src = next;
      return;
    }
    // Prevent infinite loops if default icon itself is somehow missing.
    if (e.target.src && !e.target.src.endsWith('images/icon-128.png')) {
      e.target.src = 'images/icon-128.png';
    }
  }
}, true);


setTimeout(() => {
    const extVersionEl = document.getElementById('extVersion');
    if (extVersionEl) {
        extVersionEl.textContent = 'v' + chrome.runtime.getManifest().version;
    }
}, 100);
