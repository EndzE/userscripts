// ==UserScript==
// @name         ByXatab - Steam & SteamDB Buttons
// @namespace    https://github.com/EndzE
// @version      1.0.4
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
        if (cache[path]) return cache[path];

        let appId = null;

        for (const el of document.querySelectorAll('[data-appid], [data-steamid]')) {
            const val = (el.dataset.appid || el.dataset.steamid)?.trim();
            if (val && /^\d+$/.test(val)) {
                appId = val;
                break;
            }
        }

        // Fallback to single combined regex on HTML if not found via DOM
        if (!appId && document.body) {
            appId = document.body.innerHTML.match(/data-(?:app|steam)id=["'](\d+)["']/i)?.[1] || null;
        }

        // Cache if found (reusing the already-parsed cache object)
        if (appId) {
            cache[path] = appId;
            try {
                GM_setValue(CACHE_KEY, JSON.stringify(cache));
            } catch (e) {
                console.error('[ByXatab Steam] Failed to write cache:', e);
            }
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

        const buttons = [
            {
                cls: 'byxatab-btn-steam',
                label: 'Steam',
                icon: 'https://store.steampowered.com/favicon.ico',
                href: appId
                    ? `https://store.steampowered.com/app/${appId}/`
                    : `https://store.steampowered.com/search/?term=${encoded}`,
                title: appId
                    ? `Open in Steam (App ID: ${appId})`
                    : `Search «${title}» in Steam`
            },
            {
                cls: 'byxatab-btn-steamdb',
                label: 'SteamDB',
                icon: 'https://steamdb.info/favicon.ico',
                href: appId
                    ? `https://steamdb.info/app/${appId}/`
                    : `https://steamdb.info/search/?a=app&q=${encoded}`,
                title: appId
                    ? `Open in SteamDB (App ID: ${appId})`
                    : `Search «${title}» in SteamDB`
            }
        ];

        const group = document.createElement('div');
        group.className = GROUP_CLASS;

        for (const btn of buttons) {
            const wrap = document.createElement('div');
            wrap.className = 'byxatab-steam-btn-wrapper';

            const a = document.createElement('a');
            a.href = btn.href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = `byxatab-steam-btn ${btn.cls}`;
            a.title = btn.title;
            a.innerHTML = `<img class="byxatab-btn-icon" src="${btn.icon}" width="16" height="16" alt="${btn.label}" loading="lazy"><span>${btn.label}</span>`;

            wrap.appendChild(a);
            group.appendChild(wrap);
        }

        return group;
    }

    function init() {
        const colLeft = document.querySelector('.page__col-left');
        if (!colLeft || colLeft.querySelector(`.${GROUP_CLASS}`)) {
            return Boolean(colLeft);
        }

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        const buttons = createButtons(extractAppId());
        const thanks = colLeft.querySelector('.page__thanks');

        if (thanks) {
            thanks.before(buttons);
        } else {
            colLeft.appendChild(buttons);
        }

        return true;
    }

    init();
})();
