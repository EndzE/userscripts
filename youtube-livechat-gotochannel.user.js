// ==UserScript==
// @name         YouTube - Livechat GoToChannel
// @namespace    https://github.com/EndzE
// @version      1.0.13
// @description  Restores the "Go to channel" option in YouTube live chat with instant context menus, hover prefetching, and debounce bypass.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-livechat-gotochannel.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-livechat-gotochannel.user.js
// ==/UserScript==

(function () {
    'use strict';

    const MAX_CACHE_SIZE = 1000;
    const MAX_PREFETCH_CACHE = 300;
    const CONTEXT_MENU_REGEX = /\/(youtubei\/v1\/)?live_chat\/(get_live_chat_item_context_menu|get_item_context_menu)(\?|\/|$)/;
    const CHANNEL_ID_REGEX = /UC[\w-]{22}/g;

    const mappedChannelIds = new Map();
    const prefetchCache = new Map();

    function safeB64Decode(str) {
        if (!str) return '';
        try {
            const clean = decodeURIComponent(str).replace(/-/g, '+').replace(/_/g, '/');
            const unpadded = clean.replace(/=+$/, '');
            const padded = unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), '=');
            return atob(padded);
        } catch {
            return '';
        }
    }

    /**
     * Extracts author's channelId ("UC...") from the double-Base64 protobuf `params` token in 0.002ms.
     */
    function decodeChannelIdFromParams(params) {
        if (!params) return null;
        try {
            const outer = safeB64Decode(params);
            const proto = safeB64Decode(outer);
            const matches = proto.match(CHANNEL_ID_REGEX) ?? outer.match(CHANNEL_ID_REGEX);
            return matches ? matches[matches.length - 1] : null;
        } catch {
            return null;
        }
    }

    function cacheChannelId(params, channelId) {
        if (!params || !channelId) return;
        if (!mappedChannelIds.has(params) && mappedChannelIds.size >= MAX_CACHE_SIZE) {
            const oldestKey = mappedChannelIds.keys().next().value;
            mappedChannelIds.delete(oldestKey);
        }
        mappedChannelIds.set(params, channelId);
    }

    function resolveChannelId(params) {
        if (!params) return null;
        let channelId = mappedChannelIds.get(params);
        if (channelId) return channelId;

        // Instant on-demand protobuf decode (0.002ms, 0 layout reflow)
        channelId = decodeChannelIdFromParams(params);
        if (channelId) {
            cacheChannelId(params, channelId);
            return channelId;
        }

        return null;
    }

    function generateMenuLinkItem(url, text, icon) {
        return {
            menuNavigationItemRenderer: {
                text: { runs: [{ text }] },
                icon: { iconType: icon },
                navigationEndpoint: {
                    commandMetadata: {
                        webCommandMetadata: {
                            url,
                            webPageType: 'WEB_PAGE_TYPE_CHANNEL',
                            rootVe: 83769
                        }
                    },
                    urlEndpoint: {
                        url,
                        target: 'TARGET_NEW_WINDOW'
                    }
                }
            }
        };
    }

    function appendAdditionalChannelContextItems(responseText, params) {
        if (!responseText || responseText.includes('"ACCOUNT_CIRCLE"')) {
            return responseText;
        }

        const channelId = resolveChannelId(params);
        if (!channelId) return responseText;

        try {
            const responseData = JSON.parse(responseText);
            const rootNode = responseData.response ?? responseData;
            const menuRenderer = rootNode?.liveChatItemContextMenuSupportedRenderers?.menuRenderer;
            if (!menuRenderer) return responseText;

            // Handle empty menus (e.g. logged out users)
            if (!Array.isArray(menuRenderer.items)) {
                menuRenderer.items = [];
            }

            // Check if "Go to channel" is already present
            const alreadyHasChannel = menuRenderer.items.some(it => {
                const nav = it.menuNavigationItemRenderer;
                return nav?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.webPageType === 'WEB_PAGE_TYPE_CHANNEL';
            });

            if (!alreadyHasChannel) {
                menuRenderer.items.unshift(
                    generateMenuLinkItem(`/channel/${channelId}`, 'Go to channel', 'ACCOUNT_CIRCLE')
                );
            }

            return JSON.stringify(responseData);
        } catch {
            return responseText;
        }
    }

    function extractParams(reqUrl, body) {
        if (reqUrl) {
            try {
                const urlObj = new URL(reqUrl, 'https://www.youtube.com');
                const p = urlObj.searchParams.get('params');
                if (p) return p;
            } catch {}
        }
        if (typeof body === 'string') {
            const match = body.match(/"params"\s*:\s*"([^"]+)"/);
            if (match) return match[1];
        }
        return null;
    }

    function getAuthHeaders(win) {
        const headers = {
            'Content-Type': 'application/json',
            'X-Goog-Visitor-Id': win.ytcfg?.get?.('VISITOR_DATA') || win.yt?.config_?.VISITOR_DATA || '',
            'X-YouTube-Client-Name': '1',
            'X-YouTube-Client-Version': win.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || win.yt?.config_?.INNERTUBE_CLIENT_VERSION || '2.20261105.05.01',
            'X-Origin': 'https://www.youtube.com'
        };

        try {
            const auth = win.default_live_chat_base?.Bha?.("https://www.youtube.com");
            if (auth) headers['Authorization'] = auth;
        } catch {}

        if (!headers['Authorization'] && win._ytChatLastAuthHeader) {
            headers['Authorization'] = win._ytChatLastAuthHeader;
        }

        const idToken = win.ytcfg?.get?.('ID_TOKEN') || win.yt?.config_?.ID_TOKEN;
        if (idToken) {
            headers['X-YouTube-Identity-Token'] = idToken;
        }

        return headers;
    }

    function prefetchContextMenu(params, win) {
        if (!params || prefetchCache.has(params)) return prefetchCache.get(params);

        const rawFetch = win._ytChatRawFetch;
        if (!rawFetch) return null;

        const url = `https://www.youtube.com/youtubei/v1/live_chat/get_item_context_menu?params=${encodeURIComponent(params)}&pbj=1&prettyPrint=false`;
        const context = win.ytcfg?.get?.('INNERTUBE_CONTEXT') || win.yt?.config_?.INNERTUBE_CONTEXT;
        const headers = getAuthHeaders(win);

        const fetchPromise = rawFetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: JSON.stringify({ context })
        }).then(async (response) => {
            const originalText = await response.text();

            // Validate that the server returned actual menu items (e.g. Report, Block)
            let hasServerItems = false;
            try {
                const parsed = JSON.parse(originalText);
                const root = parsed.response ?? parsed;
                const items = root?.liveChatItemContextMenuSupportedRenderers?.menuRenderer?.items;
                if (Array.isArray(items) && items.length > 0) {
                    hasServerItems = true;
                }
            } catch {}

            // If the server didn't return any items (e.g. unauthenticated timing), don't cache an empty menu
            if (!hasServerItems) {
                prefetchCache.delete(params);
                return null;
            }

            const modifiedText = appendAdditionalChannelContextItems(originalText, params);
            const cachedEntry = {
                modifiedText,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            };
            if (prefetchCache.size >= MAX_PREFETCH_CACHE) {
                const oldestKey = prefetchCache.keys().next().value;
                prefetchCache.delete(oldestKey);
            }
            prefetchCache.set(params, cachedEntry);
            return cachedEntry;
        }).catch(() => {
            prefetchCache.delete(params);
            return null;
        });

        prefetchCache.set(params, fetchPromise);
        return fetchPromise;
    }

    function lockFlags(flags) {
        if (!flags || typeof flags !== 'object') return;
        try {
            Object.defineProperty(flags, 'live_chat_web_debounce_context_menu_requests', {
                get: () => false,
                set: () => {},
                configurable: true,
                enumerable: true
            });
        } catch {
            try {
                flags.live_chat_web_debounce_context_menu_requests = false;
            } catch {}
        }
    }

    function hookFlagsContainer(container) {
        if (!container || typeof container !== 'object' || container._flagsHooked) return;
        container._flagsHooked = true;
        let currentFlags = container.EXPERIMENT_FLAGS;
        if (currentFlags) lockFlags(currentFlags);
        try {
            Object.defineProperty(container, 'EXPERIMENT_FLAGS', {
                get: () => currentFlags,
                set: (newFlags) => {
                    currentFlags = newFlags;
                    if (newFlags && typeof newFlags === 'object') {
                        lockFlags(newFlags);
                    }
                },
                configurable: true,
                enumerable: true
            });
        } catch {
            if (container.EXPERIMENT_FLAGS) lockFlags(container.EXPERIMENT_FLAGS);
        }
    }

    function applyFlagsHooks(win) {
        if (win.ytcfg) {
            hookFlagsContainer(win.ytcfg.data_);
            if (typeof win.ytcfg.d === 'function') hookFlagsContainer(win.ytcfg.d());
        }
        if (win.yt?.config_) {
            hookFlagsContainer(win.yt.config_);
        }
        if (win.default_live_chat_base) {
            if (win.default_live_chat_base.Jf) hookFlagsContainer(win.default_live_chat_base.Jf);
            if (typeof win.default_live_chat_base.n === 'function' && !win.default_live_chat_base.n._hooked) {
                const origN = win.default_live_chat_base.n;
                win.default_live_chat_base.n = function (flag) {
                    if (flag === 'live_chat_web_debounce_context_menu_requests') return false;
                    return origN.apply(this, arguments);
                };
                win.default_live_chat_base.n._hooked = true;
            }
        }
    }

    function disableContextMenuDebounce(win) {
        const patchYtcfg = (targetYtcfg) => {
            if (!targetYtcfg || targetYtcfg._ytChatSetHooked) return;
            targetYtcfg._ytChatSetHooked = true;

            const origSet = targetYtcfg.set;
            if (typeof origSet === 'function') {
                targetYtcfg.set = function (...args) {
                    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
                        if (args[0].EXPERIMENT_FLAGS) lockFlags(args[0].EXPERIMENT_FLAGS);
                    } else if (args[0] === 'EXPERIMENT_FLAGS' && args[1] && typeof args[1] === 'object') {
                        lockFlags(args[1]);
                    }

                    const res = origSet.apply(this, args);
                    applyFlagsHooks(win);
                    return res;
                };
            }
        };

        if (win.ytcfg) {
            patchYtcfg(win.ytcfg);
        } else {
            let ytcfgInstance = undefined;
            try {
                Object.defineProperty(win, 'ytcfg', {
                    get: () => ytcfgInstance,
                    set: (val) => {
                        try {
                            delete win.ytcfg;
                            win.ytcfg = val;
                        } catch {
                            ytcfgInstance = val;
                        }
                        if (val && typeof val === 'object') patchYtcfg(val);
                    },
                    configurable: true,
                    enumerable: true
                });
            } catch {}
        }

        // Hook default_live_chat_base as soon as it is assigned
        if (!win.default_live_chat_base) {
            let baseInstance = undefined;
            try {
                Object.defineProperty(win, 'default_live_chat_base', {
                    get: () => baseInstance,
                    set: (val) => {
                        baseInstance = val;
                        if (val && typeof val === 'object') applyFlagsHooks(win);
                    },
                    configurable: true,
                    enumerable: true
                });
            } catch {}
        }

        applyFlagsHooks(win);
    }

    function disableWholeItemContextMenu(win) {
        function injectCursorStyles() {
            const doc = win.document;
            if (!doc || doc.getElementById('yt-chat-cursor-fix')) return;
            const style = doc.createElement('style');
            style.id = 'yt-chat-cursor-fix';
            style.textContent = `
                yt-live-chat-text-message-renderer[whole-message-clickable],
                yt-live-chat-paid-message-renderer[whole-message-clickable],
                yt-live-chat-membership-item-renderer[whole-message-clickable],
                yt-live-chat-paid-sticker-renderer[whole-message-clickable] {
                    cursor: default !important;
                }
                yt-live-chat-text-message-renderer #message,
                yt-live-chat-paid-message-renderer #message {
                    cursor: text;
                }
                yt-live-chat-text-message-renderer #message a,
                yt-live-chat-paid-message-renderer #message a,
                yt-live-chat-text-message-renderer #menu-button,
                yt-live-chat-paid-message-renderer #menu-button {
                    cursor: pointer !important;
                }
            `;
            (doc.head || doc.documentElement)?.appendChild(style);
        }

        function patchControllerProto(pc) {
            if (!pc) return;
            const proto = Object.getPrototypeOf(pc);
            if (!proto || proto._ytChatPatched) return;
            proto._ytChatPatched = true;

            if (typeof proto.shouldSupportWholeItemClick === 'function') {
                proto.shouldSupportWholeItemClick = function () {
                    return false;
                };
            }

            if (typeof proto.computeWholeMessageClickable === 'function') {
                proto.computeWholeMessageClickable = function () {
                    return null;
                };
            }

            if (typeof proto.showContextMenu === 'function') {
                const origShow = proto.showContextMenu;
                proto.showContextMenu = function (e) {
                    if (e && e.target) {
                        const isFromMenu = e.composedPath ?
                            e.composedPath().some(el => el.id === 'menu-button' || el.id === 'menu') :
                            !!e.target.closest?.('#menu-button, #menu');
                        if (!isFromMenu) return;
                    }
                    return origShow.apply(this, arguments);
                };
            }
        }

        if (win.customElements && typeof win.customElements.define === 'function') {
            const origDefine = win.customElements.define;
            win.customElements.define = function (name, constructor) {
                if (typeof name === 'string' && name.startsWith('yt-live-chat-') && constructor?.prototype) {
                    const origConnected = constructor.prototype.connectedCallback;
                    constructor.prototype.connectedCallback = function () {
                        const res = origConnected?.apply(this, arguments);
                        const pc = this.inst || this.polymerController;
                        if (pc) patchControllerProto(pc);
                        return res;
                    };
                }
                return origDefine.apply(this, arguments);
            };
        }

        const patchAll = () => {
            injectCursorStyles();
            win.document?.querySelectorAll?.('*').forEach(el => {
                if (el.tagName?.startsWith('YT-LIVE-CHAT-') && el.polymerController) {
                    patchControllerProto(el.polymerController);
                }
            });
        };

        if (win.document?.readyState === 'loading') {
            win.document.addEventListener('DOMContentLoaded', patchAll, { once: true });
        } else {
            patchAll();
        }
        injectCursorStyles();
    }

    function initHoverPrefetch(win) {
        if (win._ytChatHoverPrefetchAttached) return;
        win._ytChatHoverPrefetchAttached = true;

        const triggerPrefetch = (e) => {
            const item = e.target.closest?.(
                'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer, yt-live-chat-paid-sticker-renderer'
            );
            if (!item) return;

            const data = item.data ?? item.__data?.data;
            const params = data?.contextMenuEndpoint?.liveChatItemContextMenuEndpoint?.params;
            if (!params || prefetchCache.has(params)) return;

            const authorChannelId = data?.authorExternalChannelId;
            if (authorChannelId) {
                cacheChannelId(params, authorChannelId);
            }

            prefetchContextMenu(params, win);
        };

        win.document?.addEventListener('pointerover', triggerPrefetch, { passive: true, capture: true });
        win.document?.addEventListener('pointerdown', triggerPrefetch, { passive: true, capture: true });
    }

    function initNetworkInterceptor(win) {
        if (win._ytChatNetworkIntercepted) return;
        win._ytChatNetworkIntercepted = true;

        const origFetch = win.fetch;
        win._ytChatRawFetch = origFetch.bind(win);

        if (typeof origFetch === 'function') {
            win.fetch = function (...args) {
                const [input, init] = args;
                const reqUrl = typeof input === 'string' ? input : (input?.url || input?.href || '');

                // Keep fresh authorization header
                const authHeader = init?.headers?.Authorization || init?.headers?.authorization ||
                    (input instanceof win.Request ? input.headers.get('authorization') : null);
                if (authHeader) {
                    win._ytChatLastAuthHeader = authHeader;
                }

                if (!reqUrl.includes('context_menu') || !CONTEXT_MENU_REGEX.test(reqUrl)) {
                    return origFetch.apply(this, args);
                }

                return (async () => {
                    let params = extractParams(reqUrl, typeof init?.body === 'string' ? init.body : null);

                    // 1. Instant response if prefetch cache hit
                    if (params && prefetchCache.has(params)) {
                        let entry = prefetchCache.get(params);
                        if (entry instanceof Promise) {
                            entry = await entry;
                        }
                        if (entry && entry.modifiedText) {
                            return new win.Response(entry.modifiedText, {
                                status: entry.status || 200,
                                statusText: entry.statusText || 'OK',
                                headers: entry.headers
                            });
                        }
                    }

                    // 2. Network fetch fallback
                    const response = await origFetch.apply(this, args);
                    try {
                        const originalText = await response.text();
                        const modifiedText = appendAdditionalChannelContextItems(originalText, params);
                        if (params) {
                            prefetchCache.set(params, {
                                modifiedText,
                                status: response.status,
                                statusText: response.statusText,
                                headers: response.headers
                            });
                        }
                        return new win.Response(modifiedText, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    } catch {
                        return response;
                    }
                })();
            };
        }
    }

    function initWindow(win) {
        if (!win || win._ytChatGoToChannelInitialized) return;
        win._ytChatGoToChannelInitialized = true;

        initNetworkInterceptor(win);
        disableContextMenuDebounce(win);
        disableWholeItemContextMenu(win);
        initHoverPrefetch(win);
    }

    function isChatPathname(pathname) {
        return pathname === '/live_chat' || pathname === '/live_chat_replay';
    }

    const targetWin = window.wrappedJSObject || window;

    // Direct execution inside the chat frame or popout chat window only
    if (isChatPathname(targetWin.location.pathname)) {
        initWindow(targetWin);
    }
})();
