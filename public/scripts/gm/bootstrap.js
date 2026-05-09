/**
 * GM shell bootstrap.
 *
 * Renders the Campaign Manager into the static `#gm-root` element that
 * replaces SillyTavern's `#chat` + `#form_sheld` inside `#sheld`. See
 * docs/adr/0004-cannibalize-st-chat-substrate.md.
 *
 * Later phases route between the Campaign Manager, Campaign Main, and
 * Scene views from this module.
 */

import { renderCampaignManager } from './campaign-manager.js';

const GM_ROOT_ID = 'gm-root';

function mountGmShell() {
    const root = document.getElementById(GM_ROOT_ID);
    if (!root) {
        console.error(`[gm] #${GM_ROOT_ID} not found in DOM; expected to replace #chat + #form_sheld inside #sheld.`);
        return;
    }

    renderCampaignManager(root);
    console.info('[gm] Campaign Manager mounted.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountGmShell, { once: true });
} else {
    mountGmShell();
}
