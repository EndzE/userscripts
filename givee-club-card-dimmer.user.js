// ==UserScript==
// @name         Givee.Club - Card Dimmer
// @namespace    https://github.com/EndzE
// @version      1.3.0
// @description  Adds top-right icon on a game card to dim/undim it. Dimmed cards are saved in storage across reloads.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=givee.club
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        *://givee.club/*
// @match        *://*.givee.club/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @noframes
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/givee-club-card-dimmer.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/givee-club-card-dimmer.user.js
// ==/UserScript==

(() => {
    "use strict";

    const STORAGE_KEY = "dimmedEventCards";
    const MAX_STORED_ITEMS = 2000;
    const DIM_CLASS = "givee-card-dimmed";
    const BTN_CLASS = "givee-dim-btn";
    const CARD_SELECTOR = "a.event-card[href*='/event/']";

    const cards = document.querySelectorAll(CARD_SELECTOR);
    if (!cards.length) return;

    const style = document.createElement("style");
    style.textContent = `
        a.event-card {
            position: relative !important;
            transition: opacity 0.15s ease, filter 0.15s ease;
        }
        a.event-card.${DIM_CLASS} {
            opacity: 0.2 !important;
            filter: grayscale(100%);
        }
        a.event-card.${DIM_CLASS}:hover {
            opacity: 0.55 !important;
            filter: grayscale(50%);
        }
        .${BTN_CLASS} {
            position: absolute;
            top: 8px;
            right: 8px;
            z-index: 20;
            width: 30px;
            height: 30px;
            padding: 0;
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.7);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: background 0.15s ease, transform 0.1s ease, border-color 0.15s ease;
        }
        .${BTN_CLASS}:hover {
            background: rgba(0, 0, 0, 0.9);
            border-color: rgba(255, 255, 255, 0.5);
            transform: scale(1.08);
        }
        .${BTN_CLASS} svg {
            width: 16px;
            height: 16px;
            pointer-events: none;
        }
        .${BTN_CLASS} .icon-unhide,
        a.event-card.${DIM_CLASS} .${BTN_CLASS} .icon-hide {
            display: none;
        }
        a.event-card.${DIM_CLASS} .${BTN_CLASS} .icon-unhide {
            display: block;
        }
    `;
    document.head.append(style);

    const getDimmedSet = () => {
        const stored = GM_getValue(STORAGE_KEY, []);
        return new Set(Array.isArray(stored) ? stored : []);
    };

    const setCardState = (card, btn, isDimmed) => {
        card.classList.toggle(DIM_CLASS, isDimmed);
        const label = isDimmed ? "Unhide card" : "Hide card";
        btn.title = label;
        btn.setAttribute("aria-label", label);
        btn.setAttribute("aria-pressed", isDimmed);
    };

    // Parse the button HTML & SVGs only once, then clone it for each card
    const btnTemplate = document.createElement("button");
    btnTemplate.type = "button";
    btnTemplate.className = BTN_CLASS;
    btnTemplate.innerHTML = `
        <svg class="icon-hide" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
        </svg>
        <svg class="icon-unhide" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        </svg>`;

    const EVENT_REGEX = /\/event\/([^/?#]+)/;
    const dimmed = getDimmedSet();
    const cardMap = new Map(); // Maps event key -> { card, btn } for fast cross-tab sync

    for (const card of cards) {
        const match = card.getAttribute("href")?.match(EVENT_REGEX);
        if (!match) continue;

        const key = `event:${match[1]}`;
        const btn = btnTemplate.cloneNode(true);
        btn.dataset.key = key;

        setCardState(card, btn, dimmed.has(key));
        card.append(btn);
        cardMap.set(key, { card, btn });
    }

    // Use capture phase (true) to intercept the event before site listeners on the card fire
    document.addEventListener("click", (event) => {
        const btn = event.target.closest(`.${BTN_CLASS}`);
        if (!btn) return;

        event.preventDefault();
        event.stopPropagation();

        const card = btn.closest(CARD_SELECTOR);
        if (!card) return;

        const key = btn.dataset.key;
        const currentDimmed = getDimmedSet(); // Read fresh state to avoid multi-tab overwrite
        const nowDimmed = !currentDimmed.has(key);

        if (nowDimmed) currentDimmed.add(key);
        else currentDimmed.delete(key);

        setCardState(card, btn, nowDimmed);

        // Cap storage size so old events don't accumulate forever
        GM_setValue(STORAGE_KEY, [...currentDimmed].slice(-MAX_STORED_ITEMS));
    }, true);

    // Sync state across open tabs in real time
    if (typeof GM_addValueChangeListener === "function") {
        GM_addValueChangeListener(STORAGE_KEY, (_name, _oldVal, newVal, remote) => {
            if (!remote) return;
            const updatedSet = new Set(Array.isArray(newVal) ? newVal : []);
            for (const [key, { card, btn }] of cardMap) {
                setCardState(card, btn, updatedSet.has(key));
            }
        });
    }
})();
