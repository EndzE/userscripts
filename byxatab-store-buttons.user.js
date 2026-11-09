// ==UserScript==
// @name         ByXatab - Store Buttons
// @namespace    https://github.com/EndzE
// @version      1.2.1
// @description  Adds Steam, Epic, GOG buttons to game pages on byxatab.com.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=byxatab.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://byxatab.com/games/*
// @connect      api.egdata.app
// @connect      catalog.gog.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @noframes
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/byxatab-store-buttons.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/byxatab-store-buttons.user.js
// ==/UserScript==

(() => {
    'use strict';

    const CACHE_KEY = 'steam_appid_cache';
    const EGS_CACHE_KEY = 'egs_offer_cache_v2';
    const GOG_CACHE_KEY = 'gog_product_cache_v1';
    const STYLE_ID = 'byxatab-steam-styles';
    const GROUP_CLASS = 'byxatab-steam-btn-group';
    const EGS_GROUP_CLASS = 'byxatab-egs-btn-group';
    const GOG_GROUP_CLASS = 'byxatab-gog-btn-group';

    const DIGITS_RE = /^\d+$/;
    const STEAM_LINK_RE = /(?:store\.steampowered\.com\/(?:app|news\/app)|steamdb\.info\/app|steamcommunity\.com\/(?:app|games))\/(\d+)/i;
    const STEAM_WIDGET_RE = /\/widget\/(\d+)/i;
    const EGS_EDITION_RE = /(?:Тип издания:[^\n\r]*|Папка[^\n\r]*\b)(?:EGS|EpicStore)/i;
    const GOG_MARKER_RE = /(?:Тип издания:[^\n\r]*|Жанр:[^\n\r]*|Папка[^\n\r]*\b|\b[[(])GOG(?:\.com)?\b/i;
    const GOG_TITLE_RE = /\b[[(]GOG[\])]/i;

    const RE_TITLE_PREFIX = /^[CС]качать\s+/i;
    const RE_TITLE_BRACKETS = /\s*\[.*?\]/g;
    const RE_TITLE_PARENS = /\s*\((?:(?:19|20)\d\d.*?|EGS|EpicStore|GOG)\)/gi;
    const RE_TITLE_TAIL = /\s*(?:v\.?\d+|build\s*\d+|(?:PC\s*\|)?\s*(?:RePack|Лицензия|Rip|Steam-Rip|Цифровая лицензия)|торрент).*$/i;

    const CSS = `
    .${GROUP_CLASS} {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        width: 100%;
        box-sizing: border-box;
    }

    /* Old Design (Torrentino): Inline near .button_line.button_secondary */
    .inner-entry__buttons {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        flex-wrap: wrap !important;
    }

    .inner-entry__buttons .${GROUP_CLASS} {
        display: inline-flex !important;
        width: auto !important;
        margin-top: 0 !important;
    }

    .byxatab-steam-btn-wrapper {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
    }

    .inner-entry__buttons .byxatab-steam-btn-wrapper {
        flex: 0 0 auto !important;
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
        color: #fff !important;
        transition: background-color 0.3s, color 0.3s, opacity 0.3s;
    }

    .inner-entry__buttons .byxatab-steam-btn {
        height: 38px !important;
        padding: 0 16px !important;
        border-radius: 4px !important;
    }

    .byxatab-btn-icon {
        width: 16px !important;
        height: 16px !important;
        border-radius: 2px !important;
        flex-shrink: 0 !important;
        object-fit: contain !important;
        vertical-align: middle !important;
    }

    /* Light Theme */
    .byxatab-btn-steam { background-color: #1b2838 !important; }
    .byxatab-btn-steam:hover { background-color: #2a475e !important; }
    .byxatab-btn-steamdb { background-color: #0075b6 !important; }
    .byxatab-btn-steamdb:hover { background-color: #005e92 !important; }
    .byxatab-btn-egs { background-color: #262626 !important; }
    .byxatab-btn-egs:hover { background-color: #3b3b3b !important; }
    .byxatab-btn-egdata { background-color: #4f46e5 !important; }
    .byxatab-btn-egdata:hover { background-color: #4338ca !important; }
    .byxatab-btn-gog { background-color: #5c2e91 !important; }
    .byxatab-btn-gog:hover { background-color: #7038b3 !important; }
    .byxatab-btn-gogdb { background-color: #0284c7 !important; }
    .byxatab-btn-gogdb:hover { background-color: #0369a1 !important; }

    /* Dark Theme */
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-steam-btn { color: #c9c9c9 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-steam-btn:hover { color: #fff !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-steam { background-color: #1a2430 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-steam:hover { background-color: #26364a !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-steamdb { background-color: #063452 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-steamdb:hover { background-color: #0b4970 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-egs { background-color: #374151 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-egs:hover { background-color: #4b5563 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-egdata { background-color: #3730a3 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-egdata:hover { background-color: #4338ca !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-gog { background-color: #3b1d61 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-gog:hover { background-color: #502784 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-gogdb { background-color: #075985 !important; }
    :is(.dt-is-active, [data-darkreader-scheme="dark"]) .byxatab-btn-gogdb:hover { background-color: #0369a1 !important; }

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

    const memCache = new Map();

    function getCache(key) {
        let cached = memCache.get(key);
        if (cached) return cached;
        try {
            const raw = GM_getValue(key, '{}');
            cached = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        } catch {
            cached = {};
        }
        memCache.set(key, cached);
        return cached;
    }

    function setCache(key, data) {
        memCache.set(key, data);
        try {
            GM_setValue(key, JSON.stringify(data));
        } catch (e) {
            console.error(`[ByXatab] Cache save error (${key}):`, e);
        }
    }

    function getRequester() {
        return (typeof GM_xmlhttpRequest === 'function')
            ? GM_xmlhttpRequest
            : (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null);
    }

    function getCandidateTitles(title) {
        if (!title.includes('/')) return [title];
        const titles = [title];
        const parts = title.split('/');
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i].trim();
            if (p && !titles.includes(p)) titles.push(p);
        }
        return titles;
    }

    function fetchEgsData(title, callback) {
        const path = location.pathname;
        const cache = getCache(EGS_CACHE_KEY);
        if (cache[path]) {
            callback(cache[path]);
            return;
        }

        const requester = getRequester();
        if (!requester) return;

        const titlesToTry = getCandidateTitles(title);

        function queryNext(idx) {
            if (idx >= titlesToTry.length) return;
            const queryTitle = titlesToTry[idx];
            requester({
                method: 'GET',
                url: `https://api.egdata.app/search/v2/search?title=${encodeURIComponent(queryTitle)}&limit=10`,
                headers: { 'Accept': 'application/json' },
                onload: (res) => {
                    try {
                        if (res.status >= 200 && res.status < 300) {
                            const json = JSON.parse(res.responseText);
                            const offers = json.offers || [];
                            if (offers.length === 0) {
                                queryNext(idx + 1);
                                return;
                            }
                            const normalizedTitle = queryTitle.trim().toLowerCase();
                            const exactMatches = offers.filter(o => o.title && o.title.trim().toLowerCase() === normalizedTitle);
                            const candidates = exactMatches.length ? exactMatches : offers;

                            const baseGames = candidates.filter(o => o.offerType === 'BASE_GAME' || o.offerType === 'EDITION');
                            const nonPrePurchase = baseGames.filter(o => !o.prePurchase);
                            const best = (nonPrePurchase.length > 0 ? nonPrePurchase : baseGames)[0] || candidates[0] || offers[0];

                            if (best) {
                                const slug = best.productSlug || best.offerMappings?.[0]?.pageSlug || best.urlSlug || null;
                                const data = { offerId: best.id, slug };
                                cache[path] = data;
                                setCache(EGS_CACHE_KEY, cache);
                                callback(data);
                                return;
                            }
                        }
                    } catch (e) {
                        console.error('[ByXatab EGS] Parse error:', e);
                    }
                    queryNext(idx + 1);
                },
                onerror: (err) => {
                    console.error('[ByXatab EGS] Request failed:', err);
                    queryNext(idx + 1);
                }
            });
        }

        queryNext(0);
    }

    function pickBestGogProduct(products, title) {
        if (!products || !products.length) return null;
        const normalizedTitle = title.trim().toLowerCase();

        // 1. Exact match on title among games/packs
        const exactGame = products.find(p => (p.productType === 'game' || p.productType === 'pack') && p.title && p.title.trim().toLowerCase() === normalizedTitle);
        if (exactGame) return exactGame;

        // 2. Exact match on title among all products
        const exactAll = products.find(p => p.title && p.title.trim().toLowerCase() === normalizedTitle);
        if (exactAll) return exactAll;

        // 3. Base games that start with the query title
        const games = products.filter(p => p.productType === 'game' || p.productType === 'pack');
        const pool = games.length ? games : products;
        const prefixMatch = pool.find(p => p.title && p.title.trim().toLowerCase().startsWith(normalizedTitle));
        if (prefixMatch) return prefixMatch;

        // 4. Word-based match: title contains query words
        const queryWords = normalizedTitle.split(/\s+/).filter(w => w.length > 2);
        if (queryWords.length) {
            const wordMatch = pool.find(p => {
                const pt = (p.title || '').toLowerCase();
                return queryWords.every(w => pt.includes(w));
            });
            if (wordMatch) return wordMatch;
        }

        return null;
    }

    function fetchGogData(title, callback) {
        if (!title || !title.trim()) return;
        const path = location.pathname;
        const cache = getCache(GOG_CACHE_KEY);
        if (cache[path]) {
            callback(cache[path]);
            return;
        }

        const requester = getRequester();
        if (!requester) return;

        const titlesToTry = getCandidateTitles(title);

        function queryNext(idx) {
            if (idx >= titlesToTry.length) return;
            const queryTitle = titlesToTry[idx];
            requester({
                method: 'GET',
                url: `https://catalog.gog.com/v1/catalog?query=like:${encodeURIComponent(queryTitle)}&limit=10`,
                headers: { 'Accept': 'application/json' },
                onload: (res) => {
                    try {
                        if (res.status >= 200 && res.status < 300) {
                            const json = JSON.parse(res.responseText);
                            const products = json.products || [];
                            const best = pickBestGogProduct(products, queryTitle);
                            if (best) {
                                const data = {
                                    productId: best.id,
                                    slug: best.slug,
                                    title: best.title
                                };
                                cache[path] = data;
                                setCache(GOG_CACHE_KEY, cache);
                                callback(data);
                                return;
                            }
                        }
                    } catch (e) {
                        console.error('[ByXatab GOG] Parse error:', e);
                    }
                    queryNext(idx + 1);
                },
                onerror: (err) => {
                    console.error('[ByXatab GOG] Request failed:', err);
                    queryNext(idx + 1);
                }
            });
        }

        queryNext(0);
    }

    function extractAppId(cache, rootEl) {
        const path = location.pathname;
        if (cache[path]) return cache[path];

        let appId = null;

        // 1. Direct dataset attribute on first matching element
        const dataEl = document.querySelector('[data-appid], [data-steamid]');
        if (dataEl) {
            const val = (dataEl.dataset.appid || dataEl.dataset.steamid)?.trim();
            if (val && DIGITS_RE.test(val)) {
                appId = val;
            }
        }

        // 2-4. Search within main content container strictly (avoid leaks to carousel/footer)
        if (!appId) {
            const root = document.querySelector('.page__content') || rootEl || document.querySelector('.page') || document.body;

            // 2. Links to Steam / SteamDB
            for (const a of root.querySelectorAll('a[href*="steam"]:not(.byxatab-steam-btn)')) {
                const m = STEAM_LINK_RE.exec(a.href);
                if (m) {
                    appId = m[1];
                    break;
                }
            }

            // 3. Steam widget iframes
            if (!appId) {
                const iframe = root.querySelector('iframe[src*="steampowered.com/widget"]');
                if (iframe) {
                    const m = STEAM_WIDGET_RE.exec(iframe.src);
                    if (m) appId = m[1];
                }
            }

            // 4. Fallback on textContent
            if (!appId) {
                const textMatch = STEAM_LINK_RE.exec(root.textContent);
                if (textMatch) appId = textMatch[1];
            }
        }

        // Cache valid App ID or purge stale negative cache
        if (appId) {
            cache[path] = appId;
            setCache(CACHE_KEY, cache);
        } else if (path in cache) {
            delete cache[path];
            setCache(CACHE_KEY, cache);
        }

        return appId;
    }

    function getGameTitle(raw) {
        return raw
            .replace(RE_TITLE_PREFIX, '')
            .replace(RE_TITLE_BRACKETS, '')
            .replace(RE_TITLE_PARENS, '')
            .replace(RE_TITLE_TAIL, '')
            .trim();
    }

    function createButtonGroup(extraClass, buttons) {
        const group = document.createElement('div');
        group.className = extraClass ? `${GROUP_CLASS} ${extraClass}` : GROUP_CLASS;
        const links = [];
        for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const wrap = document.createElement('div');
            wrap.className = 'byxatab-steam-btn-wrapper';

            const a = document.createElement('a');
            a.href = btn.href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'byxatab-steam-btn ' + btn.btnClass;
            a.title = btn.title;

            const img = document.createElement('img');
            img.className = 'byxatab-btn-icon';
            img.src = btn.icon;
            img.width = 16;
            img.height = 16;
            img.alt = btn.label;
            img.loading = 'lazy';

            const span = document.createElement('span');
            span.textContent = btn.label;

            a.append(img, span);
            wrap.appendChild(a);
            group.appendChild(wrap);
            links.push(a);
        }
        group._links = links;
        return group;
    }

    function createSteamButtons(appId, title) {
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

        return createButtonGroup('', [
            { href: steamHref, title: steamTitle, btnClass: 'byxatab-btn-steam', icon: 'https://store.steampowered.com/favicon.ico', label: 'Steam' },
            { href: steamDbHref, title: steamDbTitle, btnClass: 'byxatab-btn-steamdb', icon: 'https://steamdb.info/favicon.ico', label: 'SteamDB' }
        ]);
    }

    function createEgsButtons(data, title) {
        const slug = data?.slug;
        const offerId = data?.offerId;
        const encoded = encodeURIComponent(title);

        const egsHref = slug
            ? `https://store.epicgames.com/p/${slug}`
            : `https://store.epicgames.com/browse?q=${encoded}`;
        const egsTitle = slug
            ? `Open «${title}» in Epic Games Store`
            : `Search «${title}» in Epic Games Store`;

        const egdataHref = offerId
            ? `https://egdata.app/offers/${offerId}`
            : `https://egdata.app/search?title=${encoded}`;
        const egdataTitle = offerId
            ? `Open «${title}» in egdata.app`
            : `Search «${title}» in egdata.app`;

        return createButtonGroup(EGS_GROUP_CLASS, [
            { href: egsHref, title: egsTitle, btnClass: 'byxatab-btn-egs', icon: 'https://www.google.com/s2/favicons?sz=32&domain=epicgames.com', label: 'Epic Games' },
            { href: egdataHref, title: egdataTitle, btnClass: 'byxatab-btn-egdata', icon: 'https://egdata.app/favicon.ico', label: 'egdata' }
        ]);
    }

    function updateEgsButtons(group, data, title) {
        const links = group._links || group.querySelectorAll('a');
        if (data?.slug && links[0]) {
            links[0].href = `https://store.epicgames.com/p/${data.slug}`;
            links[0].title = `Open «${title}» in Epic Games Store`;
        }
        if (data?.offerId && links[1]) {
            links[1].href = `https://egdata.app/offers/${data.offerId}`;
            links[1].title = `Open «${title}» in egdata.app`;
        }
    }

    function createGogButtons(data, title) {
        const slug = data?.slug;
        const productId = data?.productId;
        const encoded = encodeURIComponent(title);

        const gogHref = slug
            ? `https://www.gog.com/en/game/${slug}`
            : `https://www.gog.com/en/games?query=${encoded}`;
        const gogTitle = slug
            ? `Open «${title}» in GOG`
            : `Search «${title}» in GOG`;

        const gogDbHref = productId
            ? `https://www.gogdb.org/product/${productId}`
            : `https://www.gogdb.org/products?search=${encoded}`;
        const gogDbTitle = productId
            ? `Open «${title}» in GOGDB (Product ID: ${productId})`
            : `Search «${title}» in GOGDB`;

        return createButtonGroup(GOG_GROUP_CLASS, [
            { href: gogHref, title: gogTitle, btnClass: 'byxatab-btn-gog', icon: 'https://www.gog.com/favicon.ico', label: 'GOG' },
            { href: gogDbHref, title: gogDbTitle, btnClass: 'byxatab-btn-gogdb', icon: 'https://www.gogdb.org/favicon.ico', label: 'GOGDB' }
        ]);
    }

    function updateGogButtons(group, data, title) {
        const links = group._links || group.querySelectorAll('a');
        if (data?.slug && links[0]) {
            links[0].href = `https://www.gog.com/en/game/${data.slug}`;
            links[0].title = `Open «${title}» in GOG`;
        }
        if (data?.productId && links[1]) {
            links[1].href = `https://www.gogdb.org/product/${data.productId}`;
            links[1].title = `Open «${title}» in GOGDB (Product ID: ${data.productId})`;
        }
    }

    function init() {
        // Fast layout container check (early exit on non-game pages)
        const colLeft = document.querySelector('.page__col-left');
        const oldThanks = !colLeft ? document.querySelector('.button_line.button_secondary') : null;
        const container = colLeft || oldThanks?.parentElement || document.querySelector('.inner-entry__buttons');

        if (!container) return false;

        const titleEl = document.querySelector('.page__header h1, .inner-entry__title, h1');
        const entryTech = document.querySelector('.page__tech, .inner-entry');

        const rawTitle = titleEl?.textContent || document.title;
        const title = getGameTitle(rawTitle);
        const steamCache = getCache(CACHE_KEY);
        const appId = extractAppId(steamCache, entryTech);

        const techText = entryTech?.textContent || '';
        const needsEgs = entryTech ? EGS_EDITION_RE.test(techText) : false;
        const needsGog = location.pathname.includes('/games/gog/')
            || (entryTech && (entryTech.querySelector('a[href*="/gog/"]') || GOG_MARKER_RE.test(techText)))
            || GOG_TITLE_RE.test(rawTitle);

        const showSteam = !!appId || (!needsEgs && !needsGog);

        const isModern = !!colLeft;
        const baseAnchor = isModern ? colLeft.querySelector('.page__thanks') : oldThanks;

        const steamGroup = container.querySelector(`.${GROUP_CLASS}:not(.${EGS_GROUP_CLASS}):not(.${GOG_GROUP_CLASS})`);
        const egsGroup = container.querySelector(`.${EGS_GROUP_CLASS}`);
        const gogGroup = container.querySelector(`.${GOG_GROUP_CLASS}`);

        if (!showSteam && steamGroup) {
            steamGroup.remove();
        }

        // Fast path: all needed elements already present
        if ((!showSteam || steamGroup) && (!needsEgs || egsGroup) && (!needsGog || gogGroup)) {
            return true;
        }

        // Inject Stylesheet once
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        function mountGroup(group, prevGroup) {
            if (prevGroup) {
                prevGroup.after(group);
            } else if (baseAnchor) {
                if (isModern) baseAnchor.before(group);
                else baseAnchor.after(group);
            } else {
                container.appendChild(group);
            }
        }

        let currentPrev = null;

        // 1. Steam group
        if (showSteam) {
            let sGroup = steamGroup;
            if (!sGroup) {
                sGroup = createSteamButtons(appId, title);
                mountGroup(sGroup, null);
            }
            currentPrev = sGroup;
        }

        const path = location.pathname;

        // 2. Epic Games Store group
        if (needsEgs) {
            let eGroup = egsGroup;
            if (!eGroup) {
                const egsCache = getCache(EGS_CACHE_KEY);
                const cached = egsCache[path];
                eGroup = createEgsButtons(cached, title);
                mountGroup(eGroup, currentPrev);

                if (!cached) {
                    fetchEgsData(title, (data) => updateEgsButtons(eGroup, data, title));
                }
            }
            currentPrev = eGroup;
        }

        // 3. GOG group
        if (needsGog) {
            let gGroup = gogGroup;
            if (!gGroup) {
                const gogCache = getCache(GOG_CACHE_KEY);
                const cached = gogCache[path];
                gGroup = createGogButtons(cached, title);
                mountGroup(gGroup, currentPrev);

                if (!cached) {
                    fetchGogData(title, (data) => updateGogButtons(gGroup, data, title));
                }
            }
        }

        return true;
    }

    init();
})();
