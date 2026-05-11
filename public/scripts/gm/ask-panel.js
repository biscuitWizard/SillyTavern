/**
 * Ask panel — out-of-fiction GM chat for Campaign Main.
 *
 * Persistent per-campaign transcript, loaded from
 * `GET /api/gm/campaigns/:cid/ask` on mount. The player types a question;
 * the panel optimistically appends their message, POSTs to `.../ask`,
 * and appends the GM reply. When the reply produces a `world_lore`
 * record the panel surfaces a small chip linking into the Memory
 * Explorer so the player can review what the GM committed to canon.
 *
 * The panel stays inside the Campaign Main body; it does NOT toggle
 * `body.tt-mode-scene` (which is reserved for actual scenes).
 */

import * as api from './api.js';
import { route } from './router.js';
import { currentLlmProfile, connectionStatus } from './llm-profile.js';

/**
 * Render the Ask panel into `mount`. Returns a teardown function the
 * caller can use to unhook listeners on navigation away. The mount is
 * fully replaced.
 *
 * @param {HTMLElement} mount
 * @param {{ campaign: any, onBack: () => void }} args
 * @returns {() => void}
 */
export function renderAskPanel(mount, { campaign, onBack }) {
    const panel = el('div', 'gm-ask-panel');

    const head = el('div', 'gm-ask-panel-head');
    const titleWrap = el('div');
    titleWrap.append(elText('h2', 'gm-ask-panel-title', 'Ask the GM'));
    const blurb = el('p', 'gm-ask-panel-blurb');
    blurb.textContent = 'Out-of-fiction questions about the world, the plot, or what your character knows. The GM will answer without advancing the scene, and may record durable facts as world lore.';
    titleWrap.append(blurb);
    const undoBtn = el('button', 'gm-ask-undo-btn');
    undoBtn.type = 'button';
    undoBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Undo last';
    undoBtn.title = 'Remove the last player question and GM reply';

    const headActions = el('div', 'gm-ask-head-actions');
    headActions.append(undoBtn, backButton(onBack));
    head.append(titleWrap, headActions);
    panel.append(head);

    const transcriptEl = el('div', 'gm-ask-transcript');
    panel.append(transcriptEl);

    const errorEl = el('div', 'gm-ask-error');
    errorEl.style.display = 'none';
    panel.append(errorEl);

    const form = el('form', 'gm-ask-form');
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'What do you want to ask the GM?';
    textarea.rows = 2;
    const submit = el('button', 'gm-primary-btn');
    submit.type = 'submit';
    submit.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Ask';
    form.append(textarea, submit);
    panel.append(form);

    mount.replaceChildren(panel);

    /** @type {Array<{ id?: string, role: 'player' | 'gm', text: string, lore_id?: string | null, pending?: boolean }>} */
    let entries = [];
    let busy = false;

    function rerender() {
        transcriptEl.replaceChildren();
        undoBtn.disabled = busy || entries.length === 0 || entries.some(e => e.pending);
        if (entries.length === 0) {
            transcriptEl.append(elText('div', 'gm-ask-empty', 'No questions asked yet. Try "What do I know about the steward?" or "What\'s in the next room over?"'));
            return;
        }
        for (const ent of entries) {
            transcriptEl.append(renderEntry(campaign, ent, { onDeleteFrom, onRegenerate, busy }));
        }
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    function showError(message) {
        if (!message) {
            errorEl.style.display = 'none';
            errorEl.textContent = '';
            return;
        }
        errorEl.textContent = message;
        errorEl.style.display = '';
    }

    rerender();

    api.getAskTranscript(campaign.id)
        .then(loaded => {
            entries = Array.isArray(loaded) ? loaded.slice() : [];
            rerender();
        })
        .catch(err => {
            console.warn('[gm.ask] failed to load transcript', err);
            showError(`Couldn't load past Ask history: ${err?.message || err}`);
        });

    let abortAsk = null;

    async function submitQuestion(question) {
        if (busy) return;
        const text = String(question || '').trim();
        if (!text) return;

        const status = connectionStatus();
        if (!status.ok) {
            showError('No active LLM connection. Open the API panel to fix this first.');
            return;
        }
        const directorProfile = currentLlmProfile('director');
        if (!directorProfile) {
            showError('No active LLM profile. Open the API panel to select one.');
            return;
        }

        if (directorProfile.model && /^https?:\/\//i.test(directorProfile.model)) {
            showError('The Director model field contains a URL — it should be a model name. Check the TTRPG Tavern role-model settings in the API panel.');
            return;
        }

        showError('');
        busy = true;
        submit.disabled = true;
        textarea.disabled = true;

        const optimisticPlayer = { role: 'player', text, pending: true };
        entries.push(optimisticPlayer);
        const optimisticGm = { role: 'gm', text: '', pending: true };
        entries.push(optimisticGm);
        rerender();
        textarea.value = '';

        const controller = new AbortController();
        abortAsk = controller;

        try {
            const response = await api.postAsk(campaign.id, {
                question: text,
                director_profile: directorProfile,
            }, controller.signal);

            await consumeAskStream(response, optimisticPlayer, optimisticGm);
        } catch (err) {
            if (controller.signal.aborted) return;
            console.error('[gm.ask] submit failed', err);
            entries.splice(entries.length - 2, 2,
                { ...optimisticPlayer, pending: false },
            );
            rerender();
            const detail = err?.body?.details || err?.message || String(err);
            showError(`Ask failed: ${detail}`);
        } finally {
            abortAsk = null;
            busy = false;
            submit.disabled = false;
            textarea.disabled = false;
            textarea.focus();
        }
    }

    async function consumeAskStream(response, optimisticPlayer, optimisticGm) {
        if (!response.body) {
            showError('No response body from server.');
            return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let answered = false;
        let errorShown = false;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let ev;
                try { ev = JSON.parse(line); } catch { continue; }

                if (ev.kind === 'status') {
                    optimisticGm.text = `GM is ${ev.phase || 'thinking'}…`;
                    rerender();
                } else if (ev.kind === 'tool_step') {
                    optimisticGm.text = `[${ev.tool}] ${ev.summary || ''}`;
                    rerender();
                } else if (ev.kind === 'answer') {
                    answered = true;
                    const detail = ev.detail || {};
                    entries.splice(entries.length - 2, 2,
                        detail.player_entry || { ...optimisticPlayer, pending: false },
                        detail.gm_entry || { role: 'gm', text: ev.reply || '', lore_id: ev.lore_id, pending: false },
                    );
                    rerender();
                } else if (ev.kind === 'identity_edit_request') {
                    renderIdentityCard(ev.detail);
                } else if (ev.kind === 'error') {
                    errorShown = true;
                    if (!answered) {
                        entries.splice(entries.length - 2, 2,
                            { ...optimisticPlayer, pending: false },
                        );
                        rerender();
                    }
                    showError(`Ask error: ${ev.message || ev.code || 'unknown'}`);
                }
            }
        }

        if (!answered && !errorShown) {
            entries.splice(entries.length - 2, 2,
                { ...optimisticPlayer, pending: false },
            );
            rerender();
            showError('Ask loop ended without an answer.');
        }
    }

    function renderIdentityCard(detail) {
        if (!detail) return;
        const card = el('div', 'gm-ask-identity-card');
        card.innerHTML = `
            <div class="gm-ask-identity-card-title">Identity Change Request</div>
            <div class="gm-ask-identity-card-field"><strong>${detail.character_name || '?'}</strong> — ${detail.field}: "${detail.current_value || ''}" → "${detail.proposed_value || ''}"</div>
            ${detail.rationale ? `<div class="gm-ask-identity-card-rationale">${detail.rationale}</div>` : ''}
            <div class="gm-ask-identity-card-actions">
                <button class="gm-primary-btn gm-identity-approve">Approve</button>
                <button class="gm-secondary-btn gm-identity-reject">Reject</button>
            </div>
        `;
        card.querySelector('.gm-identity-approve')?.addEventListener('click', async () => {
            try {
                await api.patchCharacter(detail.character_id, { [detail.field]: detail.proposed_value });
                card.querySelector('.gm-ask-identity-card-actions').innerHTML = '<em>Approved</em>';
            } catch (err) {
                showError(`Identity update failed: ${err?.message || err}`);
            }
        });
        card.querySelector('.gm-identity-reject')?.addEventListener('click', () => {
            card.querySelector('.gm-ask-identity-card-actions').innerHTML = '<em>Rejected</em>';
        });
        transcriptEl.append(card);
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    async function undoLastExchange() {
        if (busy || entries.length === 0) return;
        showError('');
        busy = true;
        rerender();
        try {
            const result = await api.rewindAsk(campaign.id, { last: 2 });
            entries = Array.isArray(result.entries) ? result.entries.slice() : [];
            rerender();
        } catch (err) {
            showError(`Undo failed: ${err?.message || err}`);
        } finally {
            busy = false;
            rerender();
        }
    }

    async function onDeleteFrom(entryId) {
        if (busy || !entryId) return;
        showError('');
        busy = true;
        rerender();
        try {
            const result = await api.rewindAsk(campaign.id, { entry_id: entryId });
            entries = Array.isArray(result.entries) ? result.entries.slice() : [];
            rerender();
        } catch (err) {
            showError(`Delete failed: ${err?.message || err}`);
        } finally {
            busy = false;
            rerender();
        }
    }

    async function onRegenerate() {
        if (busy || entries.length === 0) return;
        const directorProfile = currentLlmProfile('director');
        if (!directorProfile) {
            showError('No active LLM profile.');
            return;
        }
        showError('');
        busy = true;
        submit.disabled = true;
        textarea.disabled = true;

        const optimisticGm = { role: 'gm', text: 'Regenerating…', pending: true };
        entries.push(optimisticGm);
        rerender();

        const controller = new AbortController();
        abortAsk = controller;

        try {
            const response = await api.regenerateAsk(campaign.id, {
                director_profile: directorProfile,
            }, controller.signal);
            const dummyPlayer = { role: 'player', text: '', pending: false };
            await consumeAskStream(response, dummyPlayer, optimisticGm);

            const loaded = await api.getAskTranscript(campaign.id);
            entries = Array.isArray(loaded) ? loaded.slice() : [];
            rerender();
        } catch (err) {
            if (controller.signal.aborted) return;
            entries.splice(entries.indexOf(optimisticGm), 1);
            rerender();
            showError(`Regenerate failed: ${err?.message || err}`);
        } finally {
            abortAsk = null;
            busy = false;
            submit.disabled = false;
            textarea.disabled = false;
            rerender();
        }
    }

    undoBtn.addEventListener('click', undoLastExchange);

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        submitQuestion(textarea.value);
    });
    textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            submitQuestion(textarea.value);
        }
    });

    setTimeout(() => textarea.focus(), 30);

    return () => {
        // Nothing global to unhook; replacing the mount is enough.
    };
}

/* -------- Renderers -------- */

function renderEntry(campaign, ent, actions = {}) {
    const wrap = el('div', `gm-ask-msg gm-ask-msg-${ent.role === 'gm' ? 'gm' : 'player'}${ent.pending ? ' gm-ask-msg-pending' : ''}`);

    const header = el('div', 'gm-ask-msg-header');
    header.append(elText('span', 'gm-ask-msg-role', ent.role === 'gm' ? 'GM' : 'You'));

    if (!ent.pending && ent.id && !actions.busy) {
        const rowActions = el('span', 'gm-ask-msg-actions');

        if (ent.role === 'gm' && actions.onRegenerate) {
            const regenBtn = el('button', 'gm-ask-row-btn');
            regenBtn.type = 'button';
            regenBtn.title = 'Regenerate this reply';
            regenBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
            regenBtn.addEventListener('click', () => actions.onRegenerate());
            rowActions.append(regenBtn);
        }

        if (actions.onDeleteFrom) {
            const delBtn = el('button', 'gm-ask-row-btn');
            delBtn.type = 'button';
            delBtn.title = 'Delete from here';
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.addEventListener('click', () => {
                if (confirm('Delete this entry and everything after it?')) {
                    actions.onDeleteFrom(ent.id);
                }
            });
            rowActions.append(delBtn);
        }
        header.append(rowActions);
    }

    wrap.append(header);

    const body = document.createElement('div');
    body.textContent = ent.pending && ent.role === 'gm' && !ent.text
        ? 'GM is thinking…'
        : (ent.text || '');
    wrap.append(body);
    if (ent.role === 'gm' && ent.lore_id) {
        wrap.append(buildLoreChip(campaign));
    }
    return wrap;
}

function buildLoreChip(campaign) {
    const chip = document.createElement('a');
    chip.className = 'gm-lore-chip';
    chip.href = '#';
    chip.innerHTML = '<i class="fa-solid fa-book-bookmark"></i> Recorded as world lore';
    chip.title = 'Open Memory Explorer';
    chip.addEventListener('click', (ev) => {
        ev.preventDefault();
        route({ view: 'memory', campaignId: campaign.id });
    });
    return chip;
}

function backButton(onBack) {
    const btn = el('button', 'gm-panel-back-btn');
    btn.type = 'button';
    btn.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to hub';
    btn.addEventListener('click', () => {
        if (typeof onBack === 'function') onBack();
    });
    return btn;
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
