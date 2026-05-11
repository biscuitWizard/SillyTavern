/**
 * Per-message + hamburger-menu handlers for scene mode.
 *
 * In scene mode the chat substrate is SillyTavern's, but the persistence
 * model is the GM core's per-scene JSONL transcript. ST's default
 * handlers (`messageEditDone`, `deleteMessage`, `swipe_left/right`,
 * `#option_continue` etc.) all funnel through `saveChatConditional()`,
 * which targets ST's character-chat files — the wrong substrate.
 *
 * This module installs capture-phase document listeners that intercept
 * the relevant clicks while `body.tt-mode-scene` is set, call the
 * `/api/gm/scenes/:id/messages/...` endpoints (from `api.js`), and let
 * ST's existing render path otherwise stay intact. Anything not in
 * scene mode falls through unchanged so the rest of ST keeps working.
 *
 * Wiring:
 *   - .mes_edit_done    →  PUT  /messages/:line_index   (then update chat[])
 *   - .mes_edit_delete  →  DELETE /messages/:line_index (then refetch + replay)
 *   - .swipe_left/right →  POST /messages/:line_index/regenerate (last_mes only)
 *   - .tt_regenerate_from_here →  POST /messages/:line_index/regenerate (any
 *                          player mes — injected by a MutationObserver)
 *   - #option_continue  →  handleSceneTurn('') — kicks the Director without
 *                          new player input (scene-stuck recovery)
 *   - #option_regenerate →  same as .swipe_right on the last mes
 *   - #option_delete_mes →  let ST flip into delete-mode UX; the per-line
 *                           clicks then route through the DELETE endpoint
 *                           via the same `.mes_edit_delete` listener.
 *   - #option_impersonate →  hidden in scene mode (CSS); we no-op here.
 */

import * as api from './api.js';
import { currentSceneState, enterSceneMode } from './st-bridge.js';
import { currentLlmProfile, hasUsableLlmProfile, openStApiPanel } from './llm-profile.js';
import { handleTurnEvent as dispatchTurnEvent } from './turn-events.js';
import { chat as stChat, messageEdit as stMessageEdit } from '../../script.js';

let installed = false;
let regenerationInFlight = false;

/** @type {Promise<void>|null} */
let pendingEditPersist = null;

/** @type {MutationObserver | null} */
let regenBtnObserver = null;

/**
 * Install document-level capture listeners. Idempotent — repeated calls
 * are no-ops, mirroring `installSceneInputHandlers` in scene.js.
 */
export function installSceneMessageActions() {
    if (installed) return;
    installed = true;
    document.addEventListener('click', onCaptureClick, { capture: true });
    startRegenButtonObserver();
}

/**
 * Tear down the MutationObserver that injects regenerate buttons.
 * Called from `teardownSceneShell` in scene.js.
 */
export function teardownSceneMessageActions() {
    if (regenBtnObserver) {
        regenBtnObserver.disconnect();
        regenBtnObserver = null;
    }
}

/**
 * Inject a "Regenerate reply" button into every player `.mes` element's
 * `extraMesButtons` container. A MutationObserver watches `#chat` for
 * new nodes (streamed beats, replays); an initial sweep covers messages
 * already rendered at install time.
 */
function startRegenButtonObserver() {
    if (regenBtnObserver) regenBtnObserver.disconnect();

    const injectInto = (/** @type {Element} */ mes) => {
        if (mes.getAttribute('is_user') !== 'true') return;
        if (mes.querySelector('.tt_regenerate_from_here')) return;
        const container = mes.querySelector('.extraMesButtons');
        if (!container) return;
        const btn = document.createElement('div');
        btn.title = 'Regenerate reply';
        btn.className = 'mes_button tt_regenerate_from_here fa-solid fa-rotate-right';
        container.prepend(btn);
    };

    // Sweep messages already in the DOM.
    document.querySelectorAll('#chat .mes[is_user="true"]').forEach(injectInto);

    // Watch for new .mes nodes added by addOneMessage / replay.
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    regenBtnObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.classList.contains('mes')) {
                    injectInto(node);
                } else {
                    node.querySelectorAll?.('.mes[is_user="true"]')?.forEach(injectInto);
                }
            }
        }
    });
    regenBtnObserver.observe(chatEl, { childList: true, subtree: true });
}

/** @param {MouseEvent} ev */
function onCaptureClick(ev) {
    if (!document.body.classList.contains('tt-mode-scene')) return;
    const target = /** @type {Element|null} */(ev.target);
    if (!target || !(target instanceof Element)) return;

    // Order matters: option_* live in #options menu; per-mes buttons live
    // inside `.mes`. Match the more specific cases first.

    // Hamburger menu: Continue (kick the Director with empty input).
    if (target.id === 'option_continue' || target.closest('#option_continue')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        closeOptionsMenu();
        kickContinue();
        return;
    }
    // Hamburger menu: Regenerate. Acts on the last mes.
    if (target.id === 'option_regenerate' || target.closest('#option_regenerate')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        closeOptionsMenu();
        regenerateFromIdx(lastMesIdx());
        return;
    }
    // Hamburger menu: Impersonate is hidden via CSS. Belt-and-braces:
    // swallow the click in case the CSS rule is overridden.
    if (target.id === 'option_impersonate' || target.closest('#option_impersonate')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        closeOptionsMenu();
        return;
    }
    // Hamburger menu: Delete-mode toggle. We let ST's UX (per-message
    // checkboxes + bulk-delete bar) work as-is; per-mes deletes route
    // through the DELETE endpoint via .mes_edit_delete below.

    // Per-mes Edit-pencil. ST's own handler bails when there's no
    // active character/group/temp chat (none of which apply in scene
    // mode), so the click silently no-ops. We bypass the guard by
    // calling `messageEdit(idx)` directly from the capture phase, then
    // swallow the event so ST's handler doesn't run again.
    const editBtn = closestWithClass(target, 'mes_edit');
    if (editBtn && !closestWithClass(target, 'mes_edit_done')
        && !closestWithClass(target, 'mes_edit_cancel')
        && !closestWithClass(target, 'mes_edit_delete')) {
        const mes = editBtn.closest('.mes');
        const idx = mesIdxFromEl(mes);
        if (idx === null) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        try {
            stMessageEdit(idx);
        } catch (err) {
            console.error('[gm] messageEdit(idx) failed', err);
        }
        return;
    }

    // Per-mes Edit-Done (the green check that finalises an edit).
    const editDone = closestWithClass(target, 'mes_edit_done');
    if (editDone) {
        // Capture phase fires BEFORE ST's own bound handler. We let ST
        // keep its in-place DOM editing, but we intercept the event so
        // we can also persist the new text to our transcript. We can't
        // trivially read the edited text from the DOM here because ST
        // hasn't applied it yet; we defer until after ST's handler has
        // run by re-firing on bubble.
        scheduleEditPersistAfterStCommit(editDone);
        return;
    }

    // Per-mes Delete (the trash button next to edit). When ST's
    // delete-mode UX is active there's a different .mes_edit_delete
    // path; we cover both by scoping by class.
    const editDelete = closestWithClass(target, 'mes_edit_delete');
    if (editDelete) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const mes = editDelete.closest('.mes');
        const idx = mesIdxFromEl(mes);
        if (idx === null) return;
        deleteAtIndex(idx);
        return;
    }

    // Per-player-mes "Regenerate reply" button (injected by observer).
    const regenBtn = closestWithClass(target, 'tt_regenerate_from_here');
    if (regenBtn) {
        const mes = regenBtn.closest('.mes');
        const idx = mesIdxFromEl(mes);
        if (idx === null) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        regenerateFromIdx(idx);
        return;
    }

    // Per-mes swipe-regenerate. ST emits `.swipe_left` / `.swipe_right`
    // — we treat both as "regenerate" because the scene model has only
    // one canonical AI continuation per player input (no swipe history).
    const swipeBtn = closestWithClass(target, 'swipe_right')
        || closestWithClass(target, 'swipe_left')
        || closestWithClass(target, 'swipe_right_inline')
        || closestWithClass(target, 'swipe_left_inline');
    if (swipeBtn) {
        const mes = swipeBtn.closest('.mes');
        if (!mes) return;
        if (!mes.classList.contains('last_mes')) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        regenerateFromIdx(lastMesIdx());
    }
}

/** Walk up the DOM tree looking for the first element carrying `cls`. */
function closestWithClass(start, cls) {
    let el = start instanceof Element ? start : null;
    while (el) {
        if (el.classList && el.classList.contains(cls)) return el;
        el = el.parentElement;
    }
    return null;
}

function closeOptionsMenu() {
    // ST keeps a shared `#options` menu and shows/hides via class. Just
    // close it so the player isn't left with the menu floating after we
    // intercept the click.
    const menu = document.getElementById('options');
    if (menu instanceof HTMLElement) menu.style.display = 'none';
}

/**
 * Read the 0-based index of a `.mes` element. ST stores it on the
 * `mesid` attribute (string). For scene mode this index is also the
 * JSONL line index because `enterSceneMode` replays lines 1:1.
 *
 * @param {Element|null|undefined} mes
 * @returns {number|null}
 */
function mesIdxFromEl(mes) {
    if (!mes || !(mes instanceof Element)) return null;
    const raw = mes.getAttribute('mesid');
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
}

/**
 * Defer reading the edited textarea + persisting the result until
 * AFTER ST's edit-done handler has had a chance to commit the new
 * value into `chat[mesid].mes`. We don't stop the event — ST's handler
 * needs to fire so the bubble switches back from edit-mode UI.
 *
 * @param {Element} editDoneBtn
 */
function scheduleEditPersistAfterStCommit(editDoneBtn) {
    const mes = editDoneBtn.closest('.mes');
    if (!mes) return;
    const idx = mesIdxFromEl(mes);
    if (idx === null) return;
    // Read the textarea's current value here (before ST commits) AND
    // re-read after — whichever has content wins. ST's edit textarea
    // is `.edit_textarea`.
    const ta = /** @type {HTMLTextAreaElement|null} */ (mes.querySelector('.edit_textarea'));
    const beforeText = ta ? ta.value : null;
    setTimeout(() => persistMesEdit(idx, mes, beforeText), 0);
}

/**
 * @param {number} idx
 * @param {Element} mes
 * @param {string|null} beforeText
 */
async function persistMesEdit(idx, mes, beforeText) {
    const job = (async () => {
        const state = currentSceneState();
        if (!state) return;

        // Prefer ST's committed text from the chat[] mirror because its
        // edit handler converts markdown / sanitises before writing; our
        // `beforeText` snapshot is the raw textarea, which is the
        // fallback when chat[] hasn't latched yet.
        let text = '';
        if (Array.isArray(stChat) && stChat[idx] && typeof stChat[idx].mes === 'string') {
            text = stChat[idx].mes;
        }
        if (!text && beforeText !== null) text = beforeText;
        // Last-resort: read the rendered .mes_text from the DOM. ST's
        // messageEditDone may have already swapped the edit textarea for
        // the formatted div by the time our setTimeout fires.
        if (!text && mes instanceof Element) {
            const rendered = mes.querySelector('.mes_text');
            if (rendered) text = rendered.textContent?.trim() || '';
        }
        if (!text) {
            console.warn('[gm] persistMesEdit: no text found for idx', idx);
            return;
        }

        try {
            await api.editSceneMessage(state.scene.id, idx, text);
        } catch (err) {
            console.error('[gm] editSceneMessage failed', err);
            notifySystem(`Edit failed: ${err?.message || err}`);
        }
    })();
    pendingEditPersist = job;
    await job;
    if (pendingEditPersist === job) pendingEditPersist = null;
}

/**
 * Delete a transcript line + refetch + replay so chat[] / mesids stay
 * coherent. Cheaper alternatives (in-place DOM splice + chat[].splice)
 * leave roll cards' DOM nodes hanging because they aren't standard ST
 * bubbles; a clean replay keeps the model simple.
 *
 * @param {number} idx
 */
async function deleteAtIndex(idx) {
    const state = currentSceneState();
    if (!state) return;
    try {
        const result = await api.deleteSceneMessage(state.scene.id, idx);
        if (result?.cascade?.errors?.length) {
            console.warn('[gm] cascade delete had errors', result.cascade.errors);
        }
        const transcript = await api.getSceneTranscript(state.scene.id, 0);
        enterSceneMode({
            campaign: state.campaign,
            scene: state.scene,
            player: state.player,
            transcript,
        });
    } catch (err) {
        console.error('[gm] deleteSceneMessage failed', err);
        notifySystem(`Delete failed: ${err?.message || err}`);
    }
}

/**
 * Kick the Director without new player input. Mirrors the
 * "scene is stuck" recovery: fires a /turn with `user_input=''` so the
 * Director picks the next beat from where the transcript left off.
 */
async function kickContinue() {
    const state = currentSceneState();
    if (!state) return;
    if (state.readOnly || state.scene.status === 'closed') return;

    const directorProfile = currentLlmProfile('director');
    const narratorProfile = currentLlmProfile('narrator');
    if (!directorProfile || !narratorProfile || !hasUsableLlmProfile()) {
        notifySystem('No connection profile is selected — cannot continue.');
        openStApiPanel();
        return;
    }
    const summarizerProfile = currentLlmProfile('summarizer');
    try {
        const response = await api.startTurn({
            campaign_id: state.campaign.id,
            scene_id: state.scene.id,
            user_input: '',
            director_profile: directorProfile,
            actor_profile: narratorProfile,
            summarizer_profile: summarizerProfile,
        });
        await streamTurnResponse(response);
    } catch (err) {
        console.error('[gm] continue failed', err);
        notifySystem(`Continue failed: ${err?.message || err}`);
    }
}

/**
 * Regenerate from the most-recent player input. Delegates to
 * `regenerateFromIdx` with the highest mesid on screen.
 */
async function regenerateLastMes() {
    const idx = lastMesIdx();
    if (idx >= 0) await regenerateFromIdx(idx);
}

/**
 * Regenerate AI replies starting from a specific transcript index.
 * The server walks back to the nearest player line at-or-before `idx`,
 * drops everything after it, and runs a fresh Director turn.
 *
 * @param {number} idx  mesid / JSONL line index to regenerate from.
 */
async function regenerateFromIdx(idx) {
    if (regenerationInFlight) return;
    const state = currentSceneState();
    if (!state) return;
    if (state.readOnly || state.scene.status === 'closed') return;
    if (idx < 0) return;

    // Wait for any in-flight edit persistence so the server reads the
    // latest text when it builds the regeneration prompt.
    if (pendingEditPersist) {
        try { await pendingEditPersist; } catch (_) { /* logged elsewhere */ }
    }

    const directorProfile = currentLlmProfile('director');
    const narratorProfile = currentLlmProfile('narrator');
    if (!directorProfile || !narratorProfile || !hasUsableLlmProfile()) {
        notifySystem('No connection profile is selected — cannot regenerate.');
        openStApiPanel();
        return;
    }
    const summarizerProfile = currentLlmProfile('summarizer');
    regenerationInFlight = true;
    try {
        const response = await api.regenerateSceneMessage(state.scene.id, idx, {
            director_profile: directorProfile,
            actor_profile: narratorProfile,
            summarizer_profile: summarizerProfile,
        });
        const transcript = await api.getSceneTranscript(state.scene.id, 0);
        enterSceneMode({
            campaign: state.campaign,
            scene: state.scene,
            player: state.player,
            transcript,
        });
        await streamTurnResponse(response);
    } catch (err) {
        console.error('[gm] regenerate failed', err);
        notifySystem(`Regenerate failed: ${err?.message || err}`);
    } finally {
        regenerationInFlight = false;
    }
}

/**
 * Find the highest mesid in the rendered chat. Returns -1 when no
 * messages are visible.
 */
function lastMesIdx() {
    const all = document.querySelectorAll('#chat .mes[mesid]');
    let best = -1;
    for (const el of all) {
        const n = Number(el.getAttribute('mesid'));
        if (Number.isInteger(n) && n > best) best = n;
    }
    return best;
}

/**
 * Read NDJSON line-by-line. Mirrors `consumeTurnStream` in scene.js but
 * lives here to avoid circular imports — both modules are small and
 * this keeps the import graph linear.
 *
 * @param {Response} response
 */
async function streamTurnResponse(response) {
    if (!response.body) return;
    const state = currentSceneState();
    const charactersById = new Map((state?.characters || []).map(c => [c.id, c]));
    const ui = {
        setChip: (text) => {
            const chip = document.getElementById('gm-turn-chip');
            if (!chip) return;
            if (!text) {
                chip.style.display = 'none';
                chip.textContent = '';
            } else {
                chip.style.display = '';
                chip.textContent = text;
            }
        },
        characters: charactersById,
    };
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
                dispatchTurnEvent(ev, ui);
            } catch (parseErr) {
                console.warn('[gm] bad NDJSON line', line, parseErr);
            }
        }
    }
    ui.setChip('');
}

/**
 * @param {string} text
 */
function notifySystem(text) {
    // Surfacing via console keeps this module's import graph tiny;
    // surfacing via toast or a system bubble would pull in more deps.
    // The Scene view already renders chip/error states for failures
    // that happen on the main turn path; this is a fallback for
    // hamburger / chat-action errors which are intentionally less
    // intrusive.
    console.warn('[gm] scene action:', text);
    try {
        const toastr = /** @type {any} */(window).toastr;
        if (toastr && typeof toastr.warning === 'function') {
            toastr.warning(text, 'Scene action');
        }
    } catch (_) { /* ignore */ }
}
