/**
 * Event log filter bar.
 */

const ROLE_CHIPS = [
    'director', 'narrator', 'actor', 'adjudicator', 'summarizer',
    'opening', 'ask', 'plot', 'lore', 'opinion_writer',
    'narrator_continuity_writer', 'scene_summary', 'memory_extraction',
];

const SCOPE_OPTIONS = [
    { value: '', label: 'All scopes' },
    { value: 'turn', label: 'turn' },
    { value: 'scene_end', label: 'scene_end' },
    { value: 'opening', label: 'opening' },
    { value: 'ask', label: 'ask' },
    { value: 'plot', label: 'plot' },
    { value: 'lore', label: 'lore' },
    { value: 'rag_writer', label: 'rag_writer' },
    { value: 'other', label: 'other' },
];

const DEBOUNCE_MS = 200;

/**
 * @param {{ onFilterChange: (filters: { roles: string[], scopes: string[], text: string }) => void }} opts
 * @returns {HTMLElement}
 */
export function renderFilters({ onFilterChange }) {
    const state = { roles: new Set(), scope: '', text: '' };

    const bar = document.createElement('div');
    bar.className = 'gm-evlog-filter-bar';

    /* ---- Role chips ---- */
    for (const role of ROLE_CHIPS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'gm-evlog-filter-chip';
        chip.textContent = role;
        chip.addEventListener('click', () => {
            if (state.roles.has(role)) {
                state.roles.delete(role);
                chip.classList.remove('active');
            } else {
                state.roles.add(role);
                chip.classList.add('active');
            }
            emitChange();
        });
        bar.append(chip);
    }

    /* ---- Scope select ---- */
    const select = document.createElement('select');
    select.className = 'gm-evlog-filter-select';
    for (const opt of SCOPE_OPTIONS) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.append(o);
    }
    select.addEventListener('change', () => {
        state.scope = select.value;
        emitChange();
    });
    bar.append(select);

    /* ---- Text search ---- */
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'gm-evlog-filter-search';
    search.placeholder = 'Search headlines\u2026';
    let debounceTimer = null;
    search.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            state.text = search.value.trim();
            emitChange();
        }, DEBOUNCE_MS);
    });
    bar.append(search);

    function emitChange() {
        onFilterChange({
            roles: Array.from(state.roles),
            scopes: state.scope ? [state.scope] : [],
            text: state.text,
        });
    }

    return bar;
}
