/**
 * GM per-role model + URL overrides on top of SillyTavern connection profiles.
 *
 * The TTRPG Tavern GM core dispatches LLM calls for several distinct roles
 * (Director — structured JSON; Narrator — long-form prose; Actor — NPC
 * dialogue, reserved). Many users will want to bias each role differently:
 * a small/strict model for the Director (function-call reliability), a
 * larger/creative model for the Narrator, etc.
 *
 * Rather than ship a parallel settings popup, we extend SillyTavern's own
 * Connection Profiles (the connection-manager extension). Each profile is
 * a JSON bag in `extension_settings.connectionManager.profiles`; we add
 * optional keys per profile:
 *
 *   - `gm-director-model`  / `gm-director-url`
 *   - `gm-narrator-model`  / `gm-narrator-url`
 *   - `gm-actor-model`     / `gm-actor-url`
 *   - `gm-summarizer-model` / `gm-summarizer-url`
 *
 * Model overrides swap the model name; URL overrides swap the server URL
 * entirely — enabling setups where the Director and Narrator run on
 * separate llama.cpp instances (different ports / hosts / models loaded).
 *
 * If a role override is empty, we fall back to the profile's main `model`
 * or server URL (which connection-manager already populates from ST's live
 * API state on profile create / update).
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
        label: 'Director',
        modelHint: 'Structured-output role. Picks the next beat. Empty = profile default.',
        urlHint: 'Server URL for this role. Empty = profile default. Use when the Director runs on a separate llama.cpp instance.',
    },
    {
        key: 'narrator',
        label: 'Narrator',
        modelHint: 'World narration prose. Empty = profile default.',
        urlHint: 'Server URL for this role. Empty = profile default.',
    },
    {
        key: 'actor',
        label: 'Actor',
        modelHint: 'NPC dialogue (reserved, Phase 5+). Empty = profile default.',
        urlHint: 'Server URL for this role. Empty = profile default.',
    },
    {
        key: 'summarizer',
        label: 'Summarizer',
        modelHint: 'Collapses long agent-loop history into a recap when the Director\'s context fills up. A small, cheap model is fine. Empty = profile default.',
        urlHint: 'Server URL for this role. Empty = profile default.',
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
    desc.textContent = 'Per-role model and URL overrides for the selected connection profile. Leave empty to use the profile\'s defaults.';
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

    const header = document.createElement('label');
    header.innerHTML = `<strong>${role.label}</strong>`;
    row.append(header);

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.className = 'text_pole';
    modelInput.id = `gm-role-${role.key}`;
    modelInput.name = `gm-${role.key}-model`;
    modelInput.placeholder = '(use profile default)';
    modelInput.autocomplete = 'off';
    modelInput.spellcheck = false;
    modelInput.addEventListener('change', () => onRoleFieldChanged(role.key, 'model', modelInput.value));
    modelInput.addEventListener('blur', () => onRoleFieldChanged(role.key, 'model', modelInput.value));
    row.append(modelInput);

    const modelHint = document.createElement('small');
    modelHint.className = 'opacity50p';
    modelHint.textContent = role.modelHint;
    row.append(modelHint);

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'text_pole marginTop5';
    urlInput.id = `gm-role-${role.key}-url`;
    urlInput.name = `gm-${role.key}-url`;
    urlInput.placeholder = '(use profile default)';
    urlInput.autocomplete = 'off';
    urlInput.spellcheck = false;
    urlInput.addEventListener('change', () => onRoleFieldChanged(role.key, 'url', urlInput.value));
    urlInput.addEventListener('blur', () => onRoleFieldChanged(role.key, 'url', urlInput.value));
    row.append(urlInput);

    const urlHint = document.createElement('small');
    urlHint.className = 'opacity50p';
    urlHint.textContent = role.urlHint;
    row.append(urlHint);

    return row;
}

/**
 * @param {string} roleKey
 * @param {'model' | 'url'} field
 * @param {string} rawValue
 */
function onRoleFieldChanged(roleKey, field, rawValue) {
    const profile = getSelectedProfile();
    if (!profile) return;
    const value = String(rawValue || '').trim();
    const fieldKey = `gm-${roleKey}-${field}`;
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
        const modelInput = document.getElementById(`gm-role-${role.key}`);
        if (modelInput) {
            modelInput.value = String(profile[`gm-${role.key}-model`] || '');
            const fallbackModel = String(profile['model'] || '');
            modelInput.placeholder = fallbackModel ? `(use profile default: ${fallbackModel})` : '(use profile default)';
        }

        /** @type {HTMLInputElement | null} */
        const urlInput = document.getElementById(`gm-role-${role.key}-url`);
        if (urlInput) {
            urlInput.value = String(profile[`gm-${role.key}-url`] || '');
            const fallbackUrl = String(profile['server_url'] || profile['custom_url'] || profile['api-url-text'] || '');
            urlInput.placeholder = fallbackUrl ? `(${fallbackUrl})` : '(use profile default)';
        }
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
 * @param {'director' | 'narrator' | 'actor' | 'summarizer'} roleKey
 */
export function getRoleModelOverride(roleKey) {
    const profile = getSelectedProfile();
    if (!profile) return '';
    return String(profile[`gm-${roleKey}-model`] || '');
}

/**
 * Returns the role-specific URL override for the selected profile, or
 * `''` if none is set. Used by `currentLlmProfile()` to point individual
 * roles at separate llama.cpp / Ollama instances.
 *
 * @param {'director' | 'narrator' | 'actor' | 'summarizer'} roleKey
 */
export function getRoleUrlOverride(roleKey) {
    const profile = getSelectedProfile();
    if (!profile) return '';
    return String(profile[`gm-${roleKey}-url`] || '');
}

/**
 * Returns the currently selected connection profile (or null if none).
 * Used by pre-flight checks in the scene view.
 */
export function getCurrentConnectionProfile() {
    return getSelectedProfile();
}
