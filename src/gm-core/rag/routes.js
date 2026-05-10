/**
 * `/api/gm/rag/*` routes.
 *
 * The Memory Explorer + admin tools talk to RAG through these. The turn
 * loop does NOT — it calls `MemoryService` directly in-process.
 *
 *   GET    /api/gm/rag/health                  Qdrant connectivity + version + collection list
 *   GET    /api/gm/rag/collections             Qdrant collections in `*__{active campaign}*` scope
 *   GET    /api/gm/rag/collections/:kind/:cid  list records (with payload-filter query params)
 *                                              For character_memory the route variant is
 *                                              GET /api/gm/rag/collections/character_memory/:cid/:character_id
 *   POST   /api/gm/rag/memories                write one memory (debug / explorer manual entry)
 *   PATCH  /api/gm/rag/memories/:id            update tags / importance / origin promotion
 *   DELETE /api/gm/rag/memories/:id            delete a record
 *   POST   /api/gm/rag/search                  ad-hoc search with explicit scope (debug only)
 *   POST   /api/gm/rag/reconcile               admin: re-run boot reconcile for a campaign
 *   POST   /api/gm/rag/lore/seed-packs         apply a bundled pack to a campaign
 *   GET    /api/gm/rag/lore/seed-packs         list available bundled packs
 *
 * The router builds a `MemoryService` lazily per request (cheap; just a
 * factory closure) so it can pick up the user's directories from the
 * standard Express auth middleware.
 */

import express from 'express';

import * as campaignStore from '../campaigns/store.js';
import { parseCollectionName, MEMORY_KINDS, validateMemoryRecord, buildMemoryRecord } from './schemas.js';
import { createQdrant } from './qdrant.js';
import { resolveEmbedder } from './embedders.js';
import { createMemoryService } from './service.js';
import { reconcile } from './reconcile.js';
import { ingestCore } from '../lore/ingest.js';
import { listLorePacks, loadLorePack, applyLorePack } from '../lore/seed-packs.js';

/**
 * Cached service instances per directories.root. The closures over
 * `directories` are cheap; we cache them per handle to avoid spinning
 * up a new Qdrant client on every request.
 *
 * @type {Map<string, { qdrant: import('./qdrant.js').QdrantWrapper, embedder: import('./embedders.js').Embedder, service: import('./service.d.ts').MemoryService }>}
 */
const cache = new Map();

/** @type {{ qdrant?: any, embedder?: any, ragConfig?: any }} */
const sharedDeps = {};

/**
 * Override (or seed) the shared dependencies. Called by the server
 * startup path so tests + production can supply their own pieces.
 *
 * @param {{ qdrant?: any, embedder?: any, ragConfig?: any }} deps
 */
export function configureRagRoutes(deps) {
    if (deps?.qdrant) sharedDeps.qdrant = deps.qdrant;
    if (deps?.embedder) sharedDeps.embedder = deps.embedder;
    if (deps?.ragConfig) sharedDeps.ragConfig = deps.ragConfig;
    // Bust any cached services.
    cache.clear();
}

/**
 * Resolve (or build) the `MemoryService` for a request.
 *
 * @param {import('express').Request} request
 * @returns {Promise<import('./service.d.ts').MemoryService>}
 */
async function getService(request) {
    const directories = request.user.directories;
    const key = directories.root;
    const cached = cache.get(key);
    if (cached) return cached.service;

    const qdrant = sharedDeps.qdrant || createQdrant({ url: process.env.TTRPG_QDRANT_URL });
    const embedder = sharedDeps.embedder || await resolveEmbedder(sharedDeps.ragConfig || {});
    const service = createMemoryService({ directories, qdrant, embedder });
    cache.set(key, { qdrant, embedder, service });
    return service;
}

export const ragRouter = express.Router();

ragRouter.get('/health', async (request, response) => {
    const service = await getService(request);
    const h = await service.qdrant.health();
    response.json({
        ok: h.ok,
        url: service.qdrant.url,
        version: h.version,
        error: h.error,
        collections: h.collections,
        embedder: { provider: service.embedder.provider, dim: service.embedder.dim },
    });
});

ragRouter.get('/collections', async (request, response) => {
    const cid = String(request.query.cid || '').trim();
    if (!cid) return response.status(400).json({ error: 'cid query param is required' });
    try {
        const service = await getService(request);
        const all = await service.qdrant.listCollections();
        const matches = all.filter(name => {
            const parsed = parseCollectionName(name);
            return parsed && parsed.campaign_id === cid;
        });
        response.json({ collections: matches.map(name => ({ name, ...parseCollectionName(name) })) });
    } catch (err) {
        response.status(500).json({ error: err?.message || 'list collections failed' });
    }
});

ragRouter.get('/collections/:kind/:cid', async (request, response) => {
    const { kind, cid } = request.params;
    if (!MEMORY_KINDS.includes(/** @type {any} */(kind))) return response.status(400).json({ error: 'unknown kind' });
    if (kind === 'character_memory') return response.status(400).json({ error: 'character_memory requires :character_id' });
    return listRecords(request, response, /** @type {any} */(kind), cid);
});

ragRouter.get('/collections/character_memory/:cid/:character_id', async (request, response) => {
    return listRecords(request, response, 'character_memory', request.params.cid, request.params.character_id);
});

/**
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('./schemas.d.ts').MemoryKind} kind
 * @param {string} cid
 * @param {string} [characterId]
 */
async function listRecords(request, response, kind, cid, characterId) {
    try {
        const service = await getService(request);
        const filters = {};
        if (kind === 'world_lore') {
            if (request.query.origin) filters.origin = String(request.query.origin);
            if (request.query.entry_kind) filters.entry_kind = String(request.query.entry_kind);
            if (request.query.scene_id) filters.scene_id = String(request.query.scene_id);
            if (request.query.source_type) filters.source_type = String(request.query.source_type);
        }
        if (request.query.tags) {
            const raw = request.query.tags;
            const arr = Array.isArray(raw) ? raw : String(raw).split(',');
            filters.tags = arr.filter(Boolean).map(String);
        }
        const limit = Math.max(1, Math.min(500, Number(request.query.limit) || 200));
        const offset = request.query.offset ? String(request.query.offset) : null;
        const result = await service.list({
            campaignId: cid,
            kind,
            characterId,
            filters,
            limit,
            offset,
        });
        response.json({ records: result.records, next_offset: result.next_offset });
    } catch (err) {
        response.status(500).json({ error: err?.message || 'list failed' });
    }
}

ragRouter.post('/memories', async (request, response) => {
    const body = request.body ?? {};
    const cid = String(body.campaign_id || '').trim();
    const kind = body.kind;
    const characterId = body.character_id;
    if (!cid || !MEMORY_KINDS.includes(kind)) {
        return response.status(400).json({ error: 'campaign_id + valid kind required' });
    }
    try {
        const service = await getService(request);
        // Build the record. We accept either a minimal `{ content, tags, ... }`
        // body or a full pre-built record.
        const partial = body.record || body;
        const record = buildMemoryRecord({
            id: partial.id || `manual-${Date.now().toString(36)}`,
            kind,
            scope_id: kind === 'character_memory' ? `${cid}/${characterId}` : cid,
            content: partial.content || '',
            tags: partial.tags || [],
            importance: partial.importance,
            valence: partial.valence,
            temporally_blind: partial.temporally_blind,
            decay_override: partial.decay_override ?? null,
            source: partial.source || 'manual',
            metadata: partial.metadata || {},
            world_lore: partial.world_lore,
            scene_index: partial.scene_index || 0,
        });
        const err = validateMemoryRecord(record);
        if (err) return response.status(400).json({ error: err });
        const result = await service.write({ campaignId: cid, characterId, record });
        response.status(201).json({ record, write: result });
    } catch (err) {
        response.status(500).json({ error: err?.message || 'write failed' });
    }
});

ragRouter.patch('/memories/:id', async (request, response) => {
    const body = request.body ?? {};
    const cid = String(body.campaign_id || '').trim();
    const kind = body.kind;
    const characterId = body.character_id;
    if (!cid || !MEMORY_KINDS.includes(kind)) return response.status(400).json({ error: 'campaign_id + valid kind required' });
    try {
        const service = await getService(request);
        const updated = await service.patch({
            campaignId: cid,
            id: request.params.id,
            kind,
            characterId,
            patch: body.patch || body,
        });
        if (!updated) return response.status(404).json({ error: 'record not found' });
        response.json({ record: updated });
    } catch (err) {
        response.status(500).json({ error: err?.message || 'patch failed' });
    }
});

ragRouter.delete('/memories/:id', async (request, response) => {
    const cid = String(request.query.cid || '').trim();
    const kind = String(request.query.kind || '');
    const characterId = request.query.character_id ? String(request.query.character_id) : undefined;
    if (!cid || !MEMORY_KINDS.includes(/** @type {any} */(kind))) {
        return response.status(400).json({ error: 'cid + valid kind required' });
    }
    try {
        const service = await getService(request);
        const result = await service.remove({
            campaignId: cid,
            id: request.params.id,
            kind: /** @type {any} */(kind),
            characterId,
        });
        response.json(result);
    } catch (err) {
        response.status(500).json({ error: err?.message || 'delete failed' });
    }
});

ragRouter.post('/search', async (request, response) => {
    const body = request.body ?? {};
    const cid = String(body.campaign_id || body.cid || '').trim();
    const kind = body.kind;
    const characterId = body.character_id;
    const queryText = String(body.query || '').trim();
    if (!cid || !MEMORY_KINDS.includes(kind) || !queryText) {
        return response.status(400).json({ error: 'cid + valid kind + query required' });
    }
    try {
        const service = await getService(request);
        const hits = await service.search({
            campaignId: cid,
            kind,
            characterId,
            queryText,
            limit: Math.max(1, Math.min(20, Number(body.top_k) || 8)),
            filters: body.filters || undefined,
        });
        response.json({ hits });
    } catch (err) {
        response.status(500).json({ error: err?.message || 'search failed' });
    }
});

ragRouter.post('/reconcile', async (request, response) => {
    const cid = String((request.query.cid || request.body?.cid || '')).trim();
    if (!cid) return response.status(400).json({ error: 'cid is required' });
    const campaign = campaignStore.get(request.user.directories, cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });
    try {
        const service = await getService(request);
        const report = await reconcile({
            memoryService: service,
            directories: request.user.directories,
            campaignId: cid,
            loreIngest: { ingestCore },
        });
        response.json(report);
    } catch (err) {
        response.status(500).json({ error: err?.message || 'reconcile failed' });
    }
});

ragRouter.get('/lore/seed-packs', (_request, response) => {
    response.json({ packs: listLorePacks() });
});

ragRouter.get('/lore/seed-packs/:id', (request, response) => {
    const pack = loadLorePack(request.params.id);
    if (!pack) return response.status(404).json({ error: 'pack not found' });
    response.json({ pack });
});

ragRouter.post('/lore/seed-packs', async (request, response) => {
    const body = request.body ?? {};
    const cid = String(body.campaign_id || body.cid || '').trim();
    const packId = String(body.pack_id || '').trim();
    if (!cid || !packId) return response.status(400).json({ error: 'campaign_id + pack_id required' });
    const campaign = campaignStore.get(request.user.directories, cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });
    const result = applyLorePack({ directories: request.user.directories, campaignId: cid, packId });
    if (!result) return response.status(404).json({ error: 'pack not found' });
    try {
        const service = await getService(request);

        // Ingest world lore entries.
        const ingestReport = await ingestCore({ memoryService: service, directories: request.user.directories, campaignId: cid });

        // Ingest starter memories for each seeded character.
        let memories_upserted = 0;
        const memories_errors = [];
        const { createHash } = await import('node:crypto');
        for (const seed of result.character_seeds) {
            for (let i = 0; i < seed.memories.length; i++) {
                const content = seed.memories[i];
                const rawId = `seed_pack:${packId}:${seed.character_id}:${i}`;
                const id = createHash('sha256').update(rawId).digest('hex').slice(0, 16);
                const record = buildMemoryRecord({
                    id,
                    kind: 'character_memory',
                    scope_id: `${cid}/${seed.character_id}`,
                    content,
                    tags: ['seed_pack', packId],
                    importance: 0.8,
                    valence: 0,
                    temporally_blind: true,
                    source: `seed_pack:${packId}:${seed.character_id}:${i}`,
                });
                try {
                    await service.write({ campaignId: cid, record, characterId: seed.character_id });
                    memories_upserted++;
                } catch (err) {
                    memories_errors.push({ character_id: seed.character_id, index: i, error: err?.message || String(err) });
                }
            }
        }

        response.json({
            pack_applied: result,
            ingest: ingestReport,
            character_memories: { upserted: memories_upserted, errors: memories_errors },
        });
    } catch (err) {
        response.status(500).json({ error: err?.message || 'ingest after pack apply failed', pack_applied: result });
    }
});

