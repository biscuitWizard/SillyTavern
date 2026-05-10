/**
 * RAG schemas (Phase 7).
 *
 * One `MemoryRecord` shape backs all five collections; the `kind` enum
 * drives collection naming and policy. World-lore records carry a typed
 * payload extension (`WorldLorePayload`) for facet search.
 *
 * Disk JSON/JSONL is canonical. Qdrant is a derived index. Records on
 * disk look exactly like records in Qdrant payloads (minus the vector).
 */

/**
 * @typedef {(
 *  | 'world_lore'
 *  | 'character_memory'
 *  | 'director_memory'
 *  | 'narrator_memory'
 *  | 'player_journal'
 * )} MemoryKind
 */

/**
 * @typedef {Object} DecayConfig
 * @property {'exponential' | 'linear'} mode
 * @property {number} half_life     Half-life expressed in `scenes_elapsed` units.
 * @property {number} floor          Lowest multiplier the decay can produce, 0..1.
 * @property {boolean} [nostalgia]   When true, older records score *higher*; default false.
 */

/**
 * @typedef {Object} WorldLorePayload
 * @property {'core' | 'generated'} origin
 * @property {'seed_pack' | 'auto_extracted' | 'wizard_paste' | 'add_lore' | 'scene_end' | 'ask_mode' | 'manual'} source_type
 * @property {string | null} scene_id
 * @property {('location' | 'faction' | 'culture' | 'people' | 'history' | 'magic' | 'artifact' | 'bestiary' | 'cosmology' | 'language' | 'pantheon' | 'custom')} entry_kind
 * @property {string} title
 */

/**
 * @typedef {Object} MemoryRecord
 * @property {string} id                      deterministic sha256 slice
 * @property {MemoryKind} kind
 * @property {string} scope_id                campaign_id, or `${cid}/${character_id}` for character_memory
 * @property {string} content
 * @property {string[]} tags
 * @property {number} importance              0..1
 * @property {number} valence                 -1..1
 * @property {boolean} temporally_blind
 * @property {DecayConfig | null} decay_override
 * @property {string} source                  free-form provenance string
 * @property {string} created_at
 * @property {string} updated_at
 * @property {Record<string, unknown>} metadata
 * @property {WorldLorePayload} [world_lore]  only present when kind === 'world_lore'
 * @property {number} [scene_index]           captured at write time so decay can compute scenes_elapsed
 */

/**
 * @typedef {Object} RetrievalQuery
 * @property {string} text                    raw query text; the service embeds it
 * @property {number} [top_k]
 * @property {Partial<WorldLorePayload>} [world_filters]
 * @property {string[]} [tags]                tag-any-of filter
 * @property {boolean} [include_blind]        defaults true
 */

/**
 * @typedef {Object} RetrievalHit
 * @property {MemoryRecord} record
 * @property {number} raw_score               cosine-ish from Qdrant (0..1ish)
 * @property {number} score                   raw * decay multiplier
 * @property {number} decay_multiplier
 */

export const MEMORY_KINDS = /** @type {const} */ ([
    'world_lore',
    'character_memory',
    'director_memory',
    'narrator_memory',
    'player_journal',
]);

export const WORLD_LORE_ORIGINS = /** @type {const} */ (['core', 'generated']);

export const WORLD_LORE_ENTRY_KINDS = /** @type {const} */ ([
    'location', 'faction', 'culture', 'people', 'history',
    'magic', 'artifact', 'bestiary', 'cosmology', 'language',
    'pantheon', 'custom',
]);

export const WORLD_LORE_SOURCE_TYPES = /** @type {const} */ ([
    'seed_pack', 'auto_extracted', 'wizard_paste',
    'add_lore', 'scene_end', 'ask_mode', 'manual',
]);

/**
 * Default decay configurations per kind. World-lore decay is driven per-record
 * by the `origin` payload tag, so its collection-level default is "no decay
 * unless the record overrides it via `temporally_blind: false` + a config".
 *
 * @type {Record<MemoryKind, DecayConfig>}
 */
export const DEFAULT_DECAY = {
    world_lore: { mode: 'exponential', half_life: 200, floor: 0.7 },
    character_memory: { mode: 'exponential', half_life: 30, floor: 0.4 },
    director_memory: { mode: 'exponential', half_life: 8, floor: 0.2 },
    narrator_memory: { mode: 'exponential', half_life: 24, floor: 0.5 },
    player_journal: { mode: 'exponential', half_life: 999, floor: 0.95 },
};

/**
 * Resolve the Qdrant collection name for a given kind + scope. Collections
 * always carry the campaign id so two campaigns never alias.
 *
 * @param {MemoryKind} kind
 * @param {string} campaignId
 * @param {string} [characterId]   only meaningful for kind === 'character_memory'
 * @returns {string}
 */
export function collectionNameFor(kind, campaignId, characterId) {
    if (!campaignId) throw new Error('collectionNameFor: campaignId is required');
    switch (kind) {
        case 'world_lore':       return `world_lore__${campaignId}`;
        case 'director_memory':  return `director_memory__${campaignId}`;
        case 'narrator_memory':  return `narrator_memory__${campaignId}`;
        case 'player_journal':   return `player_journal__${campaignId}`;
        case 'character_memory':
            if (!characterId) throw new Error('collectionNameFor: character_memory requires characterId');
            return `character_memory__${campaignId}__${characterId}`;
        default:
            throw new Error(`collectionNameFor: unknown kind ${kind}`);
    }
}

/**
 * Parse a collection name into (kind, cid, [characterId]). Returns null if
 * the name is not one we manage.
 *
 * @param {string} name
 * @returns {{ kind: MemoryKind, campaign_id: string, character_id?: string } | null}
 */
export function parseCollectionName(name) {
    if (typeof name !== 'string') return null;
    if (name.startsWith('character_memory__')) {
        const rest = name.slice('character_memory__'.length);
        const ix = rest.indexOf('__');
        if (ix <= 0) return null;
        return {
            kind: 'character_memory',
            campaign_id: rest.slice(0, ix),
            character_id: rest.slice(ix + 2),
        };
    }
    for (const kind of /** @type {MemoryKind[]} */(['world_lore', 'director_memory', 'narrator_memory', 'player_journal'])) {
        const prefix = `${kind}__`;
        if (name.startsWith(prefix)) {
            return { kind, campaign_id: name.slice(prefix.length) };
        }
    }
    return null;
}

/**
 * @param {Partial<MemoryRecord>} input
 * @returns {string | null}  validation error or null
 */
export function validateMemoryRecord(input) {
    if (!input || typeof input !== 'object') return 'record must be an object';
    if (typeof input.id !== 'string' || !input.id) return 'id is required';
    if (!MEMORY_KINDS.includes(/** @type {any} */(input.kind))) return 'kind must be a known MemoryKind';
    if (typeof input.scope_id !== 'string' || !input.scope_id) return 'scope_id is required';
    if (typeof input.content !== 'string' || !input.content) return 'content is required';
    if (!Array.isArray(input.tags)) return 'tags must be an array';
    const importance = Number(input.importance);
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) return 'importance must be 0..1';
    const valence = Number(input.valence);
    if (!Number.isFinite(valence) || valence < -1 || valence > 1) return 'valence must be -1..1';
    if (typeof input.temporally_blind !== 'boolean') return 'temporally_blind must be a boolean';
    if (input.kind === 'world_lore') {
        const wl = input.world_lore;
        if (!wl || typeof wl !== 'object') return 'world_lore record requires world_lore payload';
        if (!WORLD_LORE_ORIGINS.includes(/** @type {any} */(wl.origin))) return 'world_lore.origin invalid';
        if (!WORLD_LORE_ENTRY_KINDS.includes(/** @type {any} */(wl.entry_kind))) return 'world_lore.entry_kind invalid';
        if (!WORLD_LORE_SOURCE_TYPES.includes(/** @type {any} */(wl.source_type))) return 'world_lore.source_type invalid';
        if (typeof wl.title !== 'string') return 'world_lore.title must be a string';
    }
    return null;
}

/**
 * Stable, conservative defaults for the public-facing record shape so
 * callers can spread a partial input into `buildMemoryRecord` without
 * worrying about every optional field.
 *
 * @param {Partial<MemoryRecord> & { id: string, kind: MemoryKind, scope_id: string, content: string }} input
 * @returns {MemoryRecord}
 */
export function buildMemoryRecord(input) {
    const now = new Date().toISOString();
    /** @type {MemoryRecord} */
    const out = {
        id: input.id,
        kind: input.kind,
        scope_id: input.scope_id,
        content: input.content,
        tags: Array.isArray(input.tags) ? [...input.tags] : [],
        importance: clamp01(input.importance ?? 0.5),
        valence: clampRange(input.valence ?? 0, -1, 1),
        temporally_blind: input.temporally_blind ?? (input.kind === 'world_lore' && input.world_lore?.origin === 'core'),
        decay_override: input.decay_override ?? null,
        source: input.source ?? '',
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
        metadata: input.metadata ?? {},
        scene_index: typeof input.scene_index === 'number' ? input.scene_index : 0,
    };
    if (input.kind === 'world_lore' && input.world_lore) {
        out.world_lore = { ...input.world_lore };
    }
    return out;
}

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
    if (!Number.isFinite(n)) return 0.5;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

/** @param {number} n @param {number} lo @param {number} hi */
function clampRange(n, lo, hi) {
    if (!Number.isFinite(n)) return 0;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}
