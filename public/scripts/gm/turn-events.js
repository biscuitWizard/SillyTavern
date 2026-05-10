/**
 * Render layer for the NDJSON `TurnEvent` stream that comes back from
 * `/api/gm/turn`.
 *
 * `scene.js` reads each event off the wire and forwards it here. Phase 5
 * adds the `state` kind (spawn / remove) and per-actor `message` rendering;
 * the existing `status`, `error`, and `end_of_turn` paths are unchanged.
 *
 * `state` events are forwarded to a registered listener so the right
 * sidebar can refresh its roster live without polling the server. The
 * transcript persistence is handled server-side; this module is only
 * responsible for the live UI.
 */

import { appendActorLine, appendRollCard } from './st-bridge.js';
import { emit as emitGmEvent } from './events.js';

/** @type {Set<(ev: any) => void>} */
const stateListeners = new Set();

/**
 * Subscribe to `state` events (spawn / remove). Returns an unsubscribe fn.
 *
 * @param {(ev: any) => void} fn
 * @returns {() => void}
 */
export function onStateEvent(fn) {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
}

/** Internal helper: notify all state listeners. */
function emitState(ev) {
    for (const fn of stateListeners) {
        try { fn(ev); } catch (err) { console.warn('[gm] state listener threw', err); }
    }
}

/**
 * Dispatch one TurnEvent. The caller (scene.js) is expected to manage the
 * Director chip text — this module only handles message / state / error.
 *
 * @param {any} ev
 * @param {{ setChip: (text: string) => void, characters?: Map<string, any> }} ui
 */
export function handleTurnEvent(ev, ui) {
    if (!ev || typeof ev !== 'object') return;

    if (ev.kind === 'status') {
        const phase = ev.phase || '';
        const labels = {
            directing: 'Director thinking…',
            awaiting_actor: 'Voice incoming…',
            closing: 'Wrapping up…',
            rolling: 'Rolling…',
        };
        ui.setChip(labels[phase] || phase);
        return;
    }

    if (ev.kind === 'message') {
        const speaker = ev.actor && ev.actor !== 'narrator' && ui.characters?.get
            ? ui.characters.get(ev.actor)
            : null;
        const avatar = speaker?.st_card_avatar
            ? `/characters/${encodeURIComponent(speaker.st_card_avatar)}`
            : (ev.avatar || null);
        appendActorLine({
            actor: ev.actor,
            name: ev.name || (ev.actor === 'narrator' ? 'Narrator' : ev.actor),
            text: ev.text || '',
            role: ev.role || (ev.actor === 'narrator' ? 'narrator' : 'actor'),
            avatar,
        });
        return;
    }

    if (ev.kind === 'roll') {
        const speaker = ev.actor_id && ui.characters?.get
            ? ui.characters.get(ev.actor_id)
            : null;
        const avatar = speaker?.st_card_avatar
            ? `/characters/${encodeURIComponent(speaker.st_card_avatar)}`
            : null;
        // Resolve the post-roll voice (may differ from the rolling actor —
        // for social checks the Director picks the target NPC as the voice
        // so they react in their own words instead of via the narrator).
        const narrationSpeakerRole = ev.narration_speaker_role || 'narrator';
        let narrationSpeakerName = ev.narration_speaker_name || null;
        let narrationSpeakerAvatar = null;
        if (narrationSpeakerRole === 'actor' && ev.narration_speaker_id && ui.characters?.get) {
            const ns = ui.characters.get(ev.narration_speaker_id);
            if (ns) {
                narrationSpeakerName = narrationSpeakerName || ns.name;
                if (ns.st_card_avatar) {
                    narrationSpeakerAvatar = `/characters/${encodeURIComponent(ns.st_card_avatar)}`;
                }
            }
        } else if (narrationSpeakerRole === 'narrator') {
            narrationSpeakerName = narrationSpeakerName || 'Narrator';
        }
        appendRollCard({
            card: ev.card,
            narration: ev.narration || '',
            actorAvatar: avatar,
            narrationSpeakerName,
            narrationSpeakerRole,
            narrationSpeakerAvatar,
        });
        return;
    }

    if (ev.kind === 'state') {
        // `state` events update the right-sidebar roster live, but we
        // intentionally do NOT inject a "X entered the scene." line into
        // the chat. The actor's own first speak (e.g. Marle's greeting)
        // is the in-fiction entrance and the sidebar already shows the
        // roster delta — a system announcement on top of that is just
        // duplicate noise and breaks immersion. Backend persistence is
        // disabled to match (see endpoints/gm.js).
        emitState(ev);
        return;
    }

    if (ev.kind === 'tool_error') {
        // Director loop bookkeeping: a recoverable tool failure (unknown
        // actor id, missing fields, etc.) that the Director will retry on
        // its next step. The player should never see these — they are
        // model thrash, not story content. We log to the dev console so
        // we can still diagnose recurring failures.
        console.warn('[gm] director tool_error (recovered):', ev.tool, ev.code, ev.message);
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
        ui.setChip('');
        return;
    }

    if (ev.kind === 'memory_write') {
        // Memory writes have no in-scene UI surface; they are observed
        // by the Memory Explorer's live feed via the global event bus.
        emitGmEvent('memory_write', ev);
        return;
    }
}
