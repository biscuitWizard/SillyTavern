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
import { openSettingsPopup, currentLlmProfile } from './settings-popup.js';
import {
    enterSceneMode,
    exitSceneMode,
    appendActorLine,
    appendPlayerLine,
    setSceneState,
    clearSceneState,
    currentSceneState,
} from './st-bridge.js';

let abortCurrentTurn = null;

/**
 * @param {HTMLElement} mount  unused — Scene view takes over ST's #chat
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
    setSceneState({ campaign, scene, player, readOnly });

    enterSceneMode({
        scene,
        player,
        campaign,
        transcript,
    });

    mountSceneTopbar(campaign, scene, { readOnly });

    if (readOnly || scene.status === 'closed') {
        disableInput('Scene closed — read-only.');
    } else {
        enableInput();
    }

    // Replace mount contents with a small banner — most of the Scene view
    // lives in #chat / #form_sheld via st-bridge, but rendering something
    // here means router error handling does not flash an empty container if
    // the scene mount races.
    mount.replaceChildren(buildSceneFallback(scene));
}

function buildSceneFallback(scene) {
    const node = document.createElement('div');
    node.className = 'gm-scene-fallback';
    node.textContent = `In scene: ${scene.name || scene.id}`;
    return node;
}

/* -------- In-scene topbar (rendered above #chat) -------- */

function mountSceneTopbar(campaign, scene, { readOnly }) {
    let bar = document.getElementById('gm-scene-topbar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'gm-scene-topbar';
        document.body.appendChild(bar);
    }
    bar.replaceChildren(
        topbarLeft(campaign, scene),
        topbarRight(campaign, scene, readOnly),
    );
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
    settings.title = 'Settings';
    settings.innerHTML = '<i class="fa-solid fa-cog"></i>';
    settings.addEventListener('click', () => openSettingsPopup());
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
    try {
        await api.endScene(scene.id);
    } catch (err) {
        console.error('[gm] endScene failed', err);
        alert(`Could not end scene: ${err?.message || err}`);
        return;
    }
    teardownSceneShell();
    route({ view: 'campaign', campaignId: campaign.id });
}

function teardownSceneShell() {
    exitSceneMode();
    clearSceneState();
    const bar = document.getElementById('gm-scene-topbar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
}

/* -------- Input enable / disable + chip helpers -------- */

function enableInput() {
    const ta = document.getElementById('send_textarea');
    if (ta instanceof HTMLTextAreaElement) {
        ta.disabled = false;
        ta.placeholder = 'Describe what your character does next…';
        // ST's RA_checkOnlineStatus poll resets the placeholder from the
        // `no_connection_text` / `connected_text` attributes, so override
        // both with our scene placeholder while we own the input.
        ta.setAttribute('no_connection_text', 'Describe what your character does next…');
        ta.setAttribute('connected_text', 'Describe what your character does next…');
    }
    const send = document.getElementById('send_but');
    if (send) {
        send.classList.remove('gm-disabled');
        // ST hides the send button via .displayNone when online_status is
        // 'no_connection'. Scene mode's CSS overrides the rule, but make
        // sure the class is gone so other ST handlers don't get confused.
        send.classList.remove('displayNone');
    }
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
    const { campaign, scene, player, readOnly } = state;
    if (readOnly || scene.status === 'closed') return;

    appendPlayerLine(input);
    // The `/api/gm/turn` endpoint persists the player line itself before
    // the Director loop runs (so the JSONL is never desynced even when the
    // turn errors). No need to double-write from the frontend.

    const controller = new AbortController();
    abortCurrentTurn = controller;
    setChip('Director thinking…');

    try {
        const directorProfile = currentLlmProfile('director');
        const actorProfile = currentLlmProfile('actor');
        const response = await api.startTurn({
            campaign_id: campaign.id,
            scene_id: scene.id,
            user_input: input,
            director_profile: directorProfile,
            actor_profile: actorProfile,
        }, controller.signal);
        await consumeTurnStream(response, { player });
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
async function consumeTurnStream(response, { player }) {
    if (!response.body) {
        setChip('Turn complete (no body)');
        setTimeout(() => setChip(''), 1500);
        return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
                handleTurnEvent(ev);
            } catch (parseErr) {
                console.warn('[gm] bad NDJSON line', line, parseErr);
            }
        }
    }
    setChip('');
}

function handleTurnEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'status') {
        const phase = ev.phase || '';
        const labels = {
            directing: 'Director thinking…',
            awaiting_actor: 'Narrating…',
            closing: 'Wrapping up…',
            rolling: 'Rolling…',
        };
        setChip(labels[phase] || phase);
        return;
    }
    if (ev.kind === 'message') {
        appendActorLine({
            actor: ev.actor,
            name: ev.name || (ev.actor === 'narrator' ? 'Narrator' : ev.actor),
            text: ev.text || '',
            role: ev.role || (ev.actor === 'narrator' ? 'narrator' : 'actor'),
            avatar: ev.avatar || null,
        });
        return;
    }
    if (ev.kind === 'error') {
        console.error('[gm] turn error event', ev);
        appendActorLine({
            actor: 'system',
            name: 'System',
            text: `(error) ${ev.message || 'unknown error'}`,
            role: 'system',
        });
        return;
    }
    if (ev.kind === 'end_of_turn') {
        setChip('');
        return;
    }
}

window.__ttHandleSceneTurn = handleSceneTurn;
