/**
 * GM shell bootstrap.
 *
 * Initializes the client-side router and routes to the Campaign Manager once
 * the DOM is ready. The router replaces children of `#gm-root` (which sits
 * inside `#sheld` ahead of ST's `#chat` + `#form_sheld`, per
 * docs/adr/0004-cannibalize-st-chat-substrate.md).
 */

import { eventSource, event_types } from '../../script.js';
import { route } from './router.js';
import { installGmRoleModelsUi } from './gm-profile-roles.js';
import { installConnectionGateWatcher } from './connection-gate.js';

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

/**
 * Install the per-role model overrides UI inside the API Connections
 * drawer once the connection-manager extension has rendered its block.
 * The connection-manager renders during ST's `app_ready` event, so we
 * also run on the first profile-loaded event as a belt-and-suspenders.
 */
function setupGmRoleModelsUi() {
    const tryInstall = () => installGmRoleModelsUi();
    if (eventSource && event_types?.APP_READY) {
        eventSource.on(event_types.APP_READY, tryInstall);
    }
    if (eventSource && event_types?.CONNECTION_PROFILE_LOADED) {
        eventSource.on(event_types.CONNECTION_PROFILE_LOADED, tryInstall);
    }
    tryInstall();
}

function bootGmShell() {
    mountGmShell();
    setupGmRoleModelsUi();
    installConnectionGateWatcher();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootGmShell, { once: true });
} else {
    bootGmShell();
}
