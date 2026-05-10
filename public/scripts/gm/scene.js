/**
 * Scene view — the play surface.
 *
 * Phase 3 wires the scene shell: the GM shell flips into `body.tt-mode-scene`,
 * SillyTavern's `#chat` becomes visible, the player types into ST's input
 * bar, lines persist as JSONL transcript entries, and the End Scene button
 * returns to Campaign Main.
 *
 * Phase 4 wires the Director loop: hitting Enter posts to `/api/gm/turn` and
 * streams `TurnEvent`s back as NDJSON.
 */

import * as api from './api.js';
import { route } from './router.js';
import { currentLlmProfile, hasUsableLlmProfile, openStApiPanel, ensureStConnected } from './llm-profile.js';
import {
    enterSceneMode,
    exitSceneMode,
    appendActorLine,
    appendPlayerLine,
    setSceneState,
    clearSceneState,
    currentSceneState,
} from './st-bridge.js';
import { handleTurnEvent as dispatchTurnEvent } from './turn-events.js';
import { renderLeftSidebar, teardownLeftSidebar } from './sidebar-left.js';
import { renderRightSidebar, teardownRightSidebar } from './sidebar-right.js';
import { setActiveCampaign } from './sheet-panel.js';

let abortCurrentTurn = null;

/**
 * Render the Scene view. The scene fits in the same UI slot as the
 * Campaign hub: the topbar lives inside `#gm-root` (replacing the
 * campaign content), and ST's `#chat` + `#form_sheld` (siblings of
 * `#gm-root` inside `#sheld`) take over the message/input area when
 * `body.tt-mode-scene` is set. ST's persistent top icon bar and any
 * drawers remain visible above — the scene no longer overlays the
 * whole viewport.
 *
 * @param {HTMLElement} mount  the GM root container
 * @param {{ campaignId: string, sceneId: string, readOnly?: boolean }} params
 */
export async function renderScene(mount, { campaignId, sceneId, readOnly = false }) {
    const [campaign, scene, characters, transcript] = await Promise.all([
        api.getCampaign(campaignId),
        api.getScene(sceneId),
        api.listCharacters(campaignId).catch(() => []),
        api.getSceneTranscript(sceneId).catch(() => []),
    ]);
    if (!campaign || !scene) {
        mount.replaceChildren(notFound(`Scene ${sceneId} not found.`));
        return;
    }

    const player = characters.find(c => c.is_player) || null;
    setSceneState({ campaign, scene, player, readOnly, characters });
    // Mirror the campaign into the sheet-panel module so any sheet
    // opened from the in-scene sidebars resolves the right layout.
    setActiveCampaign(campaign);

    enterSceneMode({
        scene,
        player,
        campaign,
        transcript,
    });

    // The scene topbar replaces #gm-root's children. The left + right
    // sidebars sit outside #gm-root (and outside #sheld) so ST's chat
    // substrate keeps occupying the centre column unchanged. We wrap the
    // sidebars in a body-level overlay container that flexes around #sheld.
    teardownLeftSidebar();
    teardownRightSidebar();
    mount.replaceChildren(buildSceneTopbar(campaign, scene, { readOnly }));
    mountSceneSidebars({ campaign, scene, player, characters });

    if (readOnly || scene.status === 'closed') {
        disableInput('Scene closed — read-only.');
    } else {
        // Set up the input first so our `connected_text` attribute is
        // already on the textarea by the time ST's `RA_checkOnlineStatus`
        // reads it after a successful reconnect — otherwise the placeholder
        // updates to `undefined` and the player sees a blank prompt.
        enableInput();
        // ST resets `online_status` to 'no_connection' every time a connection
        // profile is applied (including the implicit re-apply on app boot).
        // Auto-reconnect once so the player isn't looking at a locked send
        // button when the GM core is otherwise ready to dispatch. Best-effort:
        // if the connect button isn't wired (e.g. missing API key for a cloud
        // provider), the pre-flight on submit surfaces the real error.
        ensureStConnected();
    }
}

/* -------- In-scene topbar (rendered into #gm-root) -------- */

function buildSceneTopbar(campaign, scene, { readOnly }) {
    const bar = document.createElement('div');
    bar.id = 'gm-scene-topbar';
    bar.append(
        topbarLeft(campaign, scene),
        topbarRight(campaign, scene, readOnly),
    );
    return bar;
}

function topbarLeft(campaign, scene) {
    const left = document.createElement('div');
    left.className = 'gm-scene-topbar-left';

    const back = document.createElement('button');
    back.className = 'gm-icon-btn';
    back.type = 'button';
    back.title = 'Back to campaign';
    back.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
    back.addEventListener('click', () => onBack(campaign));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'gm-scene-topbar-titles';
    const t = document.createElement('div');
    t.className = 'gm-scene-topbar-title';
    t.textContent = scene.name || 'Scene';
    const sub = document.createElement('div');
    sub.className = 'gm-scene-topbar-subtitle';
    sub.textContent = campaign.name;
    titleWrap.append(t, sub);

    left.append(back, titleWrap);
    return left;
}

function topbarRight(campaign, scene, readOnly) {
    const right = document.createElement('div');
    right.className = 'gm-scene-topbar-right';

    const chip = document.createElement('span');
    chip.id = 'gm-turn-chip';
    chip.className = 'gm-turn-chip';
    chip.textContent = '';
    chip.style.display = 'none';
    right.append(chip);

    const settings = document.createElement('button');
    settings.className = 'gm-icon-btn';
    settings.type = 'button';
    settings.title = 'API & connection settings';
    settings.innerHTML = '<i class="fa-solid fa-plug"></i>';
    settings.addEventListener('click', () => openStApiPanel());
    right.append(settings);

    const endBtn = document.createElement('button');
    endBtn.className = 'gm-secondary-btn';
    endBtn.type = 'button';
    endBtn.disabled = readOnly || scene.status === 'closed';
    endBtn.innerHTML = '<i class="fa-solid fa-flag-checkered"></i> End Scene';
    endBtn.addEventListener('click', () => onEndScene(campaign, scene));
    right.append(endBtn);

    return right;
}

function onBack(campaign) {
    if (abortCurrentTurn) {
        try { abortCurrentTurn.abort(); } catch (_) { /* ignore */ }
        abortCurrentTurn = null;
    }
    teardownSceneShell();
    route({ view: 'campaign', campaignId: campaign.id });
}

async function onEndScene(campaign, scene) {
    if (!confirm(`End scene "${scene.name || scene.id}"?`)) return;

    const directorProfile = currentLlmProfile('director');
    const narratorProfile = currentLlmProfile('narrator');
    if (!directorProfile || !narratorProfile || !hasUsableLlmProfile()) {
        alert('No connection profile is selected, or it is missing a model. Open the API settings (plug icon) to pick or create one before ending the scene.');
        openStApiPanel();
        return;
    }

    const endBtn = document.querySelector('#gm-root .gm-secondary-btn');
    if (endBtn instanceof HTMLButtonElement) endBtn.disabled = true;
    if (abortCurrentTurn) {
        try { abortCurrentTurn.abort(); } catch (_) { /* ignore */ }
        abortCurrentTurn = null;
    }
    setChip('Closing scene…');

    let result = null;
    try {
        result = await api.endScene(scene.id, {
            director_profile: directorProfile,
            actor_profile: narratorProfile,
        });
    } catch (err) {
        console.error('[gm] endScene failed', err);
        setChip('Scene-end failed — see console');
        setTimeout(() => setChip(''), 4000);
        if (endBtn instanceof HTMLButtonElement) endBtn.disabled = false;
        sceneToast(`Could not end scene: ${err?.message || err}`, 'error');
        return;
    }

    setChip('');
    const memoriesTotal = result?.memories_extracted
        ? Object.values(result.memories_extracted).reduce((a, b) => a + b, 0)
        : 0;
    const headline = result?.summary?.headline ? ` — "${truncateForToast(result.summary.headline, 60)}"` : '';
    sceneToast(`Scene closed${headline} · ${memoriesTotal} ${memoriesTotal === 1 ? 'memory' : 'memories'} extracted`, 'ok');

    teardownSceneShell();
    route({ view: 'campaign', campaignId: campaign.id });
}

/** @param {string} message @param {'ok' | 'error'} kind */
function sceneToast(message, kind) {
    const g = /** @type {any} */(window);
    if (g.toastr) {
        const fn = kind === 'error' ? g.toastr.error : g.toastr.success;
        try { fn.call(g.toastr, message, 'Scene'); return; } catch (_) { /* fall through */ }
    }
    if (kind === 'error') console.error('[gm] scene toast', message);
    else console.info('[gm] scene toast', message);
}

/** @param {string} s @param {number} max */
function truncateForToast(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function teardownSceneShell() {
    exitSceneMode();
    clearSceneState();
    teardownLeftSidebar();
    teardownRightSidebar();
    // The scene topbar lives inside #gm-root (this view's mount). The
    // router's next renderer will call mount.replaceChildren(...) so we
    // don't need to remove the bar here, but explicit cleanup keeps the
    // body class flip and the DOM consistent if we ever route somewhere
    // that doesn't repaint #gm-root immediately.
    const bar = document.getElementById('gm-scene-topbar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    document.querySelectorAll('.gm-scene-sidebar-host').forEach(node => {
        if (node.parentNode) node.parentNode.removeChild(node);
    });
}

/**
 * Mount the left + right sidebars as fixed-position columns flanking
 * SillyTavern's `#sheld` chat surface. The same `--sheldWidth` variable
 * ST uses for its own drawer math drives our column geometry: in scene
 * mode `gm.css` shrinks `--sheldWidth` to a sensible centre size, and
 * the sidebars compute their left/right offsets from that. We do NOT
 * re-use ST's `.drawer-content.fillLeft.openDrawer` classes because
 * those rely on ST's drawer JS to toggle `.openDrawer` (animating
 * `height` from a starting-style of 0). Adding the class directly
 * leaves the height stuck at the `min-height` floor and produces the
 * 100px-tall band that the previous attempt rendered. Pure
 * `position: fixed` math sidesteps that entirely.
 *
 * @param {{ campaign: any, scene: any, player: any, characters: any[] }} ctx
 */
function mountSceneSidebars({ campaign, scene, player, characters }) {
    document.querySelectorAll('.gm-scene-sidebar-host').forEach(node => {
        if (node.parentNode) node.parentNode.removeChild(node);
    });

    const leftHost = document.createElement('aside');
    leftHost.id = 'gm-scene-sidebar-left';
    leftHost.className = 'gm-scene-sidebar-host gm-scene-sidebar-host-left';
    leftHost.append(renderLeftSidebar({ campaign, player }));

    const rightHost = document.createElement('aside');
    rightHost.id = 'gm-scene-sidebar-right';
    rightHost.className = 'gm-scene-sidebar-host gm-scene-sidebar-host-right';
    rightHost.append(renderRightSidebar({ campaign, scene, characters }));

    document.body.append(leftHost, rightHost);
}

/* -------- Input enable / disable + chip helpers -------- */

function enableInput() {
    const SCENE_PLACEHOLDER = 'Describe what your character does next…';
    // ST occasionally clones #send_textarea / #send_but into hidden template
    // containers. `getElementById` resolves the first match (which may be
    // the hidden clone), so update every node carrying the id to keep all
    // copies in sync — this is what scene-input handler code already does.
    document.querySelectorAll('#send_textarea').forEach(node => {
        if (!(node instanceof HTMLTextAreaElement)) return;
        node.disabled = false;
        // Drive the placeholder directly. ST's `RA_checkOnlineStatus` will
        // overwrite the live placeholder from `no_connection_text` /
        // `connected_text` whenever it runs, so set both attributes (so
        // any later ST-driven update lands on our string) and seed the
        // current placeholder.
        node.setAttribute('no_connection_text', SCENE_PLACEHOLDER);
        node.setAttribute('connected_text', SCENE_PLACEHOLDER);
        node.placeholder = SCENE_PLACEHOLDER;
    });
    document.querySelectorAll('#send_but').forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        node.classList.remove('gm-disabled');
        // ST adds `.displayNone` when `online_status === 'no_connection'`;
        // gm.css overrides the CSS rule, but clearing the class avoids a
        // flicker the next time ST recomputes UI state.
        node.classList.remove('displayNone');
    });
    document.querySelectorAll('#send_form').forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        node.classList.remove('no-connection');
    });
    installSceneInputHandlers();
}

/**
 * Bind a capture-phase click on `#send_but` and a capture-phase Enter on
 * `#send_textarea` so we drive the turn directly instead of relying on ST's
 * `sendTextareaMessage` → `Generate()` chain. The pre-empt inside `Generate`
 * is still kept as a safety net in case some other code path triggers a
 * generation while in scene mode, but this direct path is what the player's
 * Send / Enter actions actually use.
 */
let inputHandlersInstalled = false;
function installSceneInputHandlers() {
    if (inputHandlersInstalled) return;
    inputHandlersInstalled = true;

    // Use a document-level capture listener so we don't miss clicks on
    // nodes that ST may have duplicated or re-mounted. We match by id at
    // event time rather than by element identity at install time.
    document.addEventListener('click', sceneDocClickHandler, { capture: true });
    document.addEventListener('keydown', sceneDocKeydownHandler, { capture: true });
}

/** @param {MouseEvent} ev */
function sceneDocClickHandler(ev) {
    if (!document.body.classList.contains('tt-mode-scene')) return;
    const target = /** @type {Element|null} */(ev.target);
    if (!target) return;
    // Match either the send button or anything inside it.
    const sendBtn = target.id === 'send_but' ? target : target.closest('#send_but');
    if (!sendBtn) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    submitFromTextarea();
}

/** @param {KeyboardEvent} ev */
function sceneDocKeydownHandler(ev) {
    if (!document.body.classList.contains('tt-mode-scene')) return;
    const target = /** @type {Element|null} */(ev.target);
    if (!target || target.id !== 'send_textarea') return;
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    submitFromTextarea();
}

function submitFromTextarea() {
    // ST sometimes mounts duplicate #send_textarea nodes (template / preview
    // containers). Pick the one that actually has user input, then clear all.
    const tas = /** @type {NodeListOf<HTMLTextAreaElement>} */(
        document.querySelectorAll('textarea#send_textarea, #send_textarea')
    );
    let chosenText = '';
    for (const ta of tas) {
        if (!(ta instanceof HTMLTextAreaElement)) continue;
        const v = String(ta.value || '').trim();
        if (v && !chosenText) chosenText = v;
    }
    if (!chosenText) return;
    for (const ta of tas) {
        if (!(ta instanceof HTMLTextAreaElement)) continue;
        ta.value = '';
        try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { /* ignore */ }
    }
    handleSceneTurn(chosenText).catch(err => {
        console.error('[gm] handleSceneTurn unhandled', err);
    });
}

function disableInput(placeholder) {
    const ta = document.getElementById('send_textarea');
    if (ta instanceof HTMLTextAreaElement) {
        ta.disabled = true;
        ta.placeholder = placeholder;
    }
    const send = document.getElementById('send_but');
    if (send) send.classList.add('gm-disabled');
}

function setChip(text) {
    const chip = document.getElementById('gm-turn-chip');
    if (!chip) return;
    if (!text) {
        chip.style.display = 'none';
        chip.textContent = '';
    } else {
        chip.style.display = '';
        chip.textContent = text;
    }
}

function notFound(message) {
    const div = document.createElement('div');
    div.className = 'gm-error-banner';
    div.textContent = message;
    return div;
}

/* -------- Player-turn handler — registered globally so script.js's
   pre-empt point can call it from inside Generate(). -------- */

/**
 * Handle a player turn: append the player's message, then drive the Director
 * loop via the streaming `/api/gm/turn` endpoint.
 *
 * Returns when the turn completes (end_of_turn event or error).
 *
 * @param {string} userInput
 */
async function handleSceneTurn(userInput) {
    const input = String(userInput || '').trim();
    if (!input) return;

    const state = currentSceneState();
    if (!state) return;
    const { campaign, scene, readOnly, characters } = state;
    if (readOnly || scene.status === 'closed') return;

    // Pre-flight: a SillyTavern connection profile must be selected before
    // the GM core can dispatch. The per-role model overrides on that
    // profile (`gm-director-model`, `gm-narrator-model`) are what
    // distinguish Director vs Narrator at request time; the rest of the
    // profile (provider, URL, secret) is shared.
    const directorProfile = currentLlmProfile('director');
    const narratorProfile = currentLlmProfile('narrator');
    if (!directorProfile || !narratorProfile || !hasUsableLlmProfile()) {
        appendActorLine({
            actor: 'system',
            name: 'System',
            text: 'No connection profile is selected, or the selected profile is missing a model. Open the API settings (plug icon) to pick or create one before starting a turn.',
            role: 'system',
        });
        openStApiPanel();
        return;
    }

    appendPlayerLine(input);
    // The `/api/gm/turn` endpoint persists the player line itself before
    // the Director loop runs (so the JSONL is never desynced even when the
    // turn errors). No need to double-write from the frontend.

    const controller = new AbortController();
    abortCurrentTurn = controller;
    setChip('Director thinking…');

    try {
        const response = await api.startTurn({
            campaign_id: campaign.id,
            scene_id: scene.id,
            user_input: input,
            director_profile: directorProfile,
            actor_profile: narratorProfile,
        }, controller.signal);
        const charactersById = new Map((characters || []).map(c => [c.id, c]));
        await consumeTurnStream(response, { characters: charactersById });
    } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[gm] turn failed', err);
        appendActorLine({
            actor: 'system',
            name: 'System',
            text: `(error) ${err?.message || err}`,
            role: 'system',
        });
        setChip('Turn failed — see console');
        setTimeout(() => setChip(''), 3000);
    } finally {
        abortCurrentTurn = null;
        const ta = document.getElementById('send_textarea');
        if (ta instanceof HTMLTextAreaElement) ta.focus();
    }
}

/**
 * Read NDJSON line-by-line from a streaming response and dispatch events.
 *
 * @param {Response} response
 * @param {{ player: any | null }} ctx
 */
async function consumeTurnStream(response, { characters }) {
    if (!response.body) {
        setChip('Turn complete (no body)');
        setTimeout(() => setChip(''), 1500);
        return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const ui = { setChip, characters };
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
                const ev = JSON.parse(line);
                dispatchTurnEvent(ev, ui);
            } catch (parseErr) {
                console.warn('[gm] bad NDJSON line', line, parseErr);
            }
        }
    }
    setChip('');
}

window.__ttHandleSceneTurn = handleSceneTurn;
