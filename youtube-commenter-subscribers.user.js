// ==UserScript==
// @name         YouTube - Commenter Subscribers
// @namespace    https://github.com/EndzE
// @version      1.2.0
// @description  Displays the commenter's subscriber count next to their username on YouTube.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://*.youtube.com/*
// @grant        GM_addStyle
// @noframes
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-commenter-subscribers.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-commenter-subscribers.user.js
// ==/UserScript==

(() => {
  'use strict';

  console.log('[Commenter Subscribers] Initializing optimized v1.2.0');

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
    }
    html[dark] .subscriber-count {
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

  // In-flight promises cache & resolved results cache
  const pendingCache = new Map();
  const resolvedCache = new Map();

  // Concurrency limiter for network requests (max 4 parallel connections)
  const MAX_CONCURRENT = 4;
  let activeRequests = 0;
  const requestQueue = [];

  const runQueue = () => {
    while (activeRequests < MAX_CONCURRENT && requestQueue.length > 0) {
      const task = requestQueue.shift();
      activeRequests++;
      task().finally(() => {
        activeRequests--;
        runQueue();
      });
    }
  };

  const enqueueRequest = (task) =>
    new Promise((resolve, reject) => {
      requestQueue.push(() => task().then(resolve, reject));
      runQueue();
    });

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
   * Fetches subscriber count using ReadableStream early exit.
   * Aborts downloading the remainder of the ~1MB page as soon as subscriberCountText is matched.
   * @param {string} channelUrl
   * @returns {Promise<string|null>}
   */
  const fetchSubscriberCount = async (channelUrl) => {
    try {
      const res = await fetch(`${channelUrl}/about`);
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
    } catch (err) {
      console.warn('[Commenter Subscribers] Fetch failed for:', channelUrl, err);
      return '__ERROR__';
    }
  };

  /**
   * Normalizes channel URL and manages queued fetching with caching.
   * @param {string} rawUrl
   * @returns {Promise<string|null>}
   */
  const getSubs = (rawUrl) => {
    let channelUrl;
    try {
      const parsed = new URL(rawUrl, location.origin);
      channelUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      return Promise.resolve(null);
    }

    if (resolvedCache.has(channelUrl)) {
      return Promise.resolve(resolvedCache.get(channelUrl));
    }

    if (pendingCache.has(channelUrl)) {
      return pendingCache.get(channelUrl);
    }

    const promise = enqueueRequest(() => fetchSubscriberCount(channelUrl))
      .then((result) => {
        pendingCache.delete(channelUrl);
        if (result !== '__ERROR__') {
          resolvedCache.set(channelUrl, result);
        }
        return result;
      })
      .catch(() => {
        pendingCache.delete(channelUrl);
        return '__ERROR__';
      });

    pendingCache.set(channelUrl, promise);
    return promise;
  };

  /**
   * Updates badge DOM with subscriber count or private status.
   * Renders synchronously without loading flicker if already in resolved cache.
   * @param {HTMLAnchorElement} anchor
   * @param {HTMLElement} badge
   */
  const updateBadge = async (anchor, badge) => {
    const targetUrl = anchor.href;
    if (!targetUrl) return;

    // Check synchronous cache first for zero layout shift / instant render
    let normalizedUrl;
    try {
      const parsed = new URL(targetUrl, location.origin);
      normalizedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {}

    if (normalizedUrl && resolvedCache.has(normalizedUrl)) {
      const cached = resolvedCache.get(normalizedUrl);
      applyBadgeContent(badge, cached);
      return;
    }

    badge.classList.add('is-loading');
    const subCount = await getSubs(targetUrl);

    // Abort if YouTube recycled this comment element while request was pending
    if (anchor.href !== targetUrl) return;

    if (subCount === '__ERROR__') {
      badge.classList.add('is-loading');
      return;
    }

    applyBadgeContent(badge, subCount);
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
   * Finds the commenter's channel link inside the comment header.
   */
  const getAuthorAnchor = (header) =>
    header.querySelector(
      'a#author-text, a#name, a[href^="/@"], a[href^="/channel/"]'
    ) || header.querySelector('a');

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
      badge = document.createElement('span');
      badge.className = 'subscriber-count is-loading';
      header.appendChild(badge);
    }

    updateBadge(anchor, badge);
  };

  // Viewport observer with 400px margin for pre-emptive loading before scroll-in
  const viewportObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          initComment(entry.target);
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

  // Single shared MutationObserver scoped strictly to the comments container.
  // Replaces hundreds of per-comment href observers and eliminates global document.body scans.
  const commentsObserver = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];

      // Handle element reuse / href changes (virtual DOM recycling)
      if (m.type === 'attributes' && m.attributeName === 'href') {
        const anchor = m.target;
        if (
          anchor &&
          anchor.matches?.('a#author-text, a#name, a[href^="/@"], a[href^="/channel/"]')
        ) {
          const header = anchor.closest('div#header-author');
          if (header) {
            const badge = header.querySelector('.subscriber-count');
            if (badge) updateBadge(anchor, badge);
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
    const container =
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

  // Clean SPA navigation handling
  window.addEventListener('yt-navigate-finish', () => {
    commentsObserver.disconnect();
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    init();
  });
})();
