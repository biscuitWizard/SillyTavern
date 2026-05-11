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
    head.append(titleWrap, backButton(onBack));
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
        if (entries.length === 0) {
            transcriptEl.append(elText('div', 'gm-ask-empty', 'No questions asked yet. Try "What do I know about the steward?" or "What\'s in the next room over?"'));
            return;
        }
        for (const ent of entries) transcriptEl.append(renderEntry(campaign, ent));
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

        try {
            const result = await api.postAsk(campaign.id, {
                question: text,
                director_profile: directorProfile,
            });
            // Replace optimistic placeholders with the real persisted entries.
            entries.splice(entries.length - 2, 2,
                result.entries.player,
                result.entries.gm,
            );
            rerender();
        } catch (err) {
            console.error('[gm.ask] submit failed', err);
            // Drop the optimistic GM placeholder so the player line stays
            // visible (the player's question was already persisted on the
            // server before the LLM call).
            entries.splice(entries.length - 2, 2,
                { ...optimisticPlayer, pending: false },
            );
            rerender();
            const detail = err?.body?.details || err?.message || String(err);
            showError(`Ask failed: ${detail}`);
        } finally {
            busy = false;
            submit.disabled = false;
            textarea.disabled = false;
            textarea.focus();
        }
    }

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

function renderEntry(campaign, ent) {
    const wrap = el('div', `gm-ask-msg gm-ask-msg-${ent.role === 'gm' ? 'gm' : 'player'}${ent.pending ? ' gm-ask-msg-pending' : ''}`);
    wrap.append(elText('div', 'gm-ask-msg-role', ent.role === 'gm' ? 'GM' : 'You'));
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
