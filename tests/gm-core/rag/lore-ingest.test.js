/**
 * Phase 7: lore ingest invariants.
 *
 *   - Ingest is idempotent: re-running on unchanged YAML is a no-op.
 *   - Editing an entry produces a new id (deterministic) and the old id
 *     is removed.
 *   - Removing a YAML file removes its derived records.
 *   - The Eldoria seed pack ports into a campaign cleanly.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../../src/gm-core/rag/service.js';
import { createDeterministicEmbedder } from '../../../src/gm-core/rag/embedders.js';
import { collectionNameFor } from '../../../src/gm-core/rag/schemas.js';
import { ingestCore, deriveLoreId, loreEntryToRecord } from '../../../src/gm-core/lore/ingest.js';
import { writeCoreLoreFile } from '../../../src/gm-core/lore/store.js';
import { applyLorePack, listLorePacks, loadLorePack } from '../../../src/gm-core/lore/seed-packs.js';

let tmpRoot;
let directories;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-lore-ingest-'));
    fs.mkdirSync(path.join(tmpRoot, 'campaigns', 'cid'), { recursive: true });
    directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

function fakeQdrant() {
    const collections = new Map();
    return {
        collections,
        async health() { return { ok: true, collections: Array.from(collections.keys()) }; },
        async listCollections() { return Array.from(collections.keys()); },
        async collectionExists(name) { return collections.has(name); },
        async ensureCollection(name) {
            if (!collections.has(name)) collections.set(name, new Map());
        },
        async dropCollection(name) { collections.delete(name); },
        async upsertMany(name, items) {
            if (!collections.has(name)) collections.set(name, new Map());
            const c = collections.get(name);
            for (const { record, vector } of items) c.set(record.id, { record, vector });
        },
        async deletePoint(name, id) { collections.get(name)?.delete(id); },
        async retrievePoints(name, ids) {
            const c = collections.get(name);
            if (!c) return [];
            return ids.map(id => c.get(id)?.record).filter(Boolean);
        },
        async search() { return []; },
        async scroll({ collection }) {
            const c = collections.get(collection);
            return { points: c ? Array.from(c.values()).map(v => v.record) : [], next_offset: null };
        },
        async setPayload() {},
    };
}

async function buildService() {
    const embedder = createDeterministicEmbedder({ dim: 64 });
    const qdrant = fakeQdrant();
    const service = createMemoryService({ directories, qdrant, embedder });
    return { service, qdrant };
}

describe('lore ingest', () => {
    test('deriveLoreId is deterministic across runs and stable for unchanged content', () => {
        const entry = { title: 'A', body: 'B', entry_kind: 'history', tags: ['x'] };
        const id1 = deriveLoreId('cid', 'lore/core/setting.yaml', entry);
        const id2 = deriveLoreId('cid', 'lore/core/setting.yaml', entry);
        expect(id1).toBe(id2);
    });

    test('deriveLoreId differs across campaigns', () => {
        const entry = { title: 'A', body: 'B', entry_kind: 'history', tags: ['x'] };
        const idA = deriveLoreId('cidA', 'lore/core/setting.yaml', entry);
        const idB = deriveLoreId('cidB', 'lore/core/setting.yaml', entry);
        expect(idA).not.toBe(idB);
    });

    test('first ingest writes records; re-ingest is a no-op', async () => {
        const { service, qdrant } = await buildService();
        writeCoreLoreFile(directories, 'cid', 'setting', [
            { title: 'A', body: 'first', entry_kind: 'history', tags: [] },
            { title: 'B', body: 'second', entry_kind: 'people', tags: [] },
        ]);
        const r1 = await ingestCore({ memoryService: service, directories, campaignId: 'cid' });
        expect(r1.upserted).toBe(2);
        expect(qdrant.collections.get(collectionNameFor('world_lore', 'cid'))?.size).toBe(2);

        const r2 = await ingestCore({ memoryService: service, directories, campaignId: 'cid' });
        expect(r2.upserted).toBe(0);
        expect(r2.skipped_unchanged).toBe(2);
    });

    test('editing an entry replaces the old record id', async () => {
        const { service, qdrant } = await buildService();
        writeCoreLoreFile(directories, 'cid', 'setting', [
            { title: 'A', body: 'first', entry_kind: 'history', tags: [] },
        ]);
        await ingestCore({ memoryService: service, directories, campaignId: 'cid' });
        const collection = collectionNameFor('world_lore', 'cid');
        const firstIds = new Set(qdrant.collections.get(collection).keys());

        // Edit the body — same title, same file path, but content changes.
        writeCoreLoreFile(directories, 'cid', 'setting', [
            { title: 'A', body: 'edited', entry_kind: 'history', tags: [] },
        ]);
        const r2 = await ingestCore({ memoryService: service, directories, campaignId: 'cid' });
        expect(r2.upserted).toBe(1);
        expect(r2.deleted).toBe(1);

        const newIds = new Set(qdrant.collections.get(collection).keys());
        // No id from the first run survives.
        for (const id of firstIds) {
            expect(newIds.has(id)).toBe(false);
        }
        // And the new content is searchable.
        const records = Array.from(qdrant.collections.get(collection).values()).map(v => v.record);
        expect(records.some(r => r.content.includes('edited'))).toBe(true);
    });

    test('removing a YAML file removes its derived records', async () => {
        const { service, qdrant } = await buildService();
        writeCoreLoreFile(directories, 'cid', 'setting', [
            { title: 'A', body: 'first', entry_kind: 'history', tags: [] },
        ]);
        await ingestCore({ memoryService: service, directories, campaignId: 'cid' });
        const collection = collectionNameFor('world_lore', 'cid');
        expect(qdrant.collections.get(collection)?.size).toBe(1);

        // Delete the YAML on disk and re-ingest.
        const settingPath = path.join(directories.campaigns, 'cid', 'lore', 'core', 'setting.yaml');
        fs.unlinkSync(settingPath);
        const r2 = await ingestCore({ memoryService: service, directories, campaignId: 'cid' });
        expect(r2.deleted).toBe(1);
        expect(qdrant.collections.get(collection)?.size).toBe(0);
    });

    test('loreEntryToRecord defaults origin/temporally_blind for core seed lore', () => {
        const rec = loreEntryToRecord('cid', 'lore/core/setting.yaml', {
            title: 'A', body: 'B', entry_kind: 'history',
        });
        expect(rec.kind).toBe('world_lore');
        expect(rec.world_lore.origin).toBe('core');
        expect(rec.temporally_blind).toBe(true);
        expect(rec.world_lore.source_type).toBe('seed_pack');
    });
});

describe('seed packs', () => {
    test('the bundled Eldoria pack loads and applies into a campaign', async () => {
        const packs = listLorePacks();
        const eldoria = packs.find(p => p.id === 'eldoria');
        expect(eldoria).toBeDefined();
        expect(eldoria.entry_count).toBeGreaterThan(0);

        const loaded = loadLorePack('eldoria');
        expect(loaded).not.toBeNull();
        expect(Array.isArray(loaded.entries)).toBe(true);
        expect(loaded.entries.length).toBeGreaterThan(0);

        const result = applyLorePack({ directories, campaignId: 'cid', packId: 'eldoria' });
        expect(result).not.toBeNull();
        expect(result.entry_count).toBeGreaterThan(0);
        expect(fs.existsSync(result.written)).toBe(true);

        const { service, qdrant } = await buildService();
        const r = await ingestCore({ memoryService: service, directories, campaignId: 'cid' });
        expect(r.upserted).toBe(loaded.entries.length);
        expect(qdrant.collections.get(collectionNameFor('world_lore', 'cid'))?.size).toBe(loaded.entries.length);
    });
});
