// ==UserScript==
// @name         AIStudio - Stop Exposing Email
// @namespace    https://github.com/EndzE
// @version      1.2.3
// @description  Hides the email before first paint and strips it from the aria-label and hover tooltip.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=aistudio.google.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://aistudio.google.com/*
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/aistudio-stop-exposing-email.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/aistudio-stop-exposing-email.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 1. Instantly hide the text before the browser paints the first frame
    const hideStyle = document.createElement('style');
    hideStyle.textContent = `
        .account-switcher-button .account-switcher-text {
            visibility: hidden !important;
        }
    `;
    (document.head || document.documentElement).appendChild(hideStyle);

    // 2. Wait for the account name to appear
    const observer = new MutationObserver((mutations, obs) => {
        const avatarImg = document.querySelector('.account-switcher-button img.avatar');
        const textSpan = document.querySelector('.account-switcher-button .account-switcher-text');

        if (avatarImg && avatarImg.alt && avatarImg.alt.trim().length > 0 && textSpan) {
            // Replace the email with the account name
            const email = textSpan.textContent.trim();
            textSpan.textContent = ` ${avatarImg.alt.trim()} `;

            // Strip the email from the button's aria-label (feeds the a11y name)
            const accountBtn = textSpan.closest('button');
            const label = accountBtn?.getAttribute('aria-label');
            if (accountBtn && label?.includes(email)) {
                accountBtn.setAttribute('aria-label', label.replace(`(${email})`, '').trim());
            }

            // 3. The Material tooltip takes its text from app state and renders it after insertion,
            // so shield every tooltip surface until its text has been scrubbed, then reveal it.
            const tooltipGuard = document.createElement('style');
            tooltipGuard.textContent = `.mat-mdc-tooltip-surface { visibility: hidden !important; }`;
            (document.head || document.documentElement).appendChild(tooltipGuard);

            new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    const host =
                        mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
                    const surface = host?.closest?.('.mat-mdc-tooltip-surface');
                    if (!surface) continue;
                    if (surface.textContent.includes(email)) {
                        surface.textContent = surface.textContent.replace(`(${email})`, '').trim();
                    }
                    surface.style.setProperty('visibility', 'visible', 'important');
                }
            }).observe(document.documentElement, {
                childList: true,
                characterData: true,
                subtree: true,
            });

            // Unhide the text (revealing only the replaced name)
            hideStyle.remove();

            // Disconnect and clean up
            obs.disconnect();
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
})();
