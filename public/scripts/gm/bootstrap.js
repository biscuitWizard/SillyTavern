/**
 * GM shell bootstrap.
 *
 * Initializes the client-side router and routes to the Campaign Manager once
 * the DOM is ready. The router replaces children of `#gm-root` (which sits
 * inside `#sheld` ahead of ST's `#chat` + `#form_sheld`, per
 * docs/adr/0004-cannibalize-st-chat-substrate.md).
 */

import { route } from './router.js';

const GM_ROOT_ID = 'gm-root';

async function mountGmShell() {
    // ST clones parts of the DOM into hidden template/preview containers, so
    // `getElementById` can resolve a *duplicate* #gm-root that lives inside a
    // closed drawer. Prefer the visible one under `body > #sheld`. The router
    // applies the same selector when it re-resolves the mount.
    const root = document.querySelector('body > #sheld > #gm-root')
        || document.querySelector('#sheld > #gm-root')
        || document.getElementById(GM_ROOT_ID);
    if (!root) {
        console.error(`[gm] #${GM_ROOT_ID} not found in DOM; expected to replace #chat + #form_sheld inside #sheld.`);
        return;
    }

    await route({ view: 'manager' });
    console.info('[gm] Campaign Manager mounted.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { mountGmShell(); }, { once: true });
} else {
    mountGmShell();
}
