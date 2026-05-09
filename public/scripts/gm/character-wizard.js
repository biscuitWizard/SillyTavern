/**
 * PC creation wizard.
 *
 * Three steps: Identity → Background → Confirm. The "important" fields are
 * narrative (name, appearance, personality, voice, background); stats/skills
 * default to 5e baselines and are editable later in the sheet panel.
 *
 * Submits to `POST /api/gm/campaigns/:cid/characters`. After success, calls
 * `onDone()` so the caller can re-render whatever surface invoked the wizard.
 */

import * as api from './api.js';

let activeOverlay = null;

/**
 * @param {string} campaignId
 * @param {() => void} [onDone]
 */
export function openCharacterWizard(campaignId, onDone) {
    closeWizard();

    const state = {
        step: 0,
        name: '',
        appearance: '',
        personality: '',
        voice: '',
        background: '',
    };

    const overlay = el('div', 'gm-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeWizard();
    });
    const panel = el('div', 'gm-modal gm-wizard');
    overlay.append(panel);
    document.body.append(overlay);
    activeOverlay = overlay;

    const renderStep = async () => {
        panel.replaceChildren(
            renderHeader(state),
            renderBody(state, renderStep),
            renderFooter(state, async () => {
                if (state.step < 2) {
                    state.step++;
                    renderStep();
                    return;
                }
                try {
                    await api.createCharacter(campaignId, {
                        name: state.name,
                        appearance: state.appearance,
                        personality: state.personality,
                        voice: state.voice,
                        background: state.background,
                    });
                    closeWizard();
                    if (onDone) onDone();
                } catch (err) {
                    console.error('[gm] createCharacter failed', err);
                    alert(`Could not create character: ${err?.message || err}`);
                }
            }, () => {
                if (state.step > 0) {
                    state.step--;
                    renderStep();
                }
            }),
        );
    };

    renderStep();
}

function closeWizard() {
    if (activeOverlay && activeOverlay.parentNode) {
        activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
}

const STEP_TITLES = ['Identity', 'Background', 'Confirm'];

function renderHeader(state) {
    const head = el('div', 'gm-modal-header');
    const title = elText('h2', 'gm-modal-title', `Create your character — ${STEP_TITLES[state.step]}`);
    head.append(title);

    const dots = el('div', 'gm-wizard-dots');
    for (let i = 0; i < STEP_TITLES.length; i++) {
        const d = el('span', `gm-wizard-dot ${i === state.step ? 'active' : ''} ${i < state.step ? 'done' : ''}`);
        dots.append(d);
    }
    head.append(dots);

    const close = el('button', 'gm-icon-btn');
    close.type = 'button';
    close.innerHTML = '<i class="fa-solid fa-times"></i>';
    close.addEventListener('click', closeWizard);
    head.append(close);
    return head;
}

function renderBody(state, rerender) {
    const body = el('div', 'gm-modal-body');
    if (state.step === 0) {
        body.append(
            field('Name', textInput(state, 'name', { placeholder: 'e.g. Jack Ironwright', maxlength: 80 })),
            field('Appearance', textArea(state, 'appearance', {
                placeholder: 'Tall and broad-shouldered, with sun-bleached hair and a long scar along the jaw.',
                rows: 3,
            })),
            field('Personality', textArea(state, 'personality', {
                placeholder: 'Soft-spoken in calm rooms, fast and final under pressure. Old loyalties die hard.',
                rows: 3,
            })),
            field('Voice', textInput(state, 'voice', {
                placeholder: 'Low and clipped; rare laughter; idioms from the river country.',
            })),
        );
    } else if (state.step === 1) {
        const intro = el('p', 'gm-modal-intro');
        intro.innerHTML = 'A few paragraphs work best. <strong>This seeds the world</strong> — the Director will draw locations, NPCs, and recurring threads from what you write here.';
        body.append(intro);
        body.append(field('Background', textArea(state, 'background', {
            placeholder: 'Where does your character come from? What did they leave behind, and what brings them here? What do they hope for, and what do they fear?',
            rows: 12,
        })));
    } else {
        body.append(elText('h3', 'gm-modal-section-title', state.name || '(unnamed)'));
        body.append(detail('Appearance', state.appearance));
        body.append(detail('Personality', state.personality));
        body.append(detail('Voice', state.voice));
        body.append(detail('Background', state.background));
        const note = el('p', 'gm-modal-note');
        note.innerHTML = 'Starting stats default to 5e baselines (10 in every ability score, HP 10, AC 10, proficiency bonus 2). You can edit them from the sheet panel after creation.';
        body.append(note);
    }
    return body;
}

function renderFooter(state, onNext, onBack) {
    const foot = el('div', 'gm-modal-footer');

    const back = el('button', 'gm-secondary-btn');
    back.type = 'button';
    back.textContent = 'Back';
    back.disabled = state.step === 0;
    back.addEventListener('click', onBack);
    foot.append(back);

    const next = el('button', 'gm-primary-btn');
    next.type = 'button';
    next.textContent = state.step < 2 ? 'Next' : 'Create character';
    next.disabled = !canAdvance(state);
    next.addEventListener('click', onNext);
    foot.append(next);
    return foot;
}

function canAdvance(state) {
    if (state.step === 0) return state.name.trim().length > 0;
    if (state.step === 1) return state.background.trim().length > 0;
    return true;
}

function field(label, input) {
    const wrap = el('label', 'gm-modal-field');
    wrap.append(elText('span', 'gm-modal-field-label', label));
    wrap.append(input);
    return wrap;
}

function detail(label, value) {
    const wrap = el('div', 'gm-modal-detail');
    wrap.append(elText('div', 'gm-modal-detail-label', label));
    const body = el('div', 'gm-modal-detail-body');
    body.textContent = value || '(empty)';
    wrap.append(body);
    return wrap;
}

function textInput(state, key, { placeholder = '', maxlength } = {}) {
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'gm-modal-input';
    i.placeholder = placeholder;
    if (maxlength) i.maxLength = maxlength;
    i.value = state[key] || '';
    i.addEventListener('input', () => {
        state[key] = i.value;
        const next = i.closest('.gm-modal')?.querySelector('.gm-modal-footer .gm-primary-btn');
        if (next instanceof HTMLButtonElement) next.disabled = !canAdvance(state);
    });
    return i;
}

function textArea(state, key, { placeholder = '', rows = 4 } = {}) {
    const t = document.createElement('textarea');
    t.className = 'gm-modal-textarea';
    t.placeholder = placeholder;
    t.rows = rows;
    t.value = state[key] || '';
    t.addEventListener('input', () => {
        state[key] = t.value;
        const next = t.closest('.gm-modal')?.querySelector('.gm-modal-footer .gm-primary-btn');
        if (next instanceof HTMLButtonElement) next.disabled = !canAdvance(state);
    });
    return t;
}

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
