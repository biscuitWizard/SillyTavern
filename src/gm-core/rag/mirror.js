/**
 * Disk-first mirror writer.
 *
 * Every memory write goes through `mirror.writeRecord(...)`:
 *   1. Append the record to the appropriate JSONL on disk (atomic).
 *   2. Try to upsert it to Qdrant.
 *   3. On Qdrant failure, queue the (collection, id) pair to
 *      `rag/.pending-upserts.json` so boot reconcile picks it up later.
 *
 * Disk is canonical. The Qdrant upsert is best-effort. Reconcile is a
 * pure replay-from-disk pass; nothing in this module retries beyond
 * queueing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ensureDir, readJson, writeJson } from '../util/io.js';
import { campaignDir } from '../campaigns/store.js';
import { collectionNameFor } from './schemas.js';

/**
 * @typedef {import('./schemas.d.ts').MemoryRecord} MemoryRecord
 * @typedef {import('./qdrant.js').QdrantWrapper} QdrantWrapper
 * @typedef {import('./embedders.js').Embedder} Embedder
 */

/**
 * Resolve the on-disk JSONL path for a kind.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {import('./schemas.d.ts').MemoryKind} kind
 * @param {string} [characterId]   only meaningful for character_memory
 * @returns {string}
 */
export function mirrorPath(directories, campaignId, kind, characterId) {
    const base = campaignDir(directories, campaignId);
    switch (kind) {
        case 'world_lore':       return path.join(base, 'lore', 'generated.jsonl');
        case 'director_memory':  return path.join(base, 'director', 'memory.jsonl');
        case 'narrator_memory':  return path.join(base, 'narrator', 'memory.jsonl');
        case 'player_journal':   return path.join(base, 'player', 'journal.jsonl');
        case 'character_memory':
            if (!characterId) throw new Error('mirrorPath: character_memory requires characterId');
            return path.join(base, 'characters', `${characterId}.memories.jsonl`);
        default:
            throw new Error(`mirrorPath: unknown kind ${kind}`);
    }
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
function pendingUpsertsFile(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'rag', '.pending-upserts.json');
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
function ingestStateFile(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'rag', '.ingest-state.json');
}

/**
 * Append a record to the disk JSONL (atomic for the whole-file rewrite).
 * `write-file-atomic` doesn't support append mode directly so we read
 * the current file, append the new line, and rewrite atomically.
 * Append-only files of bounded size + the rare write rate makes this
 * cheap enough; we'll switch to a real append sink only if profiling
 * shows it.
 *
 * @param {string} filePath
 * @param {MemoryRecord} record
 */
export function appendRecordToJsonl(filePath, record) {
    ensureDir(path.dirname(filePath));
    const line = JSON.stringify(record) + '\n';
    let existing = '';
    try {
        existing = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        existing = '';
    }
    writeFileAtomicSync(filePath, existing + line, 'utf8');
}

/**
 * Replace any existing record with the same id in the JSONL with the new
 * one (idempotency on replay). When the id is not present, append.
 *
 * @param {string} filePath
 * @param {MemoryRecord} record
 */
export function upsertRecordInJsonl(filePath, record) {
    ensureDir(path.dirname(filePath));
    let existing = '';
    try {
        existing = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        existing = '';
    }
    const lines = existing.split('\n').filter(Boolean);
    let replaced = false;
    const next = lines.map(ln => {
        try {
            const obj = JSON.parse(ln);
            if (obj && obj.id === record.id) {
                replaced = true;
                return JSON.stringify(record);
            }
        } catch (_) {
            return ln;
        }
        return ln;
    });
    if (!replaced) next.push(JSON.stringify(record));
    writeFileAtomicSync(filePath, next.join('\n') + '\n', 'utf8');
}

/**
 * Read every record back from a JSONL mirror file. Skips lines that
 * fail to parse (corrupt mid-write).
 *
 * @param {string} filePath
 * @returns {MemoryRecord[]}
 */
export function readMirrorJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line));
        } catch (_) { /* skip */ }
    }
    return out;
}

/**
 * Remove a record from the JSONL by id. Cheap rewrite; tolerated by the
 * disk-canonical model since the same campaigns are rarely huge.
 *
 * @param {string} filePath
 * @param {string} id
 * @returns {boolean} true if a line was removed
 */
export function deleteRecordFromJsonl(filePath, id) {
    if (!fs.existsSync(filePath)) return false;
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    let removed = false;
    const next = lines.filter(ln => {
        try {
            const obj = JSON.parse(ln);
            if (obj && obj.id === id) {
                removed = true;
                return false;
            }
        } catch (_) { /* keep */ }
        return true;
    });
    if (!removed) return false;
    writeFileAtomicSync(filePath, next.join('\n') + (next.length ? '\n' : ''), 'utf8');
    return true;
}

/**
 * Load the pending-upserts queue. Returns an empty array if missing.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Array<{ collection: string, id: string }>}
 */
export function readPendingUpserts(directories, campaignId) {
    return readJson(pendingUpsertsFile(directories, campaignId), []);
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Array<{ collection: string, id: string }>} queue
 */
export function writePendingUpserts(directories, campaignId, queue) {
    writeJson(pendingUpsertsFile(directories, campaignId), queue);
}

/**
 * Read the ingest-state file (`{ file_relpath: content_hash }` map).
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Record<string, string>}
 */
export function readIngestState(directories, campaignId) {
    return readJson(ingestStateFile(directories, campaignId), {});
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Record<string, string>} state
 */
export function writeIngestState(directories, campaignId, state) {
    writeJson(ingestStateFile(directories, campaignId), state);
}

/**
 * Disk-first write of a record. Returns the synthetic event payload so
 * callers can emit a `kind: 'memory_write'` TurnEvent.
 *
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaignId: string,
 *   record: MemoryRecord,
 *   characterId?: string,                // for character_memory
 *   embedder: Embedder | null,
 *   qdrant: QdrantWrapper | null,
 * }} args
 * @returns {Promise<{ id: string, collection: string, persisted_disk: boolean, persisted_qdrant: boolean, error?: string }>}
 */
export async function writeRecord({ directories, campaignId, record, characterId, embedder, qdrant }) {
    const collection = collectionNameFor(record.kind, campaignId, characterId);
    const file = mirrorPath(directories, campaignId, record.kind, characterId);

    upsertRecordInJsonl(file, record);

    let persistedQdrant = false;
    let lastError;
    if (qdrant && embedder) {
        try {
            const vec = await embedder.embed(record.content);
            await qdrant.ensureCollection(collection, embedder.dim);
            await qdrant.upsertMany(collection, [{ record, vector: vec }]);
            persistedQdrant = true;
        } catch (err) {
            lastError = err?.message || String(err);
            const queue = readPendingUpserts(directories, campaignId);
            if (!queue.some(q => q.collection === collection && q.id === record.id)) {
                queue.push({ collection, id: record.id });
                writePendingUpserts(directories, campaignId, queue);
            }
        }
    } else if (qdrant && !embedder) {
        // Embedder unavailable. Queue the upsert; a future reconcile pass
        // will re-embed once an embedder resolves.
        const queue = readPendingUpserts(directories, campaignId);
        if (!queue.some(q => q.collection === collection && q.id === record.id)) {
            queue.push({ collection, id: record.id });
            writePendingUpserts(directories, campaignId, queue);
        }
    }
    return {
        id: record.id,
        collection,
        persisted_disk: true,
        persisted_qdrant: persistedQdrant,
        error: lastError,
    };
}

/**
 * Disk-first delete: remove the JSONL line, then drop from Qdrant.
 *
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaignId: string,
 *   id: string,
 *   kind: import('./schemas.d.ts').MemoryKind,
 *   characterId?: string,
 *   qdrant: QdrantWrapper | null,
 * }} args
 */
export async function deleteRecord({ directories, campaignId, id, kind, characterId, qdrant }) {
    const collection = collectionNameFor(kind, campaignId, characterId);
    const file = mirrorPath(directories, campaignId, kind, characterId);
    const removedDisk = deleteRecordFromJsonl(file, id);
    let removedQdrant = false;
    let error;
    if (qdrant) {
        try {
            await qdrant.deletePoint(collection, id);
            removedQdrant = true;
        } catch (err) {
            error = err?.message || String(err);
        }
    }
    return { id, collection, removed_disk: removedDisk, removed_qdrant: removedQdrant, error };
}
