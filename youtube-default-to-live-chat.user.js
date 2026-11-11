// ==UserScript==
// @name         YouTube - Default To Live Chat
// @namespace    https://github.com/EndzE
// @version      1.5.2
// @description  Automatically switches YouTube chat from Top Chat to Live Chat, with minimal CPU usage.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://*.youtube.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-default-to-live-chat.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-default-to-live-chat.user.js
// ==/UserScript==

(function () {
    'use strict';

    const POLL_INTERVAL_MS = 250;
    const MAX_DURATION_MS = 15000;
    const LIVE_CHAT_REGEX = /live\s*chat/i;

    let pollTimer = null;
    let stopTimer = null;
    let lastSwitchedDoc = null;

    function cleanup() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (stopTimer) {
            clearTimeout(stopTimer);
            stopTimer = null;
        }
    }

    function isWatchPage() {
        const path = window.location.pathname;
        return (
            path.startsWith('/watch') ||
            path.startsWith('/live') || // Covers /live/... and popout /live_chat
            path.endsWith('/live')      // Covers /@channel/live, /c/channel/live, etc.
        );
    }

    function isLiveChatSelected(anchor) {
        return (
            anchor.classList.contains('iron-selected') ||
            anchor.getAttribute('aria-selected') === 'true'
        );
    }

    function getChatDoc() {
        if (document.getElementById('live-chat-view-selector-sub-menu')) {
            return document;
        }
        const iframe = document.querySelector('iframe#chatframe');
        try {
            return iframe?.contentDocument || null;
        } catch {
            return null;
        }
    }

    function attachIframeListener() {
        const iframe = document.querySelector('iframe#chatframe');
        if (!iframe || iframe.__defaultLiveChatHooked) return;
        iframe.__defaultLiveChatHooked = true;
        iframe.addEventListener('load', () => {
            lastSwitchedDoc = null;
            start(true);
        });
    }

    function poll() {
        if (!isWatchPage()) {
            cleanup();
            return;
        }

        attachIframeListener();

        const chatDoc = getChatDoc();
        // Skip if chatDoc is missing or is the stale document from a previous video
        if (!chatDoc || chatDoc === lastSwitchedDoc) return;

        let docHref = '';
        try {
            docHref = chatDoc.location?.href || '';
        } catch {
            return;
        }

        if (!docHref || docHref === 'about:blank') return;

        const subMenu = chatDoc.getElementById('live-chat-view-selector-sub-menu');
        if (!subMenu) return;

        const items = subMenu.querySelectorAll('tp-yt-paper-listbox > a.yt-simple-endpoint');
        if (items.length < 2) return;

        const liveChatAnchor = Array.from(items).find(a => LIVE_CHAT_REGEX.test(a.textContent)) || items[1];
        if (!liveChatAnchor) return;

        if (isLiveChatSelected(liveChatAnchor)) {
            lastSwitchedDoc = chatDoc;
            cleanup();
            return;
        }

        const clickTarget = liveChatAnchor.querySelector('tp-yt-paper-item') || liveChatAnchor;
        clickTarget.click();

        if (isLiveChatSelected(liveChatAnchor)) {
            lastSwitchedDoc = chatDoc;
            cleanup();
        }
    }

    function start(force = false) {
        if (!isWatchPage()) {
            cleanup();
            return;
        }

        if (force) {
            lastSwitchedDoc = null;
        }

        cleanup();
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
        poll();

        stopTimer = setTimeout(cleanup, MAX_DURATION_MS);
    }

    start();
    window.addEventListener('yt-navigate-finish', () => start(false));
    window.addEventListener('yt-page-data-updated', () => start(false));
})();