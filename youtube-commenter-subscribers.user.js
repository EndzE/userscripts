// ==UserScript==
// @name         YouTube - Commenter Subscribers
// @namespace    https://github.com/EndzE
// @version      1.5.0
// @description  Displays the commenter's subscriber count next to their username on YouTube.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://www.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @noframes
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-commenter-subscribers.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-commenter-subscribers.user.js
// ==/UserScript==

(() => {
  'use strict';

  const DEBUG = false;
  const version = typeof GM_info !== 'undefined' ? GM_info?.script?.version : '1.5.0';
  if (DEBUG) console.log(`[Commenter Subscribers] Initializing v${version}`);

  const css = `
    .subscriber-count {
      font-size: 1.1rem;
      line-height: normal;
      color: var(--yt-spec-text-primary, #0f0f0f);
      background-color: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.06));
      margin-left: 6px;
      padding: 1px 4px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      font-weight: 400;
      vertical-align: middle;
      user-select: none;
      contain: layout style paint;
      white-space: nowrap;
    }
    html[dark] .subscriber-count,
    [dark] .subscriber-count {
      color: var(--yt-spec-text-primary, #f1f1f1);
      background-color: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.12));
    }
    .subscriber-count.is-private {
      opacity: 0.75;
      font-style: italic;
    }
    .subscriber-count.is-loading {
      display: none;
    }
  `;

  if (typeof GM_addStyle === 'function') {
    GM_addStyle(css);
  } else {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Sentinels
  const PRIVATE = '__PRIVATE__';
  const ERROR = '__ERROR__';

  // String token for YouTube aboutChannelViewModel subscriberCountText
  const SUB_KEY = '"subscriberCountText":"';

  /**
   * Fast string extractor for subscriberCountText with JSON escape unescaping.
   * @param {string} text
   * @param {number} [startFrom]
   * @returns {string|null}
   */
  const extractSubscriberCountFast = (text, startFrom = 0) => {
    const idx = text.indexOf(SUB_KEY, startFrom);
    if (idx === -1) return null;
    const start = idx + SUB_KEY.length;
    const end = text.indexOf('"', start);
    if (end === -1) return null;
    const raw = text.slice(start, end);
    try {
      return JSON.parse('"' + raw + '"');
    } catch {
      return raw;
    }
  };

  const SUB_LANG_REGEX =
    /subscri|suscri|subskry|abon|подпис|підпис|падпіс|абон|претплат|pretplat|iscritt|inscrit|prenumer|odběrat|odbera|tilaaj|tellij|feliratkoz|εγγεγραμμ|συνδρομητ|מנוי|登録者|구독자|订阅|訂閱|مشتر[كک]|सदस्य|গ্রাহক|ผู้ติดตาม|đăng ký|pelanggan|langganan/i;

  const FALLBACK_REGEX = /"text":\{"content":"([^"]+)"\},"accessibilityLabel":"([^"]*)"/g;

  // Multi-tier cache: L1 Memory Map + L2 GM Storage with 24-hour TTL & cross-tab persistence
  const STORAGE_KEY = 'yt_subscribers_cache_v2';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const ERROR_TTL_MS = 60 * 1000; // 1 minute negative cache for errors
  const MAX_STORAGE_ENTRIES = 1000;
  const pendingCache = new Map();
  const resolvedCache = new Map();
  const cacheExpiry = new Map();
  const handleToCanonical = new Map();
  let isDirty = false;
  let saveTimer = null;

  // Helper to read persistent GM / localStorage
  const readPersistentStorage = () => {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(STORAGE_KEY, null);
        if (val) return typeof val === 'string' ? JSON.parse(val) : val;
      }
    } catch {}
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  // Helper to write persistent GM / localStorage
  const writePersistentStorage = (payload) => {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY, payload);
        return;
      }
    } catch {}
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {}
  };

  // Safe cache accessor that verifies TTL and resolves handle aliases
  const getCachedValue = (key) => {
    if (!key) return undefined;
    const canonicalKey = handleToCanonical.get(key) || key;
    if (!resolvedCache.has(canonicalKey)) return undefined;
    const exp = cacheExpiry.get(canonicalKey);
    if (exp && Date.now() > exp) {
      resolvedCache.delete(canonicalKey);
      cacheExpiry.delete(canonicalKey);
      if (canonicalKey !== key) handleToCanonical.delete(key);
      return undefined;
    }
    return resolvedCache.get(canonicalKey);
  };

  // Canonical cache setter with LRU refresh, size capping and dirty-flag tracking
  const setCachedValue = (canonicalId, channelUrl, val, customTtl) => {
    if (val === undefined) return;
    const primary = canonicalId || channelUrl;
    if (!primary) return;

    const ttl = val === ERROR ? ERROR_TTL_MS : (customTtl || CACHE_TTL_MS);
    const exp = Date.now() + ttl;

    // Refresh LRU order: delete then set
    resolvedCache.delete(primary);
    resolvedCache.set(primary, val);
    cacheExpiry.set(primary, exp);

    // Evict oldest in-memory entries if exceeding bounds
    if (resolvedCache.size > MAX_STORAGE_ENTRIES * 1.5) {
      const oldestKey = resolvedCache.keys().next().value;
      resolvedCache.delete(oldestKey);
      cacheExpiry.delete(oldestKey);
    }

    if (canonicalId && channelUrl && canonicalId !== channelUrl) {
      handleToCanonical.delete(channelUrl);
      handleToCanonical.set(channelUrl, canonicalId);
      if (handleToCanonical.size > MAX_STORAGE_ENTRIES * 1.5) {
        const oldestHandle = handleToCanonical.keys().next().value;
        handleToCanonical.delete(oldestHandle);
      }
    }

    if (val !== ERROR) {
      persistCache();
    }
  };

  // Hydrate L1 cache from persistent GM storage with TTL filtering and alias hydration
  try {
    const now = Date.now();
    const stored = readPersistentStorage();
    if (stored && typeof stored === 'object') {
      for (const [k, item] of Object.entries(stored)) {
        if (typeof item === 'string') {
          if (item !== ERROR) {
            handleToCanonical.set(k, item);
          }
        } else if (item && typeof item === 'object' && 'exp' in item) {
          if (item.exp > now && item.val !== ERROR) {
            resolvedCache.set(k, item.val);
            cacheExpiry.set(k, item.exp);
          }
        } else if (item !== ERROR) {
          resolvedCache.set(k, item);
          cacheExpiry.set(k, now + CACHE_TTL_MS);
        }
      }
    }
    sessionStorage.removeItem('yt_subscribers_cache');
  } catch {}

  // Flushes dirty cache to persistent storage, merging with latest storage to prevent cross-tab overwrite
  const flushStorage = () => {
    saveTimer = null;
    if (!isDirty) return;
    isDirty = false;
    try {
      const now = Date.now();
      const stored = readPersistentStorage() || {};
      const mergedCanonical = new Map();
      const mergedAliases = new Map();

      // 1. Hydrate existing stored entries
      for (const [k, item] of Object.entries(stored)) {
        if (typeof item === 'string') {
          if (item !== ERROR) mergedAliases.set(k, item);
        } else if (item && typeof item === 'object' && 'exp' in item) {
          if (item.exp > now && item.val !== ERROR) {
            mergedCanonical.set(k, item);
          }
        }
      }

      // 2. Merge current tab's resolved cache (overriding if newer)
      for (const [k, v] of resolvedCache.entries()) {
        if (v !== ERROR) {
          const exp = cacheExpiry.get(k) || (now + CACHE_TTL_MS);
          if (exp > now) {
            mergedCanonical.delete(k); // Move to back for LRU
            mergedCanonical.set(k, { val: v, exp });
          }
        }
      }

      for (const [h, c] of handleToCanonical.entries()) {
        if (mergedCanonical.has(c)) {
          mergedAliases.delete(h);
          mergedAliases.set(h, c);
        }
      }

      // 3. Keep newest entries up to MAX_STORAGE_ENTRIES
      const canonicalEntries = Array.from(mergedCanonical.entries());
      const keptCanonical = canonicalEntries.slice(-MAX_STORAGE_ENTRIES);

      const payload = {};
      for (const [k, v] of keptCanonical) {
        payload[k] = v;
      }

      let remainingSlots = MAX_STORAGE_ENTRIES - keptCanonical.length;
      if (remainingSlots > 0) {
        const aliasEntries = Array.from(mergedAliases.entries());
        for (const [h, c] of aliasEntries.slice(-remainingSlots)) {
          if (payload[c]) payload[h] = c;
        }
      }

      writePersistentStorage(payload);
    } catch {}
  };

  // Schedules non-blocking cache persistence during idle frames
  const persistCache = () => {
    isDirty = true;
    if (saveTimer) return;
    if (typeof requestIdleCallback === 'function') {
      saveTimer = requestIdleCallback(flushStorage, { timeout: 3000 });
    } else {
      saveTimer = setTimeout(flushStorage, 1500);
    }
  };

  // Ensure dirty cache is committed when switching tabs or unloading
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isDirty) {
      flushStorage();
    }
  });
  window.addEventListener('pagehide', () => {
    if (isDirty) flushStorage();
  });

  // Safe InnerTube context accessor
  const getYtContext = () => {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const ytcfgObj = win?.ytcfg;
    return ytcfgObj?.get
      ? ytcfgObj.get('INNERTUBE_CONTEXT')
      : { client: { clientName: 'WEB', clientVersion: '2.20261105.05.01' } };
  };

  // Concurrency limiter with LIFO priority scheduling and rate-limit cooldown
  const MAX_CONCURRENT = 5;
  let activeRequests = 0;
  const requestQueue = [];
  let cooldownUntil = 0;

  const runQueue = () => {
    const now = Date.now();
    if (now < cooldownUntil) {
      setTimeout(runQueue, Math.max(100, cooldownUntil - now));
      return;
    }

    while (activeRequests < MAX_CONCURRENT && requestQueue.length > 0) {
      const item = requestQueue.shift();
      if (item.signal?.aborted) continue;
      activeRequests++;
      item.run().finally(() => {
        activeRequests--;
        runQueue();
      });
    }
  };

  const enqueueRequest = (task, signal) => {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise((resolve, reject) => {
      let item;
      const onAbort = () => {
        const idx = requestQueue.indexOf(item);
        if (idx !== -1) {
          requestQueue.splice(idx, 1);
        }
        reject(new DOMException('Aborted', 'AbortError'));
      };

      item = {
        run: () => {
          if (signal?.aborted) {
            onAbort();
            return Promise.resolve(); // Resolves internal queue runner without unhandled rejection
          }
          signal?.removeEventListener('abort', onAbort);
          return task().then(resolve, reject);
        },
        signal,
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      requestQueue.unshift(item);
      runQueue();
    });
  };

  /**
   * Fast fallback regex on pageHeaderRenderer metadata when subscriberCountText is missing.
   * @param {string} text
   * @returns {string|null}
   */
  const extractFallback = (text) => {
    const marker = '"pageHeaderRenderer":';
    const start = text.indexOf(marker);
    if (start === -1) return null;

    const headerSlice = text.slice(start, start + 3500);
    FALLBACK_REGEX.lastIndex = 0;
    let m;
    while ((m = FALLBACK_REGEX.exec(headerSlice)) !== null) {
      const content = m[1];
      const label = m[2];
      if (
        content &&
        !content.startsWith('@') &&
        SUB_LANG_REGEX.test(`${content} ${label}`)
      ) {
        return content;
      }
    }
    return null;
  };

  /**
   * Extracts subscriber text from varied YouTube text objects (simpleText, runs, or content).
   * @param {object} obj
   * @returns {string|null}
   */
  const extractTextObject = (obj) => {
    if (!obj) return null;
    if (typeof obj.simpleText === 'string') return obj.simpleText;
    if (Array.isArray(obj.runs)) {
      let combined = '';
      for (let i = 0; i < obj.runs.length; i++) {
        combined += obj.runs[i]?.text || '';
      }
      return combined || null;
    }
    if (typeof obj.content === 'string') return obj.content;
    return null;
  };

  /**
   * Parses subscriber count directly from InnerTube browse response JSON.
   * @param {object} data
   * @returns {string} sub count, PRIVATE sentinel, or ERROR sentinel
   */
  const parseInnerTube = (data) => {
    if (!data || typeof data !== 'object') return ERROR;
    const header = data.header;
    if (!header || typeof header !== 'object') return ERROR;

    // 1. Primary modern path: pageHeaderViewModel content metadata rows
    const rows =
      header.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata
        ?.contentMetadataViewModel?.metadataRows;
    if (rows) {
      for (let i = 0; i < rows.length; i++) {
        const parts = rows[i]?.metadataParts;
        if (!parts) continue;
        for (let j = 0; j < parts.length; j++) {
          const text = parts[j]?.text?.content;
          if (text && !text.startsWith('@')) {
            const label = parts[j]?.accessibilityLabel || '';
            if (SUB_LANG_REGEX.test(`${text} ${label}`)) {
              return text;
            }
          }
        }
      }
      return PRIVATE;
    }

    // 2. Direct legacy c4TabbedHeaderRenderer lookup
    const c4 = header.c4TabbedHeaderRenderer?.subscriberCountText;
    if (c4) {
      const text = extractTextObject(c4);
      if (text) return text;
    }

    // 3. Fast iterative object inspection across all header renderers
    for (const key in header) {
      const renderer = header[key];
      if (renderer && typeof renderer === 'object') {
        const sub = renderer.subscriberCountText;
        if (sub) {
          const text = extractTextObject(sub);
          if (text) return text;
        }
      }
    }

    if (header.c4TabbedHeaderRenderer || header.pageHeaderRenderer) {
      return PRIVATE;
    }

    return ERROR;
  };

  /**
   * Fetches subscriber count using InnerTube API browse endpoint with request hints.
   * @param {string} browseId
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  const fetchInnerTube = async (browseId, signal) => {
    const res = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: getYtContext(), browseId }),
      signal,
      priority: 'low',
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        cooldownUntil = Date.now() + 30000;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    return parseInnerTube(data);
  };

  /**
   * Fetches subscriber count using ReadableStream early exit as safety fallback.
   * @param {string} channelUrl
   * @param {AbortSignal} [signal]
   * @returns {Promise<string|null>}
   */
  const fetchSubscriberCountStream = async (channelUrl, signal) => {
    const res = await fetch(`${channelUrl}/about`, { signal, priority: 'low' });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        cooldownUntil = Date.now() + 30000;
      }
      throw new Error(`HTTP ${res.status}`);
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      const text = await res.text();
      return extractSubscriberCountFast(text) || extractFallback(text);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastScanLen = 0;

    while (true) {
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const searchFrom = Math.max(0, lastScanLen - SUB_KEY.length - 128);
      const match = extractSubscriberCountFast(buffer, searchFrom);
      lastScanLen = buffer.length;
      if (match) {
        reader.cancel().catch(() => {});
        return match;
      }

      // Keep 256KB sliding buffer to preserve pageHeaderRenderer metadata if fallback is needed
      if (buffer.length > 393216) {
        buffer = buffer.slice(-262144);
        lastScanLen = buffer.length;
      }
    }

    return extractFallback(buffer);
  };

  /**
   * Unified fetch dispatcher: attempts InnerTube browse first, falls back to stream.
   * @param {string|null} browseId
   * @param {string} channelUrl
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  const fetchSubscriberCount = async (browseId, channelUrl, signal) => {
    try {
      if (browseId) {
        return await fetchInnerTube(browseId, signal);
      }
      const streamRes = await fetchSubscriberCountStream(channelUrl, signal);
      return streamRes ?? PRIVATE;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (browseId && channelUrl && !signal?.aborted) {
        try {
          const fallbackRes = await fetchSubscriberCountStream(channelUrl, signal);
          return fallbackRes ?? PRIVATE;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
      }
      if (DEBUG) console.warn('[Commenter Subscribers] Fetch failed for:', channelUrl || browseId, err);
      return ERROR;
    }
  };

  /**
   * Fast channel URL & handle normalizer with decodeURIComponent and case-normalization.
   * @param {string} rawUrl
   * @returns {string}
   */
  const normalizeChannelUrl = (rawUrl) => {
    if (!rawUrl) return '';
    try {
      const origin = location.origin;
      let path = rawUrl.startsWith(origin) ? rawUrl.slice(origin.length) : rawUrl.replace(/^https?:\/\/[^/]+/, '');
      const qIdx = path.indexOf('?');
      if (qIdx !== -1) path = path.slice(0, qIdx);
      const hIdx = path.indexOf('#');
      if (hIdx !== -1) path = path.slice(0, hIdx);
      try {
        path = decodeURIComponent(path);
      } catch {}
      while (path.endsWith('/') && path.length > 1) {
        path = path.slice(0, -1);
      }
      if (path.startsWith('/@')) {
        path = '/@' + path.slice(2).toLowerCase();
      }
      return origin + path;
    } catch {
      return rawUrl;
    }
  };

  /**
   * Normalizes channel target and manages queued fetching with multi-tier caching.
   * Supports multi-signal reference-counted cancellation.
   * @param {string} rawUrl
   * @param {string|null} browseId
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  const getSubs = (rawUrl, browseId, signal) => {
    const channelUrl = normalizeChannelUrl(rawUrl);
    const primaryKey = browseId || channelUrl;
    if (!primaryKey) return Promise.resolve(null);

    const cachedPrimary = getCachedValue(primaryKey);
    if (cachedPrimary !== undefined) {
      return Promise.resolve(cachedPrimary);
    }
    if (channelUrl) {
      const cachedUrl = getCachedValue(channelUrl);
      if (cachedUrl !== undefined) {
        return Promise.resolve(cachedUrl);
      }
    }

    const opSub = getOpSubscriberCount(null, browseId, channelUrl);
    if (opSub !== undefined) {
      setCachedValue(browseId, channelUrl, opSub);
      return Promise.resolve(opSub);
    }

    if (pendingCache.has(primaryKey)) {
      const pending = pendingCache.get(primaryKey);
      if (!pending.masterController.signal.aborted) {
        if (signal) {
          if (signal.aborted) {
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
          }
          const onAbort = () => {
            pending.signals.delete(signal);
            if (pending.signals.size === 0 && pending.hasSignalListeners) {
              pending.masterController.abort();
            }
          };
          pending.signals.add(signal);
          pending.hasSignalListeners = true;
          signal.addEventListener('abort', onAbort, { once: true });
          return pending.promise.finally(() => {
            signal.removeEventListener('abort', onAbort);
          });
        }
        return pending.promise;
      }
      pendingCache.delete(primaryKey);
    }

    const masterController = new AbortController();
    const signals = new Set();
    let hasSignalListeners = false;

    if (signal) {
      if (signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      signals.add(signal);
      hasSignalListeners = true;
    }

    const pendingObj = {
      masterController,
      signals,
      hasSignalListeners,
      promise: null,
    };

    if (signal) {
      const onAbort = () => {
        signals.delete(signal);
        if (signals.size === 0 && pendingObj.hasSignalListeners) {
          masterController.abort();
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const promise = enqueueRequest(
      () => fetchSubscriberCount(browseId, channelUrl, masterController.signal),
      masterController.signal
    )
      .then((result) => {
        pendingCache.delete(primaryKey);
        setCachedValue(primaryKey, channelUrl, result);
        return result;
      })
      .catch((err) => {
        pendingCache.delete(primaryKey);
        if (err.name === 'AbortError') {
          throw err;
        }
        setCachedValue(primaryKey, channelUrl, ERROR);
        return ERROR;
      });

    pendingObj.promise = promise;
    pendingCache.set(primaryKey, pendingObj);
    return promise;
  };

  /**
   * Fast channel browseId extractor with page-world unwrap compatibility.
   * @param {HTMLAnchorElement} anchor
   * @param {HTMLElement} [commentElement]
   * @returns {string|null}
   */
  const getBrowseId = (anchor, commentElement) => {
    const winAnchor = anchor?.wrappedJSObject || anchor;
    if (winAnchor?.data?.browseEndpoint?.browseId) {
      return winAnchor.data.browseEndpoint.browseId;
    }
    const parentComment = commentElement || anchor?.closest('ytd-comment-view-model');
    if (parentComment) {
      const thumb = parentComment.querySelector('a#author-thumbnail');
      const winThumb = thumb?.wrappedJSObject || thumb;
      if (winThumb?.data?.browseEndpoint?.browseId) {
        return winThumb.data.browseEndpoint.browseId;
      }
    }
    const href = anchor?.href;
    if (href) {
      const idx = href.indexOf('/channel/UC');
      if (idx !== -1) {
        const end = href.indexOf('/', idx + 9);
        return end === -1 ? href.slice(idx + 9) : href.slice(idx + 9, end);
      }
    }
    return null;
  };

  const activeControllers = new WeakMap();

  const ensureBadge = (header) => {
    let badge = header.querySelector('.subscriber-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'subscriber-count';
      header.appendChild(badge);
    }
    return badge;
  };

  const applyBadgeContent = (badge, subCount) => {
    if (subCount === PRIVATE || subCount === null) {
      badge.textContent = 'Private';
      badge.classList.add('is-private');
    } else {
      badge.textContent = subCount;
      badge.classList.remove('is-private');
    }
    badge.classList.remove('is-loading');
  };

  const resolveSync = (browseId, channelUrl, header) => {
    const key = browseId || channelUrl;
    let cached = getCachedValue(key) ?? (channelUrl ? getCachedValue(channelUrl) : undefined);
    if (cached === undefined) {
      const opSub = getOpSubscriberCount(header, browseId, channelUrl);
      if (opSub !== undefined) {
        cached = opSub;
        setCachedValue(browseId, channelUrl, opSub);
      }
    }
    return cached;
  };

  const updateBadge = async (anchor, header, signal, commentElement, browseId) => {
    const targetUrl = anchor.href;
    if (!targetUrl) return;

    try {
      const subCount = await getSubs(targetUrl, browseId, signal);

      if (anchor.href !== targetUrl) return;

      if (subCount === ERROR) {
        const badge = header.querySelector('.subscriber-count');
        if (badge) badge.classList.add('is-loading');
        return;
      }

      const badge = ensureBadge(header);
      badge.dataset.target = targetUrl;
      applyBadgeContent(badge, subCount);

      if (commentElement) {
        viewportObserver.unobserve(commentElement);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      if (commentElement && activeControllers.get(commentElement)?.signal === signal) {
        activeControllers.delete(commentElement);
      }
    }
  };

  /**
   * Fast author anchor validator using O(1) property checks.
   * @param {HTMLAnchorElement} el
   * @returns {boolean}
   */
  const isAuthorAnchor = (el) => {
    if (!el || el.tagName !== 'A') return false;
    const id = el.id;
    if (id === 'author-text' || id === 'name') return true;
    if (el.parentElement?.id === 'header-author') return true;
    const href = el.getAttribute('href') || '';
    return (href.startsWith('/@') || href.startsWith('/channel/')) && el.closest('div#header-author') !== null;
  };

  /**
   * OP (video author) subscriber count resolver cached per navigation.
   */
  let cachedOpInfo = null;

  const resolveOpInfo = () => {
    const subEl = document.querySelector('#owner-sub-count');
    const subText = subEl?.textContent?.trim();
    if (!subText) return null;

    const ownerEl = document.querySelector('ytd-watch-metadata #owner, #upload-info #owner, ytd-video-owner-renderer');
    const ownerAnchor = ownerEl?.querySelector('a[href^="/@"], a[href^="/channel/"], a#avatar, a#channel-name');
    const ownerHref = ownerAnchor?.getAttribute('href');
    const ownerUrl = ownerHref ? normalizeChannelUrl(ownerHref) : null;
    const ownerBrowseId =
      ownerAnchor?.data?.browseEndpoint?.browseId ||
      ownerAnchor?.wrappedJSObject?.data?.browseEndpoint?.browseId ||
      ownerEl?.data?.navigationEndpoint?.browseEndpoint?.browseId;

    cachedOpInfo = {
      subText,
      ownerBrowseId: ownerBrowseId || null,
      ownerUrl: ownerUrl || null,
    };
    return cachedOpInfo;
  };

  const getOpSubscriberCount = (header, browseId, channelUrl) => {
    const op = cachedOpInfo || resolveOpInfo();
    if (!op?.subText) return undefined;

    if (header?.querySelector('ytd-author-comment-badge-renderer')) {
      return op.subText;
    }
    if (browseId && op.ownerBrowseId && browseId === op.ownerBrowseId) {
      return op.subText;
    }
    if (channelUrl && op.ownerUrl && channelUrl === op.ownerUrl) {
      return op.subText;
    }
    return undefined;
  };

  /**
   * Finds the commenter's channel link inside the comment header.
   */
  const getAuthorAnchor = (header) =>
    header.querySelector('a#author-text, a#name') ||
    header.querySelector('a[href^="/@"], a[href^="/channel/"]') ||
    header.querySelector('a');

  /**
   * Initializes a comment element once it nears the viewport.
   * @param {HTMLElement} commentElement
   */
  const initComment = (commentElement) => {
    const header = commentElement.querySelector('div#header-author');
    if (!header) return;

    const anchor = getAuthorAnchor(header);
    if (!anchor) return;

    const browseId = getBrowseId(anchor, commentElement);
    const channelUrl = normalizeChannelUrl(anchor.href);
    const targetUrl = anchor.href;

    const cached = resolveSync(browseId, channelUrl, header);
    if (cached !== undefined && cached !== ERROR) {
      const badge = ensureBadge(header);
      badge.dataset.target = targetUrl;
      applyBadgeContent(badge, cached);
      viewportObserver.unobserve(commentElement);
      return;
    }

    let badge = header.querySelector('.subscriber-count');
    if (badge) {
      badge.classList.add('is-loading');
    }

    if (activeControllers.has(commentElement)) return;

    const controller = new AbortController();
    activeControllers.set(commentElement, controller);
    updateBadge(anchor, header, controller.signal, commentElement, browseId);
  };

  // Viewport observer with 400px margin for pre-emptive loading and viewport exit cancellation
  const viewportObserver = new IntersectionObserver(
    (entries) => {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const el = entry.target;
        if (entry.isIntersecting) {
          initComment(el);
        } else {
          const controller = activeControllers.get(el);
          if (controller) {
            controller.abort();
            activeControllers.delete(el);
          }
        }
      }
    },
    { rootMargin: '400px 0px' }
  );

  const queueComment = (commentElement) => {
    if (!commentElement) return;
    viewportObserver.observe(commentElement);
  };

  // Single shared MutationObserver scoped strictly to the comments thread container.
  const commentsObserver = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];

      // Handle element reuse / href changes (virtual DOM recycling)
      if (m.type === 'attributes' && m.attributeName === 'href') {
        const anchor = m.target;
        if (isAuthorAnchor(anchor)) {
          const header =
            anchor.parentElement?.id === 'header-author'
              ? anchor.parentElement
              : anchor.closest('div#header-author');
          if (header) {
            const comment = anchor.closest('ytd-comment-view-model');
            if (comment) {
              const ctrl = activeControllers.get(comment);
              if (ctrl) {
                ctrl.abort();
                activeControllers.delete(comment);
              }
              const badge = header.querySelector('.subscriber-count');
              if (badge && badge.dataset.target !== anchor.href) {
                badge.classList.add('is-loading');
              }
              queueComment(comment);
            }
          }
        }
        continue;
      }

      // Handle newly added comments and thread blocks
      const added = m.addedNodes;
      for (let j = 0; j < added.length; j++) {
        const node = added[j];
        if (node.nodeType !== 1) continue;

        if (node.tagName === 'YTD-COMMENT-VIEW-MODEL') {
          queueComment(node);
        } else {
          const comments = node.getElementsByTagName('ytd-comment-view-model');
          for (let k = 0; k < comments.length; k++) {
            queueComment(comments[k]);
          }
        }
      }

      if (m.target.nodeType === 1) {
        const parentComment = m.target.tagName === 'YTD-COMMENT-VIEW-MODEL'
          ? m.target
          : m.target.closest('ytd-comment-view-model');
        if (parentComment) {
          queueComment(parentComment);
        }
      }
    }
  });

  const isShorts = () => location.pathname.startsWith('/shorts/');

  const getShortsCommentsPanel = () =>
    document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]');

  const attachCommentsObserver = (panelTarget) => {
    let threadContainer = null;
    if (panelTarget) {
      threadContainer = panelTarget.querySelector('ytd-comments #contents') || panelTarget.querySelector('#contents');
    } else {
      const panel = isShorts() ? getShortsCommentsPanel() : null;
      if (panel) {
        if (panel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
          return false;
        }
        threadContainer = panel.querySelector('ytd-comments #contents') || panel.querySelector('#contents');
      } else {
        threadContainer =
          document.querySelector('ytd-comments #contents') ||
          document.querySelector('ytd-comments:not([hidden])') ||
          document.querySelector('#comments:not([hidden])');
      }
    }

    if (!threadContainer) return false;

    commentsObserver.disconnect();
    commentsObserver.observe(threadContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    const existing = threadContainer.getElementsByTagName('ytd-comment-view-model');
    for (let i = 0; i < existing.length; i++) {
      queueComment(existing[i]);
    }

    return true;
  };

  const isCommentsRoute = () => {
    const path = location.pathname;
    return path === '/watch' || path.startsWith('/shorts/') || path.startsWith('/post/');
  };

  let pageObserver = null;
  let shortsPanelObserver = null;
  let rafId = null;

  const setupShortsComments = () => {
    const panel = getShortsCommentsPanel();
    if (!panel) return false;

    const handleVisibility = () => {
      const isExpanded = panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
      if (isExpanded) {
        attachCommentsObserver(panel);
      } else {
        commentsObserver.disconnect();
        viewportObserver.disconnect();
      }
    };

    if (shortsPanelObserver) {
      shortsPanelObserver.disconnect();
    }

    shortsPanelObserver = new MutationObserver(handleVisibility);
    shortsPanelObserver.observe(panel, { attributes: true, attributeFilter: ['visibility'] });
    handleVisibility();
    return true;
  };

  const init = () => {
    cachedOpInfo = null;
    resolveOpInfo();

    if (!isCommentsRoute()) return;

    if (isShorts()) {
      if (setupShortsComments()) return;
    } else {
      if (attachCommentsObserver()) return;
    }

    // Lightweight bootstrap observer: waits only until required container appears, throttled with rAF
    pageObserver = new MutationObserver(() => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (isShorts()) {
          if (setupShortsComments()) {
            if (pageObserver) {
              pageObserver.disconnect();
              pageObserver = null;
            }
          }
        } else {
          if (attachCommentsObserver()) {
            if (pageObserver) {
              pageObserver.disconnect();
              pageObserver = null;
            }
          }
        }
      });
    });

    const pageTarget = document.querySelector('ytd-page-manager') || document.body;
    pageObserver.observe(pageTarget, { childList: true, subtree: true });
  };

  init();

  // Clean SPA navigation handling with complete observer teardown
  window.addEventListener('yt-navigate-finish', () => {
    commentsObserver.disconnect();
    viewportObserver.disconnect();
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    if (shortsPanelObserver) {
      shortsPanelObserver.disconnect();
      shortsPanelObserver = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (const pending of pendingCache.values()) {
      pending.masterController?.abort();
    }
    pendingCache.clear();
    requestQueue.length = 0;
    init();
  });
})();
