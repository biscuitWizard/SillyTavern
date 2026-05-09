/**
 * GM per-role model overrides on top of SillyTavern connection profiles.
 *
 * The TTRPG Tavern GM core dispatches LLM calls for several distinct roles
 * (Director — structured JSON; Narrator — long-form prose; Actor — NPC
 * dialogue, reserved). Many users will want to bias each role differently:
 * a small/strict model for the Director (function-call reliability), a
 * larger/creative model for the Narrator, etc.
 *
 * Rather than ship a parallel settings popup, we extend SillyTavern's own
 * Connection Profiles (the connection-manager extension). Each profile is
 * a JSON bag in `extension_settings.connectionManager.profiles`; we simply
 * add three optional keys per profile:
 *
 *   - `gm-director-model`
 *   - `gm-narrator-model`
 *   - `gm-actor-model`   (reserved for Phase 5+)
 *
 * If a role override is empty, we fall back to the profile's main `model`
 * field (which connection-manager already populates from ST's live API
 * state on profile create / update).
 *
 * The UI is injected into ST's API drawer (`#rm_api_block`), directly
 * below the connection-manager's connection-profile selector. The inputs
 * always reflect the *currently selected* profile and write back to it on
 * change. We persist via `saveSettingsDebounced`, same channel ST uses.
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../script.js';
import { extension_settings } from '../extensions.js';

const PANEL_ID = 'gm-role-models-panel';

const ROLES = /** @type {const} */ ([
    {
        key: 'director',
        label: 'Director model',
        hint: 'Structured-output role. Picks the next beat. Empty = profile default.',
    },
    {
        key: 'narrator',
        label: 'Narrator model',
        hint: 'World narration prose. Empty = profile default.',
    },
    {
        key: 'actor',
        label: 'Actor model',
        hint: 'NPC dialogue (reserved, Phase 5+). Empty = profile default.',
    },
]);

/**
 * Bootstraps the GM role-model UI. Idempotent — safe to call multiple times;
 * we install the panel exactly once and refresh it on profile changes.
 */
export function installGmRoleModelsUi() {
    if (document.getElementById(PANEL_ID)) {
        refreshInputs();
        return;
    }

    const apiBlock = document.getElementById('rm_api_block');
    if (!apiBlock) {
        // Connection-manager's UI hasn't been injected yet. Try again on
        // app_ready — by then `#rm_api_block` and the connection-profile
        // dropdown both exist.
        return;
    }

    const panel = buildPanel();

    // Place the panel directly after connection-manager's profile block.
    // The connection-manager extension renders its template at
    // `#rm_api_block > :first-child` (insertAdjacentHTML('afterbegin')); we
    // place ourselves immediately after it so the role-model inputs sit
    // right below the profile selector.
    const cmBlock = apiBlock.querySelector('#connection_profiles')?.closest('.wide100p');
    if (cmBlock && cmBlock.parentElement === apiBlock) {
        cmBlock.insertAdjacentElement('afterend', panel);
    } else {
        apiBlock.insertAdjacentElement('afterbegin', panel);
    }

    refreshInputs();

    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, () => refreshInputs());
}

function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'wide100p';

    const header = document.createElement('div');
    header.className = 'flex-container alignItemsBaseline';
    const title = document.createElement('h3');
    title.className = 'margin0';
    title.textContent = 'TTRPG Tavern role models';
    header.append(title);
    panel.append(header);

    const desc = document.createElement('small');
    desc.className = 'opacity50p';
    desc.textContent = 'Per-role model overrides for the selected connection profile. Leave empty to use the profile\'s default model.';
    panel.append(desc);

    const empty = document.createElement('div');
    empty.id = `${PANEL_ID}-empty`;
    empty.className = 'marginTop10 marginBot10';
    empty.style.display = 'none';
    empty.innerHTML = '<small><i class="fa-solid fa-circle-info"></i> Select a connection profile above to set role overrides.</small>';
    panel.append(empty);

    const grid = document.createElement('div');
    grid.id = `${PANEL_ID}-grid`;
    grid.className = 'flex-container flexFlowColumn flexNoGap marginTop5';
    panel.append(grid);

    for (const role of ROLES) {
        grid.append(buildRoleRow(role));
    }

    return panel;
}

function buildRoleRow(role) {
    const row = document.createElement('div');
    row.className = 'flex-container flexFlowColumn flexNoGap marginBot5';

    const label = document.createElement('label');
    label.htmlFor = `gm-role-${role.key}`;
    label.innerHTML = `<strong>${role.label}</strong>`;
    row.append(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text_pole';
    input.id = `gm-role-${role.key}`;
    input.name = `gm-${role.key}-model`;
    input.placeholder = '(use profile default)';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('change', () => onRoleInputChanged(role.key, input.value));
    input.addEventListener('blur', () => onRoleInputChanged(role.key, input.value));
    row.append(input);

    const hint = document.createElement('small');
    hint.className = 'opacity50p';
    hint.textContent = role.hint;
    row.append(hint);

    return row;
}

function onRoleInputChanged(roleKey, rawValue) {
    const profile = getSelectedProfile();
    if (!profile) return;
    const value = String(rawValue || '').trim();
    const fieldKey = `gm-${roleKey}-model`;
    if (!value) {
        delete profile[fieldKey];
    } else {
        profile[fieldKey] = value;
    }
    saveSettingsDebounced();
}

function refreshInputs() {
    const empty = document.getElementById(`${PANEL_ID}-empty`);
    const grid = document.getElementById(`${PANEL_ID}-grid`);
    const profile = getSelectedProfile();
    if (!profile) {
        if (empty) empty.style.display = '';
        if (grid) grid.style.display = 'none';
        return;
    }
    if (empty) empty.style.display = 'none';
    if (grid) grid.style.display = '';
    for (const role of ROLES) {
        /** @type {HTMLInputElement | null} */
        const input = document.getElementById(`gm-role-${role.key}`);
        if (!input) continue;
        const fieldKey = `gm-${role.key}-model`;
        input.value = String(profile[fieldKey] || '');
        const fallback = String(profile['model'] || '');
        input.placeholder = fallback ? `(use profile default: ${fallback})` : '(use profile default)';
    }
}

function getSelectedProfile() {
    const cm = extension_settings?.connectionManager;
    const id = cm?.selectedProfile;
    if (!id) return null;
    return (cm?.profiles || []).find(p => p && p.id === id) || null;
}

/**
 * Returns the role-specific model override for the selected profile, or
 * `''` if none is set. Used by `currentLlmProfile()`.
 *
 * @param {'director' | 'narrator' | 'actor'} roleKey
 */
export function getRoleModelOverride(roleKey) {
    const profile = getSelectedProfile();
    if (!profile) return '';
    return String(profile[`gm-${roleKey}-model`] || '');
}

/**
 * Returns the currently selected connection profile (or null if none).
 * Used by pre-flight checks in the scene view.
 */
export function getCurrentConnectionProfile() {
    return getSelectedProfile();
}
