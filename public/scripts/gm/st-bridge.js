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
            const extraKind = line?.extra?.kind;
            if (extraKind === 'roll' && line?.extra?.card) {
                // Roll cards bypass `addOneMessage` so the rich layout
                // survives a reload. We still push a placeholder into chat[]
                // so ST's index-based handlers don't shift under us.
                appendRollCard({
                    card: line.extra.card,
                    narration: line.extra.narration || line.mes || '',
                    actorAvatar: line.force_avatar || null,
                    narrationSpeakerName: line.extra.narration_speaker_name || null,
                    narrationSpeakerRole: line.extra.narration_speaker_role || 'narrator',
                    narrationSpeakerAvatar: line.extra.narration_speaker_avatar || null,
                    persistInChat: true,
                });
                continue;
            }
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
 * Append a styled roll card directly into `#chat`, bypassing ST's
 * `addOneMessage`. The card is one combined bubble (per the user's UX):
 * d20 icon, actor + skill header, breakdown line, success/fail badge,
 * severity pill (on failure), and the post-roll narration as the body.
 *
 * The post-roll prose may be voiced by either the World Narrator (default,
 * environmental checks) or by an in-scene NPC (social checks: persuade /
 * intimidate / etc — the target reacts in their own voice). The body is
 * labelled accordingly via `narrationSpeakerName` / `narrationSpeakerRole`.
 *
 * We push a placeholder entry into `chat[]` so ST's index-based handlers
 * (delete, swipe, edit) don't desync. The placeholder is `is_system: true`
 * with `extra.kind: 'roll'` so transcript-replay code can recognise it.
 *
 * @param {{
 *   card: any,
 *   narration: string,
 *   actorAvatar?: string | null,
 *   narrationSpeakerName?: string | null,
 *   narrationSpeakerRole?: 'narrator' | 'actor',
 *   narrationSpeakerAvatar?: string | null,
 *   persistInChat?: boolean,
 * }} args
 */
export function appendRollCard({
    card,
    narration,
    actorAvatar = null,
    narrationSpeakerName = null,
    narrationSpeakerRole = 'narrator',
    narrationSpeakerAvatar = null,
    persistInChat = true,
}) {
    if (!card || typeof card !== 'object') return;
    if (persistInChat) {
        chat.push({
            name: card.actor_name || 'Roll',
            is_user: false,
            is_system: true,
            send_date: new Date().toISOString(),
            mes: narration || '',
            extra: {
                role: 'roll',
                kind: 'roll',
                card,
                narration,
                narration_speaker_name: narrationSpeakerName || null,
                narration_speaker_role: narrationSpeakerRole || 'narrator',
                narration_speaker_avatar: narrationSpeakerAvatar || null,
            },
            force_avatar: actorAvatar || undefined,
        });
    }
    document.querySelectorAll('#chat').forEach(chatEl => {
        const node = buildRollCardElement({
            card,
            narration,
            actorAvatar,
            narrationSpeakerName,
            narrationSpeakerRole,
            narrationSpeakerAvatar,
        });
        chatEl.appendChild(node);
    });
    scrollChatToBottom();
}

/**
 * @param {{
 *   card: any,
 *   narration: string,
 *   actorAvatar?: string | null,
 *   narrationSpeakerName?: string | null,
 *   narrationSpeakerRole?: 'narrator' | 'actor',
 *   narrationSpeakerAvatar?: string | null,
 * }} args
 * @returns {HTMLElement}
 */
function buildRollCardElement({
    card,
    narration,
    actorAvatar,
    narrationSpeakerName = null,
    narrationSpeakerRole = 'narrator',
    narrationSpeakerAvatar = null,
}) {
    const outcome = card.outcome === 'success' ? 'success' : 'failure';
    const severity = (card.severity || '').toLowerCase();
    const wrap = document.createElement('div');
    // Mark as a `mes` so ST's chat container styling sets the spacing
    // correctly, then layer our own classes on top.
    wrap.className = `mes gm-roll-card outcome-${outcome}`;
    if (severity) wrap.classList.add(`severity-${severity}`);
    if (card.crit === 'natural_20') wrap.classList.add('crit-success');
    else if (card.crit === 'natural_1') wrap.classList.add('crit-failure');

    const head = document.createElement('div');
    head.className = 'gm-roll-card-head';

    const die = document.createElement('div');
    die.className = 'gm-roll-card-die';
    die.innerHTML = '<i class="fa-solid fa-dice-d20" aria-hidden="true"></i>';
    head.appendChild(die);

    const headText = document.createElement('div');
    headText.className = 'gm-roll-card-headtext';

    const title = document.createElement('div');
    title.className = 'gm-roll-card-title';
    title.append(strongSpan(card.actor_name || 'Someone'));
    title.append(document.createTextNode(' rolled '));
    title.append(strongSpan(card.skill_name || 'a check'));
    title.append(document.createTextNode(` vs DC ${card.dc}`));
    headText.appendChild(title);

    const expr = document.createElement('div');
    expr.className = 'gm-roll-card-expression';
    expr.textContent = card.expression || '';
    headText.appendChild(expr);

    head.appendChild(headText);

    const badges = document.createElement('div');
    badges.className = 'gm-roll-card-badges';

    const verdict = document.createElement('span');
    verdict.className = `gm-roll-card-verdict gm-roll-card-verdict-${outcome}`;
    if (card.crit === 'natural_20') {
        verdict.textContent = 'Critical Success';
    } else if (card.crit === 'natural_1') {
        verdict.textContent = 'Critical Failure';
    } else {
        verdict.textContent = outcome === 'success' ? 'Success' : 'Failure';
    }
    badges.appendChild(verdict);

    if (severity && outcome === 'failure') {
        const sev = document.createElement('span');
        sev.className = `gm-roll-card-severity gm-roll-card-severity-${severity}`;
        sev.textContent = capitalise(severity);
        badges.appendChild(sev);
    }

    head.appendChild(badges);
    wrap.appendChild(head);

    if (card.justification) {
        const just = document.createElement('div');
        just.className = 'gm-roll-card-justification';
        just.textContent = card.justification;
        wrap.appendChild(just);
    }

    const speakerLabel = (narrationSpeakerName || (narrationSpeakerRole === 'actor' ? 'Actor' : 'Narrator')).trim();
    const speakerKindClass = narrationSpeakerRole === 'actor' ? 'speaker-actor' : 'speaker-narrator';
    const bodyWrap = document.createElement('div');
    bodyWrap.className = `gm-roll-card-body ${speakerKindClass}`;

    // Mini speaker chip above the body so it's clear who voiced the
    // consequence — matters most when an NPC reacts in their own voice
    // for a social check (otherwise it would look like a generic narrator
    // paragraph that puts dialogue in their mouth).
    const speakerRow = document.createElement('div');
    speakerRow.className = 'gm-roll-card-speaker';
    if (narrationSpeakerAvatar) {
        const av = document.createElement('span');
        av.className = 'gm-roll-card-speaker-avatar';
        av.style.backgroundImage = `url("${narrationSpeakerAvatar}")`;
        speakerRow.appendChild(av);
    }
    const speakerName = document.createElement('span');
    speakerName.className = 'gm-roll-card-speaker-name';
    speakerName.textContent = speakerLabel;
    speakerRow.appendChild(speakerName);
    bodyWrap.appendChild(speakerRow);

    const bodyText = document.createElement('div');
    bodyText.className = 'gm-roll-card-body-text';
    bodyText.textContent = (narration || '').trim();
    bodyWrap.appendChild(bodyText);

    wrap.appendChild(bodyWrap);

    if (actorAvatar) {
        wrap.dataset.actorAvatar = String(actorAvatar);
    }
    return wrap;
}

function strongSpan(text) {
    const s = document.createElement('strong');
    s.textContent = text;
    return s;
}

function capitalise(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
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
