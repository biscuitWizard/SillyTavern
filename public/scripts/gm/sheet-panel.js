/**
 * Character sheet editor (M4 — category-driven).
 *
 * The panel walks the merged `SheetLayout` returned by
 * `GET /api/gm/rulesets/:id/sheet-layout` and renders one section per
 * category, picking a typed widget per field:
 *
 *   - `kind: stats`         → grid of number / text / bar / paired
 *                             widgets (save-on-blur via `setStat`).
 *   - `kind: statuses`      → typed grid (when `fields[]`) over
 *                             `setStatus` / `clearStatus`, otherwise
 *                             the legacy free-form KV editor.
 *   - `kind: skills`        → checklist of every ruleset skill;
 *                             toggling persists via `setSkills`.
 *   - `kind: items`         → list editor for `sheet.items[]`.
 *   - `kind: notes`         → single textarea (save on blur).
 *   - `kind: relationships` → NPC-only. The PC sheet skips this section
 *                             entirely. NPC sheets eagerly render one
 *                             card toward the player character (or a
 *                             CTA when no entry exists), and tuck all
 *                             NPC↔NPC entries under a collapsed "Other
 *                             relationships" disclosure that lazily
 *                             fetches each card on first expand via
 *                             `GET /sheets/:char_id/relationships/:other_id`.
 *
 * After walking the layout we collect every `stats` / `statuses` key
 * not covered by any layout field and surface them under an "Other"
 * footer, so player- or Director-added KVs always survive.
 *
 * Backwards compat: when no layout is available (no campaign, no
 * `ruleset_id`, or the fetch fails), we render the legacy flat KV
 * editor — the same shape as the pre-M4 panel — so legacy callers
 * keep working.
 *
 * Edits broadcast a `tt:character-changed` window event so the left
 * sidebar can refresh its compact stats grid live.
 */

import * as api from './api.js';

let activeOverlay = null;
let activeCharacter = null;
let activeLayout = null;
let activeRuleset = null;
let activeCampaign = null;
let isLoadingLayout = false;

/**
 * Stash the campaign so subsequent `openSheetPanel(character)` calls
 * can fetch the layout without the caller having to plumb it through.
 *
 * Called from `campaign-main.js` and `scene.js` whenever they (re)render
 * — those views already hold the campaign in hand, so this avoids
 * touching every `openSheetPanel` call site (sidebar-left, sidebar-right,
 * party-panel, …).
 *
 * @param {any | null} campaign
 */
export function setActiveCampaign(campaign) {
    activeCampaign = campaign || null;
}

/**
 * @param {any} character
 * @param {{ campaign?: any }} [options]
 */
export function openSheetPanel(character, options = {}) {
    closeSheetPanel();
    activeCharacter = character;
    const campaign = options?.campaign || activeCampaign || null;
    // Drop any stale cached roster so the relationships picker
    // re-fetches when this panel reopens for a different campaign.
    if (!cachedRoster.campaignId || cachedRoster.campaignId !== campaign?.id) {
        cachedRoster = { campaignId: null, characters: null };
    }
    // Reset the lazy relationships state so reopening the panel for a
    // different character doesn't surface another character's expanded
    // disclosure rows or stale per-target field caches.
    expandedOtherIds = new Set();
    relationshipFieldsCache = new Map();

    const overlay = el('div', 'gm-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSheetPanel();
    });

    const panel = el('div', 'gm-modal gm-sheet-modal');
    overlay.append(panel);
    document.body.append(overlay);
    activeOverlay = overlay;

    // Reset per-open state and kick off the (best-effort) layout fetch.
    activeLayout = null;
    activeRuleset = null;
    isLoadingLayout = true;
    rerender();

    loadLayoutFor(campaign).finally(() => {
        isLoadingLayout = false;
        rerender();
    });

    document.addEventListener('keydown', onEsc);
}

export function closeSheetPanel() {
    if (activeOverlay && activeOverlay.parentNode) {
        activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
    activeCharacter = null;
    activeLayout = null;
    activeRuleset = null;
    isLoadingLayout = false;
    document.removeEventListener('keydown', onEsc);
}

function onEsc(e) {
    if (e.key === 'Escape') closeSheetPanel();
}

/**
 * Best-effort: fetch the merged layout AND the ruleset (the latter for
 * the skills checklist). Failure is non-fatal — the panel falls back
 * to the legacy flat editor and logs a warning.
 *
 * @param {{ ruleset_id?: string } | null} campaign
 */
async function loadLayoutFor(campaign) {
    const rulesetId = campaign && typeof campaign.ruleset_id === 'string' ? campaign.ruleset_id : null;
    if (!rulesetId) {
        activeLayout = null;
        activeRuleset = null;
        return;
    }
    try {
        const [layout, ruleset] = await Promise.all([
            api.getSheetLayout(rulesetId).catch(err => { console.warn('[gm.sheet] getSheetLayout failed', err); return null; }),
            api.getRuleset(rulesetId).catch(err => { console.warn('[gm.sheet] getRuleset failed', err); return null; }),
        ]);
        activeLayout = layout || null;
        activeRuleset = ruleset || null;
    } catch (err) {
        console.warn('[gm.sheet] layout fetch crashed; falling back to legacy editor', err);
        activeLayout = null;
        activeRuleset = null;
    }
}

function rerender() {
    if (!activeOverlay || !activeCharacter) return;
    const panel = activeOverlay.querySelector('.gm-modal');
    if (!panel) return;
    panel.replaceChildren(
        renderHeader(activeCharacter),
        renderBody(activeCharacter),
    );
}

/**
 * Apply the result of a successful mutation: replace the active
 * character, fire `tt:character-changed`, and re-render.
 *
 * @param {any} updated
 */
function applyUpdate(updated) {
    if (!updated) return;
    activeCharacter = updated;
    try {
        window.dispatchEvent(new CustomEvent('tt:character-changed', { detail: { character: updated } }));
    } catch (_) { /* ignore */ }
    rerender();
}

/* -------- Top-level renderers -------- */

function renderHeader(character) {
    const head = el('div', 'gm-modal-header');
    head.append(elText('h2', 'gm-modal-title', character.name));
    const close = el('button', 'gm-icon-btn');
    close.type = 'button';
    close.title = 'Close';
    close.innerHTML = '<i class="fa-solid fa-times"></i>';
    close.addEventListener('click', closeSheetPanel);
    head.append(close);
    return head;
}

function renderBody(character) {
    const body = el('div', 'gm-modal-body');

    body.append(renderIdentitySection(character));

    if (isLoadingLayout) {
        body.append(elText('p', 'gm-modal-detail-body', 'Loading sheet…'));
        return body;
    }

    if (activeLayout && Array.isArray(activeLayout.categories) && activeLayout.categories.length) {
        renderCategorizedBody(body, character, activeLayout, activeRuleset);
    } else {
        renderLegacyBody(body, character);
    }
    return body;
}

/* -------- Identity section -------- */

/**
 * Render the character identity fields (appearance, personality, voice,
 * background) as editable textareas that save on blur. This is always
 * rendered at the top of the panel, before any sheet categories, for
 * both PCs and NPCs.
 *
 * Direct player edits are always committed immediately — no approval
 * gate. The Director's `mutate_identity` action is the only path that
 * triggers an approval bubble (PC) or a silent state update (NPC).
 *
 * @param {any} character
 * @returns {HTMLElement}
 */
function renderIdentitySection(character) {
    const section = el('div', 'gm-sheet-section gm-identity-section');
    section.append(elText('div', 'gm-sheet-section-title', 'Identity'));

    const FIELDS = [
        { key: 'appearance', label: 'Appearance' },
        { key: 'personality', label: 'Personality' },
        { key: 'voice', label: 'Voice' },
        { key: 'background', label: 'Background' },
    ];

    for (const { key, label } of FIELDS) {
        const wrap = el('div', 'gm-modal-detail gm-identity-field');
        wrap.append(elText('div', 'gm-modal-detail-label', label));

        const textarea = /** @type {HTMLTextAreaElement} */ (el('textarea', 'gm-identity-field__textarea'));
        textarea.rows = 3;
        textarea.placeholder = `${label}…`;
        textarea.value = String(character[key] ?? '');

        bindBlurSave(textarea, textarea.value, async () => {
            const out = await api.setIdentityField(character.id, key, textarea.value.trim());
            return out;
        });

        wrap.append(textarea);
        section.append(wrap);
    }

    return section;
}

/* -------- Categorized body (layout-driven) -------- */

/**
 * Walk each category in the layout in order, then surface anything in
 * `stats` / `statuses` that nobody claimed under an "Other" footer.
 *
 * M5 (sidebar) will replicate this `for (const category of layout.categories)`
 * pattern to find categories marked `sidebar_highlight: true` (see the
 * `SheetCategory` schema field of the same name).
 *
 * @param {HTMLElement} body
 * @param {any} character
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout} layout
 * @param {any | null} ruleset
 */
function renderCategorizedBody(body, character, layout, ruleset) {
    /** @type {Set<string>} */
    const claimedStatKeys = new Set();
    /** @type {Set<string>} */
    const claimedStatusKeys = new Set();

    for (const category of layout.categories) {
        if (!category || typeof category !== 'object') continue;
        const section = renderCategory(category, character, ruleset, claimedStatKeys, claimedStatusKeys);
        if (section) body.append(section);
    }

    const otherStats = collectUnclaimed(character.sheet?.stats, claimedStatKeys);
    const otherStatuses = collectUnclaimed(character.sheet?.statuses, claimedStatusKeys);
    if (otherStats.length || otherStatuses.length) {
        body.append(renderOtherFooter(character, otherStats, otherStatuses));
    }
}

/**
 * @param {Record<string, any> | undefined} bag
 * @param {Set<string>} claimed
 */
function collectUnclaimed(bag, claimed) {
    if (!bag || typeof bag !== 'object') return [];
    return Object.keys(bag)
        .filter(k => !claimed.has(k))
        .sort();
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory} category
 * @param {any} character
 * @param {any | null} ruleset
 * @param {Set<string>} claimedStatKeys
 * @param {Set<string>} claimedStatusKeys
 * @returns {HTMLElement | null}
 */
function renderCategory(category, character, ruleset, claimedStatKeys, claimedStatusKeys) {
    const section = el('div', 'gm-sheet-section');
    section.dataset.categoryId = category.id || '';
    section.dataset.categoryKind = category.kind || '';
    section.append(elText('div', 'gm-sheet-section-title', category.label || category.id || 'Category'));

    switch (category.kind) {
        case 'stats':
            for (const field of category.fields || []) collectFieldKeys(field, claimedStatKeys);
            section.append(renderTypedGrid(character, category.fields || [], {
                bag: character.sheet?.stats || {},
                save: (key, value) => api.setStat(character.id, key, value),
            }));
            return section;
        case 'statuses':
            if (Array.isArray(category.fields) && category.fields.length) {
                for (const field of category.fields) collectFieldKeys(field, claimedStatusKeys);
                section.append(renderTypedGrid(character, category.fields, {
                    bag: character.sheet?.statuses || {},
                    save: (key, value) => api.setStatus(character.id, key, String(value)),
                }));
            } else {
                // No declared schema → free-form KV editor over statuses.
                // Every existing key is "claimed" by this section so the
                // Other footer doesn't double-list them.
                const statuses = character.sheet?.statuses || {};
                for (const key of Object.keys(statuses)) claimedStatusKeys.add(key);
                section.append(renderFreeFormKv({
                    kv: statuses,
                    valuePlaceholder: 'description',
                    save: (key, value) => api.setStatus(character.id, key, String(value)),
                    clear: (key) => api.clearStatus(character.id, key),
                }));
            }
            return section;
        case 'skills':
            section.append(renderSkillsChecklist(character, ruleset));
            return section;
        case 'items':
            section.append(renderItemsList(character));
            return section;
        case 'notes':
            section.append(renderNotesEditor(character));
            return section;
        case 'relationships':
            // Player character sheets never show a relationships section.
            // The design intent is that the PC's "where they stand" with
            // NPCs lives on the *NPC* sheets (each NPC tracks how *they*
            // feel about the player), not the other way around. Returning
            // null skips the section entirely (header included).
            if (character.is_player) return null;
            section.append(renderRelationshipsEditor(character, category));
            return section;
        default:
            section.append(elText('p', 'gm-modal-detail-body', `(unknown category kind: ${category.kind})`));
            return section;
    }
}

/**
 * Mark this field's stat key (and any paired_with companion) as claimed
 * so the "Other" footer doesn't re-render them.
 *
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {Set<string>} claimed
 */
function collectFieldKeys(field, claimed) {
    if (!field || !field.key) return;
    claimed.add(field.key);
    if (field.paired_with && field.paired_with.key) claimed.add(field.paired_with.key);
}

/* -------- Typed widget grid (stats / typed statuses) -------- */

/**
 * @param {any} character
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField[]} fields
 * @param {{ bag: Record<string, any>, save: (key: string, value: number | string) => Promise<any> }} args
 */
function renderTypedGrid(character, fields, { bag, save }) {
    const grid = el('div', 'gm-sheet-grid');
    for (const field of fields) {
        const cell = el('div', 'gm-sheet-field');
        cell.append(elText('div', 'gm-sheet-field-label', field.label || field.key));
        cell.append(renderFieldControl(character, field, bag, save));
        grid.append(cell);
    }
    return grid;
}

/**
 * @param {any} character
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {Record<string, any>} bag
 * @param {(key: string, value: number | string) => Promise<any>} save
 */
function renderFieldControl(character, field, bag, save) {
    const control = el('div', 'gm-sheet-field-control');
    switch (field.type) {
        case 'number':
            control.append(buildNumberInput(field, bag[field.key], save));
            return control;
        case 'text':
            control.append(buildTextInput(field, bag[field.key], save));
            return control;
        case 'bar':
            control.append(buildBarWidget(character, field, bag, save));
            return control;
        case 'paired':
            control.append(buildPairedWidget(field, bag, save));
            return control;
        default:
            control.append(buildTextInput(field, bag[field.key], save));
            return control;
    }
}

function buildNumberInput(field, currentValue, save) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'gm-modal-input';
    if (typeof field.min === 'number') input.min = String(field.min);
    if (typeof field.max === 'number') input.max = String(field.max);
    const seeded = pickInitialValue(currentValue, field.default, '');
    input.value = String(seeded);
    const initial = String(seeded);
    bindBlurSave(input, initial, async () => {
        const next = clampNumeric(parseFloat(input.value), field);
        if (Number.isNaN(next)) return null;
        return save(field.key, next);
    });
    return input;
}

function buildTextInput(field, currentValue, save) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gm-modal-input';
    const seeded = pickInitialValue(currentValue, field.default, '');
    input.value = String(seeded);
    const initial = String(seeded);
    bindBlurSave(input, initial, async () => save(field.key, input.value));
    return input;
}

function buildBarWidget(character, field, bag, save) {
    const wrap = el('div', 'gm-bar-widget');

    const current = numericOrDefault(bag[field.key], field.default, 0);
    const max = computeBarMax(character, field);

    const bar = el('div', 'gm-bar');
    const fill = el('div', 'gm-bar-fill');
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    fill.style.width = `${ratio * 100}%`;
    bar.append(fill);

    const labelRow = el('div', 'gm-bar-label');
    const valueDisplay = el('span', 'gm-bar-value');
    valueDisplay.textContent = `${formatNumber(current)} / ${formatNumber(max)}`;
    labelRow.append(valueDisplay);

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'gm-modal-input gm-bar-input';
    if (typeof field.min === 'number') input.min = String(field.min);
    if (typeof field.max === 'number') input.max = String(field.max);
    input.value = String(current);
    const initial = String(current);
    bindBlurSave(input, initial, async () => {
        const next = clampNumeric(parseFloat(input.value), field);
        if (Number.isNaN(next)) return null;
        return save(field.key, next);
    });
    labelRow.append(input);

    wrap.append(bar, labelRow);
    return wrap;
}

function buildPairedWidget(field, bag, save) {
    const wrap = el('div', 'gm-paired-widget');

    const min = typeof field.min === 'number' ? field.min : -100;
    const max = typeof field.max === 'number' ? field.max : 100;
    const leftValue = numericOrDefault(bag[field.key], field.default, 0);
    const rightKey = field.paired_with?.key;
    const rightLabel = field.paired_with?.label || rightKey || '';
    const rightDefault = field.paired_with?.default;
    const rightValue = rightKey ? numericOrDefault(bag[rightKey], rightDefault, 0) : 0;

    // Combined "lean" score in [min, max]: left subtracts, right adds.
    const lean = Math.max(min, Math.min(max, rightValue - leftValue));
    const bar = el('div', 'gm-paired-bar');
    const leftFill = el('div', 'gm-paired-bar-fill-left');
    const rightFill = el('div', 'gm-paired-bar-fill-right');
    if (lean < 0 && min < 0) {
        leftFill.style.width = `${(Math.abs(lean) / Math.abs(min)) * 50}%`;
    }
    if (lean > 0 && max > 0) {
        rightFill.style.width = `${(lean / max) * 50}%`;
    }
    bar.append(leftFill, rightFill);

    const labelRow = el('div', 'gm-paired-row');

    const leftCell = el('div', 'gm-paired-cell gm-paired-cell-left');
    leftCell.append(elText('span', 'gm-paired-label', field.label || field.key));
    const leftInput = document.createElement('input');
    leftInput.type = 'number';
    leftInput.className = 'gm-modal-input gm-paired-input gm-paired-input-left';
    if (typeof field.min === 'number') leftInput.min = String(field.min);
    if (typeof field.max === 'number') leftInput.max = String(field.max);
    leftInput.value = String(leftValue);
    const leftInitial = String(leftValue);
    bindBlurSave(leftInput, leftInitial, async () => {
        const next = clampNumeric(parseFloat(leftInput.value), field);
        if (Number.isNaN(next)) return null;
        return save(field.key, next);
    });
    leftCell.append(leftInput);

    const rightCell = el('div', 'gm-paired-cell gm-paired-cell-right');
    rightCell.append(elText('span', 'gm-paired-label', rightLabel));
    const rightInput = document.createElement('input');
    rightInput.type = 'number';
    rightInput.className = 'gm-modal-input gm-paired-input gm-paired-input-right';
    if (typeof field.min === 'number') rightInput.min = String(field.min);
    if (typeof field.max === 'number') rightInput.max = String(field.max);
    rightInput.disabled = !rightKey;
    rightInput.value = String(rightValue);
    const rightInitial = String(rightValue);
    if (rightKey) {
        bindBlurSave(rightInput, rightInitial, async () => {
            const next = clampNumeric(parseFloat(rightInput.value), field);
            if (Number.isNaN(next)) return null;
            return save(rightKey, next);
        });
    }
    rightCell.append(rightInput);

    labelRow.append(leftCell, rightCell);
    wrap.append(bar, labelRow);
    return wrap;
}

/* -------- Skills checklist -------- */

function renderSkillsChecklist(character, ruleset) {
    const wrap = el('div', 'gm-skills-list');
    const skills = Array.isArray(ruleset?.skills) ? ruleset.skills : [];
    const owned = new Set(Array.isArray(character.sheet?.skills) ? character.sheet.skills : []);

    if (!skills.length) {
        wrap.append(elText('p', 'gm-modal-detail-body',
            owned.size ? `Proficient: ${[...owned].join(', ')}` : '(no skills available for this ruleset)'));
        return wrap;
    }

    for (const skill of skills) {
        wrap.append(buildSkillRow(character, skill, owned));
    }
    return wrap;
}

function buildSkillRow(character, skill, owned) {
    const row = el('label', 'gm-skill-row');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'gm-skill-checkbox';
    checkbox.checked = owned.has(skill.id);
    checkbox.addEventListener('change', async () => {
        const next = new Set(owned);
        if (checkbox.checked) next.add(skill.id);
        else next.delete(skill.id);
        try {
            const updated = await api.setSkills(character.id, [...next]);
            applyUpdate(updated);
        } catch (err) {
            checkbox.checked = !checkbox.checked;
            console.error('[gm.sheet] setSkills failed', err);
            alert(`Save failed: ${err?.message || err}`);
        }
    });

    const name = el('span', 'gm-skill-name');
    name.textContent = skill.name || skill.id;

    const ability = el('span', 'gm-skill-ability');
    ability.textContent = (skill.ability_id || '').toUpperCase();

    row.append(checkbox, name, ability);
    return row;
}

/* -------- Items editor -------- */

function renderItemsList(character) {
    const wrap = el('div', 'gm-items-list');
    const items = Array.isArray(character.sheet?.items) ? character.sheet.items : [];

    if (items.length === 0) {
        wrap.append(elText('p', 'gm-modal-detail-body', '(no items)'));
    } else {
        for (const item of items) wrap.append(buildItemRow(character, item));
    }

    wrap.append(buildItemAddRow(character));
    return wrap;
}

function buildItemRow(character, item) {
    const row = el('div', 'gm-item-row');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'gm-modal-input gm-item-name';
    nameInput.value = item.name || '';
    bindBlurSave(nameInput, item.name || '', async () => {
        return api.updateItem(character.id, item.id, { name: nameInput.value });
    });

    const descInput = document.createElement('textarea');
    descInput.className = 'gm-modal-textarea gm-item-desc';
    descInput.rows = 2;
    descInput.value = item.description || '';
    bindBlurSave(descInput, item.description || '', async () => {
        return api.updateItem(character.id, item.id, { description: descInput.value });
    });

    row.append(nameInput, descInput);

    const influences = item.influences;
    if (influences && typeof influences === 'object' && Object.keys(influences).length) {
        const chips = el('div', 'gm-item-influences');
        for (const [key, val] of Object.entries(influences)) {
            const chip = el('span', 'gm-item-influence-chip');
            chip.textContent = `${key}: ${formatInfluenceValue(val)}`;
            chips.append(chip);
        }
        row.append(chips);
    }

    const actions = el('div', 'gm-item-actions');
    const removeBtn = el('button', 'gm-icon-btn');
    removeBtn.type = 'button';
    removeBtn.title = 'Delete item';
    removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    removeBtn.addEventListener('click', async () => {
        if (!confirm(`Delete item "${item.name || item.id}"?`)) return;
        try {
            const updated = await api.deleteItem(character.id, item.id);
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm.sheet] deleteItem failed', err);
            alert(`Delete failed: ${err?.message || err}`);
        }
    });
    actions.append(removeBtn);
    row.append(actions);

    return row;
}

function buildItemAddRow(character) {
    const row = el('div', 'gm-item-add-row');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'gm-modal-input';
    nameInput.placeholder = 'Item name';

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'gm-modal-input';
    descInput.placeholder = 'Description (optional)';

    const addBtn = el('button', 'gm-secondary-btn');
    addBtn.type = 'button';
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add item';
    addBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        try {
            const updated = await api.addItem(character.id, {
                name,
                description: descInput.value.trim(),
                influences: {},
            });
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm.sheet] addItem failed', err);
            alert(`Add failed: ${err?.message || err}`);
        }
    });

    row.append(nameInput, descInput, addBtn);
    return row;
}

function formatInfluenceValue(val) {
    if (val === null || val === undefined) return '—';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}

/* -------- Notes editor -------- */

function renderNotesEditor(character) {
    const wrap = el('div', 'gm-notes-wrap');
    const textarea = document.createElement('textarea');
    textarea.className = 'gm-modal-textarea';
    textarea.rows = 6;
    textarea.placeholder = 'Free-form notes (private to the player).';
    const initial = typeof character.sheet?.notes === 'string' ? character.sheet.notes : '';
    textarea.value = initial;
    bindBlurSave(textarea, initial, async () => api.setNotes(character.id, textarea.value));
    wrap.append(textarea);
    return wrap;
}

/* -------- Relationships (M7, NPC-only with PC-card shortcut) --------
 *
 * Visibility rules:
 *   - PC sheets never render this section (skipped one level up in
 *     renderCategory). The design intent is that relationships live
 *     on the NPC sheets, tracking how the NPC sees the player.
 *   - NPC sheets eagerly render exactly ONE card up-front: the entry
 *     toward the player character. If no entry exists, a single CTA
 *     row offers to start tracking it (with sensible defaults).
 *   - All NPC↔NPC entries live under a collapsed "Other relationships"
 *     disclosure. Each row is itself collapsed; expanding fires
 *     `api.getRelationship(characterId, otherId)` and renders the card
 *     from that focused response — we never bundle every relationship
 *     into one big blob just because the panel is open.
 *
 * Lazy-render plumbing:
 *   - `expandedOtherIds` survives a single-panel session so disclosure
 *     state isn't blown away by `applyUpdate`'s full re-render after a
 *     field save. Cleared in `openSheetPanel`.
 *   - `relationshipFieldsCache` memoises per-`other_id` field bags so a
 *     re-render after a save re-uses the data we already fetched
 *     instead of refiring the GET. Each save also patches the cached
 *     bag in place so the rendered widgets show the new value.
 *
 * Per-actor isolation: this UI only ever writes to THIS character's
 * sheet.relationships bag. The corresponding entry on the OTHER
 * character is not auto-mirrored — that's a Director / future-phase
 * design decision, not a sheet-panel concern.
 */

/** Cached roster keyed by campaign id; cleared when openSheetPanel re-opens. */
let cachedRoster = { campaignId: null, characters: null };

/** Set<string> of `other_id`s the user has expanded since the panel opened. */
let expandedOtherIds = new Set();

/** Map<string, Record<string, number | string> | null> keyed by `other_id`. */
let relationshipFieldsCache = new Map();

/**
 * @param {any} character
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory} category
 */
function renderRelationshipsEditor(character, category) {
    const wrap = el('div', 'gm-rels-list');
    if (category?.description) {
        wrap.append(elText('p', 'gm-modal-detail-body', category.description));
    }

    const rels = (character.sheet?.relationships && typeof character.sheet.relationships === 'object')
        ? character.sheet.relationships
        : {};
    // The character GET still bundles relationships server-side, so the
    // initial id list is free. Expansion-time GETs let us reload the
    // *current* fields for a given target without re-pulling the rest.
    for (const otherId of Object.keys(rels)) {
        if (!relationshipFieldsCache.has(otherId)) {
            relationshipFieldsCache.set(otherId, rels[otherId]);
        }
    }
    const allOtherIds = Object.keys(rels).sort();

    // Resolving the PC card needs the roster to know which id is the
    // player character. We render an async-aware placeholder and patch
    // it in place once the roster is available — no full re-render so
    // user-typed changes elsewhere on the sheet are never trampled.
    const pcSlot = el('div', 'gm-rels-pc-slot');
    pcSlot.dataset.pending = '1';
    pcSlot.append(elText('p', 'gm-modal-detail-body gm-rel-pc-loading', 'Loading relationship to the player character…'));
    wrap.append(pcSlot);

    // The "Other relationships" disclosure. The picker for adding a new
    // non-PC relationship lives inside it so the visible UI stays terse
    // until the user explicitly opens the section.
    const others = el('details', 'gm-rels-others');
    const summary = document.createElement('summary');
    summary.className = 'gm-rels-others-summary';
    others.append(summary);
    const othersBody = el('div', 'gm-rels-others-body');
    others.append(othersBody);
    wrap.append(others);

    // Render the disclosure rows + picker once we know the PC id (so we
    // can exclude it from the "other relationships" list and the
    // picker). The PC row goes into pcSlot.
    populateRelationshipsAsync({
        character,
        category,
        allOtherIds,
        pcSlot,
        summary,
        othersBody,
    }).catch((err) => {
        console.warn('[gm] relationships init failed', err);
        pcSlot.replaceChildren(elText('p', 'gm-modal-detail-body', '(could not load relationships — see console.)'));
        summary.textContent = 'Other relationships';
    });

    return wrap;
}

/**
 * @param {{
 *   character: any,
 *   category: import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory,
 *   allOtherIds: string[],
 *   pcSlot: HTMLElement,
 *   summary: HTMLElement,
 *   othersBody: HTMLElement,
 * }} args
 */
async function populateRelationshipsAsync(args) {
    const { character, category, allOtherIds, pcSlot, summary, othersBody } = args;
    const pcId = await resolvePlayerCharacterId(character.campaign_id);
    const playerCard = renderPlayerCharacterCard({ character, category, pcId });
    pcSlot.replaceChildren(playerCard);

    const otherIds = allOtherIds.filter((id) => id && id !== pcId);
    summary.textContent = otherIds.length
        ? `Other relationships (${otherIds.length})`
        : 'Other relationships';

    // Sort by display name so the disclosure list is scannable.
    otherIds.sort((a, b) => resolveOtherName(a).localeCompare(resolveOtherName(b)));
    for (const otherId of otherIds) {
        othersBody.append(buildLazyRelationshipRow(character, category, otherId));
    }

    othersBody.append(buildAddRelationshipRow({
        character,
        category,
        excludeIds: new Set([...otherIds, character.id, pcId].filter(Boolean)),
        onAdded: (newOtherId) => {
            // Auto-expand the new row so the user lands directly on the
            // editable card after adding it.
            expandedOtherIds.add(newOtherId);
        },
    }));
}

/**
 * Walks the roster and returns the player character's id (or null when
 * the campaign has no PC yet). Cached behind `cachedRoster`.
 *
 * @param {string | undefined} campaignId
 */
async function resolvePlayerCharacterId(campaignId) {
    if (!campaignId) return null;
    let roster;
    try {
        roster = await fetchCampaignRoster(campaignId);
    } catch (err) {
        console.warn('[gm] could not load roster for PC lookup', err);
        return null;
    }
    const pc = (roster || []).find((c) => c && c.is_player);
    return pc ? pc.id : null;
}

/**
 * Eagerly-rendered card for the player character. Two paths:
 *   - entry exists in `relationshipFieldsCache` → render the typed grid
 *     using the cached field bag.
 *   - no entry → render a "+ Track how <NPC> feels about <PC>" CTA
 *     that seeds `per_target_fields` defaults on click.
 *
 * @param {{ character: any, category: import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory, pcId: string | null }} args
 */
function renderPlayerCharacterCard(args) {
    const { character, category, pcId } = args;
    if (!pcId) {
        const empty = el('div', 'gm-rel-pc-empty');
        empty.append(elText('p', 'gm-modal-detail-body', '(this campaign has no player character yet — once one exists, this card tracks how the NPC sees them.)'));
        return empty;
    }

    const fields = relationshipFieldsCache.get(pcId);
    if (fields && typeof fields === 'object' && Object.keys(fields).length > 0) {
        return buildRelationshipCard({
            character,
            category,
            otherId: pcId,
            fields,
            isPlayerCard: true,
        });
    }

    // No entry yet → CTA.
    const cta = el('div', 'gm-rel-pc-cta');
    const label = `Track how ${character.name} feels about ${resolveOtherName(pcId)}`;
    const btn = el('button', 'gm-secondary-btn');
    btn.type = 'button';
    btn.innerHTML = `<i class="fa-solid fa-plus"></i> ${label}`;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            await seedRelationshipDefaults(character.id, pcId, category);
            // Pull the fresh fields and re-render the slot in place
            // (avoids the full applyUpdate re-render so other in-flight
            // edits aren't trampled).
            const fresh = await api.getRelationship(character.id, pcId);
            relationshipFieldsCache.set(pcId, fresh?.fields || {});
            const card = buildRelationshipCard({
                character,
                category,
                otherId: pcId,
                fields: fresh?.fields || {},
                isPlayerCard: true,
            });
            cta.replaceWith(card);
        } catch (err) {
            console.error('[gm] seed PC relationship failed', err);
            alert(`Could not start relationship: ${err?.message || err}`);
            btn.disabled = false;
        }
    });
    cta.append(btn);
    return cta;
}

/**
 * One row in the "Other relationships" disclosure. Collapsed by default
 * (or honours `expandedOtherIds` when re-rendered after a save). On
 * first toggle-open it fires `getRelationship(...)`, caches the
 * response, and renders the card body.
 *
 * @param {any} character
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory} category
 * @param {string} otherId
 */
function buildLazyRelationshipRow(character, category, otherId) {
    const row = document.createElement('details');
    row.className = 'gm-rel-other-row';
    if (expandedOtherIds.has(otherId)) row.open = true;

    const summary = document.createElement('summary');
    summary.className = 'gm-rel-other-summary';
    summary.append(elText('span', 'gm-rel-other-name', resolveOtherName(otherId)));
    summary.append(elText('span', 'gm-rel-other-hint', 'expand to load'));
    row.append(summary);

    const body = el('div', 'gm-rel-other-body');
    row.append(body);

    let loadedFromServer = false;

    const ensureBody = () => {
        // Render from cache when we have it (post-save re-renders), else
        // fetch on-demand the first time the row opens.
        const cached = relationshipFieldsCache.get(otherId);
        if (cached !== undefined && (cached === null || typeof cached === 'object')) {
            body.replaceChildren(buildRelationshipCard({
                character,
                category,
                otherId,
                fields: cached || {},
                isPlayerCard: false,
            }));
            summary.querySelector('.gm-rel-other-hint').textContent = '';
            return;
        }
        if (loadedFromServer) return;
        loadedFromServer = true;
        body.replaceChildren(elText('p', 'gm-modal-detail-body', 'Loading…'));
        summary.querySelector('.gm-rel-other-hint').textContent = 'loading…';
        api.getRelationship(character.id, otherId).then((res) => {
            const fields = res?.fields || {};
            relationshipFieldsCache.set(otherId, fields);
            body.replaceChildren(buildRelationshipCard({
                character,
                category,
                otherId,
                fields,
                isPlayerCard: false,
            }));
            summary.querySelector('.gm-rel-other-hint').textContent = '';
        }).catch((err) => {
            console.error('[gm] getRelationship failed', err);
            body.replaceChildren(elText('p', 'gm-modal-detail-body', `(load failed: ${err?.message || err})`));
            summary.querySelector('.gm-rel-other-hint').textContent = 'failed';
        });
    };

    if (row.open) ensureBody();

    row.addEventListener('toggle', () => {
        if (row.open) {
            expandedOtherIds.add(otherId);
            ensureBody();
        } else {
            expandedOtherIds.delete(otherId);
        }
    });

    return row;
}

/**
 * Shared card renderer for both the PC card and lazily-loaded "other"
 * cards. The PC card hides its remove button (the user typically wants
 * to clear individual fields rather than blow the whole entry away).
 *
 * @param {{
 *   character: any,
 *   category: import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory,
 *   otherId: string,
 *   fields: Record<string, number | string>,
 *   isPlayerCard: boolean,
 * }} args
 */
function buildRelationshipCard(args) {
    const { character, category, otherId, fields, isPlayerCard } = args;
    const card = el('div', 'gm-rel-card');
    if (isPlayerCard) card.classList.add('gm-rel-card-pc');

    const head = el('div', 'gm-rel-card-head');
    const title = el('div', 'gm-rel-card-title');
    title.append(elText('span', 'gm-rel-card-name', resolveOtherName(otherId)));
    if (isPlayerCard) {
        title.append(elText('span', 'gm-rel-card-badge', 'PC'));
    }
    head.append(title);

    const removeBtn = el('button', 'gm-icon-btn');
    removeBtn.type = 'button';
    removeBtn.title = 'Remove relationship';
    removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    removeBtn.addEventListener('click', async () => {
        if (!confirm(`Remove this relationship entry for "${resolveOtherName(otherId)}"?`)) return;
        try {
            const updated = await api.removeRelationship(character.id, otherId);
            relationshipFieldsCache.delete(otherId);
            expandedOtherIds.delete(otherId);
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm] removeRelationship failed', err);
            alert(`Could not remove relationship: ${err?.message || err}`);
        }
    });
    head.append(removeBtn);
    card.append(head);

    const perTargetFields = Array.isArray(category?.per_target_fields) ? category.per_target_fields : [];
    if (perTargetFields.length === 0) {
        // No layout-declared schema → flat KV display so existing data is
        // still visible.
        const grid = el('div', 'gm-rel-card-grid');
        for (const [key, value] of Object.entries(fields || {})) {
            const cell = el('div', 'gm-rel-field');
            cell.append(elText('div', 'gm-rel-field-label', key));
            cell.append(elText('div', 'gm-rel-field-value', String(value)));
            grid.append(cell);
        }
        card.append(grid);
    } else {
        const bag = (fields && typeof fields === 'object') ? fields : {};
        // Wrap save() so it (a) hits the field endpoint, (b) updates the
        // local cache so the next re-render sees the new value, and (c)
        // returns the server's character snapshot for applyUpdate.
        const save = async (fieldKey, value) => {
            const updated = await api.setRelationshipField(character.id, otherId, fieldKey, value);
            const cached = relationshipFieldsCache.get(otherId) || {};
            relationshipFieldsCache.set(otherId, { ...cached, [fieldKey]: value });
            return updated;
        };
        card.append(renderTypedGrid(character, perTargetFields, { bag, save }));
    }

    return card;
}

/**
 * Pick `per_target_fields` defaults and write them in sequence so the
 * new entry shows up with sensible values on the next render. Falls
 * back to a single `stage: stranger` placeholder when the layout
 * doesn't declare any defaults — keeps the bag visible.
 */
async function seedRelationshipDefaults(characterId, otherId, category) {
    const defaults = (category?.per_target_fields || [])
        .filter((f) => f && f.key && f.default !== undefined);
    if (defaults.length === 0) {
        const fallback = (category?.per_target_fields || []).find((f) => f?.key === 'stage')
            || (category?.per_target_fields || [])[0];
        if (fallback?.key) {
            return await api.setRelationshipField(characterId, otherId, fallback.key, fallback.default ?? '');
        }
        return await api.setRelationshipField(characterId, otherId, 'stage', 'stranger');
    }
    let updated = null;
    for (const field of defaults) {
        updated = await api.setRelationshipField(characterId, otherId, field.key, field.default);
    }
    return updated;
}

/**
 * @param {{
 *   character: any,
 *   category: import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory,
 *   excludeIds: Set<string>,
 *   onAdded: (newOtherId: string) => void,
 * }} args
 */
function buildAddRelationshipRow(args) {
    const { character, category, excludeIds, onAdded } = args;
    const row = el('div', 'gm-rel-add-row');

    const select = document.createElement('select');
    select.className = 'gm-modal-input gm-rel-add-select';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Loading roster…';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.append(placeholder);

    const addBtn = el('button', 'gm-secondary-btn');
    addBtn.type = 'button';
    addBtn.disabled = true;
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add';

    addBtn.addEventListener('click', async () => {
        const otherId = select.value;
        if (!otherId) return;
        try {
            const updated = await seedRelationshipDefaults(character.id, otherId, category);
            // Fetch fresh fields so the new disclosure row renders from
            // the server-of-record rather than guessing what we wrote.
            const fresh = await api.getRelationship(character.id, otherId);
            relationshipFieldsCache.set(otherId, fresh?.fields || {});
            if (typeof onAdded === 'function') onAdded(otherId);
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm] add relationship failed', err);
            alert(`Could not add relationship: ${err?.message || err}`);
        }
    });

    populateRelationshipPicker(select, addBtn, character, excludeIds);

    row.append(select, addBtn);
    return row;
}

async function populateRelationshipPicker(select, addBtn, character, excludeIds) {
    let roster = [];
    try {
        roster = await fetchCampaignRoster(character.campaign_id);
    } catch (err) {
        console.warn('[gm] could not load campaign roster for relationship picker', err);
        select.replaceChildren();
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(roster unavailable)';
        opt.disabled = true;
        opt.selected = true;
        select.append(opt);
        return;
    }
    select.replaceChildren();

    const candidates = (roster || []).filter((c) => c && c.id !== character.id && !excludeIds.has(c.id));
    if (candidates.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no other characters to track)';
        opt.disabled = true;
        opt.selected = true;
        select.append(opt);
        return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Pick a character…';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.append(placeholder);

    for (const cand of candidates) {
        const opt = document.createElement('option');
        opt.value = cand.id;
        opt.textContent = cand.name || cand.id;
        select.append(opt);
    }

    select.addEventListener('change', () => {
        addBtn.disabled = !select.value;
    });
}

async function fetchCampaignRoster(campaignId) {
    if (!campaignId) return [];
    if (cachedRoster.campaignId === campaignId && Array.isArray(cachedRoster.characters)) {
        return cachedRoster.characters;
    }
    const characters = await api.listCharacters(campaignId);
    cachedRoster = { campaignId, characters: Array.isArray(characters) ? characters : [] };
    return cachedRoster.characters;
}

/**
 * Translate an other-character id to the display name we last saw for
 * them on the cached roster. Falls back to the id when the roster
 * hasn't loaded yet.
 *
 * @param {string} otherId
 */
function resolveOtherName(otherId) {
    if (!Array.isArray(cachedRoster.characters)) return otherId;
    const hit = cachedRoster.characters.find((c) => c && c.id === otherId);
    return (hit && hit.name) || otherId;
}

/* -------- Other footer (free-form KVs the layout didn't claim) -------- */

function renderOtherFooter(character, otherStats, otherStatuses) {
    const details = document.createElement('details');
    details.className = 'gm-sheet-other';
    const summary = document.createElement('summary');
    summary.textContent = 'Other';
    details.append(summary);

    if (otherStats.length) {
        details.append(elText('div', 'gm-sheet-section-title', 'Other stats'));
        const statsBag = character.sheet?.stats || {};
        const statsKv = {};
        for (const k of otherStats) statsKv[k] = statsBag[k];
        details.append(renderFreeFormKv({
            kv: statsKv,
            valuePlaceholder: 'value',
            save: (key, value) => api.setStat(character.id, key, value),
            clear: (key) => api.clearStat(character.id, key),
        }));
    }
    if (otherStatuses.length) {
        details.append(elText('div', 'gm-sheet-section-title', 'Other statuses'));
        const statusBag = character.sheet?.statuses || {};
        const statusKv = {};
        for (const k of otherStatuses) statusKv[k] = statusBag[k];
        details.append(renderFreeFormKv({
            kv: statusKv,
            valuePlaceholder: 'description',
            save: (key, value) => api.setStatus(character.id, key, String(value)),
            clear: (key) => api.clearStatus(character.id, key),
        }));
    }

    return details;
}

/* -------- Free-form KV editor (Other footer + statuses fallback + legacy) -------- */

/**
 * @param {{
 *   kv: Record<string, number | string>,
 *   valuePlaceholder: string,
 *   save: (key: string, value: number | string) => Promise<any>,
 *   clear: (key: string) => Promise<any>,
 * }} args
 */
function renderFreeFormKv({ kv, valuePlaceholder, save, clear }) {
    const wrap = el('div', 'gm-kv-section');

    const keys = Object.keys(kv).sort();
    if (keys.length === 0) {
        wrap.append(elText('p', 'gm-modal-detail-body', '(none yet)'));
    } else {
        const grid = el('div', 'gm-kv-editor');
        for (const key of keys) {
            grid.append(buildLegacyExistingRow(key, kv[key], valuePlaceholder, save, clear));
        }
        wrap.append(grid);
    }

    wrap.append(buildLegacyAddRow(valuePlaceholder, save));
    return wrap;
}

function buildLegacyExistingRow(key, value, valuePlaceholder, save, clear) {
    const row = el('div', 'gm-kv-row');

    const keyLabel = el('div', 'gm-kv-key');
    keyLabel.textContent = key;

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'gm-modal-input gm-kv-input';
    valueInput.placeholder = valuePlaceholder;
    valueInput.value = String(value);

    const saveBtn = el('button', 'gm-icon-btn');
    saveBtn.type = 'button';
    saveBtn.title = 'Save';
    saveBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    saveBtn.addEventListener('click', async () => {
        try {
            const updated = await save(key, parseScalar(valueInput.value));
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm.sheet] save kv failed', err);
            alert(`Save failed: ${err?.message || err}`);
        }
    });

    const removeBtn = el('button', 'gm-icon-btn');
    removeBtn.type = 'button';
    removeBtn.title = 'Delete';
    removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    removeBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${key}"?`)) return;
        try {
            const updated = await clear(key);
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm.sheet] clear kv failed', err);
            alert(`Delete failed: ${err?.message || err}`);
        }
    });

    row.append(keyLabel, valueInput, saveBtn, removeBtn);
    return row;
}

function buildLegacyAddRow(valuePlaceholder, save) {
    const row = el('div', 'gm-kv-add-row');

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'gm-modal-input gm-kv-input';
    keyInput.placeholder = 'new key';

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'gm-modal-input gm-kv-input';
    valueInput.placeholder = valuePlaceholder;

    const addBtn = el('button', 'gm-secondary-btn');
    addBtn.type = 'button';
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add';
    addBtn.addEventListener('click', async () => {
        const key = keyInput.value.trim();
        if (!key) return;
        try {
            const updated = await save(key, parseScalar(valueInput.value));
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm.sheet] add kv failed', err);
            alert(`Add failed: ${err?.message || err}`);
        }
    });

    row.append(keyInput, valueInput, addBtn);
    return row;
}

/* -------- Legacy flat fallback (no layout available) -------- */

function renderLegacyBody(body, character) {
    body.append(elText('div', 'gm-sheet-section-title', 'Stats'));
    body.append(renderFreeFormKv({
        kv: character.sheet?.stats || {},
        valuePlaceholder: 'value',
        save: (key, value) => api.setStat(character.id, key, value),
        clear: (key) => api.clearStat(character.id, key),
    }));

    body.append(elText('div', 'gm-sheet-section-title', 'Statuses'));
    body.append(renderFreeFormKv({
        kv: character.sheet?.statuses || {},
        valuePlaceholder: 'description',
        save: (key, value) => api.setStatus(character.id, key, String(value)),
        clear: (key) => api.clearStatus(character.id, key),
    }));

    if (character.sheet?.skills?.length) {
        body.append(elText('h4', 'gm-modal-subsection', 'Proficient skills'));
        body.append(elText('p', 'gm-modal-detail-body', character.sheet.skills.join(', ')));
    }
}

/* -------- Helpers -------- */

/**
 * Save-on-blur: only fire `runSave` when the input's current value
 * differs from `initial`. Refreshes `initial` on success so back-to-back
 * edits don't double-save the same value.
 *
 * @param {HTMLInputElement | HTMLTextAreaElement} input
 * @param {string} initial
 * @param {() => Promise<any>} runSave
 */
function bindBlurSave(input, initial, runSave) {
    let lastSaved = initial;
    input.addEventListener('blur', async () => {
        const current = input.value;
        if (current === lastSaved) return;
        try {
            const updated = await runSave();
            if (updated) {
                lastSaved = current;
                applyUpdate(updated);
            }
        } catch (err) {
            console.error('[gm.sheet] save failed', err);
            alert(`Save failed: ${err?.message || err}`);
            input.value = lastSaved;
        }
    });
}

/**
 * Numeric clamp using the field's declared `min`/`max`. Returns `NaN`
 * when the value can't be coerced — the caller skips the save.
 *
 * @param {number} raw
 * @param {{ min?: number, max?: number }} field
 */
function clampNumeric(raw, field) {
    if (!Number.isFinite(raw)) return NaN;
    let v = raw;
    if (typeof field.min === 'number') v = Math.max(field.min, v);
    if (typeof field.max === 'number') v = Math.min(field.max, v);
    return v;
}

/**
 * @param {any} character
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 */
function computeBarMax(character, field) {
    if (field.max_from_key) {
        const fromBag = character.sheet?.stats?.[field.max_from_key];
        const candidate = Number(fromBag);
        if (Number.isFinite(candidate) && candidate > 0) return candidate;
    }
    if (typeof field.max === 'number' && field.max > 0) return field.max;
    return 100;
}

function pickInitialValue(currentValue, defaultValue, fallback) {
    if (currentValue !== undefined && currentValue !== null) return currentValue;
    if (defaultValue !== undefined && defaultValue !== null) return defaultValue;
    return fallback;
}

function numericOrDefault(value, defaultValue, fallback) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const d = Number(defaultValue);
    if (Number.isFinite(d)) return d;
    return fallback;
}

function formatNumber(n) {
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Coerce a free-form input string back into a JSON-friendly scalar.
 * Numbers round-trip; everything else stays a string. Empty strings
 * round-trip as the literal empty string (the caller gates on it).
 */
function parseScalar(raw) {
    const trimmed = String(raw ?? '').trim();
    if (trimmed === '') return '';
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const num = Number(trimmed);
        if (!Number.isNaN(num)) return num;
    }
    return trimmed;
}

function detail(label, value) {
    const wrap = el('div', 'gm-modal-detail');
    wrap.append(elText('div', 'gm-modal-detail-label', label));
    const body = el('div', 'gm-modal-detail-body');
    body.textContent = value || '(empty)';
    wrap.append(body);
    return wrap;
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
