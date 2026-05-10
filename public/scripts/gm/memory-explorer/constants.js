/**
 * Mirror of the small constant arrays in `src/gm-core/rag/schemas.js`.
 *
 * The browser bundle can't import that module directly (server-side path),
 * so we duplicate the enums here. Keep them in sync with the canonical
 * definitions on the server.
 */

export const WORLD_LORE_ORIGINS = ['core', 'generated'];

export const WORLD_LORE_ENTRY_KINDS = [
    'location', 'faction', 'culture', 'people', 'history',
    'magic', 'artifact', 'bestiary', 'cosmology', 'language',
    'pantheon', 'custom',
];

export const WORLD_LORE_SOURCE_TYPES = [
    'seed_pack', 'auto_extracted', 'wizard_paste',
    'add_lore', 'scene_end', 'manual',
];

export const MEMORY_KINDS = [
    'world_lore',
    'character_memory',
    'director_memory',
    'narrator_memory',
    'player_journal',
];
