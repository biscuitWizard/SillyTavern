/**
 * Settings popup — minimal model/connection panel surfaced from the gear
 * icon in the Campaign Main and Scene topbars.
 *
 * Phase 1 ships an info panel that shows the current ST main_api / source /
 * model and a button that opens ST's left-nav drawer (where the user picks
 * connection profiles in the normal way).
 *
 * Phase 4 adds:
 *   - A select that lets the player choose which ST connection profile is
 *     used for the GM Director and Actor calls (defaulting to "current ST
 *     selection"). The choice is stored in `localStorage`.
 *   - `currentLlmProfile(role)`, the snapshot the Scene view ships to
 *     `/api/gm/turn` so the backend can reach an upstream provider.
 *
 * The popup is intentionally self-contained: no jQuery, no popup framework
 * dependency, so the GM shell does not load before ST is fully initialized.
 */

import { main_api } from '../../script.js';
import { oai_settings } from '../openai.js';
import { extension_settings } from '../extensions.js';
import { textgenerationwebui_settings, textgen_types } from '../textgen-settings.js';

/** Textgen types we know how to dispatch to from the GM core. */
const TEXTGEN_LOCAL_SOURCES = new Set([
    textgen_types.OLLAMA,
    textgen_types.LLAMACPP,
    textgen_types.KOBOLDCPP,
]);

const LS_DIRECTOR = 'gm.director_profile_id';
const LS_ACTOR = 'gm.actor_profile_id';
const STORE_DEFAULT = 'current';

let activeOverlay = null;

/**
 * Open the settings popup as a modal overlay. Closes any existing instance.
 */
export function openSettingsPopup() {
    closeSettingsPopup();
    const overlay = el('div', 'gm-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSettingsPopup();
    });

    const panel = el('div', 'gm-modal');
    panel.append(
        renderHeader(),
        renderBody(),
        renderFooter(),
    );

    overlay.append(panel);
    document.body.append(overlay);
    activeOverlay = overlay;

    document.addEventListener('keydown', onEsc);
}

export function closeSettingsPopup() {
    if (activeOverlay && activeOverlay.parentNode) {
        activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
    document.removeEventListener('keydown', onEsc);
}

function onEsc(e) {
    if (e.key === 'Escape') closeSettingsPopup();
}

function renderHeader() {
    const head = el('div', 'gm-modal-header');
    head.append(elText('h2', 'gm-modal-title', 'GM Settings'));
    const close = el('button', 'gm-icon-btn');
    close.type = 'button';
    close.title = 'Close';
    close.innerHTML = '<i class="fa-solid fa-times"></i>';
    close.addEventListener('click', closeSettingsPopup);
    head.append(close);
    return head;
}

function renderBody() {
    const body = el('div', 'gm-modal-body');

    const intro = el('p', 'gm-modal-intro');
    intro.textContent = 'Pick which SillyTavern connection profile the Director and the Actor (Narrator + characters) call.';
    body.append(intro);

    const profiles = listProfiles();
    body.append(profileRow('Director', LS_DIRECTOR, profiles));
    body.append(profileRow('Actor (Narrator + characters)', LS_ACTOR, profiles));

    const status = el('div', 'gm-modal-status');
    status.append(elText('h3', 'gm-modal-section-title', 'Current ST connection'));
    const dl = el('dl', 'gm-modal-dl');
    dl.append(dt('main_api'), dd(main_api || '(unset)'));
    if (main_api === 'textgenerationwebui') {
        dl.append(dt('textgen type'), dd(textgenerationwebui_settings?.type || '(unset)'));
        dl.append(dt('server_url'), dd(detectActiveTextgenUrl() || '(unset)'));
    } else {
        dl.append(dt('chat_completion_source'), dd(oai_settings?.chat_completion_source || '(unset)'));
    }
    dl.append(dt('model'), dd(detectActiveModel()));
    status.append(dl);

    const note = el('p', 'gm-modal-note');
    note.innerHTML = 'When a profile is set to <strong>Use ST current</strong>, the GM core uses whatever you have selected in the SillyTavern left drawer right now.';
    body.append(status, note);

    return body;
}

function renderFooter() {
    const foot = el('div', 'gm-modal-footer');
    const btn = el('button', 'gm-secondary-btn');
    btn.type = 'button';
    btn.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i> Open ST connection drawer';
    btn.addEventListener('click', () => {
        closeSettingsPopup();
        const drawer = document.getElementById('rm_button_panel_pin') || document.getElementById('API-block');
        const apiIcon = document.querySelector('#right-nav-panel-tab') || document.querySelector('#API-block-icon');
        const target = document.querySelector('#right-nav-panel');
        // Best-effort: ST's API panel is on the right drawer. Trigger the icon if we can find it.
        const rightIcon = document.querySelector('#API-block')?.closest('.drawer-content')?.parentElement?.querySelector('.drawer-toggle');
        if (rightIcon instanceof HTMLElement) {
            rightIcon.click();
        }
    });
    foot.append(btn);
    const close = el('button', 'gm-primary-btn');
    close.type = 'button';
    close.textContent = 'Done';
    close.addEventListener('click', closeSettingsPopup);
    foot.append(close);
    return foot;
}

/**
 * Render a labeled <select> mapping ST profiles to a localStorage key.
 *
 * @param {string} label
 * @param {string} key
 * @param {Array<{ id: string, name: string }>} profiles
 */
function profileRow(label, key, profiles) {
    const row = el('div', 'gm-modal-row');
    row.append(elText('label', 'gm-modal-row-label', label));
    const select = el('select', 'gm-modal-select');

    const def = el('option');
    def.value = STORE_DEFAULT;
    def.textContent = '— Use ST current —';
    select.append(def);

    for (const p of profiles) {
        const opt = el('option');
        opt.value = p.id;
        opt.textContent = p.name;
        select.append(opt);
    }

    const stored = localStorage.getItem(key) || STORE_DEFAULT;
    select.value = profiles.some(p => p.id === stored) ? stored : STORE_DEFAULT;

    select.addEventListener('change', () => {
        localStorage.setItem(key, select.value);
    });
    row.append(select);
    return row;
}

/* -------- Profile + snapshot helpers consumed by Phase 4's Scene view -------- */

/**
 * Return the list of ST connection profiles, or [] when the connection
 * manager extension hasn't initialized yet.
 *
 * @returns {Array<{ id: string, name: string }>}
 */
function listProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles.map(p => ({ id: p.id, name: p.name || p.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a profile by id, returning the raw ST profile object.
 *
 * @param {string} id
 */
function findProfile(id) {
    const profiles = extension_settings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return null;
    return profiles.find(p => p.id === id) ?? null;
}

/**
 * Snapshot the settings ST currently has selected. The shape matches what
 * `src/gm-core/llm/client.js` accepts, so the GM core can dispatch to the
 * upstream provider directly.
 *
 * Two modes:
 *   - `main_api === 'openai'`        → translate `oai_settings` (cloud + custom).
 *   - `main_api === 'textgenerationwebui'` → translate `textgenerationwebui_settings`
 *     for the local providers we support (ollama, llamacpp, koboldcpp).
 *
 * @returns {object}
 */
function snapshotCurrentSettings() {
    if (main_api === 'textgenerationwebui') {
        return snapshotTextgenSettings();
    }
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

/**
 * Translate the textgen UI's currently-selected local backend into an
 * LlmProfile snapshot. Only the providers in TEXTGEN_LOCAL_SOURCES dispatch
 * cleanly via the GM core's OpenAI-compatible transport; everything else
 * returns an empty profile so the backend errors out clearly instead of
 * silently misrouting.
 *
 * @returns {object}
 */
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
 * Build a `LLMProfile` snapshot for one role (`director` or `actor`).
 * The shape matches what `src/gm-core/llm/client.js` accepts on the server.
 *
 * @param {'director' | 'actor'} role
 * @returns {object}
 */
export function currentLlmProfile(role) {
    const key = role === 'director' ? LS_DIRECTOR : LS_ACTOR;
    const stored = localStorage.getItem(key) || STORE_DEFAULT;
    const profile = stored !== STORE_DEFAULT ? findProfile(stored) : null;
    if (!profile) return snapshotCurrentSettings();

    // Translate an ST connection profile's slash-command snapshot into our
    // LlmProfile shape. The connection-manager records keys like `api`,
    // `model`, `api-url`, `secret-id`, `proxy`. Map those to our LLM client's
    // expected fields.
    const source = profile['api'];
    const apiUrl = profile['api-url'] || '';

    // Local textgen providers (ollama, llamacpp, koboldcpp): the api-url is
    // the server root (e.g. `http://localhost:11434`). Pass it through as
    // `custom_url`; the backend client appends `/v1` when needed.
    if (TEXTGEN_LOCAL_SOURCES.has(source)) {
        return {
            source,
            model: profile['model'] || '',
            custom_url: apiUrl,
            reverse_proxy: '',
            proxy_password: '',
            temperature: 0.7,
            max_tokens: 1024,
            secret_id: profile['secret-id'] || undefined,
        };
    }

    return {
        source: source || '',
        model: profile['model'] || '',
        reverse_proxy: source !== 'custom' ? apiUrl : '',
        proxy_password: profile['proxy_password'] || '',
        custom_url: source === 'custom' ? apiUrl : '',
        temperature: 0.7,
        max_tokens: 1024,
        secret_id: profile['secret-id'] || undefined,
    };
}

function detectActiveModel() {
    const snap = snapshotCurrentSettings();
    return snap.model || '(none)';
}

function detectActiveTextgenUrl() {
    const t = textgenerationwebui_settings || {};
    const type = t.type;
    if (!type) return '';
    return (t.server_urls && t.server_urls[type]) || '';
}

/* -------- DOM helpers -------- */

function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function elText(tag, className, text) {
    const node = el(tag, className);
    node.textContent = text;
    return node;
}

function dt(text) {
    const node = document.createElement('dt');
    node.textContent = text;
    return node;
}

function dd(text) {
    const node = document.createElement('dd');
    node.textContent = text;
    return node;
}
