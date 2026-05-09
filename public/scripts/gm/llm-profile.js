/**
 * LLM profile snapshot.
 *
 * The GM core sends a snapshot of SillyTavern's currently-selected LLM
 * profile to `/api/gm/turn` so the backend client (`src/gm-core/llm/client.js`)
 * can dispatch directly to the upstream provider without round-tripping
 * through SillyTavern's `/api/backends/...` surface.
 *
 * TTRPG Tavern intentionally uses ST's *one* active connection for both the
 * Director and the Actor (Narrator + characters). Splitting roles across
 * profiles is a power-user concern and would be best surfaced inside ST's
 * Connection Manager extension if/when we need it — the GM shell does not
 * own a parallel settings UI.
 */

import { main_api, online_status } from '../../script.js';
import { oai_settings } from '../openai.js';
import { textgenerationwebui_settings, textgen_types } from '../textgen-settings.js';
import { getRoleModelOverride, getCurrentConnectionProfile } from './gm-profile-roles.js';

/** Textgen types we know how to dispatch to from the GM core. */
const TEXTGEN_LOCAL_SOURCES = new Set([
    textgen_types.OLLAMA,
    textgen_types.LLAMACPP,
    textgen_types.KOBOLDCPP,
]);

/**
 * @typedef {'director' | 'narrator' | 'actor'} GmRole
 */

/**
 * Snapshot the LLM profile for a given GM role.
 *
 * A SillyTavern Connection Profile is the source of truth: the profile sets
 * the API/provider/URL/secret, and optionally a per-role model override
 * (`gm-{role}-model`). If no override is set, the profile's main `model`
 * is used.
 *
 * The provider/URL/etc. are read from the live ST settings (`oai_settings`
 * or `textgenerationwebui_settings`) — connection-manager keeps those in
 * sync with the selected profile via `applyConnectionProfile`. We require
 * a selected profile and return `null` otherwise; the scene view treats
 * `null` as a hard pre-flight failure and routes the user to the API
 * settings drawer.
 *
 * @param {GmRole} [role]
 * @returns {object | null}
 */
export function currentLlmProfile(role) {
    const profile = getCurrentConnectionProfile();
    if (!profile) return null;

    const live = main_api === 'textgenerationwebui'
        ? snapshotTextgenSettings()
        : snapshotOpenAISettings();
    if (!live.source) return null;

    if (role) {
        const override = getRoleModelOverride(role);
        if (override) live.model = override;
    }
    return live;
}

/**
 * Returns true iff the user has a selected connection profile and the
 * resulting snapshot has enough fields to actually dispatch a turn.
 */
export function hasUsableLlmProfile() {
    const snap = currentLlmProfile();
    if (!snap) return false;
    if (!snap.source) return false;
    if (!snap.model) return false;
    return true;
}

/**
 * Composite "is the GM ready to dispatch a turn?" check used by the campaign
 * manager and campaign main views to gate interactive components.
 *
 * Three conditions must all hold:
 *  - A connection profile is selected (so per-role overrides have a home).
 *  - The selected profile resolves to a usable provider/model snapshot.
 *  - SillyTavern's `online_status` is something other than `'no_connection'`.
 *
 * The third one is what `RA_checkOnlineStatus` keys off. We treat it as a
 * proxy for "the API call would succeed" — even though the GM core dispatches
 * direct-to-provider, requiring ST's connection to be live ensures the user
 * has actually tested their credentials before a campaign is playable.
 *
 * @returns {{
 *   hasProfile: boolean,
 *   hasModel: boolean,
 *   online: boolean,
 *   ok: boolean,
 *   reason: 'no-profile' | 'no-model' | 'offline' | null,
 * }}
 */
export function connectionStatus() {
    const profile = getCurrentConnectionProfile();
    const hasProfile = !!profile;
    const snap = hasProfile ? currentLlmProfile() : null;
    const hasModel = !!(snap && snap.source && snap.model);
    const online = !!(online_status && online_status !== 'no_connection');
    const ok = hasProfile && hasModel && online;
    /** @type {'no-profile' | 'no-model' | 'offline' | null} */
    let reason = null;
    if (!hasProfile) reason = 'no-profile';
    else if (!hasModel) reason = 'no-model';
    else if (!online) reason = 'offline';
    return { hasProfile, hasModel, online, ok, reason };
}

function snapshotOpenAISettings() {
    const s = oai_settings || {};
    const source = s.chat_completion_source;
    const modelByCarrier = {
        openai: s.openai_model,
        claude: s.claude_model,
        openrouter: s.openrouter_model,
        custom: s.custom_model,
        groq: s.groq_model,
        deepseek: s.deepseek_model,
        xai: s.xai_model,
        nanogpt: s.nanogpt_model,
        electronhub: s.electronhub_model,
        chutes: s.chutes_model,
        moonshot: s.moonshot_model,
        fireworks: s.fireworks_model,
        cohere: s.cohere_model,
        mistralai: s.mistralai_model,
        perplexity: s.perplexity_model,
        ai21: s.ai21_model,
        makersuite: s.google_model,
        vertexai: s.vertexai_model,
        azure_openai: s.azure_openai_model,
        cometapi: s.cometapi_model,
        zai: s.zai_model,
        siliconflow: s.siliconflow_model,
        minimax: s.minimax_model,
        workers_ai: s.workers_ai_model,
        pollinations: s.pollinations_model,
        aimlapi: s.aimlapi_model,
    };
    return {
        source: source || '',
        model: modelByCarrier[source] || s.openai_model || '',
        reverse_proxy: s.reverse_proxy || '',
        proxy_password: s.proxy_password || '',
        custom_url: s.custom_url || '',
        temperature: typeof s.temp_openai === 'number' ? s.temp_openai : 0.7,
        max_tokens: typeof s.openai_max_tokens === 'number' ? s.openai_max_tokens : 1024,
        secret_id: undefined,
    };
}

function snapshotTextgenSettings() {
    const t = textgenerationwebui_settings || {};
    const type = t.type || '';
    if (!TEXTGEN_LOCAL_SOURCES.has(type)) {
        return { source: '', model: '', custom_url: '', temperature: 0.7, max_tokens: 1024 };
    }
    const modelByType = {
        [textgen_types.OLLAMA]: t.ollama_model,
        [textgen_types.LLAMACPP]: t.llamacpp_model,
        [textgen_types.KOBOLDCPP]: '',
    };
    const url = (t.server_urls && t.server_urls[type]) || '';
    return {
        source: type,
        model: modelByType[type] || '',
        custom_url: url,
        reverse_proxy: '',
        proxy_password: '',
        temperature: typeof t.temp === 'number' ? t.temp : 0.7,
        max_tokens: typeof t.max_new_tokens === 'number' ? t.max_new_tokens : 1024,
        secret_id: undefined,
    };
}

/**
 * SillyTavern's connection-manager applies a profile by running its
 * slash commands, the first of which is `/api …`. Switching `main_api`
 * (even to the same value) calls `setOnlineStatus('no_connection')` in
 * ST's bootstrap, so right after a profile load ST always reports
 * "Not connected to API!" until the user clicks Connect again.
 *
 * The GM core dispatches direct-to-provider so it doesn't need ST's
 * status to be 'connected' to function — but ST's UI (`#send_but`,
 * placeholder text) keys off `online_status`, so the player sees a
 * locked input until ST is reconnected. This helper clicks the
 * appropriate Connect button when a profile is selected but ST is
 * disconnected, and resolves once `online_status` flips (or after
 * `timeoutMs`).
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>} true if connected, false on timeout/no-profile
 */
export async function ensureStConnected({ timeoutMs = 10000 } = {}) {
    if (online_status && online_status !== 'no_connection') return true;

    const profile = getCurrentConnectionProfile();
    if (!profile) return false;

    const buttonId = CONNECT_BUTTON_ID[main_api];
    if (!buttonId) return false;
    const button = document.getElementById(buttonId);
    if (!(button instanceof HTMLElement)) return false;

    button.click();

    // Wait until ST's `online_status` flips off 'no_connection' or we time
    // out. We rely on the live ESM binding from `script.js`, which updates
    // in-place when ST's internal `setOnlineStatus(...)` runs.
    const start = Date.now();
    return await new Promise((resolve) => {
        const tick = () => {
            if (online_status && online_status !== 'no_connection') {
                resolve(true);
                return;
            }
            if (Date.now() - start > timeoutMs) {
                resolve(false);
                return;
            }
            setTimeout(tick, 200);
        };
        tick();
    });
}

const CONNECT_BUTTON_ID = {
    kobold: 'api_button',
    novel: 'api_button_novel',
    textgenerationwebui: 'api_button_textgenerationwebui',
    openai: 'api_button_openai',
};

/**
 * Open SillyTavern's "API Connections" drawer in the top icon bar. This is
 * where the user picks `main_api`, configures the backend URL, and selects
 * a connection profile via the connection-manager extension.
 *
 * Used by the GM shell's topbar plug icon — instead of shipping a parallel
 * settings popup, we route the player into ST's existing settings UI.
 * Both the campaign view and scene view live inside `#sheld`, so ST's
 * `#top-settings-holder` and the drawer it hosts are visible without any
 * additional show/hide gymnastics.
 */
export function openStApiPanel() {
    const drawer = document.querySelector('#sys-settings-button');
    const toggle = drawer?.querySelector(':scope > .drawer-toggle');
    if (toggle instanceof HTMLElement) {
        toggle.click();
        return;
    }
    const fallback = document.getElementById('API-status-top');
    if (fallback instanceof HTMLElement) fallback.click();
}
