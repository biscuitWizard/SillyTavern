/**
 * Lore schemas (Phase 7).
 *
 * `LoreEntry` is the on-disk YAML shape. Lore entries map 1:1 to
 * `world_lore` MemoryRecords with the typed payload extension.
 */

import { WORLD_LORE_ENTRY_KINDS, WORLD_LORE_SOURCE_TYPES } from '../rag/schemas.js';

/**
 * @typedef {Object} LoreEntry
 * @property {string} [id]                  optional explicit id (otherwise derived from file path + content)
 * @property {string} title
 * @property {string} body
 * @property {('location'|'faction'|'culture'|'people'|'history'|'magic'|'artifact'|'bestiary'|'cosmology'|'language'|'pantheon'|'custom')} entry_kind
 * @property {string[]} [tags]
 * @property {('core'|'generated')} [origin]                defaults to 'core'
 * @property {('seed_pack'|'auto_extracted'|'wizard_paste'|'add_lore'|'scene_end'|'manual')} [source_type]   defaults to 'seed_pack'
 * @property {string | null} [scene_id]
 * @property {number} [importance]          defaults to 0.6
 * @property {boolean} [temporally_blind]   defaults to true for origin === 'core'
 */

/**
 * A character definition bundled inside a lore pack.
 *
 * When a pack is applied to a campaign, `applyLorePack` creates one
 * `Character` JSON file per entry (skipping any that already exist) and
 * returns the `starter_memories` list so the caller can ingest them into
 * Qdrant immediately via `memoryService.write`.
 *
 * @typedef {Object} PackCharacter
 * @property {string} id                slug used as the character id
 * @property {string} name
 * @property {string} [appearance]
 * @property {string} [personality]
 * @property {string} [voice]
 * @property {string} [background]
 * @property {import('../library/schemas.js').CharacterSheet} [sheet]
 * @property {string[]} [starter_memories]   first-person memory strings
 */

/**
 * @typedef {Object} LorePack
 * @property {string} pack_id
 * @property {string} pack_name
 * @property {string} [description]
 * @property {LoreEntry[]} entries
 * @property {PackCharacter[]} [characters]   optional: characters to instantiate when the pack is applied
 */

/**
 * @param {unknown} input
 * @returns {string | null}
 */
export function validateLoreEntry(input) {
    if (!input || typeof input !== 'object') return 'lore entry must be an object';
    const e = /** @type {Record<string, unknown>} */(input);
    if (typeof e.title !== 'string' || !e.title.trim()) return 'title required';
    if (typeof e.body !== 'string' || !e.body.trim()) return 'body required';
    if (typeof e.entry_kind !== 'string' || !WORLD_LORE_ENTRY_KINDS.includes(/** @type {any} */(e.entry_kind))) {
        return `entry_kind must be one of ${WORLD_LORE_ENTRY_KINDS.join(', ')}`;
    }
    if (e.tags !== undefined && (!Array.isArray(e.tags) || e.tags.some(t => typeof t !== 'string'))) {
        return 'tags must be an array of strings';
    }
    if (e.origin !== undefined && e.origin !== 'core' && e.origin !== 'generated') return 'origin invalid';
    if (e.source_type !== undefined && !WORLD_LORE_SOURCE_TYPES.includes(/** @type {any} */(e.source_type))) {
        return 'source_type invalid';
    }
    return null;
}
