/**
 * Character creation wizard (Phase 5: PC + NPC modes, KV stats step).
 *
 * Steps:
 *   PC mode  : Identity → Background → Stats → Confirm
 *   NPC mode : Identity → Stats → Confirm
 *
 * The Stats step pre-populates the KV grid from the campaign's active
 * ruleset (`GET /api/gm/rulesets/:id`). Each row is `key | value | delete`
 * and the user can add new rows. Empty values are dropped before submit.
 *
 * Submits to `POST /api/gm/campaigns/:cid/characters` with
 * `is_player: <true|false>` and `sheet.stats: <kv>`. Calls back with the
 * created character so the right-sidebar picker can add it as a
 * participant.
 */

import * as api from './api.js';
import { currentLlmProfile } from './llm-profile.js';

let activeOverlay = null;

/**
 * @param {string} campaignId
 * @param {(created?: any) => void} [onDone]
 * @param {{ mode?: 'pc' | 'npc' }} [options]
 */
export function openCharacterWizard(campaignId, onDone, options = {}) {
    closeWizard();

    const isNpc = options.mode === 'npc';

    const state = {
        step: 0,
        steps: isNpc ? ['Identity', 'Stats', 'Confirm'] : ['Identity', 'Background', 'Stats', 'Confirm'],
        isNpc,
        campaignId,
        name: '',
        appearance: '',
        personality: '',
        voice: '',
        background: '',
        /** @type {Array<{ key: string, value: string }>} */
        statRows: [],
        statsLoaded: false,
        rulesetId: null,
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
        // Lazy-load the starter stat pack just before the user sees the
        // Stats step. Falls back gracefully if the ruleset endpoint is
        // unreachable — the user can still type their own KVs.
        const stepName = state.steps[state.step];
        if (stepName === 'Stats' && !state.statsLoaded) {
            await loadStarterStats(state);
        }

        panel.replaceChildren(
            renderHeader(state),
            renderBody(state, renderStep),
            renderFooter(state, async () => {
                if (state.step < state.steps.length - 1) {
                    state.step++;
                    renderStep();
                    return;
                }
                try {
                    const stats = collectStats(state);
                    // Ship the active connection's director profile to the
                    // server so it can synthesise the opening "where things
                    // stand" snapshot in the same request when this is the
                    // freshly-created PC. Failure is non-fatal — Campaign
                    // Main shows a "Generate opening" affordance as the
                    // fallback.
                    const directorProfile = !state.isNpc ? currentLlmProfile('director') : null;
                    const out = await api.createCharacter(campaignId, {
                        name: state.name,
                        appearance: state.appearance,
                        personality: state.personality,
                        voice: state.voice,
                        background: state.background,
                        is_player: !state.isNpc,
                        sheet: Object.keys(stats).length ? { stats } : undefined,
                        ...(directorProfile ? { director_profile: directorProfile } : {}),
                    });
                    closeWizard();
                    if (onDone) onDone(out.character);
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

async function loadStarterStats(state) {
    state.statsLoaded = true;
    try {
        const campaign = await api.getCampaign(state.campaignId);
        if (!campaign) return;
        state.rulesetId = campaign.ruleset_id || 'dnd5e';
        const ruleset = await api.getRuleset(state.rulesetId);
        if (!ruleset) return;
        state.statRows = Object.entries(ruleset.starter_stats || {}).map(([key, value]) => ({
            key,
            value: String(value),
        }));
    } catch (err) {
        console.warn('[gm] loadStarterStats failed', err);
    }
}

function collectStats(state) {
    /** @type {Record<string, number | string>} */
    const out = {};
    for (const row of state.statRows) {
        const key = String(row.key || '').trim();
        if (!key) continue;
        const raw = String(row.value ?? '').trim();
        if (raw === '') continue;
        const num = Number(raw);
        if (!Number.isNaN(num) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
            out[key] = num;
        } else {
            out[key] = raw;
        }
    }
    return out;
}

function closeWizard() {
    if (activeOverlay && activeOverlay.parentNode) {
        activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
}

function renderHeader(state) {
    const head = el('div', 'gm-modal-header');
    const verb = state.isNpc ? 'Create NPC' : 'Create your character';
    const title = elText('h2', 'gm-modal-title', `${verb} — ${state.steps[state.step]}`);
    head.append(title);

    const dots = el('div', 'gm-wizard-dots');
    for (let i = 0; i < state.steps.length; i++) {
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
    const stepName = state.steps[state.step];

    if (stepName === 'Identity') {
        body.append(
            field('Name', textInput(state, 'name', { placeholder: state.isNpc ? 'e.g. Amelia Verra' : 'e.g. Jack Ironwright', maxlength: 80 })),
            field('Appearance', textArea(state, 'appearance', {
                placeholder: state.isNpc
                    ? 'A weathered tavern keeper with a short grey beard and a steady gaze.'
                    : 'Tall and broad-shouldered, with sun-bleached hair and a long scar along the jaw.',
                rows: 3,
            })),
            field('Personality', textArea(state, 'personality', {
                placeholder: state.isNpc
                    ? 'Patient and shrewd. Reads strangers fast.'
                    : 'Soft-spoken in calm rooms, fast and final under pressure. Old loyalties die hard.',
                rows: 3,
            })),
            field('Voice', textInput(state, 'voice', {
                placeholder: state.isNpc
                    ? 'Warm and slow; the cadence of someone who has heard every excuse.'
                    : 'Low and clipped; rare laughter; idioms from the river country.',
            })),
        );
    } else if (stepName === 'Background') {
        const intro = el('p', 'gm-modal-intro');
        intro.innerHTML = 'A few paragraphs work best. <strong>This seeds the world</strong> — the Director will draw locations, NPCs, and recurring threads from what you write here.';
        body.append(intro);
        body.append(field('Background', textArea(state, 'background', {
            placeholder: 'Where does your character come from? What did they leave behind, and what brings them here? What do they hope for, and what do they fear?',
            rows: 12,
        })));
    } else if (stepName === 'Stats') {
        const intro = el('p', 'gm-modal-intro');
        intro.innerHTML = `Stats are key-value pairs. Pre-filled from the campaign's <strong>${state.rulesetId || 'ruleset'}</strong> starter pack — keep, edit, delete, or add new keys as you like.`;
        body.append(intro);
        body.append(renderStatsGrid(state, rerender));
    } else if (stepName === 'Confirm') {
        body.append(elText('h3', 'gm-modal-section-title', state.name || '(unnamed)'));
        body.append(detail('Appearance', state.appearance));
        body.append(detail('Personality', state.personality));
        body.append(detail('Voice', state.voice));
        if (!state.isNpc) body.append(detail('Background', state.background));
        const stats = collectStats(state);
        if (Object.keys(stats).length) {
            body.append(elText('h4', 'gm-modal-subsection', 'Stats'));
            const grid = el('div', 'gm-stats-grid');
            for (const [k, v] of Object.entries(stats)) {
                const cell = el('div', 'gm-stats-cell');
                cell.append(elText('div', 'gm-stats-key', k));
                cell.append(elText('div', 'gm-stats-value', String(v)));
                grid.append(cell);
            }
            body.append(grid);
        }
        const note = el('p', 'gm-modal-note');
        note.textContent = state.isNpc
            ? 'You can edit this NPC\'s sheet anytime from the in-scene roster.'
            : 'You can edit any stat from the sheet panel after creation.';
        body.append(note);
    }
    return body;
}

function renderStatsGrid(state, rerender) {
    const wrap = el('div', 'gm-kv-editor');

    const renderRows = () => {
        wrap.replaceChildren();
        for (let i = 0; i < state.statRows.length; i++) {
            const row = state.statRows[i];
            const rowEl = el('div', 'gm-kv-row');

            const keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.className = 'gm-modal-input gm-kv-input';
            keyInput.placeholder = 'key';
            keyInput.value = row.key;
            keyInput.addEventListener('input', () => { row.key = keyInput.value; });

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.className = 'gm-modal-input gm-kv-input';
            valueInput.placeholder = 'value';
            valueInput.value = row.value;
            valueInput.addEventListener('input', () => { row.value = valueInput.value; });

            const removeBtn = el('button', 'gm-icon-btn');
            removeBtn.type = 'button';
            removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            removeBtn.addEventListener('click', () => {
                state.statRows.splice(i, 1);
                renderRows();
            });

            rowEl.append(keyInput, valueInput, removeBtn);
            wrap.append(rowEl);
        }

        const addRow = el('button', 'gm-secondary-btn gm-kv-add');
        addRow.type = 'button';
        addRow.innerHTML = '<i class="fa-solid fa-plus"></i> Add stat';
        addRow.addEventListener('click', () => {
            state.statRows.push({ key: '', value: '' });
            renderRows();
        });
        wrap.append(addRow);
    };

    renderRows();
    return wrap;
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
    const isFinal = state.step === state.steps.length - 1;
    next.textContent = isFinal ? (state.isNpc ? 'Create NPC' : 'Create character') : 'Next';
    next.disabled = !canAdvance(state);
    next.addEventListener('click', onNext);
    foot.append(next);
    return foot;
}

function canAdvance(state) {
    const stepName = state.steps[state.step];
    if (stepName === 'Identity') return state.name.trim().length > 0;
    if (stepName === 'Background') return state.background.trim().length > 0;
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
