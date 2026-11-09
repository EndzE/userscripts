// ==UserScript==
// @name         ByXatab - Steam & SteamDB Buttons
// @namespace    https://github.com/EndzE
// @version      1.0.5
// @description  Adds Steam and SteamDB buttons to game pages on byxatab.com.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=byxatab.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://byxatab.com/games/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/byxatab-steam-steamdb-buttons.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/byxatab-steam-steamdb-buttons.user.js
// ==/UserScript==

(() => {
    'use strict';

    const CACHE_KEY = 'steam_appid_cache';
    const STYLE_ID = 'byxatab-steam-styles';
    const GROUP_CLASS = 'byxatab-steam-btn-group';

    const DIGITS_RE = /^\d+$/;
    const STEAM_LINK_RE = /(?:store\.steampowered\.com\/(?:app|news\/app)|steamdb\.info\/app|steamcommunity\.com\/(?:app|games))\/(\d+)/i;
    const STEAM_WIDGET_RE = /\/widget\/(\d+)/i;

    const CSS = `
    .${GROUP_CLASS} {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        width: 100%;
        box-sizing: border-box;
    }

    .byxatab-steam-btn-wrapper {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
    }

    .byxatab-steam-btn-wrapper .swi-block {
        flex-shrink: 0;
    }

    .byxatab-steam-btn {
        flex: 1;
        width: 100%;
        height: 35px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 0 8px;
        border-radius: 5px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        text-decoration: none !important;
        box-sizing: border-box;
        border: none;
        box-shadow: none;
        user-select: none;
        transition: background-color 0.3s, color 0.3s, opacity 0.3s;
    }

    .byxatab-btn-icon {
        width: 16px;
        height: 16px;
        border-radius: 2px;
        flex-shrink: 0;
        display: block;
    }

    /* Light Theme */
    .byxatab-btn-steam {
        background-color: #1b2838;
        color: #fff !important;
    }

    .byxatab-btn-steam:hover {
        background-color: #2a475e;
        color: #fff !important;
    }

    .byxatab-btn-steamdb {
        background-color: #0075b6;
        color: #fff !important;
    }

    .byxatab-btn-steamdb:hover {
        background-color: #005e92;
        color: #fff !important;
    }

    /* Dark Theme */
    .dt-is-active .byxatab-btn-steam {
        background-color: #1a2430;
        color: #c9c9c9 !important;
    }

    .dt-is-active .byxatab-btn-steam:hover {
        background-color: #26364a;
        color: #fff !important;
    }

    .dt-is-active .byxatab-btn-steamdb {
        background-color: #063452;
        color: #c9c9c9 !important;
    }

    .dt-is-active .byxatab-btn-steamdb:hover {
        background-color: #0b4970;
        color: #fff !important;
    }

    .byxatab-steam-btn:active {
        opacity: 0.85;
    }

    /* Column Spacing & Thanks Button Fixes */
    .page__thanks {
        margin-top: 8px !important;
        margin-bottom: 12px !important;
    }

    .page__thanks a {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 100% !important;
        height: 35px !important;
        box-sizing: border-box !important;
    }
    `;

    function getStorage() {
        try {
            const raw = GM_getValue(CACHE_KEY, '{}');
            return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        } catch {
            return {};
        }
    }

    function extractAppId() {
        const path = location.pathname;
        const cache = getStorage();
        if (path in cache) return cache[path] || null;

        let appId = null;
        const root = document.querySelector('.page') || document.querySelector('#dle-content') || document.body;

        if (root) {
            // 1. Direct dataset attribute on first matching element (no NodeList or dataset Proxy)
            const dataEl = root.querySelector('[data-appid], [data-steamid]');
            if (dataEl) {
                const val = (dataEl.getAttribute('data-appid') || dataEl.getAttribute('data-steamid'))?.trim();
                if (val && DIGITS_RE.test(val)) {
                    appId = val;
                }
            }

            // 2. Links to Steam / SteamDB in page body / patchnotes
            if (!appId) {
                for (const a of root.querySelectorAll('a[href*="steam"]')) {
                    const m = a.href.match(STEAM_LINK_RE);
                    if (m) {
                        appId = m[1];
                        break;
                    }
                }
            }

            // 3. Steam widget iframes
            if (!appId) {
                const iframe = root.querySelector('iframe[src*="steampowered.com/widget"]');
                if (iframe) {
                    const m = iframe.src.match(STEAM_WIDGET_RE);
                    if (m) appId = m[1];
                }
            }

            // 4. Fallback on textContent (15x faster than innerHTML, zero HTML serialization)
            if (!appId) {
                const textMatch = root.textContent.match(STEAM_LINK_RE);
                if (textMatch) appId = textMatch[1];
            }
        }

        // Cache result (including empty string for non-Steam games to eliminate repeat parsing)
        cache[path] = appId || '';
        try {
            GM_setValue(CACHE_KEY, JSON.stringify(cache));
        } catch (e) {
            console.error('[ByXatab Steam] Failed to write cache:', e);
        }

        return appId;
    }

    function getGameTitle() {
        return (
            document.querySelector('.page__header h1, h1')?.textContent?.trim() ||
            document.title.replace(/^[CС]качать\s+|\s+торрент.*$/gi, '').trim()
        );
    }

    function createButtons(appId) {
        const title = appId ? '' : getGameTitle();
        const encoded = appId ? '' : encodeURIComponent(title);
        const steamHref = appId
            ? `https://store.steampowered.com/app/${appId}/`
            : `https://store.steampowered.com/search/?term=${encoded}`;
        const steamTitle = appId
            ? `Open in Steam (App ID: ${appId})`
            : `Search «${title}» in Steam`;
        const steamDbHref = appId
            ? `https://steamdb.info/app/${appId}/`
            : `https://steamdb.info/search/?a=app&q=${encoded}`;
        const steamDbTitle = appId
            ? `Open in SteamDB (App ID: ${appId})`
            : `Search «${title}» in SteamDB`;

        const group = document.createElement('div');
        group.className = GROUP_CLASS;
        group.innerHTML = `
            <div class="byxatab-steam-btn-wrapper">
                <a href="${steamHref}" target="_blank" rel="noopener noreferrer" class="byxatab-steam-btn byxatab-btn-steam" title="${steamTitle}">
                    <img class="byxatab-btn-icon" src="https://store.steampowered.com/favicon.ico" width="16" height="16" alt="Steam" loading="lazy">
                    <span>Steam</span>
                </a>
            </div>
            <div class="byxatab-steam-btn-wrapper">
                <a href="${steamDbHref}" target="_blank" rel="noopener noreferrer" class="byxatab-steam-btn byxatab-btn-steamdb" title="${steamDbTitle}">
                    <img class="byxatab-btn-icon" src="https://steamdb.info/favicon.ico" width="16" height="16" alt="SteamDB" loading="lazy">
                    <span>SteamDB</span>
                </a>
            </div>`;

        return group;
    }

    function init() {
        const colLeft = document.getElementsByClassName('page__col-left')[0];
        if (!colLeft || colLeft.getElementsByClassName(GROUP_CLASS).length) {
            return Boolean(colLeft);
        }

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        const buttons = createButtons(extractAppId());
        const thanks = colLeft.getElementsByClassName('page__thanks')[0];

        if (thanks) {
            thanks.before(buttons);
        } else {
            colLeft.appendChild(buttons);
        }

        return true;
    }

    init();
})();
