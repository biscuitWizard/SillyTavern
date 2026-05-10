/**
 * Character creation wizard (M6: layout-driven steps).
 *
 * The wizard now generates its steps from the campaign's merged
 * `SheetLayout` (M1) instead of a single hardcoded "Stats" step.
 *
 * Step order:
 *   1. **Identity** (always)             — name, appearance, personality, voice.
 *   2. **Background** (PC only)          — long textarea seeding the world.
 *   3. **Per layout category**           — every category with `wizard_step: true`
 *                                           (see `data/sheet-layouts/*.yaml`)
 *                                           gets its own step rendered through
 *                                           the shared `sheet-renderer.js` helper
 *                                           in `mode: 'wizard'`.
 *   4. **Confirm** (always)              — re-renders every wizard-step category
 *                                           through the SAME helper in
 *                                           `mode: 'preview'`, so the user sees
 *                                           the categorized sheet exactly the way
 *                                           the panel will after creation.
 *
 * Categories without `wizard_step: true` (e.g. Skills if the layout
 * doesn't opt them in) DO NOT get a wizard step. They still render in
 * the post-creation sheet panel because the sheet panel walks the full
 * layout.
 *
 * Relationships are intentionally NOT collected in the wizard even when
 * a `kind: relationships` category is flagged `wizard_step: true` — the
 * step renders a "you'll set up relationships after creation" notice
 * (per the M6 brief and §"Wizard state" of the plan). The relationships
 * editor lands in M7 inside `sheet-panel.js`.
 *
 * Layout fetch:
 *   - On open, fetch `getCampaign(campaignId)` to grab `ruleset_id`.
 *   - Then `Promise.all([getRuleset(rulesetId), getSheetLayout(rulesetId)])`.
 *   - If the layout fetch returns null (older ruleset on disk, or the
 *     ruleset has no `sheet_layout.yaml`), the wizard falls back to the
 *     legacy single-Stats KV step so older campaigns still work.
 *
 * Submit shape (POST `/api/gm/campaigns/:cid/characters`):
 *   {
 *     name, appearance, personality, voice,
 *     background?            // omitted in npc mode
 *     is_player: <true|false>,
 *     sheet?: { stats?, statuses?, items?, skills?, notes? },
 *     director_profile?      // PC + currentLlmProfile('director') set
 *   }
 *
 * Empty bags (`stats: {}` etc.) are dropped to match today's
 * "drop sheet entirely when stats is empty" behavior.
 */

import * as api from './api.js';
import { currentLlmProfile } from './llm-profile.js';
import { renderCategorySection } from './sheet-renderer.js';

let activeOverlay = null;

/**
 * @param {string} campaignId
 * @param {(created?: any) => void} [onDone]
 * @param {{ mode?: 'pc' | 'npc' }} [options]
 */
export function openCharacterWizard(campaignId, onDone, options = {}) {
    closeWizard();

    const isNpc = options.mode === 'npc';

    /**
     * Wizard draft state. Bags for stats/statuses/items/skills/notes are
     * filled from layout defaults + ruleset starter pack when the layout
     * arrives. Until then we keep the "Loading layout…" surface.
     */
    const state = {
        step: 0,
        /** @type {Array<{ id: string, label: string, kind: string, category?: any }>} */
        steps: [],
        isNpc,
        campaignId,
        // Identity
        name: '',
        appearance: '',
        personality: '',
        voice: '',
        background: '',
        // Sheet bags (filled from layout defaults + ruleset starter pack)
        /** @type {Record<string, number | string>} */
        stats: {},
        /** @type {Record<string, string>} */
        statuses: {},
        /** @type {Array<{ name: string, description: string, influences: any[] }>} */
        items: [],
        /** @type {string[]} */
        skills: [],
        /** @type {string} */
        notes: '',
        // Loaded layout / ruleset
        /** @type {string | null} */
        rulesetId: null,
        /** @type {any | null} */
        ruleset: null,
        /** @type {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout | null} */
        layout: null,
        layoutLoaded: false,
        // Legacy fallback: KV editor state (only populated when layout is null).
        /** @type {Array<{ key: string, value: string }>} */
        statRows: [],
    };

    const overlay = el('div', 'gm-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeWizard();
    });
    const panel = el('div', 'gm-modal gm-wizard');
    overlay.append(panel);
    document.body.append(overlay);
    activeOverlay = overlay;

    const rerender = () => {
        const stepDef = state.steps[state.step] || { label: '…', kind: 'identity', id: 'identity' };
        panel.replaceChildren(
            renderHeader(state, stepDef),
            renderBody(state, rerender),
            renderFooter(state, async () => {
                if (state.step < state.steps.length - 1) {
                    state.step++;
                    rerender();
                    return;
                }
                await submit(state, onDone);
            }, () => {
                if (state.step > 0) {
                    state.step--;
                    rerender();
                }
            }),
        );
    };

    // Show identity immediately while the layout loads in the
    // background; rebuild the step list once both ruleset + layout
    // resolve. This avoids a "Loading…" splash on the first step.
    state.steps = buildStepDefs(state);
    rerender();
    loadLayout(state).finally(() => {
        // Snapshot the user's progress before the step list changes so
        // we can re-anchor their position relative to identity /
        // background, which are stable.
        const wasOnIdentity = state.steps[state.step]?.kind === 'identity';
        const wasOnBackground = state.steps[state.step]?.kind === 'background';
        state.steps = buildStepDefs(state);
        if (wasOnIdentity) state.step = 0;
        else if (wasOnBackground) state.step = state.steps.findIndex(s => s.kind === 'background');
        // Clamp; the step count may have changed.
        state.step = Math.max(0, Math.min(state.step, state.steps.length - 1));
        rerender();
    });
}

/**
 * Compute the active step list given the loaded layout (or absence of
 * one). Used both at open-time (with an empty layout) and again after
 * the fetch completes.
 *
 * @param {any} state
 */
function buildStepDefs(state) {
    /** @type {Array<{ id: string, label: string, kind: string, category?: any }>} */
    const steps = [];
    steps.push({ id: 'identity', label: 'Identity', kind: 'identity' });
    if (!state.isNpc) steps.push({ id: 'background', label: 'Background', kind: 'background' });

    if (state.layoutLoaded && state.layout && Array.isArray(state.layout.categories)) {
        for (const category of state.layout.categories) {
            if (!category || !category.wizard_step) continue;
            steps.push({
                id: `cat-${category.id || category.label}`,
                label: category.label || category.id || 'Category',
                kind: 'category',
                category,
            });
        }
    } else if (state.layoutLoaded) {
        // No layout on disk — fall back to today's single Stats step.
        steps.push({ id: 'legacy-stats', label: 'Stats', kind: 'legacy-stats' });
    }

    steps.push({ id: 'confirm', label: 'Confirm', kind: 'confirm' });
    return steps;
}

/**
 * Fetch the campaign, ruleset, and layout. Seeds sheet bags from layout
 * defaults + ruleset starter_stats (per-field default wins for fields
 * the layout knows; ruleset starter wins for keys the layout doesn't
 * claim). Failures are non-fatal: we flag `layoutLoaded` so the step
 * list can fall back to the legacy single-Stats path.
 *
 * @param {any} state
 */
async function loadLayout(state) {
    try {
        const campaign = await api.getCampaign(state.campaignId);
        if (campaign) state.rulesetId = campaign.ruleset_id || 'dnd5e';
        if (!state.rulesetId) {
            state.layoutLoaded = true;
            return;
        }
        const [ruleset, layout] = await Promise.all([
            api.getRuleset(state.rulesetId).catch(err => {
                console.warn('[gm.wizard] getRuleset failed', err);
                return null;
            }),
            api.getSheetLayout(state.rulesetId).catch(err => {
                console.warn('[gm.wizard] getSheetLayout failed', err);
                return null;
            }),
        ]);
        state.ruleset = ruleset || null;
        state.layout = layout || null;
        state.stats = seedStats(layout, ruleset);
        state.statuses = seedStatuses(layout);
        if (!state.layout) {
            // Legacy fallback path: seed the KV grid from the ruleset's
            // starter pack so the user can still hand-edit a flat KV
            // bag, exactly like today.
            state.statRows = Object.entries(ruleset?.starter_stats || {}).map(([key, value]) => ({
                key,
                value: String(value),
            }));
        }
    } catch (err) {
        console.warn('[gm.wizard] loadLayout crashed; falling back to legacy stats step', err);
        state.layout = null;
    } finally {
        state.layoutLoaded = true;
    }
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout | null} layout
 * @param {any | null} ruleset
 * @returns {Record<string, number | string>}
 */
function seedStats(layout, ruleset) {
    /** @type {Record<string, number | string>} */
    const out = {};
    /** @type {Set<string>} */
    const claimed = new Set();
    if (layout && Array.isArray(layout.categories)) {
        for (const cat of layout.categories) {
            if (!cat || cat.kind !== 'stats') continue;
            for (const field of (cat.fields || [])) {
                if (!field || !field.key) continue;
                claimed.add(field.key);
                if (field.paired_with?.key) claimed.add(field.paired_with.key);
                if (field.default !== undefined && out[field.key] === undefined) {
                    out[field.key] = field.default;
                }
                if (field.paired_with?.key && field.paired_with.default !== undefined && out[field.paired_with.key] === undefined) {
                    out[field.paired_with.key] = field.paired_with.default;
                }
            }
        }
    }
    if (ruleset && ruleset.starter_stats && typeof ruleset.starter_stats === 'object') {
        for (const [k, v] of Object.entries(ruleset.starter_stats)) {
            if (!claimed.has(k) && out[k] === undefined) out[k] = v;
        }
    }
    return out;
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout | null} layout
 * @returns {Record<string, string>}
 */
function seedStatuses(layout) {
    /** @type {Record<string, string>} */
    const out = {};
    if (layout && Array.isArray(layout.categories)) {
        for (const cat of layout.categories) {
            if (!cat || cat.kind !== 'statuses') continue;
            for (const field of (cat.fields || [])) {
                if (!field || !field.key) continue;
                if (field.default !== undefined && out[field.key] === undefined) {
                    out[field.key] = String(field.default);
                }
            }
        }
    }
    return out;
}

/* -------- Submit -------- */

async function submit(state, onDone) {
    try {
        const directorProfile = !state.isNpc ? currentLlmProfile('director') : null;
        const sheetPayload = buildSheetPayload(state);

        /** @type {any} */
        const body = {
            name: state.name,
            appearance: state.appearance,
            personality: state.personality,
            voice: state.voice,
            is_player: !state.isNpc,
        };
        if (!state.isNpc) body.background = state.background;
        if (sheetPayload) body.sheet = sheetPayload;
        if (directorProfile) body.director_profile = directorProfile;

        const out = await api.createCharacter(state.campaignId, body);
        closeWizard();
        if (onDone) onDone(out.character);
    } catch (err) {
        console.error('[gm.wizard] createCharacter failed', err);
        alert(`Could not create character: ${err?.message || err}`);
    }
}

/**
 * Compose the request body's `sheet` field, dropping any empty bag.
 * Matches today's behavior of omitting `sheet` entirely when nothing
 * is populated.
 *
 * @param {any} state
 * @returns {object | undefined}
 */
function buildSheetPayload(state) {
    /** @type {any} */
    const sheet = {};
    let hasAny = false;

    if (state.layout) {
        const stats = collectStatsFromLayout(state);
        if (Object.keys(stats).length) { sheet.stats = stats; hasAny = true; }
        const statuses = collectStatusesFromState(state);
        if (Object.keys(statuses).length) { sheet.statuses = statuses; hasAny = true; }
        if (Array.isArray(state.items) && state.items.length) {
            sheet.items = state.items.map(it => ({
                name: String(it.name ?? '').trim(),
                description: String(it.description ?? '').trim(),
                influences: Array.isArray(it.influences) ? it.influences : [],
            })).filter(it => it.name.length > 0);
            if (sheet.items.length) hasAny = true; else delete sheet.items;
        }
        if (Array.isArray(state.skills) && state.skills.length) {
            sheet.skills = [...new Set(state.skills.map(s => String(s)))];
            hasAny = true;
        }
        if (typeof state.notes === 'string' && state.notes.trim().length) {
            sheet.notes = state.notes;
            hasAny = true;
        }
    } else {
        const stats = collectStatsFromLegacy(state);
        if (Object.keys(stats).length) { sheet.stats = stats; hasAny = true; }
    }

    return hasAny ? sheet : undefined;
}

/**
 * @param {any} state
 * @returns {Record<string, number | string>}
 */
function collectStatsFromLayout(state) {
    const bag = state.stats || {};
    /** @type {Record<string, number | string>} */
    const out = {};
    for (const [k, v] of Object.entries(bag)) {
        if (v === undefined || v === null) continue;
        const raw = typeof v === 'number' ? v : String(v);
        if (typeof raw === 'string') {
            if (raw === '') continue;
            // Coerce numeric-looking strings like "10" back to numbers
            // so the server's starter-stats merge path stores them as
            // numbers (matches the legacy KV path's behavior).
            if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
                const num = Number(raw);
                if (!Number.isNaN(num)) {
                    out[k] = num;
                    continue;
                }
            }
            out[k] = raw;
        } else {
            out[k] = raw;
        }
    }
    return out;
}

/**
 * @param {any} state
 * @returns {Record<string, string>}
 */
function collectStatusesFromState(state) {
    const bag = state.statuses || {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(bag)) {
        if (v === undefined || v === null) continue;
        const raw = String(v);
        if (raw === '') continue;
        out[k] = raw;
    }
    return out;
}

/**
 * Legacy fallback: parse the KV grid the same way the pre-M6 wizard did.
 *
 * @param {any} state
 * @returns {Record<string, number | string>}
 */
function collectStatsFromLegacy(state) {
    /** @type {Record<string, number | string>} */
    const out = {};
    for (const row of state.statRows || []) {
        const key = String(row.key || '').trim();
        if (!key) continue;
        const raw = String(row.value ?? '').trim();
        if (raw === '') continue;
        if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
            const num = Number(raw);
            if (!Number.isNaN(num)) {
                out[key] = num;
                continue;
            }
        }
        out[key] = raw;
    }
    return out;
}

/* -------- Header / footer / overlay -------- */

function closeWizard() {
    if (activeOverlay && activeOverlay.parentNode) {
        activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
}

function renderHeader(state, stepDef) {
    const head = el('div', 'gm-modal-header');
    const verb = state.isNpc ? 'Create NPC' : 'Create your character';
    head.append(elText('h2', 'gm-modal-title', `${verb} — ${stepDef.label}`));

    const dots = el('div', 'gm-wizard-dots');
    for (let i = 0; i < state.steps.length; i++) {
        const d = el('span',
            `gm-wizard-dot ${i === state.step ? 'active' : ''} ${i < state.step ? 'done' : ''}`);
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
    const stepDef = state.steps[state.step];
    if (!stepDef) return false;
    if (stepDef.kind === 'identity') return state.name.trim().length > 0;
    if (stepDef.kind === 'background') return state.background.trim().length > 0;
    return true;
}

/* -------- Body -------- */

function renderBody(state, rerender) {
    const body = el('div', 'gm-modal-body');
    const stepDef = state.steps[state.step];
    if (!stepDef) {
        body.append(elText('p', 'gm-modal-detail-body', 'Loading…'));
        return body;
    }

    switch (stepDef.kind) {
        case 'identity':
            renderIdentityStep(body, state);
            return body;
        case 'background':
            renderBackgroundStep(body, state);
            return body;
        case 'category':
            renderCategoryStep(body, state, stepDef.category);
            return body;
        case 'legacy-stats':
            renderLegacyStatsStep(body, state, rerender);
            return body;
        case 'confirm':
            renderConfirmStep(body, state);
            return body;
        default:
            body.append(elText('p', 'gm-modal-detail-body', `(unknown step: ${String(stepDef.kind)})`));
            return body;
    }
}

function renderIdentityStep(body, state) {
    body.append(
        field('Name', textInput(state, 'name', {
            placeholder: state.isNpc ? 'e.g. Amelia Verra' : 'e.g. Jack Ironwright',
            maxlength: 80,
        })),
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
}

function renderBackgroundStep(body, state) {
    const intro = el('p', 'gm-modal-intro');
    intro.innerHTML = 'A few paragraphs work best. <strong>This seeds the world</strong> — the Director will draw locations, NPCs, and recurring threads from what you write here.';
    body.append(intro);
    body.append(field('Background', textArea(state, 'background', {
        placeholder: 'Where does your character come from? What did they leave behind, and what brings them here? What do they hope for, and what do they fear?',
        rows: 12,
    })));
}

/**
 * Render one layout-driven step. Builds a `RenderOptions` bag bound to
 * the wizard's in-memory `state` and delegates to the shared renderer
 * in `mode: 'wizard'`.
 *
 * @param {HTMLElement} body
 * @param {any} state
 * @param {any} category
 */
function renderCategoryStep(body, state, category) {
    if (!state.layoutLoaded) {
        body.append(elText('p', 'gm-modal-detail-body', 'Loading layout…'));
        return;
    }
    if (category?.description) {
        body.append(elText('p', 'gm-modal-intro', category.description));
    }
    body.append(renderCategorySection(category, buildWizardOptions(state, category)));
}

function renderConfirmStep(body, state) {
    body.append(elText('h3', 'gm-modal-section-title', state.name || '(unnamed)'));
    body.append(detail('Appearance', state.appearance));
    body.append(detail('Personality', state.personality));
    body.append(detail('Voice', state.voice));
    if (!state.isNpc) body.append(detail('Background', state.background));

    if (state.layout && Array.isArray(state.layout.categories)) {
        for (const category of state.layout.categories) {
            if (!category || !category.wizard_step) continue;
            body.append(renderCategorySection(category, buildPreviewOptions(state)));
        }
    } else {
        const stats = collectStatsFromLegacy(state);
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
    }

    const note = el('p', 'gm-modal-note');
    note.textContent = state.isNpc
        ? 'You can edit this NPC\'s sheet anytime from the in-scene roster.'
        : 'You can edit any of these fields from the sheet panel after creation.';
    body.append(note);
}

function renderLegacyStatsStep(body, state, rerender) {
    const intro = el('p', 'gm-modal-intro');
    intro.innerHTML = `Stats are key-value pairs. Pre-filled from the campaign's <strong>${state.rulesetId || 'ruleset'}</strong> starter pack — keep, edit, delete, or add new keys as you like.`;
    body.append(intro);
    body.append(renderLegacyStatsGrid(state, rerender));
}

function renderLegacyStatsGrid(state, rerender) {
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

/* -------- Renderer option bags -------- */

/**
 * Build a `RenderOptions` bag bound to the wizard's in-memory state.
 *
 * For `kind: stats` and `kind: statuses`, `getValue(field) / setValue(field, v)`
 * read and write the corresponding bag in `state.stats` / `state.statuses`.
 * For other kinds (skills / items / notes), the bag-level setters mutate
 * the corresponding state slice and trigger a rerender.
 *
 * @param {any} state
 * @param {any} category
 * @returns {import('./sheet-renderer.js').RenderOptions}
 */
function buildWizardOptions(state, category) {
    const bag = pickBagFor(state, category);
    return {
        mode: /** @type {'wizard'} */('wizard'),
        getValue: (field) => bag ? bag[field.key] : undefined,
        setValue: (field, value) => {
            if (!bag || !field || !field.key) return;
            bag[field.key] = value;
        },
        getStatValue: (key) => state.stats[key],
        skills: state.skills,
        setSkills: (next) => { state.skills = Array.isArray(next) ? [...next] : []; },
        rulesetSkills: Array.isArray(state.ruleset?.skills) ? state.ruleset.skills : [],
        items: state.items,
        setItems: (next) => { state.items = Array.isArray(next) ? next : []; },
        statuses: state.statuses,
        setStatuses: (next) => { state.statuses = (next && typeof next === 'object') ? { ...next } : {}; },
        relationships: {},
        notes: state.notes,
        setNotes: (next) => { state.notes = typeof next === 'string' ? next : ''; },
        // We deliberately do NOT pass onChange — the renderer's
        // sub-components rebuild their own subtrees (item / status
        // list) on structural changes; calling rerender from here
        // would blow away the currently-focused input mid-edit.
    };
}

/**
 * Build a `RenderOptions` bag for the Confirm step. Same state, but
 * `mode: 'preview'` so the renderer emits read-only widgets.
 *
 * @param {any} state
 * @returns {import('./sheet-renderer.js').RenderOptions}
 */
function buildPreviewOptions(state) {
    return {
        mode: /** @type {'preview'} */('preview'),
        getValue: (field) => {
            // For the confirm preview we only render fields whose
            // category we know — stats vs statuses. The renderer's
            // preview path only reads from `getValue`, so we route
            // every non-stats key to the statuses bag.
            if (state.stats && Object.prototype.hasOwnProperty.call(state.stats, field.key)) {
                return state.stats[field.key];
            }
            if (state.statuses && Object.prototype.hasOwnProperty.call(state.statuses, field.key)) {
                return state.statuses[field.key];
            }
            return undefined;
        },
        setValue: () => {},
        getStatValue: (key) => state.stats[key],
        skills: state.skills,
        rulesetSkills: Array.isArray(state.ruleset?.skills) ? state.ruleset.skills : [],
        items: state.items,
        statuses: state.statuses,
        relationships: {},
        notes: state.notes,
    };
}

/**
 * Pick the in-memory bag a category writes to.
 *
 * @param {any} state
 * @param {any} category
 */
function pickBagFor(state, category) {
    if (!category) return null;
    if (category.kind === 'stats') return state.stats;
    if (category.kind === 'statuses') return state.statuses;
    return null;
}

/* -------- Identity field helpers (local — these don't fit the shared renderer) -------- */

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

/**
 * @param {any} state
 * @param {string} key
 * @param {{ placeholder?: string, maxlength?: number }} [options]
 */
function textInput(state, key, options = {}) {
    const { placeholder = '', maxlength } = options;
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'gm-modal-input';
    i.placeholder = placeholder;
    if (maxlength) i.maxLength = maxlength;
    i.value = state[key] || '';
    i.addEventListener('input', () => {
        state[key] = i.value;
        refreshFooterEnabled(i, state);
    });
    return i;
}

/**
 * @param {any} state
 * @param {string} key
 * @param {{ placeholder?: string, rows?: number }} [options]
 */
function textArea(state, key, options = {}) {
    const { placeholder = '', rows = 4 } = options;
    const t = document.createElement('textarea');
    t.className = 'gm-modal-textarea';
    t.placeholder = placeholder;
    t.rows = rows;
    t.value = state[key] || '';
    t.addEventListener('input', () => {
        state[key] = t.value;
        refreshFooterEnabled(t, state);
    });
    return t;
}

function refreshFooterEnabled(node, state) {
    const next = node.closest('.gm-modal')?.querySelector('.gm-modal-footer .gm-primary-btn');
    if (next instanceof HTMLButtonElement) next.disabled = !canAdvance(state);
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
