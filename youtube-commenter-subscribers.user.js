// ==UserScript==
// @name         YouTube - Commenter Subscribers
// @namespace    https://github.com/EndzE
// @version      1.5.24
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
  const version = typeof GM_info !== 'undefined' ? GM_info?.script?.version : '1.5.24';
  if (DEBUG) console.log(`[Commenter Subscribers] Initializing v${version}`);

  const css = `
    .subscriber-count {
      font-size: 1.1rem;
      line-height: normal;
      color: #0f0f0f;
      background-color: rgba(0, 0, 0, 0.06);
      margin-left: 4px;
      padding: 1px 3px;
      border-radius: 3px;
      white-space: nowrap;
    }
    html[dark] .subscriber-count,
    [dark] .subscriber-count {
      color: #ddd;
      background-color: #333;
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
   * Safely unescapes raw JSON strings (handling unicode escapes like \u00a0, quotes, etc.).
   * @param {string} raw
   * @returns {string}
   */
  const unescapeJsonString = (raw) => {
    if (!raw) return '';
    try {
      return JSON.parse('"' + raw + '"');
    } catch {
      return raw;
    }
  };

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
    return unescapeJsonString(text.slice(start, end));
  };

  const SUB_LANG_REGEX =
    /subscri|suscri|subskry|abon|подпис|підпис|падпіс|абон|претплат|pretplat|iscritt|inscrit|prenumer|odběrat|odbera|tilaaj|tellij|feliratkoz|εγγεγραμμ|συνδρομητ|מנוי|登録者|구독자|订阅|訂閱|مشتر[كک]|सदस्य|গ্রাহক|ผู้ติดตาม|đăng ký|pelanggan|langganan|naroč|abunə|გამომწერ|բաժանորդ|سبسکرائبر|жазылу|захиалагч|tagasubaybay/i;

  const FALLBACK_REGEX = /"text":\{"content":"([^"]+)"\},"accessibilityLabel":"([^"]*)"/g;

  // Multi-tier cache: L1 Memory Map + L2 GM Storage with 24-hour TTL & cross-tab persistence
  const STORAGE_KEY = 'yt_subscribers_cache_v2';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const ERROR_TTL_MS = 60 * 1000; // 1 minute negative cache for errors
  const MAX_STORAGE_ENTRIES = 1000;
  const pendingCache = new Map();
  const storageCache = new Map();
  let isDirty = false;
  let saveTimer = null;

  // Helper to read persistent GM / localStorage
  const readPersistentStorage = () => {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(STORAGE_KEY, null);
        return typeof val === 'string' ? JSON.parse(val) : val;
      }
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
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      }
    } catch {}
  };

  // Safe cache accessor that verifies TTL
  const getCachedValue = (key) => {
    if (!key) return undefined;
    const entry = storageCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) {
      storageCache.delete(key);
      return undefined;
    }
    return entry.val;
  };

  // Cache setter with LRU refresh, size capping and dirty-flag tracking
  const setCachedValue = (canonicalId, channelUrl, val, customTtl) => {
    if (val === undefined || (!canonicalId && !channelUrl)) return;
    const ttl = val === ERROR ? ERROR_TTL_MS : (customTtl || CACHE_TTL_MS);
    const exp = Date.now() + ttl;
    const entry = { val, exp };

    if (canonicalId) {
      storageCache.delete(canonicalId);
      storageCache.set(canonicalId, entry);
    }
    if (channelUrl && channelUrl !== canonicalId) {
      storageCache.delete(channelUrl);
      storageCache.set(channelUrl, entry);
    }

    // Evict oldest in-memory entries if exceeding bounds (capped at MAX_STORAGE_ENTRIES * 2 for dual keys)
    while (storageCache.size > MAX_STORAGE_ENTRIES * 2) {
      const oldestKey = storageCache.keys().next().value;
      storageCache.delete(oldestKey);
    }

    if (val !== ERROR) {
      persistCache();
    }
  };

  // Hydrate L1 cache from persistent storage with TTL filtering and backward-compatible migration
  try {
    const now = Date.now();
    const stored = readPersistentStorage();
    if (stored && typeof stored === 'object') {
      for (const [k, item] of Object.entries(stored)) {
        if (item && typeof item === 'object' && item.exp > now && item.val !== ERROR) {
          storageCache.set(k, item);
        }
      }
      // Migrate legacy string aliases from previous schema
      for (const [k, item] of Object.entries(stored)) {
        if (typeof item === 'string' && storageCache.has(item)) {
          storageCache.set(k, storageCache.get(item));
        }
      }
    }
  } catch {}

  const cancelSaveTimer = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };

  // Flushes dirty cache to persistent storage, merging with latest storage to prevent cross-tab overwrite
  const flushStorage = () => {
    cancelSaveTimer();
    if (!isDirty) return;
    isDirty = false;
    try {
      const now = Date.now();
      const stored = readPersistentStorage() || {};
      const merged = new Map();

      // 1. Merge existing valid storage entries
      for (const [k, item] of Object.entries(stored)) {
        if (item && typeof item === 'object' && item.exp > now && item.val !== ERROR) {
          merged.set(k, item);
        }
      }

      // 2. Merge current tab's cache (overriding if newer and refreshing LRU order)
      for (const [k, entry] of storageCache.entries()) {
        if (entry.exp > now && entry.val !== ERROR) {
          merged.delete(k);
          merged.set(k, entry);
        }
      }

      // 3. Keep newest entries up to MAX_STORAGE_ENTRIES * 2
      const entries = Array.from(merged.entries()).slice(-MAX_STORAGE_ENTRIES * 2);
      const payload = Object.fromEntries(entries);
      writePersistentStorage(payload);
    } catch {}
  };

  // Schedules non-blocking cache persistence via debounce timer
  const persistCache = () => {
    isDirty = true;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(flushStorage, 2000);
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
  let cooldownTimer = null;

  const runQueue = () => {
    const now = Date.now();
    if (now < cooldownUntil) {
      if (!cooldownTimer) {
        cooldownTimer = setTimeout(() => {
          cooldownTimer = null;
          runQueue();
        }, Math.max(100, cooldownUntil - now));
      }
      return;
    }
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }

    while (activeRequests < MAX_CONCURRENT && requestQueue.length > 0) {
      const item = requestQueue.shift();
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
        if (idx !== -1) requestQueue.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      item = {
        run: () => {
          signal?.removeEventListener('abort', onAbort);
          try {
            const p = task(resolve, reject);
            return p ? p.then(resolve, reject) : Promise.resolve();
          } catch (err) {
            reject(err);
            return Promise.resolve();
          }
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      requestQueue.unshift(item); // LIFO: prioritize currently visible comments
      runQueue();
    });
  };

  /**
   * Fast fallback regex on pageHeaderRenderer metadata when subscriberCountText is missing.
   * @param {string} text
   * @returns {string|null}
   */
  const extractFallback = (text) => {
    if (!text) return null;
    const marker = '"pageHeaderRenderer":';
    const start = text.indexOf(marker);
    if (start === -1) return null;

    const headerSlice = text.slice(start, start + 3500);
    FALLBACK_REGEX.lastIndex = 0;
    let m;
    while ((m = FALLBACK_REGEX.exec(headerSlice)) !== null) {
      const content = unescapeJsonString(m[1]);
      const label = unescapeJsonString(m[2]);
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
            if (
              SUB_LANG_REGEX.test(`${text} ${label}`) ||
              (i === 1 && j === 0 && /\d/.test(text) && !/video|videó|vidéo|видео|vídeo|bideo|videolar|videod|videot|videi|videok|فيديو|ویڈیو|वीडियो|ভিডিও|วีดีโอ|비디오|動画|视频|影片/i.test(`${text} ${label}`))
            ) {
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
   * @returns {Promise<string>}
   */
  const fetchInnerTube = async (browseId) => {
    const res = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: getYtContext(), browseId }),
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
   * @returns {Promise<string|null>}
   */
  const fetchSubscriberCountStream = async (channelUrl) => {
    const res = await fetch(`${channelUrl}/about`, { priority: 'low' });
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
    let savedHeaderSlice = null;

    while (true) {
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

      // Early fallback check and header slice preservation
      const headerIdx = buffer.indexOf('"pageHeaderRenderer":');
      if (headerIdx !== -1) {
        if (!savedHeaderSlice && buffer.length >= headerIdx + 3500) {
          savedHeaderSlice = buffer.slice(headerIdx, headerIdx + 3500);
          const fallbackMatch = extractFallback(savedHeaderSlice);
          reader.cancel().catch(() => {});
          return fallbackMatch;
        }
      }

      // Keep 256KB sliding buffer to preserve trailing metadata if fallback is needed
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
   * @returns {Promise<string>}
   */
  const fetchSubscriberCount = async (browseId, channelUrl) => {
    try {
      if (browseId) {
        return await fetchInnerTube(browseId);
      }
      const streamRes = await fetchSubscriberCountStream(channelUrl);
      return streamRes ?? PRIVATE;
    } catch (err) {
      if (browseId && channelUrl) {
        try {
          const fallbackRes = await fetchSubscriberCountStream(channelUrl);
          return fallbackRes ?? PRIVATE;
        } catch {}
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
   * In-flight requests are shared across callers and populate cache on completion.
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

    // If already in-flight on the network, share the promise
    if (pendingCache.has(primaryKey)) {
      return pendingCache.get(primaryKey);
    }

    // Wait for an active slot in the LIFO queue (cancellable while waiting)
    return enqueueRequest((resolve, reject) => {
      // Re-check cache / in-flight when finally starting
      const reCached = getCachedValue(primaryKey) ?? (channelUrl ? getCachedValue(channelUrl) : undefined);
      if (reCached !== undefined) {
        resolve(reCached);
        return Promise.resolve();
      }

      if (pendingCache.has(primaryKey)) {
        pendingCache.get(primaryKey).then(resolve, reject);
        return Promise.resolve();
      }

      const inFlight = fetchSubscriberCount(browseId, channelUrl)
        .then((result) => {
          setCachedValue(primaryKey, channelUrl, result);
          return result;
        })
        .catch(() => {
          setCachedValue(primaryKey, channelUrl, ERROR);
          return ERROR;
        })
        .finally(() => {
          if (pendingCache.get(primaryKey) === inFlight) {
            pendingCache.delete(primaryKey);
          }
        });

      pendingCache.set(primaryKey, inFlight);
      return inFlight.then(resolve, reject);
    }, signal);
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
  const activeControllerSet = new Set();

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
    const isPrivate = subCount === PRIVATE || subCount === null;
    const nextText = isPrivate ? 'Private' : subCount;
    if (badge.textContent !== nextText) {
      badge.textContent = nextText;
    }
    badge.classList.toggle('is-private', isPrivate);
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

  const updateBadge = async (anchor, header, signal, commentElement, browseId, controller) => {
    const targetUrl = anchor.href;
    if (!targetUrl) return;

    try {
      const subCount = await getSubs(targetUrl, browseId, signal);

      if (signal?.aborted) return;
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
        unobserveComment(commentElement);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      if (commentElement && activeControllers.get(commentElement) === controller) {
        activeControllers.delete(commentElement);
      }
      if (controller) {
        activeControllerSet.delete(controller);
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
    if (isShorts()) {
      cachedOpInfo = { subText: null, ownerUrl: null, ownerBrowseId: null };
      return cachedOpInfo;
    }

    const currentVideoId = new URLSearchParams(location.search).get('v');
    if (currentVideoId) {
      const metaVideoId =
        document.querySelector('ytd-watch-metadata')?.getAttribute('video-id') ||
        document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
      if (metaVideoId && metaVideoId !== currentVideoId) {
        return null;
      }
    }

    const ownerEl = document.querySelector('ytd-watch-metadata #owner, ytd-video-owner-renderer');
    const subEl = ownerEl?.querySelector('#owner-sub-count');
    const subText = subEl?.textContent?.trim();
    if (!subText) {
      if (ownerEl?.querySelector('a[href^="/@"], a[href^="/channel/"]')) {
        cachedOpInfo = { subText: null, ownerUrl: null, ownerBrowseId: null };
        return cachedOpInfo;
      }
      return null;
    }

    const ownerAnchor = ownerEl?.querySelector(
      'a.yt-simple-endpoint[href^="/@"], a.yt-simple-endpoint[href^="/channel/"], a[href^="/@"], a[href^="/channel/"]'
    );
    const ownerHref = ownerAnchor?.getAttribute('href');
    const ownerUrl = ownerHref ? normalizeChannelUrl(ownerHref) : null;
    const ownerBrowseId =
      ownerAnchor?.data?.browseEndpoint?.browseId ||
      ownerAnchor?.wrappedJSObject?.data?.browseEndpoint?.browseId ||
      ownerEl?.data?.navigationEndpoint?.browseEndpoint?.browseId;

    if (!ownerUrl && !ownerBrowseId) return null;

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

    const matchesUrl = channelUrl && op.ownerUrl && channelUrl === op.ownerUrl;
    const matchesBrowseId = browseId && op.ownerBrowseId && browseId === op.ownerBrowseId;

    if (header?.querySelector('span#author-comment-badge:not([hidden]) ytd-author-comment-badge-renderer')) {
      if (matchesUrl || matchesBrowseId || (!op.ownerUrl && !op.ownerBrowseId)) {
        return op.subText;
      }
      return undefined;
    }
    if (matchesBrowseId || matchesUrl) {
      return op.subText;
    }
    return undefined;
  };

  /**
   * Finds the commenter's channel link inside the comment header.
   */
  const getAuthorAnchor = (header) =>
    header.querySelector(
      'a#author-text:not([hidden]), span#author-comment-badge:not([hidden]) a#name, a#name:not([hidden])'
    ) ||
    header.querySelector('a#author-text, a#name') ||
    header.querySelector('a[href^="/@"], a[href^="/channel/"]') ||
    header.querySelector('a');

  let observedComments = new WeakSet();

  const unobserveComment = (el) => {
    if (!el) return;
    observedComments.delete(el);
    viewportObserver.unobserve(el);
  };

  const resetViewportObserver = () => {
    for (const ctrl of activeControllerSet) {
      ctrl.abort();
    }
    activeControllerSet.clear();
    observedComments = new WeakSet();
    viewportObserver.disconnect();
  };

  /**
   * Initializes a comment element once it nears the viewport.
   * @param {HTMLElement} commentElement
   */
  const initComment = (commentElement) => {
    const header = commentElement.querySelector('div#header-author');
    if (!header) {
      unobserveComment(commentElement);
      return;
    }

    const anchor = getAuthorAnchor(header);
    if (!anchor) {
      unobserveComment(commentElement);
      return;
    }

    const browseId = getBrowseId(anchor, commentElement);
    const channelUrl = normalizeChannelUrl(anchor.href);
    const targetUrl = anchor.href;

    const cached = resolveSync(browseId, channelUrl, header);
    if (cached !== undefined) {
      if (cached !== ERROR) {
        const badge = ensureBadge(header);
        badge.dataset.target = targetUrl;
        applyBadgeContent(badge, cached);
      } else {
        const badge = header.querySelector('.subscriber-count');
        if (badge) badge.classList.add('is-loading');
      }
      unobserveComment(commentElement);
      return;
    }

    let badge = header.querySelector('.subscriber-count');
    if (badge) {
      badge.classList.add('is-loading');
    }

    if (activeControllers.has(commentElement)) return;

    const controller = new AbortController();
    activeControllers.set(commentElement, controller);
    activeControllerSet.add(controller);
    updateBadge(anchor, header, controller.signal, commentElement, browseId, controller);
  };

  const isCommentResolved = (commentElement) => {
    const header = commentElement.querySelector('div#header-author');
    const badge = header?.querySelector('.subscriber-count');
    if (!badge || badge.classList.contains('is-loading')) return false;
    const anchor = getAuthorAnchor(header);
    return Boolean(anchor?.href && badge.dataset.target === anchor.href);
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
            activeControllerSet.delete(controller);
          }
        }
      }
    },
    { rootMargin: '400px 0px' }
  );

  const queueComment = (commentElement, force = false) => {
    if (!commentElement) return;

    if (!force) {
      if (observedComments.has(commentElement)) return;
      if (activeControllers.has(commentElement)) return;
      if (isCommentResolved(commentElement)) return;
    } else {
      unobserveComment(commentElement);
    }

    observedComments.add(commentElement);
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
                activeControllerSet.delete(ctrl);
              }
              const badge = header.querySelector('.subscriber-count');
              if (badge && badge.dataset.target !== anchor.href) {
                badge.classList.add('is-loading');
              }
              queueComment(comment, true);
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
        if (node.classList.contains('subscriber-count')) continue;

        if (node.tagName === 'YTD-COMMENT-VIEW-MODEL') {
          queueComment(node);
        } else {
          const comments = node.getElementsByTagName('ytd-comment-view-model');
          for (let k = 0; k < comments.length; k++) {
            queueComment(comments[k]);
          }
        }
      }

      if (m.addedNodes.length > 0) continue;

      // Ignore mutations originating from or directly adding the badge itself
      if (
        m.target.nodeType === 1 &&
        !m.target.classList.contains('subscriber-count')
      ) {
        if (
          m.addedNodes.length === 1 &&
          m.addedNodes[0].nodeType === 1 &&
          m.addedNodes[0].classList.contains('subscriber-count')
        ) {
          continue;
        }

        const parentComment =
          m.target.tagName === 'YTD-COMMENT-VIEW-MODEL'
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
      threadContainer = panelTarget.querySelector('ytd-comments') || panelTarget;
    } else {
      const panel = isShorts() ? getShortsCommentsPanel() : null;
      if (panel) {
        if (panel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
          return false;
        }
        threadContainer = panel.querySelector('ytd-comments') || panel;
      } else {
        threadContainer =
          document.querySelector('ytd-comments') ||
          document.querySelector('#comments');
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
        resetViewportObserver();
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
    resetViewportObserver();
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
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    requestQueue.length = 0;
    init();
  });
})();
