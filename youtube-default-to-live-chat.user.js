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
        return path.startsWith('/watch') || path.startsWith('/live');
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
            start();
        });
    }

    function poll() {
        if (!isWatchPage()) {
            cleanup();
            return;
        }

        attachIframeListener();

        const chatDoc = getChatDoc();
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

        // YouTube always orders the selector as [0] = Top Chat, [1] = Live Chat across all locales
        const liveChatAnchor = items[1];
        if (!liveChatAnchor) return;

        // If already on Live Chat, stop immediately
        if (isLiveChatSelected(liveChatAnchor)) {
            lastSwitchedDoc = chatDoc;
            cleanup();
            return;
        }

        // Click the item directly without opening the dropdown button first.
        // The DOM nodes already exist inside the closed dropdown, so this switches
        // chat modes silently without a visual menu flash or a 250ms render delay.
        const clickTarget = liveChatAnchor.querySelector('tp-yt-paper-item') || liveChatAnchor;
        clickTarget.click();

        // If Polymer updated the selection state synchronously, clean up now;
        // otherwise, the next poll tick will verify the switch and clean up.
        if (isLiveChatSelected(liveChatAnchor)) {
            lastSwitchedDoc = chatDoc;
            cleanup();
        }
    }

    function start() {
        if (!isWatchPage()) {
            cleanup();
            return;
        }

        cleanup();
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
        poll(); // Try immediately

        stopTimer = setTimeout(() => {
            cleanup();
        }, MAX_DURATION_MS);
    }

    start();
    window.addEventListener('yt-navigate-finish', start);
    window.addEventListener('yt-page-data-updated', start);
})();