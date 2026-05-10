/**
 * Plot panel — declared-action gate for Campaign Main.
 *
 * The player describes what their character intends to do; the GM either
 * pushes back with one concrete reason (and the player edits + retries
 * inside the panel) or starts a new scene and the panel routes the
 * player into the scene view. The new scene's transcript already carries
 * the GM's `opening_pose` as a seeded narrator line so the scene loads
 * grounded.
 *
 * The panel stays inside the Campaign Main body; it does NOT toggle
 * `body.tt-mode-scene` (which is reserved for actual scenes).
 */

import * as api from './api.js';
import { route } from './router.js';
import { currentLlmProfile, connectionStatus } from './llm-profile.js';

/**
 * Render the Plot panel into `mount`. Returns a teardown function the
 * caller can use to unhook listeners on navigation away. The mount is
 * fully replaced.
 *
 * @param {HTMLElement} mount
 * @param {{ campaign: any, player: any, onBack: () => void }} args
 * @returns {() => void}
 */
export function renderPlotPanel(mount, { campaign, player, onBack }) {
    const panel = el('div', 'gm-plot-panel');

    const head = el('div', 'gm-plot-panel-head');
    const titleWrap = el('div');
    titleWrap.append(elText('h2', 'gm-plot-panel-title', 'Take action'));
    const blurb = el('p', 'gm-plot-panel-blurb');
    blurb.textContent = 'Tell the GM what your character wants to do, say, or attempt next. They\'ll either push back with a reason or set the scene so you can play it out.';
    titleWrap.append(blurb);
    head.append(titleWrap, backButton(onBack));
    panel.append(head);

    const errorEl = el('div', 'gm-plot-error');
    errorEl.style.display = 'none';
    panel.append(errorEl);

    const form = el('form', 'gm-plot-form');
    const label = el('label');
    label.textContent = `What does ${player?.name || 'your character'} do, say, or attempt next?`;
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'e.g. "I duck behind the wagon and try to read the steward\'s lips through the gate slats."';
    label.append(textarea);
    form.append(label);

    const formActions = el('div', 'gm-plot-form-actions');
    const submitBtn = el('button', 'gm-primary-btn');
    submitBtn.type = 'submit';
    submitBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Run it by the GM';
    formActions.append(submitBtn);
    form.append(formActions);

    panel.append(form);

    const resultHost = el('div', 'gm-plot-result-host');
    panel.append(resultHost);

    mount.replaceChildren(panel);

    let busy = false;

    function showError(message) {
        if (!message) {
            errorEl.style.display = 'none';
            errorEl.textContent = '';
            return;
        }
        errorEl.textContent = message;
        errorEl.style.display = '';
    }

    function showSpinner() {
        const spinner = el('div', 'gm-plot-result');
        spinner.append(elHTML('div', 'gm-plot-result-spinner', '<i class="fa-solid fa-circle-notch fa-spin"></i> The GM is considering your move…'));
        resultHost.replaceChildren(spinner);
    }

    function clearResult() {
        resultHost.replaceChildren();
    }

    function showPushback(reason) {
        const card = el('div', 'gm-plot-result is-pushback');
        const head = elHTML('div', 'gm-plot-result-head', '<i class="fa-solid fa-hand"></i> The GM pushes back');
        const body = elText('p', 'gm-plot-result-body', reason || 'The GM declined to start a scene.');
        const actions = el('div', 'gm-plot-result-actions');

        const editBtn = el('button', 'gm-secondary-btn');
        editBtn.type = 'button';
        editBtn.innerHTML = '<i class="fa-solid fa-pen"></i> Edit & resubmit';
        editBtn.addEventListener('click', () => {
            clearResult();
            textarea.focus();
        });

        const dismissBtn = el('button', 'gm-secondary-btn');
        dismissBtn.type = 'button';
        dismissBtn.textContent = 'Back';
        dismissBtn.addEventListener('click', () => {
            clearResult();
        });

        actions.append(editBtn, dismissBtn);
        card.append(head, body, actions);
        resultHost.replaceChildren(card);
    }

    function showSceneStarting(result) {
        const card = el('div', 'gm-plot-result is-start');
        const headEl = elHTML('div', 'gm-plot-result-head', '<i class="fa-solid fa-play"></i> Scene starting…');
        const body = elText('p', 'gm-plot-result-body', result.opening_pose || '');
        card.append(headEl, body);
        if (Array.isArray(result.suggested_unknown) && result.suggested_unknown.length) {
            const note = el('div', 'gm-plot-result-spinner');
            note.innerHTML = `<i class="fa-solid fa-info-circle"></i> Suggested NPCs not yet on the campaign roster: <em>${escapeHtml(result.suggested_unknown.join(', '))}</em>`;
            card.append(note);
        }
        resultHost.replaceChildren(card);
        // Route into the scene shortly after so the player sees the
        // "starting" beat and the GM's pose before the scene view paints.
        setTimeout(() => {
            route({ view: 'scene', campaignId: campaign.id, sceneId: result.scene_id });
        }, 600);
    }

    async function submitIntent(intent) {
        if (busy) return;
        const text = String(intent || '').trim();
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
        submitBtn.disabled = true;
        textarea.disabled = true;
        showSpinner();

        try {
            const result = await api.postPlot(campaign.id, {
                intent: text,
                director_profile: directorProfile,
            });
            if (result.decision === 'start_scene') {
                showSceneStarting(result);
            } else {
                showPushback(result.reason);
                busy = false;
                submitBtn.disabled = false;
                textarea.disabled = false;
            }
        } catch (err) {
            console.error('[gm.plot] submit failed', err);
            clearResult();
            showError(`Plot mode failed: ${err?.message || err}`);
            busy = false;
            submitBtn.disabled = false;
            textarea.disabled = false;
        }
    }

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        submitIntent(textarea.value);
    });
    textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            submitIntent(textarea.value);
        }
    });

    setTimeout(() => textarea.focus(), 30);

    return () => {
        // Nothing global to unhook.
    };
}

/* -------- Renderers / helpers -------- */

function backButton(onBack) {
    const btn = el('button', 'gm-panel-back-btn');
    btn.type = 'button';
    btn.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to hub';
    btn.addEventListener('click', () => {
        if (typeof onBack === 'function') onBack();
    });
    return btn;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[c] || c));
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

function elHTML(tag, className, html) {
    const node = el(tag, className);
    node.innerHTML = html;
    return node;
}
