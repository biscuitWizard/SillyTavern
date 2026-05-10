/**
 * Core lore ingest — campaign-load step.
 *
 * Walks `{handle}/campaigns/{cid}/lore/core/*.yaml`, hashes each entry,
 * and upserts deterministically into `world_lore__{cid}` with
 * `origin: 'core'`, `temporally_blind: true`. Tracks file-hash state in
 * `rag/.ingest-state.json` so re-running is idempotent and a removed
 * YAML deletes its derived records.
 *
 * Idempotency model:
 *   - Each entry's id is `sha256("{cid}|{file_relpath}|{stable_entry_key}|{content_hash}").slice(0, 16)`
 *     where `stable_entry_key` is `entry.id || entry.title`.
 *   - The state file tracks `{ "<file_relpath>": { hash, ids: string[] } }` —
 *     `hash` is the YAML file's content hash, `ids` is the ids of every
 *     entry produced from it. On change, we drop the old ids and re-upsert.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    listCoreLoreFiles,
    loreCoreDir,
    readLoreFile,
} from './store.js';
import { campaignDir } from '../campaigns/store.js';
import { collectionNameFor, buildMemoryRecord } from '../rag/schemas.js';
import * as mirror from '../rag/mirror.js';

/**
 * @typedef {import('./schemas.js').LoreEntry} LoreEntry
 * @typedef {import('../rag/service.d.ts').MemoryService} MemoryService
 */

/**
 * @param {string} text
 * @returns {string}  hex sha256
 */
function hashText(text) {
    return createHash('sha256').update(String(text)).digest('hex');
}

/**
 * Compute the deterministic record id for a lore entry. Combines the
 * campaign id, the file's relative path inside the campaign dir, the
 * stable entry key, and the entry content hash so re-ingesting an
 * unchanged file is a no-op while edits force a fresh id.
 *
 * @param {string} campaignId
 * @param {string} fileRelpath
 * @param {LoreEntry} entry
 * @returns {string}
 */
export function deriveLoreId(campaignId, fileRelpath, entry) {
    const stableKey = String(entry.id || entry.title || 'untitled');
    const body = JSON.stringify({
        title: entry.title,
        body: entry.body,
        entry_kind: entry.entry_kind,
        tags: entry.tags || [],
        importance: entry.importance ?? 0.6,
        origin: entry.origin || 'core',
    });
    const hash = createHash('sha256')
        .update(`${campaignId}|${fileRelpath}|${stableKey}|${body}`)
        .digest('hex');
    return hash.slice(0, 16);
}

/**
 * @param {string} campaignId
 * @param {string} fileRelpath
 * @param {LoreEntry} entry
 * @returns {import('../rag/schemas.d.ts').MemoryRecord}
 */
export function loreEntryToRecord(campaignId, fileRelpath, entry) {
    const origin = entry.origin || 'core';
    const sourceType = entry.source_type || 'seed_pack';
    const id = deriveLoreId(campaignId, fileRelpath, entry);
    return buildMemoryRecord({
        id,
        kind: 'world_lore',
        scope_id: campaignId,
        content: `${entry.title}\n\n${entry.body}`.trim(),
        tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
        importance: typeof entry.importance === 'number' ? entry.importance : 0.6,
        valence: 0,
        temporally_blind: typeof entry.temporally_blind === 'boolean'
            ? entry.temporally_blind
            : (origin === 'core'),
        source: `${sourceType}:${fileRelpath}:${entry.id || entry.title || ''}`,
        world_lore: {
            origin,
            source_type: sourceType,
            scene_id: entry.scene_id || null,
            entry_kind: entry.entry_kind,
            title: entry.title,
        },
    });
}

/**
 * Ingest every `lore/core/*.yaml` file for a campaign into Qdrant.
 * Idempotent. Reuses `MemoryService.write()` so the disk-mirror /
 * pending-upserts plumbing stays consistent.
 *
 * @param {{
 *   memoryService: MemoryService,
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaignId: string,
 * }} args
 * @returns {Promise<{
 *   files_processed: number,
 *   upserted: number,
 *   deleted: number,
 *   skipped_unchanged: number,
 *   errors: Array<{ file: string, error: string }>,
 * }>}
 */
export async function ingestCore({ memoryService, directories, campaignId }) {
    const report = {
        files_processed: 0,
        upserted: 0,
        deleted: 0,
        skipped_unchanged: 0,
        /** @type {Array<{ file: string, error: string }>} */
        errors: [],
    };
    const baseDir = loreCoreDir(directories, campaignId);
    if (!fs.existsSync(baseDir)) {
        return report;
    }
    const collection = collectionNameFor('world_lore', campaignId);
    /** @type {Record<string, { hash: string, ids: string[] }>} */
    const state = mirror.readIngestState(directories, campaignId);
    /** @type {Record<string, { hash: string, ids: string[] }>} */
    const next = {};

    const files = listCoreLoreFiles(directories, campaignId);
    const cdir = campaignDir(directories, campaignId);

    for (const filePath of files) {
        report.files_processed++;
        const rel = path.relative(cdir, filePath);
        let raw;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            report.errors.push({ file: rel, error: err?.message || String(err) });
            continue;
        }
        const fileHash = hashText(raw);
        const prior = state[rel];
        const entries = readLoreFile(filePath);
        const currentIds = entries.map(e => deriveLoreId(campaignId, rel, e));

        if (prior && prior.hash === fileHash && sameIdSet(prior.ids, currentIds)) {
            report.skipped_unchanged += entries.length;
            next[rel] = prior;
            continue;
        }

        // Delete records whose ids vanished from this file.
        if (prior?.ids?.length) {
            const dropped = prior.ids.filter(id => !currentIds.includes(id));
            for (const id of dropped) {
                try {
                    await memoryService.remove({ campaignId, id, kind: 'world_lore' });
                    report.deleted++;
                } catch (err) {
                    report.errors.push({ file: rel, error: `remove ${id}: ${err?.message || err}` });
                }
            }
        }

        // Upsert every entry from the file.
        for (const entry of entries) {
            const record = loreEntryToRecord(campaignId, rel, entry);
            try {
                await memoryService.write({ campaignId, record });
                report.upserted++;
            } catch (err) {
                report.errors.push({ file: rel, error: `upsert ${record.id}: ${err?.message || err}` });
            }
        }
        next[rel] = { hash: fileHash, ids: currentIds };
    }

    // Drop records from files that were removed from disk entirely.
    for (const rel of Object.keys(state)) {
        if (next[rel]) continue;
        const prior = state[rel];
        for (const id of prior.ids || []) {
            try {
                await memoryService.remove({ campaignId, id, kind: 'world_lore' });
                report.deleted++;
            } catch (err) {
                report.errors.push({ file: rel, error: `remove ${id}: ${err?.message || err}` });
            }
        }
    }

    mirror.writeIngestState(directories, campaignId, next);
    void collection; // referenced for clarity even though MemoryService picks the name.
    return report;
}

/** @param {string[]} a @param {string[]} b */
function sameIdSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    for (let i = 0; i < sortedA.length; i++) {
        if (sortedA[i] !== sortedB[i]) return false;
    }
    return true;
}
