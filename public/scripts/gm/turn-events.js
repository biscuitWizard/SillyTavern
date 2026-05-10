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
        appendRollCard({
            card: ev.card,
            narration: ev.narration || '',
            actorAvatar: avatar,
        });
        return;
    }

    if (ev.kind === 'state') {
        const verb = ev.change === 'spawn' ? 'entered' : 'left';
        const name = ev.character_name || ev.character_id || 'Someone';
        appendActorLine({
            actor: 'system',
            name: 'System',
            text: `${name} ${verb} the scene.`,
            role: 'system',
        });
        emitState(ev);
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
