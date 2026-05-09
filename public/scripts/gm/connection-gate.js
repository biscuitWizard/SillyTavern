/**
 * Connection gate — watches SillyTavern's connection state and exposes
 * helpers the campaign views use to disable themselves while the GM is
 * not ready to dispatch a turn.
 *
 * The campaign-manager and campaign-main views import `mountConnectionGate`
 * to attach a "Configure a connection profile" banner above their content
 * and dim/disable the interactive parts. The gate auto-refreshes when the
 * underlying state changes, so the banner appears and disappears live as
 * the user toggles the API drawer.
 *
 * State sources:
 *   - `getCurrentConnectionProfile()` — connection-manager's selected profile
 *   - `currentLlmProfile()`           — the resolved live snapshot (provider/model)
 *   - `online_status`                 — set by ST's `setOnlineStatus(...)`
 *
 * Events we listen to:
 *   - `event_types.ONLINE_STATUS_CHANGED`     — fires after every connect/disconnect
 *   - `event_types.CONNECTION_PROFILE_LOADED` — fires when the user picks a profile
 *
 * @typedef {ReturnType<typeof import('./llm-profile.js').connectionStatus>} GmConnectionStatus
 */

import { eventSource, event_types } from '../../script.js';
import { connectionStatus, openStApiPanel } from './llm-profile.js';

/** @type {Set<(status: GmConnectionStatus) => void>} */
const subscribers = new Set();

let watcherInstalled = false;
/** @type {GmConnectionStatus | null} */
let lastStatus = null;

/**
 * Install the global watcher exactly once. Subsequent calls are no-ops —
 * the bootstrap may run before SillyTavern is fully ready, so it's safe
 * to re-call. Also flips `body.tt-disconnected` so global CSS rules can
 * react without each view having to.
 */
export function installConnectionGateWatcher() {
    if (watcherInstalled) return;
    watcherInstalled = true;

    const broadcast = () => {
        const status = connectionStatus();
        lastStatus = status;
        document.body.classList.toggle('tt-disconnected', !status.ok);
        for (const fn of subscribers) {
            try { fn(status); } catch (err) {
                console.error('[gm] connection-gate subscriber threw', err);
            }
        }
    };

    eventSource.on(event_types.ONLINE_STATUS_CHANGED, broadcast);
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, broadcast);
    broadcast();
}

/**
 * Subscribe to status changes. Returns an unsubscribe function. The first
 * call is dispatched synchronously with the last-known status (or a fresh
 * snapshot if none has been computed yet) so callers don't need a separate
 * "initial render" path.
 *
 * @param {(status: GmConnectionStatus) => void} fn
 */
export function subscribeConnectionStatus(fn) {
    subscribers.add(fn);
    try {
        fn(lastStatus || connectionStatus());
    } catch (err) {
        console.error('[gm] connection-gate initial subscriber threw', err);
    }
    return () => subscribers.delete(fn);
}

/**
 * Get the current status synchronously. Prefer `subscribeConnectionStatus`
 * when you also need to react to updates.
 */
export function getConnectionStatus() {
    return lastStatus || connectionStatus();
}

/**
 * Mount a "Connection required" banner directly before `target` and apply a
 * dim/disable effect to `target` while the gate is closed. The banner sits
 * *outside* the disabled target so its action button stays clickable.
 * Both auto-refresh on connection-state changes.
 *
 * Returns a teardown function that removes the banner, restores the target,
 * and stops listening. The view is responsible for calling teardown on
 * unmount — typically by stashing it in a closure scope keyed by the route.
 *
 * @param {{
 *   container: HTMLElement,    // unused except as a parent ownership signal
 *   target: HTMLElement,       // what to dim + block when not OK; banner is inserted before it
 * }} args
 * @returns {() => void}
 */
export function mountConnectionGate({ container: _container, target }) {
    const banner = buildBanner();
    const apply = (status) => {
        if (status.ok) {
            banner.remove();
            target.classList.remove('gm-gate-disabled');
            target.removeAttribute('aria-disabled');
            return;
        }
        renderBannerForStatus(banner, status);
        // Insert immediately before the disabled target. Even if the view
        // re-renders (replaceChildren on the parent), `target` keeps its
        // identity for the lifetime of this mount, so the insertion stays
        // anchored to the right slot.
        if (banner.parentNode !== target.parentNode || banner.nextSibling !== target) {
            target.parentNode?.insertBefore(banner, target);
        }
        target.classList.add('gm-gate-disabled');
        target.setAttribute('aria-disabled', 'true');
    };
    const unsub = subscribeConnectionStatus(apply);
    return () => {
        unsub();
        banner.remove();
        target.classList.remove('gm-gate-disabled');
        target.removeAttribute('aria-disabled');
    };
}

function buildBanner() {
    const banner = document.createElement('div');
    banner.className = 'gm-connection-banner';
    banner.setAttribute('role', 'alert');
    return banner;
}

/** @param {HTMLElement} banner @param {GmConnectionStatus} status */
function renderBannerForStatus(banner, status) {
    const { reason } = status;

    const icon = document.createElement('div');
    icon.className = 'gm-connection-banner-icon';
    icon.innerHTML = '<i class="fa-solid fa-plug-circle-exclamation"></i>';

    const body = document.createElement('div');
    body.className = 'gm-connection-banner-body';

    const title = document.createElement('div');
    title.className = 'gm-connection-banner-title';
    title.textContent = titleForReason(reason);
    const msg = document.createElement('div');
    msg.className = 'gm-connection-banner-message';
    msg.textContent = messageForReason(reason);
    body.append(title, msg);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'gm-primary-btn';
    action.innerHTML = '<i class="fa-solid fa-plug"></i> Open API settings';
    action.addEventListener('click', () => openStApiPanel());

    banner.replaceChildren(icon, body, action);
}

/** @param {GmConnectionStatus['reason']} reason */
function titleForReason(reason) {
    switch (reason) {
        case 'no-profile': return 'Pick a connection profile';
        case 'no-model':   return 'Connection profile is missing a model';
        case 'offline':    return 'Connection is not active';
        default:           return 'Connection required';
    }
}

/** @param {GmConnectionStatus['reason']} reason */
function messageForReason(reason) {
    switch (reason) {
        case 'no-profile':
            return 'Open the API settings drawer, choose or create a Connection Profile, and verify it connects before starting a campaign.';
        case 'no-model':
            return 'The selected profile has no model. Open the API settings drawer and either set a model on the profile or fill in a per-role override.';
        case 'offline':
            return 'You have a profile selected, but SillyTavern reports it as not connected. Open the API settings drawer and click Connect to verify it works before continuing.';
        default:
            return 'Configure and verify your connection profile before continuing.';
    }
}
