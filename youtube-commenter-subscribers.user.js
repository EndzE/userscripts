// ==UserScript==
// @name         YouTube - Commenter Subscribers
// @namespace    https://github.com/EndzE
// @version      1.6.0
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
  const version = typeof GM_info !== 'undefined' ? GM_info?.script?.version : '1.6.0';
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
  const dirtyKeys = new Map();
  let saveTimer = null;
  let idleId = null;

  /**
   * Normalizes a channel URL or path into a canonical short path (/@handle lowercased or /channel/UC...).
   * @param {string} rawUrl
   * @returns {string}
   */
  const normalizeChannelPath = (rawUrl) => {
    if (!rawUrl) return '';
    try {
      const origin = location.origin;
      let path = rawUrl.startsWith(origin)
        ? rawUrl.slice(origin.length)
        : rawUrl.replace(/^https?:\/\/[^/]+/, '');
      const qIdx = path.indexOf('?');
      if (qIdx !== -1) path = path.slice(0, qIdx);
      const hIdx = path.indexOf('#');
      if (hIdx !== -1) path = path.slice(0, hIdx);
      try {
        path = decodeURIComponent(path);
      } catch { }
      while (path.endsWith('/') && path.length > 1) {
        path = path.slice(0, -1);
      }
      if (path.startsWith('/@')) {
        path = '/@' + path.slice(2).toLowerCase();
      }
      return path;
    } catch {
      return rawUrl;
    }
  };

  /**
   * Fast channel URL & handle normalizer with decodeURIComponent and case-normalization.
   * @param {string} rawUrl
   * @returns {string}
   */
  const normalizeChannelUrl = (rawUrl) => {
    const path = normalizeChannelPath(rawUrl);
    if (!path) return '';
    return path.startsWith('/') ? location.origin + path : path;
  };

  const normalizeStorageKey = (key) => {
    if (key.startsWith('http://') || key.startsWith('https://')) {
      return normalizeChannelPath(key);
    }
    return key;
  };

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
    } catch { }
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

  // Cache setter with LRU refresh, size capping and dirty-key tracking
  const setCachedValue = (canonicalId, channelPath, val, customTtl) => {
    if (val === undefined || (!canonicalId && !channelPath)) return;
    const ttl = val === ERROR ? ERROR_TTL_MS : (customTtl || CACHE_TTL_MS);
    const exp = Date.now() + ttl;
    const entry = { val, exp };

    if (canonicalId) {
      storageCache.delete(canonicalId);
      storageCache.set(canonicalId, entry);
    }
    if (channelPath && channelPath !== canonicalId) {
      storageCache.delete(channelPath);
      storageCache.set(channelPath, entry);
    }

    // Evict oldest in-memory entries if exceeding bounds (capped at MAX_STORAGE_ENTRIES * 2 for dual keys)
    while (storageCache.size > MAX_STORAGE_ENTRIES * 2) {
      const oldestKey = storageCache.keys().next().value;
      storageCache.delete(oldestKey);
    }

    if (val !== ERROR) {
      const persistKey = canonicalId || channelPath;
      dirtyKeys.set(persistKey, [val, Math.ceil(exp / 1000)]);
      persistCache();
    }
  };

  // Hydrate L1 cache from persistent storage (supports compact tuples, legacy objects, and string aliases)
  try {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const stored = readPersistentStorage();
    if (stored && typeof stored === 'object') {
      for (const [rawKey, item] of Object.entries(stored)) {
        const key = normalizeStorageKey(rawKey);
        if (Array.isArray(item)) {
          if (item.length >= 2 && typeof item[1] === 'number' && item[1] > nowSec && item[0] !== ERROR) {
            storageCache.set(key, { val: item[0], exp: item[1] * 1000 });
          }
        } else if (item && typeof item === 'object' && item.exp > nowMs && item.val !== ERROR) {
          storageCache.set(key, item);
        }
      }
      // Migrate legacy string aliases from previous schema
      for (const [rawKey, item] of Object.entries(stored)) {
        if (typeof item === 'string') {
          const targetKey = normalizeStorageKey(item);
          if (storageCache.has(targetKey)) {
            storageCache.set(normalizeStorageKey(rawKey), storageCache.get(targetKey));
          }
        }
      }
    }
  } catch { }

  const cancelSaveTimer = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (idleId !== null && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(idleId);
      idleId = null;
    }
  };

  // Flushes dirty keys to persistent storage, merging with latest storage to prevent cross-tab overwrite
  const flushStorage = () => {
    cancelSaveTimer();
    if (dirtyKeys.size === 0) return;
    const pendingDirty = new Map(dirtyKeys);
    dirtyKeys.clear();
    try {
      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);
      const stored = readPersistentStorage() || {};
      const merged = new Map();

      // 1. Merge existing valid storage entries, compacting legacy objects on the fly
      for (const [rawKey, item] of Object.entries(stored)) {
        const key = normalizeStorageKey(rawKey);
        if (Array.isArray(item)) {
          if (item.length >= 2 && typeof item[1] === 'number' && item[1] > nowSec && item[0] !== ERROR) {
            merged.set(key, [item[0], item[1]]);
          }
        } else if (item && typeof item === 'object' && item.exp > nowMs && item.val !== ERROR) {
          merged.set(key, [item.val, Math.ceil(item.exp / 1000)]);
        }
      }

      // 2. Apply only dirty entries from this tab (refreshing LRU order)
      for (const [key, compactEntry] of pendingDirty.entries()) {
        merged.delete(key);
        merged.set(key, compactEntry);
      }

      // 3. Keep newest entries up to MAX_STORAGE_ENTRIES
      const entries = Array.from(merged.entries()).slice(-MAX_STORAGE_ENTRIES);
      writePersistentStorage(Object.fromEntries(entries));
    } catch { }
  };

  // Schedules non-blocking cache persistence via debounce timer + idle callback
  const persistCache = () => {
    if (dirtyKeys.size === 0 || saveTimer !== null || idleId !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (typeof requestIdleCallback === 'function') {
        idleId = requestIdleCallback(() => {
          idleId = null;
          flushStorage();
        }, { timeout: 5000 });
      } else {
        flushStorage();
      }
    }, 2500);
  };

  // Ensure dirty cache is committed when switching tabs or unloading
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirtyKeys.size > 0) {
      flushStorage();
    }
  });
  window.addEventListener('pagehide', () => {
    if (dirtyKeys.size > 0) flushStorage();
  });

  // Safe minimal cached InnerTube context accessor
  let cachedContext = null;

  const getYtContext = () => {
    if (cachedContext) return cachedContext;
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const rawClient = win?.ytcfg?.get?.('INNERTUBE_CONTEXT')?.client;
    const hl = rawClient?.hl || document.documentElement.lang || 'en';
    const gl = rawClient?.gl || 'US';
    if (rawClient?.clientVersion) {
      cachedContext = {
        client: {
          clientName: rawClient.clientName || 'WEB',
          clientVersion: rawClient.clientVersion,
          hl,
          gl,
        },
      };
      return cachedContext;
    }
    return {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20261119.07.00',
        hl,
        gl,
      },
    };
  };

  // Concurrency limiter with O(1) LIFO priority scheduling and adaptive rate-limit cooldown
  let maxConcurrent = 10;
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

    while (activeRequests < maxConcurrent && requestQueue.length > 0) {
      const item = requestQueue.pop();
      if (item.cancelled) continue;
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
      const item = {
        cancelled: false,
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
      const onAbort = () => {
        item.cancelled = true;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      requestQueue.push(item); // O(1) LIFO: prioritize currently visible comments
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

  // Tiered InnerTube endpoints with $fields projection and protobuf about-channel continuation
  const ABOUT_CONT_INNER = '8gYFGgOaAQA%3D';
  const ABOUT_CONT_TAG = [0xe2, 0xa9, 0x85, 0xb2, 0x02];
  const ABOUT_FIELDS_QUERY = encodeURIComponent(
    'onResponseReceivedEndpoints/appendContinuationItemsAction/continuationItems/aboutChannelRenderer/metadata/aboutChannelViewModel/subscriberCountText'
  );
  const BROWSE_HEADER_FIELDS_QUERY = encodeURIComponent(
    'header(pageHeaderRenderer/content/pageHeaderViewModel/metadata/contentMetadataViewModel/metadataRows(metadataParts(text/content,accessibilityLabel)),c4TabbedHeaderRenderer/subscriberCountText)'
  );
  const RESOLVE_URL_FIELDS_QUERY = encodeURIComponent('endpoint/browseEndpoint/browseId');

  let useAboutContinuation = true;
  let aboutMissStreak = 0;

  const writeVarint = (buf, n) => {
    while (n > 0x7f) {
      buf.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    buf.push(n);
  };

  const buildAboutContinuation = (browseId) => {
    const msg = [0x12];
    writeVarint(msg, browseId.length);
    for (let i = 0; i < browseId.length; i++) {
      msg.push(browseId.charCodeAt(i) & 0xff);
    }
    msg.push(0x1a);
    writeVarint(msg, ABOUT_CONT_INNER.length);
    for (let i = 0; i < ABOUT_CONT_INNER.length; i++) {
      msg.push(ABOUT_CONT_INNER.charCodeAt(i) & 0xff);
    }
    const outer = ABOUT_CONT_TAG.slice();
    writeVarint(outer, msg.length);
    for (let i = 0; i < msg.length; i++) {
      outer.push(msg[i]);
    }
    let bin = '';
    for (let i = 0; i < outer.length; i++) {
      bin += String.fromCharCode(outer[i]);
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const handleHttpFailure = (res, adaptConcurrency = false) => {
    if (res.status === 429) {
      cooldownUntil = Date.now() + 30000;
      if (adaptConcurrency) {
        maxConcurrent = Math.max(4, Math.floor(maxConcurrent / 2));
      }
    } else if (res.status >= 500) {
      cooldownUntil = Date.now() + 30000;
    }
    throw new Error(`HTTP ${res.status}`);
  };

  /**
   * Tier 1: Ultra-lightweight aboutChannelViewModel continuation (~198B response).
   * @param {string} browseId
   * @returns {Promise<string|null>}
   */
  const fetchAboutContinuation = async (browseId) => {
    const res = await fetch(`/youtubei/v1/browse?prettyPrint=false&$fields=${ABOUT_FIELDS_QUERY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: getYtContext(), continuation: buildAboutContinuation(browseId) }),
      priority: 'low',
    });
    if (res.status === 400) {
      useAboutContinuation = false;
      return null;
    }
    if (!res.ok) handleHttpFailure(res, true);
    const data = await res.json();
    const vm =
      data?.onResponseReceivedEndpoints?.[0]?.appendContinuationItemsAction
        ?.continuationItems?.[0]?.aboutChannelRenderer?.metadata
        ?.aboutChannelViewModel;
    if (vm && typeof vm === 'object') {
      return typeof vm.subscriberCountText === 'string' && vm.subscriberCountText
        ? vm.subscriberCountText
        : PRIVATE;
    }
    return null;
  };

  /**
   * Tier 2: Projected header-only channel browse using lightweight Search tab params.
   * @param {string} browseId
   * @returns {Promise<string>}
   */
  const fetchBrowseHeader = async (browseId) => {
    const res = await fetch(`/youtubei/v1/browse?prettyPrint=false&$fields=${BROWSE_HEADER_FIELDS_QUERY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: getYtContext(), browseId, params: 'EgZzZWFyY2jyBgQKAloA' }),
      priority: 'low',
    });
    if (!res.ok) handleHttpFailure(res, true);
    const data = await res.json();
    return parseInnerTube(data);
  };

  /**
   * Tiered InnerTube fetcher with automatic circuit breaker back to header browse.
   * @param {string} browseId
   * @returns {Promise<string>}
   */
  const fetchInnerTube = async (browseId) => {
    if (useAboutContinuation) {
      const fastRes = await fetchAboutContinuation(browseId);
      if (fastRes !== null) {
        aboutMissStreak = 0;
        return fastRes;
      }
    }
    const headerRes = await fetchBrowseHeader(browseId);
    if (headerRes !== ERROR) {
      aboutMissStreak++;
      if (aboutMissStreak >= 3) {
        useAboutContinuation = false;
      }
    }
    return headerRes;
  };

  /**
   * Tier 3: Resolves a handle/channel URL to a browseId without downloading full HTML.
   * @param {string} channelUrl
   * @returns {Promise<string|null>}
   */
  const resolveBrowseId = async (channelUrl) => {
    const res = await fetch(`/youtubei/v1/navigation/resolve_url?prettyPrint=false&$fields=${RESOLVE_URL_FIELDS_QUERY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: getYtContext(), url: channelUrl }),
      priority: 'low',
    });
    if (!res.ok) handleHttpFailure(res, true);
    const data = await res.json();
    return data?.endpoint?.browseEndpoint?.browseId || null;
  };

  /**
   * Fetches subscriber count using ReadableStream early exit as safety fallback.
   * @param {string} channelUrl
   * @returns {Promise<string|null>}
   */
  const fetchSubscriberCountStream = async (channelUrl) => {
    const res = await fetch(`${channelUrl}/about`, { priority: 'low' });
    if (!res.ok) handleHttpFailure(res, false);

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
        reader.cancel().catch(() => { });
        return match;
      }

      // Early fallback check and header slice preservation
      const headerIdx = buffer.indexOf('"pageHeaderRenderer":');
      if (headerIdx !== -1) {
        if (!savedHeaderSlice && buffer.length >= headerIdx + 3500) {
          savedHeaderSlice = buffer.slice(headerIdx, headerIdx + 3500);
          const fallbackMatch = extractFallback(savedHeaderSlice);
          reader.cancel().catch(() => { });
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
   * Unified fetch dispatcher: InnerTube continuation -> header browse -> resolve_url -> stream fallback.
   * @param {string|null} browseId
   * @param {string} channelUrl
   * @returns {Promise<string>}
   */
  const fetchSubscriberCount = async (browseId, channelUrl) => {
    try {
      let targetId = browseId;
      if (!targetId && channelUrl) {
        targetId = await resolveBrowseId(channelUrl);
      }
      if (targetId) {
        return await fetchInnerTube(targetId);
      }
      const streamRes = await fetchSubscriberCountStream(channelUrl);
      return streamRes ?? PRIVATE;
    } catch (err) {
      if (channelUrl) {
        try {
          const fallbackRes = await fetchSubscriberCountStream(channelUrl);
          return fallbackRes ?? PRIVATE;
        } catch { }
      }
      if (DEBUG) console.warn('[Commenter Subscribers] Fetch failed for:', channelUrl || browseId, err);
      return ERROR;
    }
  };

  /**
   * Normalizes channel target and manages queued fetching with multi-tier caching.
   * In-flight requests are shared across callers and populate cache on completion.
   * @param {string} rawUrl
   * @param {string} channelPath
   * @param {string|null} browseId
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  const getSubs = (rawUrl, channelPath, browseId, signal) => {
    const primaryKey = browseId || channelPath;
    if (!primaryKey) return Promise.resolve(null);

    const cachedPrimary = getCachedValue(primaryKey);
    if (cachedPrimary !== undefined) {
      return Promise.resolve(cachedPrimary);
    }
    if (channelPath) {
      const cachedPath = getCachedValue(channelPath);
      if (cachedPath !== undefined) {
        return Promise.resolve(cachedPath);
      }
    }

    const opSub = getOpSubscriberCount(browseId, channelPath);
    if (opSub !== undefined) {
      setCachedValue(browseId, channelPath, opSub);
      return Promise.resolve(opSub);
    }

    // If already in-flight on the network, share the promise
    if (pendingCache.has(primaryKey)) {
      return pendingCache.get(primaryKey);
    }

    // Wait for an active slot in the LIFO queue (cancellable while waiting)
    return enqueueRequest((resolve, reject) => {
      // Re-check cache / in-flight when finally starting
      const reCached = getCachedValue(primaryKey) ?? (channelPath ? getCachedValue(channelPath) : undefined);
      if (reCached !== undefined) {
        resolve(reCached);
        return Promise.resolve();
      }

      if (pendingCache.has(primaryKey)) {
        pendingCache.get(primaryKey).then(resolve, reject);
        return Promise.resolve();
      }

      const channelUrl = rawUrl ? normalizeChannelUrl(rawUrl) : (channelPath ? location.origin + channelPath : '');
      const inFlight = fetchSubscriberCount(browseId, channelUrl)
        .then((result) => {
          setCachedValue(primaryKey, channelPath, result);
          return result;
        })
        .catch(() => {
          setCachedValue(primaryKey, channelPath, ERROR);
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
      const thumb = parentComment.querySelector('#author-thumbnail a, a#author-thumbnail');
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

  let activeControllers = new WeakMap();
  const activeControllerSet = new Set();
  let commentState = new WeakMap();
  const pendingBadgeWrites = new Map();
  let badgeRafId = null;

  const getOrCreateState = (commentElement) => {
    let state = commentState.get(commentElement);
    if (!state) {
      state = {
        header: null,
        anchor: null,
        badge: null,
        resolvedTarget: null,
        activeTarget: null,
        awaitingHref: false,
      };
      commentState.set(commentElement, state);
    }
    return state;
  };

  const ensureBadge = (header, state) => {
    let badge = state?.badge?.isConnected ? state.badge : header.querySelector('.subscriber-count');
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

  const flushBadgeWrites = () => {
    badgeRafId = null;
    if (pendingBadgeWrites.size === 0) return;
    const jobs = Array.from(pendingBadgeWrites.entries());
    pendingBadgeWrites.clear();

    for (let i = 0; i < jobs.length; i++) {
      const [commentElement, job] = jobs[i];
      if (!commentElement.isConnected || !job.header.isConnected || !job.anchor.isConnected) continue;
      if (job.anchor.href !== job.targetUrl) continue;

      const state = getOrCreateState(commentElement);
      const badge = ensureBadge(job.header, state);
      badge.dataset.target = job.targetUrl;
      applyBadgeContent(badge, job.subCount);

      state.header = job.header;
      state.anchor = job.anchor;
      state.badge = badge;
      state.resolvedTarget = job.targetUrl;
      state.activeTarget = null;
      state.awaitingHref = false;
      unobserveComment(commentElement);
    }
  };

  const scheduleBadgeWrite = (commentElement, header, anchor, targetUrl, subCount) => {
    pendingBadgeWrites.set(commentElement, { header, anchor, targetUrl, subCount });
    if (badgeRafId === null) {
      badgeRafId = requestAnimationFrame(flushBadgeWrites);
    }
  };

  const resolveSync = (browseId, channelPath) => {
    const key = browseId || channelPath;
    let cached = getCachedValue(key) ?? (channelPath ? getCachedValue(channelPath) : undefined);
    if (cached === undefined) {
      const opSub = getOpSubscriberCount(browseId, channelPath);
      if (opSub !== undefined) {
        cached = opSub;
        setCachedValue(browseId, channelPath, opSub);
      }
    }
    return cached;
  };

  const updateBadge = async (anchor, header, signal, commentElement, browseId, channelPath, controller) => {
    const targetUrl = anchor.href;
    if (!targetUrl) return;

    try {
      const subCount = await getSubs(targetUrl, channelPath, browseId, signal);

      if (signal?.aborted) return;
      if (anchor.href !== targetUrl) return;

      const state = getOrCreateState(commentElement);
      if (subCount === ERROR) {
        const badge = state.badge?.isConnected ? state.badge : header.querySelector('.subscriber-count');
        if (badge) badge.classList.add('is-loading');
        state.resolvedTarget = null;
        return;
      }

      scheduleBadgeWrite(commentElement, header, anchor, targetUrl, subCount);
      unobserveComment(commentElement);
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      if (commentElement) {
        if (activeControllers.get(commentElement) === controller) {
          activeControllers.delete(commentElement);
        }
        const state = commentState.get(commentElement);
        if (state && state.activeTarget === targetUrl) {
          state.activeTarget = null;
        }
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
      cachedOpInfo = { subText: null, ownerPath: null, ownerBrowseId: null };
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
        cachedOpInfo = { subText: null, ownerPath: null, ownerBrowseId: null };
        return cachedOpInfo;
      }
      return null;
    }

    const ownerAnchor = ownerEl?.querySelector(
      'a.yt-simple-endpoint[href^="/@"], a.yt-simple-endpoint[href^="/channel/"], a[href^="/@"], a[href^="/channel/"]'
    );
    const ownerHref = ownerAnchor?.getAttribute('href');
    const ownerPath = ownerHref ? normalizeChannelPath(ownerHref) : null;
    const ownerBrowseId =
      ownerAnchor?.data?.browseEndpoint?.browseId ||
      ownerAnchor?.wrappedJSObject?.data?.browseEndpoint?.browseId ||
      ownerEl?.data?.navigationEndpoint?.browseEndpoint?.browseId;

    if (!ownerPath && !ownerBrowseId) return null;

    cachedOpInfo = {
      subText,
      ownerBrowseId: ownerBrowseId || null,
      ownerPath: ownerPath || null,
    };
    return cachedOpInfo;
  };

  const getOpSubscriberCount = (browseId, channelPath) => {
    const op = cachedOpInfo || resolveOpInfo();
    if (!op?.subText) return undefined;

    if (
      (browseId && op.ownerBrowseId && browseId === op.ownerBrowseId) ||
      (channelPath && op.ownerPath && channelPath === op.ownerPath)
    ) {
      return op.subText;
    }
    return undefined;
  };

  /**
   * Finds the commenter's channel link inside the comment header (fast-path on #author-text).
   */
  const getAuthorAnchor = (header) => {
    const authorText = header.querySelector('a#author-text');
    if (authorText && !authorText.hidden) return authorText;
    return (
      header.querySelector('span#author-comment-badge:not([hidden]) a#name, a#name:not([hidden])') ||
      authorText ||
      header.querySelector('a#name, a[href^="/@"], a[href^="/channel/"], a')
    );
  };

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
    activeControllers = new WeakMap();
    commentState = new WeakMap();
    observedComments = new WeakSet();
    pendingBadgeWrites.clear();
    if (badgeRafId !== null) {
      cancelAnimationFrame(badgeRafId);
      badgeRafId = null;
    }
    viewportObserver.disconnect();
  };

  /**
   * Initializes a comment element once it nears the viewport.
   * @param {HTMLElement} commentElement
   */
  const initComment = (commentElement) => {
    const header = commentElement.querySelector('div#header-author');
    if (!header) {
      getOrCreateState(commentElement).awaitingHref = true;
      unobserveComment(commentElement);
      return;
    }

    const anchor = getAuthorAnchor(header);
    if (!anchor || !anchor.href) {
      const state = getOrCreateState(commentElement);
      state.header = header;
      state.anchor = anchor || null;
      state.awaitingHref = true;
      unobserveComment(commentElement);
      return;
    }

    const targetUrl = anchor.href;
    const state = getOrCreateState(commentElement);
    state.header = header;
    state.anchor = anchor;
    state.awaitingHref = false;

    if (state.resolvedTarget === targetUrl && state.badge?.isConnected) {
      unobserveComment(commentElement);
      return;
    }

    const browseId = getBrowseId(anchor, commentElement);
    const channelPath = normalizeChannelPath(targetUrl);

    const cached = resolveSync(browseId, channelPath);
    if (cached !== undefined) {
      if (cached !== ERROR) {
        scheduleBadgeWrite(commentElement, header, anchor, targetUrl, cached);
      } else {
        const badge = state.badge?.isConnected ? state.badge : header.querySelector('.subscriber-count');
        if (badge) badge.classList.add('is-loading');
        state.resolvedTarget = null;
      }
      unobserveComment(commentElement);
      return;
    }

    const existingBadge = state.badge?.isConnected ? state.badge : header.querySelector('.subscriber-count');
    if (existingBadge) {
      state.badge = existingBadge;
      if (state.resolvedTarget !== targetUrl) {
        existingBadge.classList.add('is-loading');
        state.resolvedTarget = null;
      }
    }

    const prevCtrl = activeControllers.get(commentElement);
    if (prevCtrl) {
      if (state.activeTarget === targetUrl) return;
      prevCtrl.abort();
      activeControllers.delete(commentElement);
      activeControllerSet.delete(prevCtrl);
    }

    const controller = new AbortController();
    state.activeTarget = targetUrl;
    activeControllers.set(commentElement, controller);
    activeControllerSet.add(controller);
    updateBadge(anchor, header, controller.signal, commentElement, browseId, channelPath, controller);
  };

  const isCommentResolved = (commentElement) => {
    const pending = pendingBadgeWrites.get(commentElement);
    if (pending && pending.anchor?.isConnected && pending.anchor.href === pending.targetUrl) {
      return true;
    }
    const state = commentState.get(commentElement);
    if (state) {
      return Boolean(
        state.resolvedTarget &&
        state.badge?.isConnected &&
        state.anchor?.isConnected &&
        state.anchor.href === state.resolvedTarget
      );
    }
    const header = commentElement.querySelector('div#header-author');
    const badge = header?.querySelector('.subscriber-count');
    if (!badge || badge.classList.contains('is-loading')) return false;
    const anchor = getAuthorAnchor(header);
    return Boolean(anchor?.href && badge.dataset.target === anchor.href);
  };

  // Viewport observer with 600px margin for pre-emptive loading and viewport exit cancellation
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
            const state = commentState.get(el);
            if (state) state.activeTarget = null;
          }
        }
      }
    },
    { rootMargin: '600px 0px' }
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

  const SKIP_CONTAINER_TAGS = new Set([
    'SPAN',
    'A',
    'BUTTON',
    'IMG',
    'SVG',
    'PATH',
    'H3',
    'SLOT',
    'TEMPLATE',
    'DOM-REPEAT',
    'YT-ICON',
    'YT-ICON-BUTTON',
    'YT-BUTTON-SHAPE',
    'YT-ATTRIBUTED-STRING',
    'YT-FORMATTED-STRING',
    'YT-IMG-SHADOW',
    'YT-INTERACTION',
    'TP-YT-PAPER-BUTTON',
    'TP-YT-PAPER-TOOLTIP',
    'YT-PDG-COMMENT-CHIP-RENDERER',
    'YTD-COMMENT-ENGAGEMENT-BAR',
    'YTD-MENU-RENDERER',
  ]);

  // Single shared MutationObserver scoped strictly to the comments thread container.
  const commentsObserver = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];

      // Handle element reuse / href changes (virtual DOM recycling)
      if (m.type === 'attributes' && m.attributeName === 'href') {
        const anchor = m.target;
        if (isAuthorAnchor(anchor) && anchor.href) {
          const comment = anchor.closest('ytd-comment-view-model');
          if (comment) {
            const state = commentState.get(comment);
            if (state && (state.resolvedTarget === anchor.href || state.activeTarget === anchor.href)) {
              continue;
            }
            if (state?.activeTarget && state.activeTarget !== anchor.href) {
              const ctrl = activeControllers.get(comment);
              if (ctrl) {
                ctrl.abort();
                activeControllers.delete(comment);
                activeControllerSet.delete(ctrl);
              }
              state.activeTarget = null;
            }
            if (state?.resolvedTarget && state.resolvedTarget !== anchor.href) {
              const badge = state.badge?.isConnected
                ? state.badge
                : state.header?.querySelector('.subscriber-count');
              if (badge) badge.classList.add('is-loading');
              state.resolvedTarget = null;
              pendingBadgeWrites.delete(comment);
              queueComment(comment, true);
            } else if (state?.awaitingHref) {
              state.awaitingHref = false;
              pendingBadgeWrites.delete(comment);
              queueComment(comment, true);
            } else if (!observedComments.has(comment)) {
              queueComment(comment);
            }
          }
        }
        continue;
      }

      // Handle newly added comments and header elements
      const added = m.addedNodes;
      for (let j = 0; j < added.length; j++) {
        const node = added[j];
        if (node.nodeType !== 1) continue;
        if (node.classList.contains('subscriber-count')) continue;

        const tag = node.tagName;
        if (tag === 'YTD-COMMENT-VIEW-MODEL') {
          queueComment(node);
        } else if (node.id === 'header-author' || node.id === 'author-text' || node.id === 'name') {
          const parentComment = node.closest('ytd-comment-view-model');
          const state = parentComment ? commentState.get(parentComment) : null;
          if (state?.awaitingHref) {
            state.awaitingHref = false;
            queueComment(parentComment, true);
          }
        } else if (node.childElementCount > 0 && !SKIP_CONTAINER_TAGS.has(tag)) {
          const comments = node.getElementsByTagName('ytd-comment-view-model');
          for (let k = 0; k < comments.length; k++) {
            queueComment(comments[k]);
          }
        }
      }

      // Re-queue comment only if our own badge was removed externally
      const removed = m.removedNodes;
      for (let j = 0; j < removed.length; j++) {
        const node = removed[j];
        if (node.nodeType === 1 && node.classList.contains('subscriber-count')) {
          const parentComment = m.target.closest?.('ytd-comment-view-model');
          if (parentComment) {
            const state = commentState.get(parentComment);
            if (state) {
              state.badge = null;
              state.resolvedTarget = null;
            }
            pendingBadgeWrites.delete(parentComment);
            queueComment(parentComment, true);
          }
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
    cachedContext = null;
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
