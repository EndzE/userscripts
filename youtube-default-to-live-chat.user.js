// ==UserScript==
// @name         YouTube - Default To Live Chat
// @namespace    https://github.com/EndzE
// @version      1.5.0
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

    const POLL_INTERVAL_MS = 300;
    const MAX_DURATION_MS = 30000;

    let pollTimer = null;
    let stopTimer = null;

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

    function poll() {
        const chatDoc = getChatDoc();
        if (!chatDoc) return;

        const subMenu = chatDoc.getElementById('live-chat-view-selector-sub-menu');
        if (!subMenu) return;

        const items = subMenu.querySelectorAll('tp-yt-paper-listbox > a.yt-simple-endpoint');
        const liveChatAnchor = Array.from(items).find(a => /live\s*chat/i.test(a.textContent)) || items[1];
        if (!liveChatAnchor) return;

        // If already on Live Chat, stop immediately
        if (isLiveChatSelected(liveChatAnchor)) {
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
            cleanup();
        }
    }

    function start() {
        cleanup();
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
        poll(); // Try immediately

        stopTimer = setTimeout(() => {
            console.debug('[Default To Live Chat] gave up after 30s — menu never switched');
            cleanup();
        }, MAX_DURATION_MS);
    }

    start();
    window.addEventListener('yt-navigate-finish', start);
})();
