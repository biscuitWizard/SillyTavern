/**
 * Granular CharacterSheet mutators (Phase 2).
 *
 * Each mutator takes the directories, campaign id, character id, and the
 * payload, and returns the updated Character (or null if the character is
 * missing). They go through `library/store.js` so cache invalidation, atomic
 * writes, and `updated_at` bumps stay in one place.
 */

import * as charStore from '../library/store.js';

/**
 * @typedef {import('../library/schemas.js').Character} Character
 * @typedef {import('../library/schemas.js').CharacterSheet} CharacterSheet
 * @typedef {import('../library/schemas.js').Item} Item
 */

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {(sheet: CharacterSheet) => CharacterSheet} mutate
 * @returns {Character | null}
 */
function withSheet(directories, campaignId, characterId, mutate) {
    const existing = charStore.get(directories, campaignId, characterId);
    if (!existing) return null;
    const sheet = mutate(existing.sheet);
    return charStore.update(directories, campaignId, characterId, { sheet });
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} key
 * @param {number | string} value
 */
export function setStat(directories, campaignId, characterId, key, value) {
    return withSheet(directories, campaignId, characterId, (sheet) => ({
        ...sheet,
        stats: { ...sheet.stats, [key]: value },
    }));
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} key
 * @param {number} delta
 */
export function adjustStat(directories, campaignId, characterId, key, delta) {
    return withSheet(directories, campaignId, characterId, (sheet) => {
        const current = Number(sheet.stats[key] ?? 0);
        return { ...sheet, stats: { ...sheet.stats, [key]: current + delta } };
    });
}

/**
 * Remove an arbitrary stat key from the sheet. Phase 5 makes the stat bag
 * fully KV-driven, so the editor needs a delete primitive parallel to
 * `clearStatus`.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} key
 */
export function clearStat(directories, campaignId, characterId, key) {
    return withSheet(directories, campaignId, characterId, (sheet) => {
        if (!Object.prototype.hasOwnProperty.call(sheet.stats, key)) return sheet;
        const next = { ...sheet.stats };
        delete next[key];
        return { ...sheet, stats: next };
    });
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} key
 * @param {string} value
 */
export function setStatus(directories, campaignId, characterId, key, value) {
    return withSheet(directories, campaignId, characterId, (sheet) => ({
        ...sheet,
        statuses: { ...sheet.statuses, [key]: value },
    }));
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} key
 */
export function clearStatus(directories, campaignId, characterId, key) {
    return withSheet(directories, campaignId, characterId, (sheet) => {
        const next = { ...sheet.statuses };
        delete next[key];
        return { ...sheet, statuses: next };
    });
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {Omit<Item, 'id'> & { id?: string }} item
 */
export function addItem(directories, campaignId, characterId, item) {
    return withSheet(directories, campaignId, characterId, (sheet) => {
        const id = item.id || `item-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        /** @type {Item} */
        const next = {
            id,
            name: String(item.name ?? '').trim(),
            description: String(item.description ?? '').trim(),
            influences: Array.isArray(item.influences) ? [...item.influences] : [],
        };
        return { ...sheet, items: [...sheet.items, next] };
    });
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} itemId
 * @param {Partial<Item>} patch
 */
export function updateItem(directories, campaignId, characterId, itemId, patch) {
    return withSheet(directories, campaignId, characterId, (sheet) => ({
        ...sheet,
        items: sheet.items.map((it) => it.id === itemId ? { ...it, ...patch, id: itemId } : it),
    }));
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} itemId
 */
export function deleteItem(directories, campaignId, characterId, itemId) {
    return withSheet(directories, campaignId, characterId, (sheet) => ({
        ...sheet,
        items: sheet.items.filter((it) => it.id !== itemId),
    }));
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string[]} skills
 */
export function setSkills(directories, campaignId, characterId, skills) {
    return withSheet(directories, campaignId, characterId, (sheet) => ({
        ...sheet,
        skills: Array.isArray(skills) ? [...skills] : [],
    }));
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {string} notes
 */
export function setNotes(directories, campaignId, characterId, notes) {
    return withSheet(directories, campaignId, characterId, (sheet) => ({
        ...sheet,
        notes: String(notes ?? ''),
    }));
}
