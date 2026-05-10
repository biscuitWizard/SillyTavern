/**
 * Memory Explorer — centre pane.
 *
 * Filter row + paginated record table. Free-text query routes through
 * `POST /api/gm/rag/search` (debounced); empty query falls back to the
 * paginated list endpoint. Pagination uses the `next_offset` cursor the
 * server returns from Qdrant scroll.
 *
 * The list is intentionally re-renderable from scratch — the parent
 * orchestrator owns the active collection state and re-mounts this
 * component when the user picks a different rail entry.
 */

import * as api from '../api.js';
import { WORLD_LORE_ENTRY_KINDS, WORLD_LORE_ORIGINS } from './constants.js';

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * @typedef {import('./left-rail.js').CollectionRef} CollectionRef
 */

/**
 * @param {{
 *   campaignId: string,
 *   collection: CollectionRef,
 *   onSelectRecord: (record: any) => void,
 *   selectedRecordId: string | null,
 * }} params
 * @returns {{ node: HTMLElement, refresh: () => Promise<void>, teardown: () => void }}
 */
export function renderRecordList({ campaignId, collection, onSelectRecord, selectedRecordId }) {
    const root = el('div', 'gm-memex-list');

    const errorBanner = el('div', 'gm-memex-error');
    errorBanner.style.display = 'none';

    const filterRow = el('div', 'gm-memex-filter-row');

    const searchInput = el('input', 'gm-memex-input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search this collection…';
    filterRow.append(field('Search', searchInput));

    const tagInput = el('input', 'gm-memex-input');
    tagInput.type = 'text';
    tagInput.placeholder = 'tag-a, tag-b';
    filterRow.append(field('Tags', tagInput));

    /** @type {HTMLSelectElement} */
    let originSelect = null;
    /** @type {HTMLSelectElement} */
    let entryKindSelect = null;
    if (collection.kind === 'world_lore') {
        originSelect = buildSelect(['', ...WORLD_LORE_ORIGINS], v => v ? humanize(v) : 'Any origin');
        filterRow.append(field('Origin', originSelect));
        entryKindSelect = buildSelect(['', ...WORLD_LORE_ENTRY_KINDS], v => v ? humanize(v) : 'Any kind');
        filterRow.append(field('Entry kind', entryKindSelect));
    }

    const meta = el('div', 'gm-memex-list-meta');
    const summary = elText('span', 'gm-memex-list-summary', '');
    meta.append(summary);

    const table = el('div', 'gm-memex-table');
    const loadMoreBtn = el('button', 'gm-secondary-btn gm-memex-loadmore');
    loadMoreBtn.type = 'button';
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.style.display = 'none';

    root.append(errorBanner, filterRow, meta, table, loadMoreBtn);

    /** @type {{ records: any[], nextOffset: any, mode: 'list' | 'search', queryText: string }} */
    const state = {
        records: [],
        nextOffset: null,
        mode: 'list',
        queryText: '',
    };

    /** @type {number | null} */
    let debounceTimer = null;
    let renderToken = 0;

    function setError(msg) {
        if (!msg) {
            errorBanner.style.display = 'none';
            errorBanner.textContent = '';
            return;
        }
        errorBanner.style.display = '';
        errorBanner.textContent = msg;
    }

    function buildFilters() {
        const filters = {};
        const tagsRaw = String(tagInput.value || '').trim();
        if (tagsRaw) {
            const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
            if (tags.length) filters.tags = tags;
        }
        if (originSelect && originSelect.value) filters.origin = originSelect.value;
        if (entryKindSelect && entryKindSelect.value) filters.entry_kind = entryKindSelect.value;
        return filters;
    }

    async function runList({ append = false } = {}) {
        const token = ++renderToken;
        if (!append) {
            state.records = [];
            state.nextOffset = null;
            renderRows();
        }
        try {
            const filters = buildFilters();
            const out = await api.listRagRecords({
                cid: campaignId,
                kind: collection.kind,
                characterId: collection.characterId,
                filters,
                limit: PAGE_SIZE,
                offset: append ? state.nextOffset : null,
            });
            if (token !== renderToken) return;
            const records = Array.isArray(out.records) ? out.records : [];
            state.records = append ? state.records.concat(records) : records;
            state.nextOffset = out.next_offset ?? null;
            state.mode = 'list';
            setError('');
            renderRows();
        } catch (err) {
            if (token !== renderToken) return;
            console.error('[gm] memex list failed', err);
            setError(`Could not load records: ${(err && err.message) || err}`);
            renderRows();
        }
    }

    async function runSearch() {
        const queryText = String(searchInput.value || '').trim();
        state.queryText = queryText;
        if (!queryText) {
            return runList();
        }
        const token = ++renderToken;
        try {
            const filters = buildFilters();
            const out = await api.searchRag({
                cid: campaignId,
                kind: collection.kind,
                characterId: collection.characterId,
                query: queryText,
                top_k: 20,
                filters: Object.keys(filters).length ? filters : undefined,
            });
            if (token !== renderToken) return;
            const hits = Array.isArray(out.hits) ? out.hits : [];
            state.records = hits.map(h => h && h.record).filter(Boolean);
            state.nextOffset = null;
            state.mode = 'search';
            setError('');
            renderRows();
        } catch (err) {
            if (token !== renderToken) return;
            console.error('[gm] memex search failed', err);
            setError(`Search failed: ${(err && err.message) || err}`);
            renderRows();
        }
    }

    function renderRows() {
        table.replaceChildren();
        if (!state.records.length) {
            const empty = el('div', 'gm-memex-empty');
            empty.textContent = state.mode === 'search'
                ? 'No matches for that query.'
                : 'No records in this collection. New records appear here as the Director, Narrator, and characters speak.';
            table.append(empty);
        } else {
            for (const record of state.records) {
                table.append(renderRow(record, {
                    selected: record.id === selectedRecordId,
                    onClick: () => onSelectRecord(record),
                }));
            }
        }
        const total = state.records.length;
        const suffix = state.mode === 'search' ? ' for query' : '';
        summary.textContent = `${total} record${total === 1 ? '' : 's'}${suffix}`;
        loadMoreBtn.style.display = (state.mode === 'list' && state.nextOffset != null) ? '' : 'none';
    }

    /**
     * Update the in-memory record cache after a save / delete so the
     * list reflects the change without a network round trip. Re-renders
     * synchronously.
     *
     * @param {string} id
     * @param {object | null} record  null deletes the row
     */
    function patchCachedRecord(id, record) {
        const ix = state.records.findIndex(r => r && r.id === id);
        if (ix === -1) {
            if (record) state.records.unshift(record);
        } else if (record === null) {
            state.records.splice(ix, 1);
        } else {
            state.records[ix] = record;
        }
        renderRows();
    }

    function setSelected(id) {
        for (const node of table.querySelectorAll('.gm-memex-row')) {
            const rid = node.getAttribute('data-record-id');
            node.classList.toggle('is-selected', rid === id);
        }
    }

    searchInput.addEventListener('input', () => {
        if (debounceTimer != null) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            debounceTimer = null;
            runSearch().catch(err => console.error('[gm] memex search debounce', err));
        }, SEARCH_DEBOUNCE_MS);
    });
    tagInput.addEventListener('change', () => runList());
    if (originSelect) originSelect.addEventListener('change', () => runList());
    if (entryKindSelect) entryKindSelect.addEventListener('change', () => runList());
    loadMoreBtn.addEventListener('click', () => runList({ append: true }));

    runList().catch(err => console.error('[gm] initial memex list', err));

    return {
        node: root,
        async refresh() {
            if (state.mode === 'search' && state.queryText) await runSearch();
            else await runList();
        },
        teardown() {
            renderToken++;
            if (debounceTimer != null) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
        },
        patchCachedRecord,
        setSelected,
    };
}

/**
 * @param {any} record
 * @param {{ selected: boolean, onClick: () => void }} ui
 */
function renderRow(record, { selected, onClick }) {
    const row = el('button', `gm-memex-row${selected ? ' is-selected' : ''}`);
    row.type = 'button';
    row.dataset.recordId = record.id || '';
    row.addEventListener('click', onClick);

    const main = el('div', 'gm-memex-row-main');
    const title = el('div', 'gm-memex-row-title');
    title.textContent = recordTitle(record);
    main.append(title);

    const tagWrap = el('div', 'gm-memex-tags');
    for (const tag of (record.tags || []).slice(0, 8)) {
        tagWrap.append(elText('span', 'gm-memex-tag-chip', tag));
    }
    main.append(tagWrap);

    const metaLine = el('div', 'gm-memex-row-meta');
    metaLine.append(metaPill('importance', formatNumber(record.importance, 2)));
    metaLine.append(metaPill('valence', formatNumber(record.valence, 2)));
    if (record.kind === 'world_lore' && record.world_lore) {
        metaLine.append(metaPill('origin', record.world_lore.origin || '—'));
        metaLine.append(metaPill('kind', record.world_lore.entry_kind || '—'));
    }
    if (record.kind === 'world_lore' && record.world_lore?.scene_id) {
        metaLine.append(metaPill('scene', truncate(record.world_lore.scene_id, 14)));
    } else if (record.metadata && record.metadata.scene_id) {
        metaLine.append(metaPill('scene', truncate(String(record.metadata.scene_id), 14)));
    }
    if (record.created_at) {
        metaLine.append(metaPill('created', formatRelative(record.created_at)));
    }
    main.append(metaLine);

    row.append(main);
    return row;
}

function recordTitle(record) {
    if (record.kind === 'world_lore' && record.world_lore?.title) return record.world_lore.title;
    const content = String(record.content || '').trim();
    if (!content) return record.id || '(untitled)';
    const firstLine = content.split('\n')[0].trim();
    return firstLine.length > 96 ? `${firstLine.slice(0, 96)}…` : firstLine;
}

function metaPill(label, value) {
    const pill = el('span', 'gm-memex-meta-pill');
    pill.append(elText('span', 'gm-memex-meta-pill-label', `${label}:`));
    pill.append(elText('span', 'gm-memex-meta-pill-value', String(value)));
    return pill;
}

function field(label, control) {
    const wrap = el('label', 'gm-memex-field');
    wrap.append(elText('span', 'gm-memex-field-label', label));
    wrap.append(control);
    return wrap;
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

function formatNumber(n, digits) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return n.toFixed(digits);
}

function truncate(s, max) {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function humanize(s) {
    return String(s).replace(/_/g, ' ');
}

function formatRelative(iso) {
    const then = Date.parse(iso);
    if (!then) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(then).toLocaleDateString();
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
