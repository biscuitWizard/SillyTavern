/**
 * Narrow shim layer between the GM shell and SillyTavern internals.
 *
 * Goal: every direct ST coupling (the chat array, `addOneMessage()`, the
 * `body.tt-mode-scene` flip, the input bar, the avatar machinery) lives
 * here, and nowhere else. When upstream merges break ST's `addOneMessage`
 * shape or chat[] semantics, this is the file that takes the diff.
 */

import { addOneMessage, chat } from '../../script.js';

const SCENE_MODE_CLASS = 'tt-mode-scene';

/**
 * Per-scene cached state. The Scene view's input handler reads from this.
 *
 * @type {null | {
 *   campaign: any,
 *   scene: any,
 *   player: any | null,
 *   readOnly: boolean,
 * }}
 */
let activeState = null;

/** @returns {typeof activeState} */
export function currentSceneState() {
    return activeState;
}

/** @param {typeof activeState} state */
export function setSceneState(state) {
    activeState = state;
}

export function clearSceneState() {
    activeState = null;
}

/**
 * Enter scene mode: flip the body class, clear ST's chat array, replay any
 * existing transcript via `addOneMessage`. The Scene view's topbar and the
 * input wiring happen in `scene.js`.
 *
 * @param {{
 *   campaign: any,
 *   scene: any,
 *   player: any | null,
 *   transcript: Array<any>,
 * }} ctx
 */
export function enterSceneMode({ campaign: _campaign, scene: _scene, player, transcript }) {
    document.body.classList.add(SCENE_MODE_CLASS);

    // Clear ST's chat array in-place (we cannot reassign because it's an
    // import binding consumers hold). Also wipe the rendered #chat DOM so
    // any prior welcome / placeholder messages don't bleed into the scene.
    // ST may have duplicate #chat elements in the DOM (template/preview
    // containers); empty every visible one we can find.
    chat.length = 0;
    document.querySelectorAll('#chat').forEach(el => {
        try { el.innerHTML = ''; } catch (_) { /* ignore */ }
    });

    if (Array.isArray(transcript)) {
        for (const line of transcript) {
            const mes = normalizeTranscriptLine(line, player);
            chat.push(mes);
            try {
                addOneMessage(mes, { scroll: false });
            } catch (err) {
                console.warn('[gm] addOneMessage failed during replay', err, mes);
            }
        }
    }

    scrollChatToBottom();
}

export function exitSceneMode() {
    document.body.classList.remove(SCENE_MODE_CLASS);
    chat.length = 0;
    const chatEl = document.getElementById('chat');
    if (chatEl) chatEl.innerHTML = '';
}

/**
 * Append the player's line: push to chat[], render via addOneMessage. The
 * caller is responsible for persisting to the JSONL transcript.
 *
 * @param {string} text
 */
export function appendPlayerLine(text) {
    if (!activeState) return;
    const player = activeState.player;
    const mes = {
        name: player ? player.name : 'Player',
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: text,
        extra: { role: 'player' },
    };
    if (player?.st_card_avatar) {
        mes.force_avatar = `/characters/${encodeURIComponent(player.st_card_avatar)}`;
    }
    chat.push(mes);
    try {
        addOneMessage(mes);
    } catch (err) {
        console.error('[gm] addOneMessage failed for player line', err);
    }
    scrollChatToBottom();
}

/**
 * Append an AI actor line (Narrator or character or system error).
 *
 * @param {{ actor: string, name: string, text: string, role: string, avatar?: string | null }} args
 */
export function appendActorLine({ actor, name, text, role, avatar = null }) {
    const mes = {
        name: name || actor,
        is_user: false,
        is_system: role === 'system',
        send_date: new Date().toISOString(),
        mes: text,
        extra: { role, actor },
    };
    if (avatar) mes.force_avatar = avatar;
    chat.push(mes);
    try {
        addOneMessage(mes);
    } catch (err) {
        console.error('[gm] addOneMessage failed for actor line', err);
    }
    scrollChatToBottom();
}

/**
 * Convert a JSONL transcript line into the in-memory shape ST's `chat[]`
 * uses. Mostly identical, but tolerant of missing fields.
 *
 * @param {any} line
 * @param {any | null} player
 */
function normalizeTranscriptLine(line, player) {
    const mes = {
        name: line.name || (line.is_user ? 'Player' : 'Narrator'),
        is_user: !!line.is_user,
        is_system: !!line.is_system,
        send_date: line.send_date || new Date().toISOString(),
        mes: line.mes || '',
        extra: line.extra || {},
    };
    if (line.force_avatar) {
        mes.force_avatar = line.force_avatar;
    } else if (line.is_user && player?.st_card_avatar) {
        mes.force_avatar = `/characters/${encodeURIComponent(player.st_card_avatar)}`;
    }
    return mes;
}

function scrollChatToBottom() {
    const el = document.getElementById('chat');
    if (el) el.scrollTop = el.scrollHeight;
}

/**
 * Whether the GM shell is currently in scene mode. Read by the `Generate()`
 * pre-empt point in `script.js`.
 */
export function isInSceneMode() {
    return document.body.classList.contains(SCENE_MODE_CLASS);
}
