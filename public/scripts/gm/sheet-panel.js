/**
 * Character sheet KV editor (Phase 5).
 *
 * Phase 2 shipped this as a read-only modal. Phase 5 promotes it to a real
 * editor for the `stats` and `statuses` KV bags — set, delete, and add
 * arbitrary keys, all backed by the granular `/api/gm/sheets/:id/...`
 * mutators.
 *
 * Items + skills stay read-only this phase (full editor lands in Phase
 * 6/10 once the ruleset's bounded skill catalog is loaded).
 *
 * Edits broadcast a `tt:character-changed` window event so the left
 * sidebar can refresh its compact stats grid live.
 */

import * as api from './api.js';

let activeOverlay = null;
let activeCharacter = null;

/** @param {any} character */
export function openSheetPanel(character) {
    closeSheetPanel();
    activeCharacter = character;

    const overlay = el('div', 'gm-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSheetPanel();
    });

    const panel = el('div', 'gm-modal gm-sheet-modal');
    overlay.append(panel);
    document.body.append(overlay);
    activeOverlay = overlay;

    rerender();

    document.addEventListener('keydown', onEsc);
}

export function closeSheetPanel() {
    if (activeOverlay && activeOverlay.parentNode) {
        activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
    activeCharacter = null;
    document.removeEventListener('keydown', onEsc);
}

function onEsc(e) {
    if (e.key === 'Escape') closeSheetPanel();
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
 * Apply the result of a successful mutation: replace the active character,
 * fire the `tt:character-changed` event, and re-render.
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

/* -------- Renderers -------- */

function renderHeader(character) {
    const head = el('div', 'gm-modal-header');
    head.append(elText('h2', 'gm-modal-title', character.name));
    const close = el('button', 'gm-icon-btn');
    close.type = 'button';
    close.innerHTML = '<i class="fa-solid fa-times"></i>';
    close.addEventListener('click', closeSheetPanel);
    head.append(close);
    return head;
}

function renderBody(character) {
    const body = el('div', 'gm-modal-body');

    body.append(detail('Appearance', character.appearance));
    body.append(detail('Personality', character.personality));
    body.append(detail('Voice', character.voice));
    if (character.background) body.append(detail('Background', character.background));

    body.append(elText('h3', 'gm-modal-section-title', 'Stats'));
    body.append(renderKvSection({
        kind: 'stats',
        kv: character.sheet?.stats || {},
        valuePlaceholder: 'value',
        save: (key, value) => api.setStat(character.id, key, value),
        clear: (key) => api.clearStat(character.id, key),
    }));

    body.append(elText('h3', 'gm-modal-section-title', 'Statuses'));
    body.append(renderKvSection({
        kind: 'statuses',
        kv: character.sheet?.statuses || {},
        valuePlaceholder: 'description',
        save: (key, value) => api.setStatus(character.id, key, String(value)),
        clear: (key) => api.clearStatus(character.id, key),
    }));

    if (character.sheet?.skills?.length) {
        body.append(elText('h4', 'gm-modal-subsection', 'Proficient skills'));
        body.append(elText('p', 'gm-modal-detail-body', character.sheet.skills.join(', ')));
    }

    return body;
}

/**
 * @param {{
 *   kind: string,
 *   kv: Record<string, number | string>,
 *   valuePlaceholder: string,
 *   save: (key: string, value: number | string) => Promise<any>,
 *   clear: (key: string) => Promise<any>,
 * }} args
 */
function renderKvSection({ kind, kv, valuePlaceholder, save, clear }) {
    const wrap = el('div', 'gm-kv-section');

    const keys = Object.keys(kv).sort();
    if (keys.length === 0) {
        wrap.append(elText('p', 'gm-modal-detail-body', '(none yet)'));
    } else {
        const grid = el('div', 'gm-kv-editor');
        for (const key of keys) {
            grid.append(buildExistingRow(key, kv[key], valuePlaceholder, save, clear));
        }
        wrap.append(grid);
    }

    wrap.append(buildAddRow(kind, valuePlaceholder, save));
    return wrap;
}

function buildExistingRow(key, value, valuePlaceholder, save, clear) {
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
            const updated = await save(key, parseValue(valueInput.value));
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm] save kv failed', err);
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
            console.error('[gm] clear kv failed', err);
            alert(`Delete failed: ${err?.message || err}`);
        }
    });

    row.append(keyLabel, valueInput, saveBtn, removeBtn);
    return row;
}

function buildAddRow(kind, valuePlaceholder, save) {
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
            const updated = await save(key, parseValue(valueInput.value));
            applyUpdate(updated);
        } catch (err) {
            console.error('[gm] add kv failed', err);
            alert(`Add failed: ${err?.message || err}`);
        }
    });

    row.append(keyInput, valueInput, addBtn);
    return row;
}

/**
 * Coerce a free-form input string back into a JSON-friendly scalar. Numbers
 * round-trip; everything else stays a string. Empty strings round-trip as
 * the literal empty string (the caller gates on it before submitting).
 */
function parseValue(raw) {
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
