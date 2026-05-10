/**
 * Memory Explorer — left rail.
 *
 * Lists the five memory collections for the active campaign. Character
 * memory expands into one row per character so the user can inspect each
 * actor's private notes.
 *
 * The rail is purely presentational; it calls back into `onSelect` with
 * a collection descriptor that the parent uses to drive the centre pane.
 *
 * @typedef {{
 *   id: string,
 *   kind: 'world_lore' | 'character_memory' | 'director_memory' | 'narrator_memory' | 'player_journal',
 *   characterId?: string,
 *   label: string,
 *   sublabel?: string,
 * }} CollectionRef
 */

/**
 * Build the canonical collection list for a campaign.
 *
 * @param {{ id: string }} _campaign
 * @param {Array<{ id: string, name: string, is_player?: boolean }>} characters
 * @returns {CollectionRef[]}
 */
export function buildCollectionRefs(_campaign, characters) {
    /** @type {CollectionRef[]} */
    const refs = [];
    refs.push({ id: 'world_lore', kind: 'world_lore', label: 'World Lore', sublabel: 'Shared canon' });
    for (const ch of (characters || [])) {
        if (!ch || !ch.id) continue;
        refs.push({
            id: `character_memory:${ch.id}`,
            kind: 'character_memory',
            characterId: ch.id,
            label: ch.name || ch.id,
            sublabel: ch.is_player ? 'Player character' : 'Cast member',
        });
    }
    refs.push({ id: 'director_memory',  kind: 'director_memory',  label: 'Director Memory',  sublabel: 'Director-only notes' });
    refs.push({ id: 'narrator_memory',  kind: 'narrator_memory',  label: 'Narrator Memory',  sublabel: 'Scene atmosphere' });
    refs.push({ id: 'player_journal',   kind: 'player_journal',   label: 'Player Journal',   sublabel: 'What the player saw' });
    return refs;
}

/**
 * Render the rail.
 *
 * @param {{
 *   refs: CollectionRef[],
 *   activeId: string | null,
 *   onSelect: (ref: CollectionRef) => void,
 * }} params
 * @returns {HTMLElement}
 */
export function renderLeftRail({ refs, activeId, onSelect }) {
    const root = el('div', 'gm-memex-rail');
    root.append(elText('div', 'gm-memex-rail-title', 'Collections'));
    if (!refs.length) {
        root.append(elText('div', 'gm-memex-rail-empty', 'No collections.'));
        return root;
    }
    for (const ref of refs) {
        const btn = el('button', `gm-memex-rail-item${ref.id === activeId ? ' is-active' : ''}`);
        btn.type = 'button';
        btn.dataset.collectionId = ref.id;
        const label = elText('div', 'gm-memex-rail-label', ref.label);
        btn.append(label);
        if (ref.sublabel) btn.append(elText('div', 'gm-memex-rail-sublabel', ref.sublabel));
        btn.append(elText('div', 'gm-memex-rail-kind', humanizeKind(ref.kind)));
        btn.addEventListener('click', () => onSelect(ref));
        root.append(btn);
    }
    return root;
}

/** @param {CollectionRef['kind']} kind */
function humanizeKind(kind) {
    switch (kind) {
        case 'world_lore':       return 'world_lore';
        case 'character_memory': return 'character_memory';
        case 'director_memory':  return 'director_memory';
        case 'narrator_memory':  return 'narrator_memory';
        case 'player_journal':   return 'player_journal';
        default:                 return String(kind);
    }
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
