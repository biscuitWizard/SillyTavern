/**
 * Qdrant client wrapper.
 *
 * - Lazy-init: nothing connects until the first call.
 * - Auto-create collections on first write with the embedder's vector dim.
 * - Payload-filter helpers to keep callers out of Qdrant's filter DSL.
 * - `health()` for the explorer banner / `GET /api/gm/rag/health`.
 *
 * Every method swallows transport errors at the call site so callers can
 * decide how to degrade. We do NOT auto-retry inside the wrapper — the
 * caller (mirror.js) owns retry and queueing semantics so we don't
 * double-write into the pending queue.
 */

import { createHash } from 'node:crypto';

import { QdrantClient } from '@qdrant/js-client-rest';

import { parseCollectionName } from './schemas.js';

const DEFAULT_URL = 'http://localhost:6333';

/**
 * @typedef {import('./schemas.d.ts').MemoryRecord} MemoryRecord
 * @typedef {import('./schemas.d.ts').WorldLorePayload} WorldLorePayload
 */

/**
 * @typedef {Object} QdrantWrapper
 * @property {() => Promise<{ ok: boolean, version?: string, collections?: string[], error?: string }>} health
 * @property {() => Promise<string[]>} listCollections
 * @property {(collection: string) => Promise<boolean>} collectionExists
 * @property {(collection: string, dim: number) => Promise<void>} ensureCollection
 * @property {(collection: string) => Promise<void>} dropCollection
 * @property {(collection: string, records: { record: MemoryRecord, vector: number[] }[]) => Promise<void>} upsertMany
 * @property {(collection: string, id: string) => Promise<void>} deletePoint
 * @property {(collection: string, ids: string[]) => Promise<MemoryRecord[]>} retrievePoints
 * @property {(args: { collection: string, vector: number[], limit?: number, filter?: object, withVectors?: boolean }) => Promise<{ record: MemoryRecord, raw_score: number }[]>} search
 * @property {(args: { collection: string, filter?: object, limit?: number, offset?: string | number | null }) => Promise<{ points: MemoryRecord[], next_offset: string | number | null }>} scroll
 * @property {(collection: string, id: string, payload: Partial<MemoryRecord>) => Promise<void>} setPayload
 * @property {QdrantClient | null} _client  underlying client; null until first use
 * @property {string} url
 */

/**
 * Build the `points` payload Qdrant wants. We store the entire record in
 * the payload (minus `id`) so a search response is enough to reconstruct
 * the record without a second hop.
 *
 * @param {MemoryRecord} record
 * @param {number[]} vector
 * @returns {{ id: string, vector: number[], payload: Record<string, unknown> }}
 */
function pointFromRecord(record, vector) {
    const { id, ...rest } = record;
    return {
        id: idForQdrant(id),
        vector,
        payload: { ...rest, _id: id },
    };
}

/**
 * Qdrant accepts unsigned int / uuid as native ids; for arbitrary strings
 * we keep them in payload (`_id`) and use a deterministic UUID-shaped id
 * derived from the string.
 *
 * @param {string} stringId
 * @returns {string}
 */
function idForQdrant(stringId) {
    // sha256 → hex; format as a UUID-shape (8-4-4-4-12). Deterministic.
    // Qdrant accepts UUIDs and unsigned 64-bit ints; we use UUIDs.
    const hex = createHash('sha256').update(String(stringId)).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Reverse helper for `pointFromRecord`. Pulls the original record back out
 * of a Qdrant payload, restoring the `id` from the `_id` payload field.
 *
 * @param {{ id?: string | number, payload?: Record<string, unknown> }} pt
 * @returns {MemoryRecord | null}
 */
export function recordFromPoint(pt) {
    if (!pt || typeof pt !== 'object' || !pt.payload || typeof pt.payload !== 'object') return null;
    const payload = /** @type {Record<string, unknown>} */ (pt.payload);
    const stringId = typeof payload._id === 'string' ? payload._id : (typeof pt.id === 'string' ? pt.id : String(pt.id));
    /** @type {any} */
    const rec = { ...payload, id: stringId };
    delete rec._id;
    return rec;
}

/**
 * Build a Qdrant filter from a payload-equality map. Falsy values are
 * dropped. Arrays become `match: { any: [...] }`.
 *
 * @param {Record<string, unknown>} eq
 * @returns {object | undefined}
 */
export function buildFilter(eq) {
    const must = [];
    for (const [key, value] of Object.entries(eq || {})) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            must.push({ key, match: { any: value } });
        } else if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
            must.push({ key, match: { value } });
        }
    }
    return must.length ? { must } : undefined;
}

/**
 * @param {{ url?: string, apiKey?: string }} [opts]
 * @returns {QdrantWrapper}
 */
export function createQdrant(opts = {}) {
    const url = opts.url || process.env.TTRPG_QDRANT_URL || DEFAULT_URL;
    /** @type {QdrantClient | null} */
    let client = null;
    function lazyClient() {
        if (!client) {
            client = new QdrantClient({ url, apiKey: opts.apiKey, checkCompatibility: false });
        }
        return client;
    }

    /** @type {QdrantWrapper} */
    const wrapper = {
        url,
        get _client() { return client; },

        async health() {
            try {
                const c = lazyClient();
                const collections = await c.getCollections();
                const names = (collections?.collections || []).map(x => x.name);
                let version;
                try {
                    const tele = await c.api('cluster').clusterStatus({});
                    version = tele?.result?.version;
                } catch (_) { /* not all qdrant builds expose this */ }
                return { ok: true, version, collections: names };
            } catch (err) {
                return { ok: false, error: err?.message || String(err) };
            }
        },

        async listCollections() {
            const c = lazyClient();
            const res = await c.getCollections();
            return (res?.collections || []).map(x => x.name);
        },

        async collectionExists(collection) {
            const c = lazyClient();
            try {
                await c.getCollection(collection);
                return true;
            } catch (err) {
                if (looksLikeMissingCollection(err)) return false;
                throw err;
            }
        },

        async ensureCollection(collection, dim) {
            const c = lazyClient();
            if (await this.collectionExists(collection)) return;
            await c.createCollection(collection, {
                vectors: { size: dim, distance: 'Cosine' },
            });
            // Index the payload fields we filter on so chip filters are fast.
            for (const field of [
                'kind', 'scope_id', 'tags', 'temporally_blind',
                'world_lore.origin', 'world_lore.entry_kind',
                'world_lore.scene_id', 'world_lore.source_type',
            ]) {
                try {
                    await c.createPayloadIndex(collection, {
                        field_name: field,
                        field_schema: field === 'tags' ? 'keyword' : (field === 'temporally_blind' ? 'bool' : 'keyword'),
                        wait: true,
                    });
                } catch (_) { /* index creation is best-effort */ }
            }
        },

        async dropCollection(collection) {
            const c = lazyClient();
            try {
                await c.deleteCollection(collection);
            } catch (err) {
                if (looksLikeMissingCollection(err)) return;
                throw err;
            }
        },

        async upsertMany(collection, items) {
            if (!items || items.length === 0) return;
            const c = lazyClient();
            const points = items.map(({ record, vector }) => pointFromRecord(record, vector));
            await c.upsert(collection, { wait: true, points });
        },

        async deletePoint(collection, stringId) {
            const c = lazyClient();
            try {
                await c.delete(collection, { wait: true, points: [idForQdrant(stringId)] });
            } catch (err) {
                if (looksLikeMissingCollection(err)) return;
                throw err;
            }
        },

        async retrievePoints(collection, ids) {
            if (!ids || ids.length === 0) return [];
            const c = lazyClient();
            try {
                const res = await c.retrieve(collection, {
                    ids: ids.map(idForQdrant),
                    with_payload: true,
                    with_vector: false,
                });
                return (res || []).map(recordFromPoint).filter(Boolean);
            } catch (err) {
                if (looksLikeMissingCollection(err)) return [];
                throw err;
            }
        },

        async search({ collection, vector, limit = 16, filter }) {
            const c = lazyClient();
            try {
                const res = await c.search(collection, {
                    vector,
                    limit,
                    with_payload: true,
                    with_vector: false,
                    filter,
                });
                return (res || [])
                    .map(pt => {
                        const record = recordFromPoint(pt);
                        return record ? { record, raw_score: Number(pt.score) || 0 } : null;
                    })
                    .filter(Boolean);
            } catch (err) {
                if (looksLikeMissingCollection(err)) return [];
                throw err;
            }
        },

        async scroll({ collection, filter, limit = 256, offset = null }) {
            const c = lazyClient();
            try {
                const res = await c.scroll(collection, {
                    filter,
                    limit,
                    offset,
                    with_payload: true,
                    with_vector: false,
                });
                const points = (res?.points || []).map(recordFromPoint).filter(Boolean);
                return { points, next_offset: res?.next_page_offset ?? null };
            } catch (err) {
                if (looksLikeMissingCollection(err)) return { points: [], next_offset: null };
                throw err;
            }
        },

        async setPayload(collection, stringId, payload) {
            const c = lazyClient();
            await c.setPayload(collection, {
                wait: true,
                payload,
                points: [idForQdrant(stringId)],
            });
        },
    };

    return wrapper;
}

/** @param {unknown} err */
function looksLikeMissingCollection(err) {
    if (!err) return false;
    const msg = String(/** @type {Error} */(err).message || err).toLowerCase();
    return msg.includes('doesn\'t exist') || msg.includes('not found') || msg.includes('not exist') || msg.includes('404');
}

export { idForQdrant, parseCollectionName };
