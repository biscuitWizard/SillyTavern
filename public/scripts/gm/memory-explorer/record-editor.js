/**
 * Memory Explorer — right pane editor.
 *
 * Pre-fills from the selected record. Save → `PATCH /api/gm/rag/memories/:id`,
 * Delete → `DELETE /api/gm/rag/memories/:id` after `confirm()`.
 *
 * The editor never throws past its render boundary — every API call is
 * wrapped and surfaces as an inline status banner so the parent surface
 * keeps working even if the patch fails.
 */

import * as api from '../api.js';
import { WORLD_LORE_ENTRY_KINDS, WORLD_LORE_ORIGINS } from './constants.js';

/**
 * @typedef {import('./left-rail.js').CollectionRef} CollectionRef
 */

/**
 * @param {{
 *   campaignId: string,
 *   collection: CollectionRef,
 *   record: any,
 *   onSaved: (record: any) => void,
 *   onDeleted: (id: string) => void,
 * }} params
 */
export function renderRecordEditor({ campaignId, collection, record, onSaved, onDeleted }) {
    const root = el('div', 'gm-memex-editor');

    if (!record) {
        root.append(emptyState());
        return { node: root };
    }

    const header = el('div', 'gm-memex-editor-header');
    header.append(elText('div', 'gm-memex-editor-title', titleFor(record)));
    header.append(elText('div', 'gm-memex-editor-id', record.id || ''));
    root.append(header);

    const status = el('div', 'gm-memex-editor-status');
    status.style.display = 'none';
    root.append(status);

    const contentArea = el('textarea', 'gm-memex-textarea');
    contentArea.rows = 8;
    contentArea.value = String(record.content || '');
    root.append(field('Content', contentArea));

    const tagsInput = el('input', 'gm-memex-input');
    tagsInput.type = 'text';
    tagsInput.value = (record.tags || []).join(', ');
    root.append(field('Tags (comma-separated)', tagsInput));

    const importanceWrap = el('div', 'gm-memex-slider-row');
    const importance = el('input', 'gm-memex-slider');
    importance.type = 'range';
    importance.min = '0';
    importance.max = '1';
    importance.step = '0.05';
    importance.value = String(clamp(record.importance, 0, 1, 0.5));
    const importanceVal = elText('span', 'gm-memex-slider-value', importance.value);
    importance.addEventListener('input', () => { importanceVal.textContent = importance.value; });
    importanceWrap.append(importance, importanceVal);
    root.append(field('Importance (0–1)', importanceWrap));

    const valenceWrap = el('div', 'gm-memex-slider-row');
    const valence = el('input', 'gm-memex-slider');
    valence.type = 'range';
    valence.min = '-1';
    valence.max = '1';
    valence.step = '0.05';
    valence.value = String(clamp(record.valence, -1, 1, 0));
    const valenceVal = elText('span', 'gm-memex-slider-value', valence.value);
    valence.addEventListener('input', () => { valenceVal.textContent = valence.value; });
    valenceWrap.append(valence, valenceVal);
    root.append(field('Valence (−1…1)', valenceWrap));

    const blindWrap = el('label', 'gm-memex-checkbox-row');
    const blind = document.createElement('input');
    blind.type = 'checkbox';
    blind.checked = !!record.temporally_blind;
    blindWrap.append(blind, document.createTextNode(' Temporally blind (no decay)'));
    root.append(blindWrap);

    /** @type {HTMLSelectElement | null} */
    let entryKindSelect = null;
    /** @type {HTMLSelectElement | null} */
    let originSelect = null;
    if (collection.kind === 'world_lore') {
        entryKindSelect = buildSelect(WORLD_LORE_ENTRY_KINDS, humanize);
        entryKindSelect.value = record.world_lore?.entry_kind || 'custom';
        root.append(field('Entry kind', entryKindSelect));

        originSelect = buildSelect(WORLD_LORE_ORIGINS, v => `${humanize(v)}${v === 'core' ? ' (canonical)' : ''}`);
        originSelect.value = record.world_lore?.origin || 'generated';
        root.append(field('Origin', originSelect));
    }

    const buttons = el('div', 'gm-memex-editor-buttons');
    const save = el('button', 'gm-primary-btn');
    save.type = 'button';
    save.textContent = 'Save';
    const del = el('button', 'gm-secondary-btn gm-memex-delete');
    del.type = 'button';
    del.textContent = 'Delete';
    buttons.append(save, del);
    root.append(buttons);

    function setStatus(msg, kind) {
        if (!msg) {
            status.style.display = 'none';
            status.textContent = '';
            status.className = 'gm-memex-editor-status';
            return;
        }
        status.style.display = '';
        status.textContent = msg;
        status.className = `gm-memex-editor-status is-${kind || 'info'}`;
    }

    save.addEventListener('click', async () => {
        save.disabled = true;
        del.disabled = true;
        setStatus('Saving…', 'info');
        try {
            const patch = {
                content: contentArea.value,
                tags: tagsInput.value.split(',').map(s => s.trim()).filter(Boolean),
                importance: Number(importance.value),
                valence: Number(valence.value),
                temporally_blind: blind.checked,
            };
            if (collection.kind === 'world_lore') {
                patch.world_lore = {
                    ...(record.world_lore || {}),
                    entry_kind: entryKindSelect ? entryKindSelect.value : (record.world_lore?.entry_kind || 'custom'),
                    origin: originSelect ? originSelect.value : (record.world_lore?.origin || 'generated'),
                };
            }
            const updated = await api.patchMemory({
                campaignId,
                kind: collection.kind,
                characterId: collection.characterId,
                id: record.id,
                patch,
            });
            if (!updated) {
                setStatus('Save returned no record.', 'error');
                return;
            }
            setStatus('Saved.', 'ok');
            onSaved(updated);
        } catch (err) {
            console.error('[gm] memex save failed', err);
            setStatus(`Save failed: ${(err && err.message) || err}`, 'error');
        } finally {
            save.disabled = false;
            del.disabled = false;
        }
    });

    del.addEventListener('click', async () => {
        if (!confirm(`Delete record "${titleFor(record)}"? This cannot be undone.`)) return;
        save.disabled = true;
        del.disabled = true;
        setStatus('Deleting…', 'info');
        try {
            await api.deleteMemory({
                campaignId,
                kind: collection.kind,
                characterId: collection.characterId,
                id: record.id,
            });
            setStatus('Deleted.', 'ok');
            onDeleted(record.id);
        } catch (err) {
            console.error('[gm] memex delete failed', err);
            setStatus(`Delete failed: ${(err && err.message) || err}`, 'error');
            save.disabled = false;
            del.disabled = false;
        }
    });

    return { node: root };
}

function emptyState() {
    const empty = el('div', 'gm-memex-editor-empty');
    empty.append(elText('div', 'gm-memex-editor-empty-title', 'No record selected'));
    empty.append(elText('div', 'gm-memex-editor-empty-body', 'Pick a record from the centre pane to inspect or edit it.'));
    return empty;
}

function titleFor(record) {
    if (record.kind === 'world_lore' && record.world_lore?.title) return record.world_lore.title;
    const content = String(record.content || '').trim();
    if (!content) return record.id || '(untitled)';
    const firstLine = content.split('\n')[0].trim();
    return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

function buildSelect(values, formatter) {
    const sel = document.createElement('select');
    sel.className = 'gm-memex-input';
    for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = formatter(v);
        sel.append(opt);
    }
    return sel;
}

function field(label, control) {
    const wrap = el('label', 'gm-memex-editor-field');
    wrap.append(elText('div', 'gm-memex-editor-field-label', label));
    wrap.append(control);
    return wrap;
}

function clamp(n, lo, hi, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

function humanize(s) {
    return String(s).replace(/_/g, ' ');
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
