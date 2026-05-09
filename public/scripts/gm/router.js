/**
 * Minimal client-side router for the GM shell.
 *
 * The shell has three views: `manager`, `campaign`, `scene`. They mount into
 * `#gm-root` (the campaign + manager surfaces) or take over `#chat` /
 * `#form_sheld` via `body.tt-mode-scene` (the scene surface). This module
 * keeps the active view in memory and delegates rendering.
 *
 * No framework. The route is the single source of truth for which view is
 * mounted at any moment; navigation goes through `route()`, never direct DOM
 * mutation from a click handler.
 */

import { renderCampaignManager } from './campaign-manager.js';
import { renderCampaignMain } from './campaign-main.js';
import { renderScene } from './scene.js';

const GM_ROOT_ID = 'gm-root';

/**
 * @typedef {Object} RouteState
 * @property {'manager' | 'campaign' | 'scene'} view
 * @property {string} [campaignId]
 * @property {string} [sceneId]
 * @property {boolean} [readOnly]
 */

/** @type {RouteState | null} */
let current = null;

function rootEl() {
    // ST's startup duplicates parts of the DOM into hidden template/preview
    // containers (jQuery UI tabs, drawers, etc.), which means the document
    // can end up with multiple elements that share `id="gm-root"`. The one
    // we actually want is the visible #gm-root: the immediate child of the
    // top-level `body > #sheld`. Fall back to getElementById otherwise so
    // tests that mount #gm-root somewhere unusual still work.
    const visible = document.querySelector('body > #sheld > #gm-root')
        || document.querySelector('#sheld > #gm-root')
        || document.getElementById(GM_ROOT_ID);
    if (!visible) throw new Error(`#${GM_ROOT_ID} missing from DOM`);
    return /** @type {HTMLElement} */(visible);
}

/**
 * Navigate to a view. Always replaces the previous render.
 *
 * @param {RouteState} next
 */
export async function route(next) {
    current = next;
    const root = rootEl();
    root.replaceChildren(loadingNode());

    try {
        if (next.view === 'manager') {
            document.body.classList.remove('tt-mode-scene');
            await renderCampaignManager(root);
            return;
        }
        if (next.view === 'campaign') {
            document.body.classList.remove('tt-mode-scene');
            if (!next.campaignId) throw new Error('campaign view requires campaignId');
            await renderCampaignMain(root, { campaignId: next.campaignId });
            return;
        }
        if (next.view === 'scene') {
            if (!next.campaignId || !next.sceneId) {
                throw new Error('scene view requires campaignId + sceneId');
            }
            await renderScene(root, {
                campaignId: next.campaignId,
                sceneId: next.sceneId,
                readOnly: !!next.readOnly,
            });
            return;
        }
        throw new Error(`unknown route view: ${(next).view}`);
    } catch (err) {
        console.error('[gm] route render failed', err);
        root.replaceChildren(errorNode(err));
    }
}

/** @returns {RouteState | null} */
export function getCurrentRoute() {
    return current;
}

function loadingNode() {
    const node = document.createElement('div');
    node.className = 'gm-loading';
    node.textContent = 'Loading…';
    return node;
}

/** @param {unknown} err */
function errorNode(err) {
    const node = document.createElement('div');
    node.className = 'gm-error-banner';
    const msg = (err && /** @type {Error} */(err).message) || String(err);
    node.textContent = `Failed to render: ${msg}`;
    return node;
}
