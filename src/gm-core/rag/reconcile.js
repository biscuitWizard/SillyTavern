/**
 * Boot reconcile.
 *
 * Walks every disk mirror for a campaign and replays missing records into
 * Qdrant. Idempotent. Safe to call on every campaign-load and on demand
 * via `POST /api/gm/rag/reconcile`.
 *
 * Order:
 *   1. Drain `rag/.pending-deletes.json` → drop those Qdrant collections.
 *   2. Walk `lore/core/*.yaml`, hash each, upsert changed/new files,
 *      delete records whose source file vanished. (Lore-ingest module
 *      is the canonical YAML→Qdrant path; reconcile reuses it.)
 *   3. Walk every `*.jsonl` mirror; for each line, upsert if Qdrant lacks
 *      the id (the WAL replay).
 *   4. Drain `rag/.pending-upserts.json`: for each (collection, id),
 *      look up the record on disk and re-attempt the upsert.
 *
 * Returns a structured report so the explorer can show "X core lore
 * records, Y character memories restored".
 */

import fs from 'node:fs';
import path from 'node:path';

import { campaignDir } from '../campaigns/store.js';
import * as mirror from './mirror.js';
import { collectionNameFor } from './schemas.js';
import { ensureDir, readJson, writeJson } from '../util/io.js';

/**
 * @typedef {import('./service.d.ts').MemoryService} MemoryService
 * @typedef {import('./schemas.d.ts').MemoryKind} MemoryKind
 * @typedef {import('./schemas.d.ts').MemoryRecord} MemoryRecord
 */

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
function pendingDeletesFile(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'rag', '.pending-deletes.json');
}

/**
 * Top-level pending deletes (used when a campaign dir was already removed
 * but Qdrant collection drops failed). Lives in `directories.root` so it
 * survives campaign-dir removal.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 */
function rootPendingDeletesFile(directories) {
    return path.join(directories.root, '.rag-pending-deletes.json');
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {Array<{ collection: string }>}
 */
export function readRootPendingDeletes(directories) {
    return readJson(rootPendingDeletesFile(directories), []);
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Array<{ collection: string }>} queue
 */
export function writeRootPendingDeletes(directories, queue) {
    writeJson(rootPendingDeletesFile(directories), queue);
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Array<{ collection: string }>}
 */
export function readPendingDeletes(directories, campaignId) {
    return readJson(pendingDeletesFile(directories, campaignId), []);
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Array<{ collection: string }>} queue
 */
export function writePendingDeletes(directories, campaignId, queue) {
    writeJson(pendingDeletesFile(directories, campaignId), queue);
}

/**
 * Walk the campaign disk and produce { kind, characterId?, file } tuples
 * for every JSONL mirror.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Array<{ kind: MemoryKind, characterId?: string, file: string }>}
 */
function enumerateMirrors(directories, campaignId) {
    const base = campaignDir(directories, campaignId);
    /** @type {Array<{ kind: MemoryKind, characterId?: string, file: string }>} */
    const out = [];
    const direct = [
        { kind: /** @type {MemoryKind} */('world_lore'),       file: path.join(base, 'lore', 'generated.jsonl') },
        { kind: /** @type {MemoryKind} */('director_memory'),  file: path.join(base, 'director', 'memory.jsonl') },
        { kind: /** @type {MemoryKind} */('narrator_memory'),  file: path.join(base, 'narrator', 'memory.jsonl') },
        { kind: /** @type {MemoryKind} */('player_journal'),   file: path.join(base, 'player', 'journal.jsonl') },
    ];
    for (const item of direct) {
        if (fs.existsSync(item.file)) out.push(item);
    }
    const charDir = path.join(base, 'characters');
    if (fs.existsSync(charDir)) {
        for (const f of fs.readdirSync(charDir)) {
            if (!f.endsWith('.memories.jsonl')) continue;
            const characterId = f.slice(0, -'.memories.jsonl'.length);
            out.push({
                kind: 'character_memory',
                characterId,
                file: path.join(charDir, f),
            });
        }
    }
    return out;
}

/**
 * @param {{
 *   memoryService: MemoryService,
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaignId: string,
 *   loreIngest?: { ingestCore: (args: any) => Promise<{ upserted: number, deleted: number }> },
 * }} args
 * @returns {Promise<{
 *   pending_deletes_drained: number,
 *   pending_upserts_drained: number,
 *   core_lore_upserted: number,
 *   core_lore_deleted: number,
 *   mirror_records_replayed: number,
 *   collections_touched: string[],
 *   qdrant_ok: boolean,
 *   error?: string,
 * }>}
 */
export async function reconcile({ memoryService, directories, campaignId, loreIngest }) {
    const report = {
        pending_deletes_drained: 0,
        pending_upserts_drained: 0,
        core_lore_upserted: 0,
        core_lore_deleted: 0,
        mirror_records_replayed: 0,
        /** @type {string[]} */
        collections_touched: [],
        qdrant_ok: true,
        /** @type {string | undefined} */
        error: undefined,
    };

    // Probe Qdrant once. If it's not reachable we still drain the queues
    // (they're fine to leave as-is) but skip the upsert pass.
    const health = await memoryService.qdrant.health();
    if (!health.ok) {
        report.qdrant_ok = false;
        report.error = health.error;
        return report;
    }

    // 1. Pending deletes (per-campaign).
    const pendingDeletes = readPendingDeletes(directories, campaignId);
    /** @type {Array<{ collection: string }>} */
    const remainingDeletes = [];
    for (const item of pendingDeletes) {
        try {
            await memoryService.qdrant.dropCollection(item.collection);
            report.pending_deletes_drained++;
        } catch (err) {
            console.warn('[rag.reconcile] drop failed', err?.message || err);
            remainingDeletes.push(item);
        }
    }
    if (remainingDeletes.length !== pendingDeletes.length) {
        writePendingDeletes(directories, campaignId, remainingDeletes);
    }

    // 1b. Root-level pending deletes (collections orphaned by a campaign-dir wipe).
    const rootPending = readRootPendingDeletes(directories);
    /** @type {Array<{ collection: string }>} */
    const rootRemaining = [];
    for (const item of rootPending) {
        try {
            await memoryService.qdrant.dropCollection(item.collection);
            report.pending_deletes_drained++;
        } catch (err) {
            rootRemaining.push(item);
        }
    }
    if (rootRemaining.length !== rootPending.length) {
        writeRootPendingDeletes(directories, rootRemaining);
    }

    // 2. Core lore ingest (canonical YAML → Qdrant).
    if (loreIngest && typeof loreIngest.ingestCore === 'function') {
        try {
            const r = await loreIngest.ingestCore({ memoryService, directories, campaignId });
            report.core_lore_upserted = r?.upserted || 0;
            report.core_lore_deleted = r?.deleted || 0;
        } catch (err) {
            console.warn('[rag.reconcile] core lore ingest failed', err?.message || err);
        }
    }

    // 3. Mirror replay. Reads every JSONL line and upserts those Qdrant
    // doesn't already know about. Cheap-ish because Qdrant retrieve is
    // batch-friendly.
    for (const m of enumerateMirrors(directories, campaignId)) {
        const records = mirror.readMirrorJsonl(m.file);
        if (records.length === 0) continue;
        const collection = collectionNameFor(m.kind, campaignId, m.characterId);
        try {
            await memoryService.qdrant.ensureCollection(collection, memoryService.embedder.dim);
        } catch (err) {
            console.warn('[rag.reconcile] ensureCollection failed', collection, err?.message || err);
            continue;
        }
        report.collections_touched.push(collection);

        // Pull existing ids in chunks to avoid pathological retrieves.
        const existingIds = new Set();
        const chunk = 64;
        for (let i = 0; i < records.length; i += chunk) {
            const slice = records.slice(i, i + chunk);
            const ids = slice.map(r => r.id);
            try {
                const found = await memoryService.qdrant.retrievePoints(collection, ids);
                for (const f of found) existingIds.add(f.id);
            } catch (err) {
                /* swallow; we'll just upsert all */
            }
        }
        const missing = records.filter(r => !existingIds.has(r.id));
        if (missing.length === 0) continue;

        // Embed + upsert in batches.
        try {
            const vectors = await memoryService.embedder.embedBatch(missing.map(r => r.content));
            const items = missing.map((record, ix) => ({ record, vector: vectors[ix] }));
            const batchSize = 32;
            for (let i = 0; i < items.length; i += batchSize) {
                await memoryService.qdrant.upsertMany(collection, items.slice(i, i + batchSize));
            }
            report.mirror_records_replayed += missing.length;
        } catch (err) {
            console.warn('[rag.reconcile] replay upsert failed', collection, err?.message || err);
        }
    }

    // 4. Drain pending-upserts. Same model: look up each record on disk,
    // re-embed, re-upsert.
    const pendingUpserts = mirror.readPendingUpserts(directories, campaignId);
    /** @type {Array<{ collection: string, id: string }>} */
    const remainingUpserts = [];
    if (pendingUpserts.length > 0) {
        // Build a quick disk index across all mirrors so we don't open each
        // file twice.
        const allMirrors = enumerateMirrors(directories, campaignId).map(m => ({
            ...m,
            collection: collectionNameFor(m.kind, campaignId, m.characterId),
            records: mirror.readMirrorJsonl(m.file),
        }));
        const index = new Map();
        for (const m of allMirrors) {
            for (const r of m.records) {
                index.set(`${m.collection}::${r.id}`, { record: r, mirror: m });
            }
        }
        for (const item of pendingUpserts) {
            const found = index.get(`${item.collection}::${item.id}`);
            if (!found) {
                // Record vanished from disk — drop the queue item.
                continue;
            }
            try {
                const vec = await memoryService.embedder.embed(found.record.content);
                await memoryService.qdrant.ensureCollection(item.collection, memoryService.embedder.dim);
                await memoryService.qdrant.upsertMany(item.collection, [{ record: found.record, vector: vec }]);
                report.pending_upserts_drained++;
            } catch (err) {
                remainingUpserts.push(item);
            }
        }
        mirror.writePendingUpserts(directories, campaignId, remainingUpserts);
    }

    // Make sure the rag dir exists for the next campaign load.
    ensureDir(path.join(campaignDir(directories, campaignId), 'rag'));

    return report;
}
