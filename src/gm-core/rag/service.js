/**
 * MemoryService — campaign-scoped RAG facade.
 *
 * Every method takes the campaign id explicitly so a caller cannot pick
 * up the wrong campaign by accident. Per-role retrieval helpers are the
 * code-side enforcement of the leak invariant in DESIGN.md:
 *
 *   - `for_character(cid, char_id, ...)`  → ONLY that character's collection
 *                                            + a small slice of world_lore
 *                                            + a slice of player_journal.
 *   - `for_director(cid, ...)`            → world_lore + director_memory.
 *   - `for_narrator(cid, ...)`            → world_lore + narrator_memory.
 *   - `for_world(cid, filters?)`          → world_lore with payload filters.
 *   - `for_player_journal(cid)`           → player_journal alone.
 *
 * Search results pass through `decay.applyDecayToHits` after Qdrant
 * returns raw cosines.
 */

import { collectionNameFor, DEFAULT_DECAY, buildMemoryRecord } from './schemas.js';
import { applyDecayToHits } from './decay.js';
import { buildFilter } from './qdrant.js';
import * as mirror from './mirror.js';

/**
 * @typedef {import('./schemas.d.ts').MemoryKind} MemoryKind
 * @typedef {import('./schemas.d.ts').MemoryRecord} MemoryRecord
 * @typedef {import('./schemas.d.ts').RetrievalHit} RetrievalHit
 * @typedef {import('./schemas.d.ts').RetrievalQuery} RetrievalQuery
 * @typedef {import('./schemas.d.ts').WorldLorePayload} WorldLorePayload
 * @typedef {import('./qdrant.js').QdrantWrapper} QdrantWrapper
 * @typedef {import('./embedders.js').Embedder} Embedder
 */

/**
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   qdrant: QdrantWrapper,
 *   embedder: Embedder,
 *   topK?: { world?: number, character?: number, director?: number, narrator?: number, player_journal?: number },
 *   getCurrentSceneIndex?: (campaignId: string) => number,
 * }} deps
 */
export function createMemoryService(deps) {
    const { directories, qdrant, embedder } = deps;
    const topK = {
        world: 6,
        character: 4,
        director: 2,
        narrator: 2,
        player_journal: 1,
        ...(deps.topK || {}),
    };
    const sceneIndexFn = typeof deps.getCurrentSceneIndex === 'function'
        ? deps.getCurrentSceneIndex
        : () => 0;

    /**
     * Run a Qdrant search against one collection and apply decay.
     *
     * @param {{
     *   collection: string,
     *   queryText: string,
     *   limit?: number,
     *   filter?: object,
     *   campaignId: string,
     *   kind: MemoryKind,
     * }} args
     * @returns {Promise<RetrievalHit[]>}
     */
    async function searchOne(args) {
        const { collection, queryText, limit = topK.world, filter, campaignId, kind } = args;
        if (!queryText || !queryText.trim()) return [];
        let vector;
        try {
            vector = await embedder.embed(queryText);
        } catch (err) {
            console.warn('[rag] embed failed; returning empty hits', err?.message || err);
            return [];
        }
        let raw;
        try {
            raw = await qdrant.search({ collection, vector, limit: Math.max(limit * 3, limit), filter });
        } catch (err) {
            console.warn('[rag] search failed', err?.message || err);
            return [];
        }
        const fallback = DEFAULT_DECAY[kind];
        const decayed = applyDecayToHits(raw, sceneIndexFn(campaignId), fallback);
        return decayed.slice(0, limit);
    }

    /**
     * Retrieval slice for an Actor X.
     *
     * @param {{
     *   campaignId: string,
     *   characterId: string,
     *   queryText: string,
     *   topK?: { character?: number, world?: number, player_journal?: number },
     * }} args
     * @returns {Promise<{ character: RetrievalHit[], world: RetrievalHit[], player_journal: RetrievalHit[] }>}
     */
    async function for_character({ campaignId, characterId, queryText, topK: override }) {
        const k = { ...topK, ...(override || {}) };
        const [character, world, journal] = await Promise.all([
            searchOne({
                collection: collectionNameFor('character_memory', campaignId, characterId),
                queryText,
                limit: k.character,
                campaignId,
                kind: 'character_memory',
            }),
            searchOne({
                collection: collectionNameFor('world_lore', campaignId),
                queryText,
                limit: k.world,
                campaignId,
                kind: 'world_lore',
            }),
            searchOne({
                collection: collectionNameFor('player_journal', campaignId),
                queryText,
                limit: k.player_journal,
                campaignId,
                kind: 'player_journal',
            }),
        ]);
        return { character, world, player_journal: journal };
    }

    /**
     * Retrieval slice for the Director.
     *
     * @param {{ campaignId: string, queryText: string, topK?: { world?: number, director?: number } }} args
     * @returns {Promise<{ world: RetrievalHit[], director: RetrievalHit[] }>}
     */
    async function for_director({ campaignId, queryText, topK: override }) {
        const k = { ...topK, ...(override || {}) };
        const [world, director] = await Promise.all([
            searchOne({
                collection: collectionNameFor('world_lore', campaignId),
                queryText,
                limit: k.world,
                campaignId,
                kind: 'world_lore',
            }),
            searchOne({
                collection: collectionNameFor('director_memory', campaignId),
                queryText,
                limit: k.director,
                campaignId,
                kind: 'director_memory',
            }),
        ]);
        return { world, director };
    }

    /**
     * Retrieval slice for the Narrator.
     *
     * @param {{ campaignId: string, queryText: string, topK?: { world?: number, narrator?: number } }} args
     * @returns {Promise<{ world: RetrievalHit[], narrator: RetrievalHit[] }>}
     */
    async function for_narrator({ campaignId, queryText, topK: override }) {
        const k = { ...topK, ...(override || {}) };
        const [world, narrator] = await Promise.all([
            searchOne({
                collection: collectionNameFor('world_lore', campaignId),
                queryText,
                limit: k.world,
                campaignId,
                kind: 'world_lore',
            }),
            searchOne({
                collection: collectionNameFor('narrator_memory', campaignId),
                queryText,
                limit: k.narrator,
                campaignId,
                kind: 'narrator_memory',
            }),
        ]);
        return { world, narrator };
    }

    /**
     * World-lore search with optional payload filters.
     *
     * @param {{
     *   campaignId: string,
     *   queryText: string,
     *   limit?: number,
     *   filters?: Partial<WorldLorePayload> & { tags?: string[] },
     * }} args
     * @returns {Promise<RetrievalHit[]>}
     */
    async function for_world({ campaignId, queryText, limit, filters }) {
        const filterEq = {};
        if (filters?.origin) filterEq['world_lore.origin'] = filters.origin;
        if (filters?.entry_kind) filterEq['world_lore.entry_kind'] = filters.entry_kind;
        if (filters?.scene_id) filterEq['world_lore.scene_id'] = filters.scene_id;
        if (filters?.source_type) filterEq['world_lore.source_type'] = filters.source_type;
        if (filters?.tags && filters.tags.length) filterEq.tags = filters.tags;
        const filter = buildFilter(filterEq);
        return searchOne({
            collection: collectionNameFor('world_lore', campaignId),
            queryText,
            limit: limit ?? topK.world,
            filter,
            campaignId,
            kind: 'world_lore',
        });
    }

    /**
     * @param {{ campaignId: string, queryText: string, limit?: number }} args
     * @returns {Promise<RetrievalHit[]>}
     */
    async function for_player_journal({ campaignId, queryText, limit }) {
        return searchOne({
            collection: collectionNameFor('player_journal', campaignId),
            queryText,
            limit: limit ?? topK.player_journal,
            campaignId,
            kind: 'player_journal',
        });
    }

    /**
     * General-purpose search the explorer + the `search_memory` tool route
     * through. Caller specifies kind; service builds the collection name
     * and applies decay using the kind's defaults.
     *
     * @param {{
     *   campaignId: string,
     *   kind: MemoryKind,
     *   characterId?: string,
     *   queryText: string,
     *   limit?: number,
     *   filters?: Partial<WorldLorePayload> & { tags?: string[] },
     * }} args
     * @returns {Promise<RetrievalHit[]>}
     */
    async function search(args) {
        const { campaignId, kind, characterId, queryText, limit, filters } = args;
        const collection = collectionNameFor(kind, campaignId, characterId);
        const filterEq = {};
        if (filters?.tags && filters.tags.length) filterEq.tags = filters.tags;
        if (kind === 'world_lore') {
            if (filters?.origin) filterEq['world_lore.origin'] = filters.origin;
            if (filters?.entry_kind) filterEq['world_lore.entry_kind'] = filters.entry_kind;
            if (filters?.scene_id) filterEq['world_lore.scene_id'] = filters.scene_id;
            if (filters?.source_type) filterEq['world_lore.source_type'] = filters.source_type;
        }
        const filter = buildFilter(filterEq);
        return searchOne({
            collection,
            queryText,
            limit: limit ?? topK.world,
            filter,
            campaignId,
            kind,
        });
    }

    /**
     * Disk-first write. Wraps `mirror.writeRecord` so every caller — Director
     * loop writers, Lore ingest, Explorer manual edits — uses the same path.
     *
     * @param {{
     *   campaignId: string,
     *   record: MemoryRecord,
     *   characterId?: string,
     * }} args
     */
    async function write(args) {
        const validated = buildMemoryRecord(args.record);
        return mirror.writeRecord({
            directories,
            campaignId: args.campaignId,
            record: validated,
            characterId: args.characterId,
            embedder,
            qdrant,
        });
    }

    /**
     * @param {{
     *   campaignId: string,
     *   id: string,
     *   kind: MemoryKind,
     *   characterId?: string,
     * }} args
     */
    async function remove(args) {
        return mirror.deleteRecord({
            directories,
            campaignId: args.campaignId,
            id: args.id,
            kind: args.kind,
            characterId: args.characterId,
            qdrant,
        });
    }

    /**
     * List records in a collection. Used by the Explorer.
     *
     * @param {{
     *   campaignId: string,
     *   kind: MemoryKind,
     *   characterId?: string,
     *   filters?: Partial<WorldLorePayload> & { tags?: string[] },
     *   limit?: number,
     *   offset?: string | number | null,
     * }} args
     * @returns {Promise<{ records: MemoryRecord[], next_offset: string | number | null }>}
     */
    async function list(args) {
        const { campaignId, kind, characterId, filters, limit = 200, offset = null } = args;
        const collection = collectionNameFor(kind, campaignId, characterId);
        const filterEq = {};
        if (filters?.tags && filters.tags.length) filterEq.tags = filters.tags;
        if (kind === 'world_lore') {
            if (filters?.origin) filterEq['world_lore.origin'] = filters.origin;
            if (filters?.entry_kind) filterEq['world_lore.entry_kind'] = filters.entry_kind;
            if (filters?.scene_id) filterEq['world_lore.scene_id'] = filters.scene_id;
            if (filters?.source_type) filterEq['world_lore.source_type'] = filters.source_type;
        }
        const filter = buildFilter(filterEq);
        try {
            const res = await qdrant.scroll({ collection, filter, limit, offset });
            return { records: res.points, next_offset: res.next_offset };
        } catch (err) {
            console.warn('[rag] list failed; falling back to disk mirror', err?.message || err);
            return { records: readMirrorAll({ directories, campaignId, kind, characterId }), next_offset: null };
        }
    }

    /**
     * Patch payload fields on a record (tags, importance, temporally_blind,
     * decay_override, world_lore origin promotion). Disk + Qdrant.
     *
     * @param {{
     *   campaignId: string,
     *   id: string,
     *   kind: MemoryKind,
     *   characterId?: string,
     *   patch: Partial<MemoryRecord>,
     * }} args
     */
    async function patch(args) {
        const { campaignId, id, kind, characterId, patch: patchFields } = args;
        const file = mirror.mirrorPath(directories, campaignId, kind, characterId);
        const all = mirror.readMirrorJsonl(file);
        const ix = all.findIndex(r => r.id === id);
        if (ix === -1) return null;
        const current = all[ix];
        const next = buildMemoryRecord({
            ...current,
            ...patchFields,
            id,
            kind,
            scope_id: current.scope_id,
            content: patchFields.content ?? current.content,
            metadata: { ...(current.metadata || {}), ...(patchFields.metadata || {}) },
            world_lore: kind === 'world_lore'
                ? { ...(current.world_lore || {}), ...(patchFields.world_lore || {}) }
                : undefined,
        });
        next.updated_at = new Date().toISOString();
        const collection = collectionNameFor(kind, campaignId, characterId);
        mirror.upsertRecordInJsonl(file, next);
        try {
            const vec = await embedder.embed(next.content);
            await qdrant.ensureCollection(collection, embedder.dim);
            await qdrant.upsertMany(collection, [{ record: next, vector: vec }]);
        } catch (err) {
            console.warn('[rag] patch upsert failed; queued', err?.message || err);
            const queue = mirror.readPendingUpserts(directories, campaignId);
            if (!queue.some(q => q.collection === collection && q.id === id)) {
                queue.push({ collection, id });
                mirror.writePendingUpserts(directories, campaignId, queue);
            }
        }
        return next;
    }

    return {
        for_character,
        for_director,
        for_narrator,
        for_world,
        for_player_journal,
        search,
        write,
        remove,
        list,
        patch,
        embedder,
        qdrant,
        directories,
    };
}

/** @param {{ directories: import('../../users.js').UserDirectoryList, campaignId: string, kind: MemoryKind, characterId?: string }} args */
function readMirrorAll({ directories, campaignId, kind, characterId }) {
    return mirror.readMirrorJsonl(mirror.mirrorPath(directories, campaignId, kind, characterId));
}
