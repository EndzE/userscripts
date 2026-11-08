// ==UserScript==
// @name         YouTube - Commenter Subscribers
// @namespace    https://github.com/EndzE
// @version      1.1.3
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

  console.log('Commenter Subscribers for YouTube™ initialized.');

  const css = `
    .subscriber-count {
      font-size: 1.1rem;
      line-height: normal;
      color: #ddd;
      background-color: #333;
      margin-left: 4px;
      padding: 1px 3px;
      border-radius: 3px;
    }
    .subscriber-count.is-private {
      font-style: italic;
    }
    .subscriber-count.is-loading {
      visibility: hidden;
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

  const subCache = new Map();

  /**
   * Extracts the subscriber count from YouTube channel HTML.
   * Supports both aboutChannelViewModel ("subscriberCountText") and
   * the fallback pageHeaderViewModel ("contentMetadataViewModel").
   * @param {string} html
   * @returns {string|null} Subscriber string, or null if private/0 subs.
   */
  const extractSubCount = (html) => {
    // 1. Direct match from aboutChannelViewModel (/about endpoint)
    const match = html.match(REGEX_SUB_TEXT);
    if (match) return match[1];

    // 2. Fallback: Parse ytInitialData pageHeaderViewModel if /about format changes
    const marker = 'var ytInitialData = ';
    const start = html.indexOf(marker);
    if (start !== -1) {
      const jsonStart = start + marker.length;
      const scriptEnd = html.indexOf(';</script>', jsonStart);
      if (scriptEnd !== -1) {
        try {
          const data = JSON.parse(html.slice(jsonStart, scriptEnd));
          const rows =
            data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel
              ?.metadata?.contentMetadataViewModel?.metadataRows;

          if (Array.isArray(rows)) {
            const parts = rows.flatMap((row) => row.metadataParts || []);
            for (const part of parts) {
              const content = part?.text?.content;
              const label = part?.accessibilityLabel || '';
              if (
                content &&
                !content.startsWith('@') &&
                (SUB_LANG_REGEX.test(`${content} ${label}`) ||
                  (part.accessibilityLabel && !part.text?.styleRuns))
              ) {
                return content;
              }
            }
            return null;
          }
        } catch {
          // Fall through
        }
      }
    }

    return null;
  };

  /**
   * Normalizes the channel URL and fetches/caches the subscriber count.
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

    if (subCache.has(channelUrl)) {
      return subCache.get(channelUrl);
    }

    // Keep default same-origin credentials so YouTube cookies/consent are sent
    const fetchPromise = fetch(`${channelUrl}/about`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(extractSubCount)
      .catch((err) => {
        subCache.delete(channelUrl);
        console.warn('[Commenter Subscribers] Fetch failed:', err);
        return '__ERROR__';
      });

    subCache.set(channelUrl, fetchPromise);
    return fetchPromise;
  };

  /**
   * Updates the subscriber badge for a specific comment.
   */
  const updateBadge = async (anchor, badge) => {
    const targetUrl = anchor.href;
    if (!targetUrl) return;

    badge.classList.add('is-loading');
    const subCount = await getSubs(targetUrl);

    // Abort if YouTube recycled this comment element while the request was in flight
    if (anchor.href !== targetUrl) return;

    if (subCount === '__ERROR__') {
      // Keep hidden if the network request itself failed
      return;
    }

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

    const hrefObserver = new MutationObserver(() => updateBadge(anchor, badge));
    hrefObserver.observe(anchor, {
      attributes: true,
      attributeFilter: ['href'],
    });
  };

  // Lazy-load subscriber counts only when comments are scrolled near the viewport
  const viewportObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          initComment(entry.target);
        }
      }
    },
    { rootMargin: '300px 0px' }
  );

  let scanScheduled = false;

  const processComments = () => {
    scanScheduled = false;
    const comments = document.querySelectorAll(
      'ytd-comment-view-model:not([data-sub-count-added])'
    );

    for (const comment of comments) {
      const header = comment.querySelector('div#header-author');
      if (!header || !getAuthorAnchor(header)) continue;

      comment.dataset.subCountAdded = 'true';
      viewportObserver.observe(comment);
    }
  };

  const scheduleScan = () => {
    if (!scanScheduled) {
      scanScheduled = true;
      requestAnimationFrame(processComments);
    }
  };

  processComments();

  const bodyObserver = new MutationObserver(scheduleScan);
  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
