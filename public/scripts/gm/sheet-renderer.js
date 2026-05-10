/**
 * Shared category renderer for the character sheet (M6).
 *
 * `renderCategorySection(category, options)` walks a single
 * `SheetCategory` from the merged `SheetLayout` (M1) and emits a
 * <section> matching the visual contract M4 set up in `sheet-panel.js`
 * (same `gm-sheet-section` / `gm-sheet-grid` / `gm-bar-widget` /
 * `gm-paired-widget` / `gm-skills-list` / `gm-items-list` /
 * `gm-notes-wrap` / `gm-rels-list` class names so the M4 stylesheet
 * applies without per-surface overrides).
 *
 * The renderer supports three modes selected by `options.mode`:
 *
 *   - `mode: 'edit'`    — each interaction calls back into the supplied
 *                          setter, which is expected to perform a
 *                          server-side save (this matches the
 *                          per-field-save pattern of `sheet-panel.js`).
 *                          Currently the sheet panel still ships its
 *                          own copy of these widgets — see the M6
 *                          hand-off note for the rationale. This module
 *                          exposes the helper so a future cleanup pass
 *                          can swap the panel over.
 *   - `mode: 'wizard'`  — interactions mutate an in-memory draft via
 *                          the supplied setters; no network calls.
 *                          Used by the character wizard (M6).
 *   - `mode: 'preview'` — read-only rendering: bars and chips render
 *                          but inputs/buttons do not. Used by the
 *                          wizard's Confirm step and any future debug
 *                          surface that wants a non-interactive view.
 *
 * The `options` bag intentionally exposes both per-field accessors
 * (`getValue` / `setValue` for stats and statuses widgets) and
 * bag-level accessors (`skills` + `setSkills`, `items` + `setItems`,
 * `setStatuses`, `notes` + `setNotes`) so the wizard can keep one
 * source of truth (its in-memory state object) while the sheet panel
 * (when migrated) can keep the per-field server-save semantics.
 */

/**
 * @typedef {'edit' | 'wizard' | 'preview'} RendererMode
 *
 * @typedef {{
 *   mode: RendererMode,
 *   getValue: (field: import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField) => any,
 *   setValue: (field: import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField, value: any) => any,
 *   getStatValue?: (key: string) => any,
 *   skills?: string[],
 *   setSkills?: (next: string[]) => any,
 *   rulesetSkills?: Array<{ id: string, name?: string, ability_id?: string }>,
 *   items?: any[],
 *   setItems?: (next: any[]) => any,
 *   statuses?: Record<string, string>,
 *   setStatuses?: (next: Record<string, string>) => any,
 *   relationships?: Record<string, Record<string, any>>,
 *   notes?: string,
 *   setNotes?: (next: string) => any,
 *   onChange?: () => void,
 * }} RenderOptions
 */

/**
 * Render one layout category as a `<section>`. Returns the element
 * fully constructed (caller appends to body / step container).
 *
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetCategory} category
 * @param {RenderOptions} options
 * @returns {HTMLElement}
 */
export function renderCategorySection(category, options) {
    const section = el('div', 'gm-sheet-section');
    section.dataset.categoryId = category.id || '';
    section.dataset.categoryKind = category.kind || '';
    section.append(elText('div', 'gm-sheet-section-title', category.label || category.id || 'Category'));

    if (category.description && options.mode === 'preview') {
        section.append(elText('p', 'gm-modal-detail-body', category.description));
    }

    switch (category.kind) {
        case 'stats':
            section.append(renderTypedGrid(category.fields || [], options));
            return section;
        case 'statuses':
            if (Array.isArray(category.fields) && category.fields.length) {
                section.append(renderTypedGrid(category.fields, options));
            } else {
                section.append(renderFreeFormStatuses(options));
            }
            return section;
        case 'skills':
            section.append(renderSkillsChecklist(options));
            return section;
        case 'items':
            section.append(renderItemsList(options));
            return section;
        case 'notes':
            section.append(renderNotesEditor(options));
            return section;
        case 'relationships':
            // M6: relationships are not editable from the wizard. The
            // sheet panel (M7) owns the per-target editor card; the
            // wizard only flags that the workflow exists. The notice
            // here intentionally short-circuits even when the layout
            // YAML opts the category in via `wizard_step: true` —
            // see the M6 hand-off note + plan §"Wizard state".
            section.append(renderRelationshipsNotice(options));
            return section;
        default:
            section.append(elText('p', 'gm-modal-detail-body',
                `(unknown category kind: ${String(category.kind)})`));
            return section;
    }
}

/* ---------------- Stats / typed-status grid ---------------- */

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField[]} fields
 * @param {RenderOptions} options
 */
function renderTypedGrid(fields, options) {
    const grid = el('div', 'gm-sheet-grid');
    for (const field of fields) {
        if (!field || !field.key) continue;
        const cell = el('div', 'gm-sheet-field');
        cell.append(elText('div', 'gm-sheet-field-label', field.label || field.key));
        cell.append(renderFieldControl(field, options));
        grid.append(cell);
    }
    return grid;
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {RenderOptions} options
 */
function renderFieldControl(field, options) {
    const control = el('div', 'gm-sheet-field-control');
    if (options.mode === 'preview') {
        control.append(renderPreviewValue(field, options));
        return control;
    }
    switch (field.type) {
        case 'number':
            control.append(buildNumberInput(field, options));
            return control;
        case 'text':
            control.append(buildTextInput(field, options));
            return control;
        case 'bar':
            control.append(buildBarWidget(field, options));
            return control;
        case 'paired':
            control.append(buildPairedWidget(field, options));
            return control;
        default:
            control.append(buildTextInput(field, options));
            return control;
    }
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {RenderOptions} options
 */
function renderPreviewValue(field, options) {
    if (field.type === 'bar') {
        const wrap = el('div', 'gm-bar-widget');
        const current = numericOrDefault(options.getValue(field), field.default, 0);
        const max = computeBarMax(field, options);
        const bar = el('div', 'gm-bar');
        const fill = el('div', 'gm-bar-fill');
        const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
        fill.style.width = `${ratio * 100}%`;
        bar.append(fill);
        const labelRow = el('div', 'gm-bar-label');
        labelRow.append(elText('span', 'gm-bar-value',
            `${formatNumber(current)} / ${formatNumber(max)}`));
        wrap.append(bar, labelRow);
        return wrap;
    }
    if (field.type === 'paired') {
        // Render the same paired bar visual as the editor, but with
        // both legs as static values.
        const min = typeof field.min === 'number' ? field.min : -100;
        const max = typeof field.max === 'number' ? field.max : 100;
        const leftValue = numericOrDefault(options.getValue(field), field.default, 0);
        const rightField = field.paired_with
            ? /** @type {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} */({
                key: field.paired_with.key,
                label: field.paired_with.label,
                type: field.type,
                default: field.paired_with.default,
                min: field.min,
                max: field.max,
            })
            : null;
        const rightValue = rightField ? numericOrDefault(options.getValue(rightField), rightField.default, 0) : 0;
        const wrap = el('div', 'gm-paired-widget');
        const lean = Math.max(min, Math.min(max, rightValue - leftValue));
        const bar = el('div', 'gm-paired-bar');
        const leftFill = el('div', 'gm-paired-bar-fill-left');
        const rightFill = el('div', 'gm-paired-bar-fill-right');
        if (lean < 0 && min < 0) leftFill.style.width = `${(Math.abs(lean) / Math.abs(min)) * 50}%`;
        if (lean > 0 && max > 0) rightFill.style.width = `${(lean / max) * 50}%`;
        bar.append(leftFill, rightFill);
        const labelRow = el('div', 'gm-paired-row');
        const leftCell = el('div', 'gm-paired-cell gm-paired-cell-left');
        leftCell.append(elText('span', 'gm-paired-label', field.label || field.key));
        leftCell.append(elText('span', 'gm-bar-value', formatNumber(leftValue)));
        const rightCell = el('div', 'gm-paired-cell gm-paired-cell-right');
        rightCell.append(elText('span', 'gm-paired-label', field.paired_with?.label || field.paired_with?.key || ''));
        rightCell.append(elText('span', 'gm-bar-value', formatNumber(rightValue)));
        labelRow.append(leftCell, rightCell);
        wrap.append(bar, labelRow);
        return wrap;
    }
    const raw = options.getValue(field);
    const seeded = pickInitialValue(raw, field.default, '');
    const node = el('div', 'gm-modal-detail-body');
    node.textContent = seeded === '' ? '(empty)' : String(seeded);
    return node;
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {RenderOptions} options
 */
function buildNumberInput(field, options) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'gm-modal-input';
    if (typeof field.min === 'number') input.min = String(field.min);
    if (typeof field.max === 'number') input.max = String(field.max);
    const seeded = pickInitialValue(options.getValue(field), field.default, '');
    input.value = String(seeded);
    bindFieldInput(input, () => {
        const next = clampNumeric(parseFloat(input.value), field);
        if (Number.isNaN(next)) return null;
        options.setValue(field, next);
        return next;
    });
    return input;
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {RenderOptions} options
 */
function buildTextInput(field, options) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gm-modal-input';
    const seeded = pickInitialValue(options.getValue(field), field.default, '');
    input.value = String(seeded);
    bindFieldInput(input, () => {
        options.setValue(field, input.value);
        return input.value;
    });
    return input;
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {RenderOptions} options
 */
function buildBarWidget(field, options) {
    const wrap = el('div', 'gm-bar-widget');
    const current = numericOrDefault(options.getValue(field), field.default, 0);
    const max = computeBarMax(field, options);

    const bar = el('div', 'gm-bar');
    const fill = el('div', 'gm-bar-fill');
    const setFill = (value) => {
        const safeMax = computeBarMax(field, options);
        const ratio = safeMax > 0 ? Math.max(0, Math.min(1, value / safeMax)) : 0;
        fill.style.width = `${ratio * 100}%`;
    };
    setFill(current);
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
    bindFieldInput(input, () => {
        const next = clampNumeric(parseFloat(input.value), field);
        if (Number.isNaN(next)) return null;
        options.setValue(field, next);
        const newMax = computeBarMax(field, options);
        valueDisplay.textContent = `${formatNumber(next)} / ${formatNumber(newMax)}`;
        setFill(next);
        return next;
    });
    labelRow.append(input);

    wrap.append(bar, labelRow);
    return wrap;
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {RenderOptions} options
 */
function buildPairedWidget(field, options) {
    const wrap = el('div', 'gm-paired-widget');
    const min = typeof field.min === 'number' ? field.min : -100;
    const max = typeof field.max === 'number' ? field.max : 100;
    const leftValue = numericOrDefault(options.getValue(field), field.default, 0);
    const rightKey = field.paired_with?.key;
    const rightLabel = field.paired_with?.label || rightKey || '';
    const rightDefault = field.paired_with?.default;
    /** @type {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField | null} */
    const rightField = rightKey
        ? {
            key: rightKey,
            label: rightLabel,
            type: 'paired',
            default: rightDefault,
            min: field.min,
            max: field.max,
        }
        : null;
    const rightValue = rightField ? numericOrDefault(options.getValue(rightField), rightField.default, 0) : 0;

    const bar = el('div', 'gm-paired-bar');
    const leftFill = el('div', 'gm-paired-bar-fill-left');
    const rightFill = el('div', 'gm-paired-bar-fill-right');
    const refresh = (l, r) => {
        const lean = Math.max(min, Math.min(max, r - l));
        leftFill.style.width = lean < 0 && min < 0 ? `${(Math.abs(lean) / Math.abs(min)) * 50}%` : '0%';
        rightFill.style.width = lean > 0 && max > 0 ? `${(lean / max) * 50}%` : '0%';
    };
    refresh(leftValue, rightValue);
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
    bindFieldInput(leftInput, () => {
        const next = clampNumeric(parseFloat(leftInput.value), field);
        if (Number.isNaN(next)) return null;
        options.setValue(field, next);
        const r = rightField ? numericOrDefault(options.getValue(rightField), rightField.default, 0) : 0;
        refresh(next, r);
        return next;
    });
    leftCell.append(leftInput);

    const rightCell = el('div', 'gm-paired-cell gm-paired-cell-right');
    rightCell.append(elText('span', 'gm-paired-label', rightLabel));
    const rightInput = document.createElement('input');
    rightInput.type = 'number';
    rightInput.className = 'gm-modal-input gm-paired-input gm-paired-input-right';
    if (typeof field.min === 'number') rightInput.min = String(field.min);
    if (typeof field.max === 'number') rightInput.max = String(field.max);
    rightInput.disabled = !rightField;
    rightInput.value = String(rightValue);
    if (rightField) {
        bindFieldInput(rightInput, () => {
            const next = clampNumeric(parseFloat(rightInput.value), field);
            if (Number.isNaN(next)) return null;
            options.setValue(rightField, next);
            const l = numericOrDefault(options.getValue(field), field.default, 0);
            refresh(l, next);
            return next;
        });
    }
    rightCell.append(rightInput);

    labelRow.append(leftCell, rightCell);
    wrap.append(bar, labelRow);
    return wrap;
}

/* ---------------- Skills checklist ---------------- */

/**
 * @param {RenderOptions} options
 */
function renderSkillsChecklist(options) {
    const wrap = el('div', 'gm-skills-list');
    const skills = Array.isArray(options.rulesetSkills) ? options.rulesetSkills : [];
    const owned = new Set(Array.isArray(options.skills) ? options.skills : []);

    if (options.mode === 'preview') {
        const list = [...owned];
        if (!list.length) {
            wrap.append(elText('p', 'gm-modal-detail-body', '(no proficient skills selected)'));
        } else {
            wrap.append(elText('p', 'gm-modal-detail-body', `Proficient: ${list.join(', ')}`));
        }
        return wrap;
    }

    if (!skills.length) {
        // No catalog available — show whatever the owned set holds.
        wrap.append(elText('p', 'gm-modal-detail-body',
            owned.size ? `Proficient: ${[...owned].join(', ')}` : '(no skills available for this ruleset)'));
        return wrap;
    }

    for (const skill of skills) {
        wrap.append(buildSkillRow(skill, owned, options));
    }
    return wrap;
}

/**
 * @param {{ id: string, name?: string, ability_id?: string }} skill
 * @param {Set<string>} owned
 * @param {RenderOptions} options
 */
function buildSkillRow(skill, owned, options) {
    const row = el('label', 'gm-skill-row');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'gm-skill-checkbox';
    checkbox.checked = owned.has(skill.id);
    checkbox.addEventListener('change', () => {
        const next = new Set(owned);
        if (checkbox.checked) next.add(skill.id);
        else next.delete(skill.id);
        if (typeof options.setSkills === 'function') options.setSkills([...next]);
        owned.clear();
        for (const id of next) owned.add(id);
        if (typeof options.onChange === 'function') options.onChange();
    });

    const name = el('span', 'gm-skill-name');
    name.textContent = skill.name || skill.id;

    const ability = el('span', 'gm-skill-ability');
    ability.textContent = (skill.ability_id || '').toUpperCase();

    row.append(checkbox, name, ability);
    return row;
}

/* ---------------- Items list ---------------- */

/**
 * @param {RenderOptions} options
 */
function renderItemsList(options) {
    const wrap = el('div', 'gm-items-list');
    const items = Array.isArray(options.items) ? options.items : [];

    if (options.mode === 'preview') {
        if (!items.length) {
            wrap.append(elText('p', 'gm-modal-detail-body', '(no items)'));
            return wrap;
        }
        for (const item of items) wrap.append(buildItemPreviewRow(item));
        return wrap;
    }

    if (!items.length) {
        wrap.append(elText('p', 'gm-modal-detail-body', '(no items)'));
    } else {
        items.forEach((item, idx) => wrap.append(buildItemRow(item, idx, options, wrap)));
    }
    wrap.append(buildItemAddRow(options, wrap));
    return wrap;
}

/**
 * @param {any} item
 * @param {number} idx
 * @param {RenderOptions} options
 * @param {HTMLElement} listRoot
 */
function buildItemRow(item, idx, options, listRoot) {
    const row = el('div', 'gm-item-row');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'gm-modal-input gm-item-name';
    nameInput.value = item.name || '';
    nameInput.addEventListener('input', () => {
        item.name = nameInput.value;
        if (typeof options.setItems === 'function') options.setItems(options.items || []);
    });

    const descInput = document.createElement('textarea');
    descInput.className = 'gm-modal-textarea gm-item-desc';
    descInput.rows = 2;
    descInput.value = item.description || '';
    descInput.addEventListener('input', () => {
        item.description = descInput.value;
        if (typeof options.setItems === 'function') options.setItems(options.items || []);
    });

    row.append(nameInput, descInput);

    const actions = el('div', 'gm-item-actions');
    const removeBtn = el('button', 'gm-icon-btn');
    removeBtn.type = 'button';
    removeBtn.title = 'Remove starting item';
    removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    removeBtn.addEventListener('click', () => {
        const list = Array.isArray(options.items) ? options.items.slice() : [];
        list.splice(idx, 1);
        if (typeof options.setItems === 'function') options.setItems(list);
        rebuildItemList(listRoot, options);
    });
    actions.append(removeBtn);
    row.append(actions);
    return row;
}

/**
 * @param {any} item
 */
function buildItemPreviewRow(item) {
    const row = el('div', 'gm-item-row');
    const name = el('div', 'gm-item-name');
    name.textContent = item.name || '(unnamed item)';
    const desc = el('div', 'gm-item-desc');
    desc.textContent = item.description || '';
    row.append(name, desc);
    return row;
}

/**
 * @param {RenderOptions} options
 * @param {HTMLElement} listRoot
 */
function buildItemAddRow(options, listRoot) {
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
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add starting item';
    addBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) return;
        const list = Array.isArray(options.items) ? options.items.slice() : [];
        list.push({
            // Wizard-side draft items don't yet have a server id; the
            // sheet `addItem` mutator (server-side) generates one when
            // the character is persisted.
            name,
            description: descInput.value.trim(),
            influences: [],
        });
        if (typeof options.setItems === 'function') options.setItems(list);
        nameInput.value = '';
        descInput.value = '';
        rebuildItemList(listRoot, options);
    });

    row.append(nameInput, descInput, addBtn);
    return row;
}

/**
 * Replace the list root's children with a freshly-rendered version of
 * the items list. We rebuild rather than splice so the indices in
 * remove handlers stay accurate without re-allocating per row.
 *
 * @param {HTMLElement} listRoot
 * @param {RenderOptions} options
 */
function rebuildItemList(listRoot, options) {
    const fresh = renderItemsList(options);
    listRoot.replaceChildren(...Array.from(fresh.childNodes));
    if (typeof options.onChange === 'function') options.onChange();
}

/* ---------------- Free-form statuses (kind: statuses w/o fields) ---------------- */

/**
 * @param {RenderOptions} options
 */
function renderFreeFormStatuses(options) {
    const wrap = el('div', 'gm-kv-section');
    const bag = options.statuses && typeof options.statuses === 'object' ? options.statuses : {};
    const keys = Object.keys(bag).sort();

    if (options.mode === 'preview') {
        if (!keys.length) {
            wrap.append(elText('p', 'gm-modal-detail-body', '(none)'));
            return wrap;
        }
        const grid = el('div', 'gm-kv-editor');
        for (const k of keys) {
            const row = el('div', 'gm-kv-row');
            row.append(elText('div', 'gm-kv-key', k));
            row.append(elText('div', 'gm-modal-detail-body', String(bag[k])));
            grid.append(row);
        }
        wrap.append(grid);
        return wrap;
    }

    if (keys.length) {
        const grid = el('div', 'gm-kv-editor');
        for (const k of keys) {
            grid.append(buildStatusRow(k, bag[k], options, wrap));
        }
        wrap.append(grid);
    } else {
        wrap.append(elText('p', 'gm-modal-detail-body', '(none yet)'));
    }
    wrap.append(buildStatusAddRow(options, wrap));
    return wrap;
}

/**
 * @param {string} key
 * @param {string} value
 * @param {RenderOptions} options
 * @param {HTMLElement} listRoot
 */
function buildStatusRow(key, value, options, listRoot) {
    const row = el('div', 'gm-kv-row');
    row.append(elText('div', 'gm-kv-key', key));

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'gm-modal-input gm-kv-input';
    valueInput.placeholder = 'description';
    valueInput.value = String(value ?? '');
    valueInput.addEventListener('input', () => {
        const next = { ...(options.statuses || {}) };
        next[key] = valueInput.value;
        if (typeof options.setStatuses === 'function') options.setStatuses(next);
    });

    const removeBtn = el('button', 'gm-icon-btn');
    removeBtn.type = 'button';
    removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    removeBtn.addEventListener('click', () => {
        const next = { ...(options.statuses || {}) };
        delete next[key];
        if (typeof options.setStatuses === 'function') options.setStatuses(next);
        rebuildStatuses(listRoot, options);
    });

    row.append(valueInput, removeBtn);
    return row;
}

/**
 * @param {RenderOptions} options
 * @param {HTMLElement} listRoot
 */
function buildStatusAddRow(options, listRoot) {
    const row = el('div', 'gm-kv-add-row');

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'gm-modal-input gm-kv-input';
    keyInput.placeholder = 'condition';

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'gm-modal-input gm-kv-input';
    valueInput.placeholder = 'description';

    const addBtn = el('button', 'gm-secondary-btn');
    addBtn.type = 'button';
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add';
    addBtn.addEventListener('click', () => {
        const key = keyInput.value.trim();
        if (!key) return;
        const next = { ...(options.statuses || {}) };
        next[key] = valueInput.value.trim();
        if (typeof options.setStatuses === 'function') options.setStatuses(next);
        keyInput.value = '';
        valueInput.value = '';
        rebuildStatuses(listRoot, options);
    });

    row.append(keyInput, valueInput, addBtn);
    return row;
}

/**
 * @param {HTMLElement} listRoot
 * @param {RenderOptions} options
 */
function rebuildStatuses(listRoot, options) {
    const fresh = renderFreeFormStatuses(options);
    listRoot.replaceChildren(...Array.from(fresh.childNodes));
    if (typeof options.onChange === 'function') options.onChange();
}

/* ---------------- Notes ---------------- */

/**
 * @param {RenderOptions} options
 */
function renderNotesEditor(options) {
    const wrap = el('div', 'gm-notes-wrap');
    const initial = typeof options.notes === 'string' ? options.notes : '';
    if (options.mode === 'preview') {
        const node = el('div', 'gm-modal-detail-body');
        node.textContent = initial.length ? initial : '(no notes)';
        wrap.append(node);
        return wrap;
    }
    const textarea = document.createElement('textarea');
    textarea.className = 'gm-modal-textarea';
    textarea.rows = 6;
    textarea.placeholder = 'Free-form notes (private to the player).';
    textarea.value = initial;
    textarea.addEventListener('input', () => {
        if (typeof options.setNotes === 'function') options.setNotes(textarea.value);
    });
    wrap.append(textarea);
    return wrap;
}

/* ---------------- Relationships notice ---------------- */

/**
 * @param {RenderOptions} options
 */
function renderRelationshipsNotice(options) {
    const wrap = el('div', 'gm-rels-list');
    const rels = options.relationships;
    const hasAny = rels && typeof rels === 'object' && Object.keys(rels).length > 0;
    if (options.mode === 'preview' && hasAny) {
        for (const [otherId, fields] of Object.entries(rels)) {
            const card = el('div', 'gm-rel-card');
            card.append(elText('div', 'gm-rel-card-title', otherId));
            const grid = el('div', 'gm-rel-card-grid');
            if (fields && typeof fields === 'object') {
                for (const [k, v] of Object.entries(fields)) {
                    const cell = el('div', 'gm-rel-field');
                    cell.append(elText('div', 'gm-rel-field-label', k));
                    cell.append(elText('div', 'gm-rel-field-value', String(v)));
                    grid.append(cell);
                }
            }
            card.append(grid);
            wrap.append(card);
        }
        return wrap;
    }
    wrap.append(elText('p', 'gm-modal-detail-body',
        'You\'ll set up relationships after creation, from the sheet panel.'));
    return wrap;
}

/* ---------------- Helpers ---------------- */

/**
 * Wire up an editable widget so the supplied `runSetter` runs both on
 * `input` (for live-feedback widgets that mirror state, like the bar
 * fill) and on `blur` (so we always have a final commit). Errors raised
 * by the setter are caught — the wizard never displays them; the sheet
 * panel is not on this code path yet.
 *
 * @param {HTMLInputElement} input
 * @param {() => any} runSetter
 */
function bindFieldInput(input, runSetter) {
    const handler = () => {
        try { runSetter(); } catch (err) { console.warn('[gm.sheet-renderer] setter threw', err); }
    };
    input.addEventListener('input', handler);
    input.addEventListener('blur', handler);
}

/**
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetField} field
 * @param {RenderOptions} options
 */
function computeBarMax(field, options) {
    if (field.max_from_key && typeof options.getStatValue === 'function') {
        const candidate = Number(options.getStatValue(field.max_from_key));
        if (Number.isFinite(candidate) && candidate > 0) return candidate;
    }
    if (typeof field.max === 'number' && field.max > 0) return field.max;
    return 100;
}

function clampNumeric(raw, field) {
    if (!Number.isFinite(raw)) return NaN;
    let v = raw;
    if (typeof field.min === 'number') v = Math.max(field.min, v);
    if (typeof field.max === 'number') v = Math.min(field.max, v);
    return v;
}

function pickInitialValue(currentValue, defaultValue, fallback) {
    if (currentValue !== undefined && currentValue !== null && currentValue !== '') return currentValue;
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
