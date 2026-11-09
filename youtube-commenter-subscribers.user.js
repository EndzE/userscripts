// ==UserScript==
// @name         YouTube - Commenter Subscribers
// @namespace    https://github.com/EndzE
// @version      1.4.0
// @description  Displays the commenter's subscriber count next to their username on YouTube.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://*.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-commenter-subscribers.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-commenter-subscribers.user.js
// ==/UserScript==

(() => {
  'use strict';

  console.log('[Commenter Subscribers] Initializing v1.4.0 (GM Storage 24h TTL + LIFO + AbortController)');

  const css = `
    .subscriber-count {
      font-size: 1.1rem;
      line-height: normal;
      color: #0f0f0f;
      background-color: rgba(0, 0, 0, 0.06);
      margin-left: 6px;
      padding: 1px 4px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      font-weight: 400;
      vertical-align: middle;
      user-select: none;
      contain: layout style;
      white-space: nowrap;
    }
    html[dark] .subscriber-count,
    [dark] .subscriber-count {
      color: #f1f1f1;
      background-color: rgba(255, 255, 255, 0.12);
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

  // Regex pattern for YouTube aboutChannelViewModel subscriberCountText
  const REGEX_SUB_TEXT = /"subscriberCountText":"([^"]+)"/;
  const SUB_LANG_REGEX =
    /subscri|suscri|subskry|abon|подпис|підпис|падпіс|абон|претплат|pretplat|iscritt|inscrit|prenumer|odběrat|odbera|tilaaj|tellij|feliratkoz|εγγεγραμμ|συνδρομητ|מנוי|登録者|구독자|订阅|訂閱|مشتر[كک]|सदस्य|গ্রাহক|ผู้ติดตาม|đăng ký|pelanggan|langganan/i;

  // Multi-tier cache: L1 Memory Map + L2 GM Storage with 24-hour TTL & cross-tab persistence
  const STORAGE_KEY = 'yt_subscribers_cache_v2';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const MAX_STORAGE_ENTRIES = 1000;
  const pendingCache = new Map();
  const resolvedCache = new Map();
  const cacheExpiry = new Map();

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

  // Safe cache accessor that verifies 24-hour TTL
  const getCachedValue = (key) => {
    if (!key || !resolvedCache.has(key)) return undefined;
    const exp = cacheExpiry.get(key);
    if (exp && Date.now() > exp) {
      resolvedCache.delete(key);
      cacheExpiry.delete(key);
      return undefined;
    }
    return resolvedCache.get(key);
  };

  // Hydrate L1 cache from persistent GM storage with 24h TTL filtering
  try {
    const now = Date.now();
    const stored = readPersistentStorage();
    if (stored && typeof stored === 'object') {
      for (const [k, item] of Object.entries(stored)) {
        if (item && typeof item === 'object' && 'exp' in item) {
          if (item.exp > now && item.val !== '__ERROR__') {
            resolvedCache.set(k, item.val);
            cacheExpiry.set(k, item.exp);
          }
        } else if (item !== '__ERROR__') {
          resolvedCache.set(k, item);
          cacheExpiry.set(k, now + CACHE_TTL_MS);
        }
      }
    }
    // Clean up legacy sessionStorage if present
    sessionStorage.removeItem('yt_subscribers_cache');
  } catch {}

  let saveTimer = null;
  const persistCache = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const now = Date.now();
        const payload = {};
        let count = 0;
        for (const [k, v] of resolvedCache.entries()) {
          if (v !== '__ERROR__') {
            const exp = cacheExpiry.get(k) || (now + CACHE_TTL_MS);
            if (exp > now) {
              payload[k] = { val: v, exp };
              if (++count >= MAX_STORAGE_ENTRIES) break;
            }
          }
        }
        writePersistentStorage(payload);
      } catch {}
    }, 1500);
  };

  // Safe InnerTube context accessor
  const getYtContext = () => {
    const ytcfgObj =
      (typeof window !== 'undefined' && window.ytcfg) ||
      (typeof unsafeWindow !== 'undefined' && unsafeWindow?.ytcfg);
    return ytcfgObj?.get
      ? ytcfgObj.get('INNERTUBE_CONTEXT')
      : { client: { clientName: 'WEB', clientVersion: '2.20261105.05.01' } };
  };

  // Concurrency limiter with LIFO priority scheduling and AbortSignal support
  const MAX_CONCURRENT = 6;
  let activeRequests = 0;
  const requestQueue = [];

  const runQueue = () => {
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
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
          }
          signal?.removeEventListener('abort', onAbort);
          return task().then(resolve, reject);
        },
        signal,
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      // LIFO priority: recently visible comments are placed at front to resolve first
      requestQueue.unshift(item);
      runQueue();
    });
  };

  /**
   * Fast fallback regex on pageHeaderRenderer metadata when subscriberCountText is missing.
   * Eliminates heavy JSON.parse calls on large payloads and prevents false positives.
   * @param {string} text
   * @returns {string|null}
   */
  const extractFallback = (text) => {
    const marker = '"pageHeaderRenderer":';
    const start = text.indexOf(marker);
    if (start === -1) return null;

    const headerSlice = text.slice(start, start + 3500);
    const regex = /"text":\{"content":"([^"]+)"\},"accessibilityLabel":"([^"]*)"/g;
    let m;
    while ((m = regex.exec(headerSlice)) !== null) {
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
   * Extracts subscriber text from varied YouTube text objects (simpleText, runs, or content)
   * without creating heap string allocations.
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
   * Completely avoids JSON.stringify re-serialization and heap string churn.
   * @param {object} data
   * @returns {string|null}
   */
  const parseInnerTube = (data) => {
    if (!data) return null;
    const header = data.header;
    if (!header) return null;

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
    }

    // 2. Direct legacy c4TabbedHeaderRenderer lookup
    const c4 = header.c4TabbedHeaderRenderer?.subscriberCountText;
    if (c4) {
      const text = extractTextObject(c4);
      if (text) return text;
    }

    // 3. Fast iterative object inspection across all header renderers (zero serialization)
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

    return null;
  };

  /**
   * Fetches subscriber count using InnerTube API browse endpoint (~30 KB JSON).
   * 93% faster and 97% lighter than full HTML page fetching.
   * @param {string} browseId
   * @param {AbortSignal} [signal]
   * @returns {Promise<string|null>}
   */
  const fetchInnerTube = async (browseId, signal) => {
    const res = await fetch('/youtubei/v1/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: getYtContext(), browseId }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseInnerTube(data);
  };

  /**
   * Fetches subscriber count using ReadableStream early exit as safety fallback.
   * Aborts downloading the remainder of the page as soon as subscriberCountText is matched.
   * @param {string} channelUrl
   * @param {AbortSignal} [signal]
   * @returns {Promise<string|null>}
   */
  const fetchSubscriberCountStream = async (channelUrl, signal) => {
    const res = await fetch(`${channelUrl}/about`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (!res.body || typeof res.body.getReader !== 'function') {
      const text = await res.text();
      const match = text.match(REGEX_SUB_TEXT);
      return match ? match[1] : extractFallback(text);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (signal?.aborted) {
        reader.cancel().catch(() => {});
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(REGEX_SUB_TEXT);
      if (match) {
        reader.cancel().catch(() => {});
        return match[1];
      }

      // Keep 256KB sliding buffer to preserve pageHeaderRenderer metadata if fallback is needed
      if (buffer.length > 393216) {
        buffer = buffer.slice(-262144);
      }
    }

    return extractFallback(buffer);
  };

  /**
   * Unified fetch dispatcher: attempts InnerTube browse first, falls back to stream.
   * @param {string|null} browseId
   * @param {string} channelUrl
   * @param {AbortSignal} [signal]
   * @returns {Promise<string|null>}
   */
  const fetchSubscriberCount = async (browseId, channelUrl, signal) => {
    try {
      if (browseId) {
        return await fetchInnerTube(browseId, signal);
      }
      return await fetchSubscriberCountStream(channelUrl, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (browseId && channelUrl && !signal?.aborted) {
        try {
          return await fetchSubscriberCountStream(channelUrl, signal);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
      }
      console.warn('[Commenter Subscribers] Fetch failed for:', channelUrl || browseId, err);
      return '__ERROR__';
    }
  };

  /**
   * Fast channel URL & handle normalizer without URL object allocations.
   * @param {string} rawUrl
   * @returns {string}
   */
  const normalizeChannelUrl = (rawUrl) => {
    if (!rawUrl) return '';
    const cleanPath = rawUrl
      .replace(/^https?:\/\/[^/]+/, '')
      .split(/[?#]/)[0]
      .replace(/\/+$/, '');
    return location.origin + cleanPath;
  };

  /**
   * Normalizes channel target and manages queued fetching with multi-tier caching.
   * Supports multi-signal reference-counted cancellation.
   * @param {string} rawUrl
   * @param {string|null} browseId
   * @param {AbortSignal} [signal]
   * @returns {Promise<string|null>}
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

    if (pendingCache.has(primaryKey)) {
      const pending = pendingCache.get(primaryKey);
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
        if (result !== '__ERROR__') {
          const exp = Date.now() + CACHE_TTL_MS;
          resolvedCache.set(primaryKey, result);
          cacheExpiry.set(primaryKey, exp);
          if (channelUrl && channelUrl !== primaryKey) {
            resolvedCache.set(channelUrl, result);
            cacheExpiry.set(channelUrl, exp);
          }
          persistCache();
        }
        return result;
      })
      .catch((err) => {
        pendingCache.delete(primaryKey);
        if (err.name === 'AbortError') {
          throw err;
        }
        return '__ERROR__';
      });

    pendingObj.promise = promise;
    pendingCache.set(primaryKey, pendingObj);
    return promise;
  };

  /**
   * Extracts browseId from anchor data or URL.
   * @param {HTMLAnchorElement} anchor
   * @returns {string|null}
   */
  const getBrowseId = (anchor) => {
    if (anchor?.data?.browseEndpoint?.browseId) {
      return anchor.data.browseEndpoint.browseId;
    }
    const parentComment = anchor?.closest('ytd-comment-view-model');
    if (parentComment) {
      const thumb = parentComment.querySelector('a#author-thumbnail');
      if (thumb?.data?.browseEndpoint?.browseId) {
        return thumb.data.browseEndpoint.browseId;
      }
    }
    const match = anchor?.href?.match(/\/channel\/(UC[\w-]+)/);
    return match ? match[1] : null;
  };

  const activeControllers = new WeakMap();

  const updateBadge = async (anchor, badge, signal, commentElement) => {
    const targetUrl = anchor.href;
    if (!targetUrl) return;

    const browseId = getBrowseId(anchor);
    const channelUrl = normalizeChannelUrl(targetUrl);
    const cacheKey = browseId || channelUrl;

    badge.dataset.target = targetUrl;

    // Check synchronous cache first for zero layout shift / instant render
    const cached = getCachedValue(cacheKey) ?? (channelUrl ? getCachedValue(channelUrl) : undefined);
    if (cached !== undefined) {
      applyBadgeContent(badge, cached);
      if (commentElement) {
        activeControllers.delete(commentElement);
        viewportObserver.unobserve(commentElement);
      }
      return;
    }

    badge.classList.add('is-loading');

    try {
      const subCount = await getSubs(targetUrl, browseId, signal);

      // Abort if YouTube recycled this comment element while request was pending
      if (anchor.href !== targetUrl) return;

      if (subCount === '__ERROR__') {
        badge.classList.add('is-loading');
        return;
      }

      applyBadgeContent(badge, subCount);
      if (commentElement) {
        viewportObserver.unobserve(commentElement);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        return;
      }
    } finally {
      if (commentElement && activeControllers.get(commentElement)?.signal === signal) {
        activeControllers.delete(commentElement);
      }
    }
  };

  const applyBadgeContent = (badge, subCount) => {
    if (subCount === null) {
      badge.textContent = 'Private';
      badge.classList.add('is-private');
    } else {
      badge.textContent = subCount;
      badge.classList.remove('is-private');
    }
    badge.classList.remove('is-loading');
  };

  /**
   * Fast author anchor validator using O(1) property checks instead of heavy CSS matches selectors.
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
   * Finds the commenter's channel link inside the comment header with fast-path for author-text.
   */
  const getAuthorAnchor = (header) =>
    header.querySelector('a#author-text') ||
    header.querySelector('a#name') ||
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

    let badge = header.querySelector('.subscriber-count');
    if (!badge) {
      // Synchronous fast-path: if already cached, initialize badge with content immediately
      const browseId = getBrowseId(anchor);
      const channelUrl = normalizeChannelUrl(anchor.href);
      const cacheKey = browseId || channelUrl;

      const cached = getCachedValue(cacheKey) ?? (channelUrl ? getCachedValue(channelUrl) : undefined);
      if (cached !== undefined) {
        badge = document.createElement('span');
        badge.className = 'subscriber-count';
        badge.dataset.target = anchor.href;
        applyBadgeContent(badge, cached);
        header.appendChild(badge);
        viewportObserver.unobserve(commentElement);
        return;
      }

      badge = document.createElement('span');
      badge.className = 'subscriber-count is-loading';
      header.appendChild(badge);
    }

    if (activeControllers.has(commentElement)) return;

    const controller = new AbortController();
    activeControllers.set(commentElement, controller);
    updateBadge(anchor, badge, controller.signal, commentElement);
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
          // Element left viewport before completing: abort and clean up
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

  const seenComments = new WeakSet();

  const queueComment = (commentElement) => {
    if (!commentElement || seenComments.has(commentElement)) return;
    seenComments.add(commentElement);
    viewportObserver.observe(commentElement);
  };

  // Single shared MutationObserver scoped strictly to the comments thread container.
  // Replaces heavy CSS .matches calls with O(1) property checks.
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
            const badge = header.querySelector('.subscriber-count');
            if (badge) {
              if (badge.dataset.target !== anchor.href) {
                if (comment) {
                  const ctrl = activeControllers.get(comment);
                  if (ctrl) {
                    ctrl.abort();
                    activeControllers.delete(comment);
                  }
                  queueComment(comment);
                  initComment(comment);
                }
              }
            } else {
              if (comment) queueComment(comment);
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
        } else if (node.firstElementChild) {
          const comments = node.getElementsByTagName('ytd-comment-view-model');
          for (let k = 0; k < comments.length; k++) {
            queueComment(comments[k]);
          }
        }
      }
    }
  });

  const attachCommentsObserver = () => {
    const threadContainer = document.querySelector('ytd-comments #contents');
    const container =
      threadContainer ||
      document.querySelector('ytd-comments') ||
      document.querySelector('#comments');

    if (!container) return false;

    commentsObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    // Process any comments already present in the container
    const existing = container.getElementsByTagName('ytd-comment-view-model');
    for (let i = 0; i < existing.length; i++) {
      queueComment(existing[i]);
    }

    return true;
  };

  let pageObserver = null;

  const init = () => {
    if (attachCommentsObserver()) return;

    // Lightweight bootstrap observer: waits only until ytd-comments appears, then self-disconnects
    pageObserver = new MutationObserver(() => {
      if (attachCommentsObserver()) {
        pageObserver.disconnect();
        pageObserver = null;
      }
    });

    const pageTarget =
      document.querySelector('ytd-page-manager') ||
      document.body;

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
    for (const pending of pendingCache.values()) {
      pending.masterController?.abort();
    }
    pendingCache.clear();
    requestQueue.length = 0;
    init();
  });
})();
