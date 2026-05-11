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
import * as api from './api.js';

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
        const avatar = speaker ? api.getPortraitUrl(speaker) : (ev.avatar || null);
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
        const avatar = speaker ? api.getPortraitUrl(speaker) : null;
        appendRollCard({
            card: ev.card,
            actorAvatar: avatar,
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

    if (ev.kind === 'identity_mutated') {
        // NPC identity was updated directly by the Director. Notify
        // party/sheet panel listeners to refresh; no chat line needed —
        // the Director will narrate the change itself if it matters.
        window.dispatchEvent(new CustomEvent('tt:character-changed', {
            detail: { character_id: ev.character_id },
        }));
        return;
    }

    if (ev.kind === 'identity_edit_request') {
        appendIdentityApprovalBubble(ev);
        return;
    }
}

/**
 * Render a Director-proposed identity field change as a chat bubble with
 * Approve / Deny controls. For the PC only — NPC changes go through
 * `identity_mutated` (applied directly, no approval needed).
 *
 * Layout:
 *   ┌── Director proposes updating [name]'s [field] ──────────────────┐
 *   │  Current  │  Proposed                                            │
 *   │  <muted>  │  <highlighted>                                       │
 *   │  Rationale (italic)                                              │
 *   │  [Approve]  [Deny ▾]                                             │
 *   │    (feedback textarea + Confirm Deny — shown on Deny click)      │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * After a decision the controls are replaced with a read-only confirmation
 * note so the bubble is preserved in the transcript for reference.
 *
 * @param {{ character_id: string, character_name: string, field: string, current_value: string, proposed_value: string, rationale: string }} ev
 */
function appendIdentityApprovalBubble(ev) {
    const FIELD_LABELS = {
        appearance: 'Appearance',
        personality: 'Personality',
        voice: 'Voice',
        background: 'Background',
    };
    const fieldLabel = FIELD_LABELS[ev.field] || ev.field;

    const bubble = document.createElement('div');
    bubble.className = 'mes gm-identity-request';
    bubble.dataset.characterId = ev.character_id;
    bubble.dataset.field = ev.field;

    bubble.innerHTML = `
        <div class="gm-identity-request__header">
            Director proposes: update <strong>${escHtml(ev.character_name)}</strong>'s <em>${escHtml(fieldLabel)}</em>
        </div>
        <div class="gm-identity-request__diff">
            <div class="gm-identity-request__diff-pane gm-identity-request__diff-pane--current">
                <div class="gm-identity-request__diff-label">Current</div>
                <div class="gm-identity-request__diff-text">${escHtml(ev.current_value || '(empty)')}</div>
            </div>
            <div class="gm-identity-request__diff-arrow">→</div>
            <div class="gm-identity-request__diff-pane gm-identity-request__diff-pane--proposed">
                <div class="gm-identity-request__diff-label">Proposed</div>
                <div class="gm-identity-request__diff-text">${escHtml(ev.proposed_value)}</div>
            </div>
        </div>
        <div class="gm-identity-request__rationale">"${escHtml(ev.rationale)}"</div>
        <div class="gm-identity-request__actions">
            <button class="gm-identity-request__btn gm-identity-request__btn--approve" type="button">Approve</button>
            <button class="gm-identity-request__btn gm-identity-request__btn--deny" type="button">Deny</button>
        </div>
        <div class="gm-identity-request__deny-form" hidden>
            <textarea class="gm-identity-request__feedback" rows="2" placeholder="Optional reason for the Director…"></textarea>
            <button class="gm-identity-request__btn gm-identity-request__btn--confirm-deny" type="button">Confirm Deny</button>
        </div>
    `;

    const actionsEl = bubble.querySelector('.gm-identity-request__actions');
    const denyFormEl = bubble.querySelector('.gm-identity-request__deny-form');
    const feedbackEl = bubble.querySelector('.gm-identity-request__feedback');
    const approveBtn = bubble.querySelector('.gm-identity-request__btn--approve');
    const denyBtn = bubble.querySelector('.gm-identity-request__btn--deny');
    const confirmDenyBtn = bubble.querySelector('.gm-identity-request__btn--confirm-deny');

    function lockBubble(confirmationText) {
        actionsEl.remove();
        if (denyFormEl) denyFormEl.remove();
        const note = document.createElement('div');
        note.className = 'gm-identity-request__confirmation';
        note.textContent = confirmationText;
        bubble.append(note);
    }

    approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        denyBtn.disabled = true;
        try {
            await api.setIdentityField(ev.character_id, ev.field, ev.proposed_value);
            window.dispatchEvent(new CustomEvent('tt:character-changed', {
                detail: { character_id: ev.character_id },
            }));
            lockBubble('✓ Applied.');
        } catch (err) {
            approveBtn.disabled = false;
            denyBtn.disabled = false;
            console.error('[gm] identity approve failed', err);
            alert(`Could not apply change: ${err?.message || err}`);
        }
    });

    denyBtn.addEventListener('click', () => {
        denyFormEl.hidden = false;
        denyBtn.hidden = true;
        feedbackEl.focus();
    });

    confirmDenyBtn.addEventListener('click', () => {
        const feedback = feedbackEl.value.trim();
        const reason = feedback ? ` Reason: "${feedback}"` : '';
        const systemText = `[Director proposed updating ${ev.character_name}'s ${fieldLabel} — rejected.${reason}]`;
        appendActorLine({
            actor: 'system',
            name: 'System',
            text: systemText,
            role: 'system',
        });
        lockBubble('✗ Declined.');
    });

    const chat = document.getElementById('chat');
    if (chat) {
        chat.append(bubble);
        bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
}

/** HTML-escape a string for safe insertion into innerHTML. */
function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
