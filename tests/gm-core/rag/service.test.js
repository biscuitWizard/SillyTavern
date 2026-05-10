/**
 * Phase 7: MemoryService leak invariants.
 *
 * Uses an in-memory FakeQdrant + DeterministicEmbedder. Asserts:
 *   - `for_character` only hits character_memory of the requested character.
 *   - `for_director` never returns hits from any character_memory.
 *   - `for_narrator` never returns hits from any character_memory.
 *   - `for_world` payload filters route through to the underlying call.
 *   - Disk-first writes survive a wiped Qdrant (write → wipe → reconcile).
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../../src/gm-core/rag/service.js';
import { createDeterministicEmbedder } from '../../../src/gm-core/rag/embedders.js';
import { collectionNameFor, buildMemoryRecord } from '../../../src/gm-core/rag/schemas.js';
import { reconcile } from '../../../src/gm-core/rag/reconcile.js';

/**
 * In-memory Qdrant double. Mirrors enough of the `QdrantWrapper` surface
 * for the service tests; cosine similarity is computed in JS.
 */
function createFakeQdrant() {
    /** @type {Map<string, Map<string, { record: any, vector: number[] }>>} */
    const collections = new Map();
    const ensure = (name) => {
        if (!collections.has(name)) collections.set(name, new Map());
        return collections.get(name);
    };
    function cosine(a, b) {
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
        return dot;
    }
    function passesFilter(record, filter) {
        if (!filter || !filter.must) return true;
        for (const m of filter.must) {
            const segs = String(m.key).split('.');
            let v = record;
            for (const s of segs) v = v?.[s];
            if (m.match?.value !== undefined) {
                if (v !== m.match.value) return false;
            } else if (m.match?.any !== undefined) {
                if (Array.isArray(v)) {
                    if (!v.some(x => m.match.any.includes(x))) return false;
                } else {
                    if (!m.match.any.includes(v)) return false;
                }
            }
        }
        return true;
    }
    return {
        collections,
        async health() { return { ok: true, collections: Array.from(collections.keys()) }; },
        async listCollections() { return Array.from(collections.keys()); },
        async collectionExists(name) { return collections.has(name); },
        async ensureCollection(name) { ensure(name); },
        async dropCollection(name) { collections.delete(name); },
        async upsertMany(name, items) {
            const c = ensure(name);
            for (const { record, vector } of items) {
                c.set(record.id, { record, vector });
            }
        },
        async deletePoint(name, id) {
            collections.get(name)?.delete(id);
        },
        async retrievePoints(name, ids) {
            const c = collections.get(name);
            if (!c) return [];
            const out = [];
            for (const id of ids) {
                const item = c.get(id);
                if (item) out.push(item.record);
            }
            return out;
        },
        async search({ collection, vector, limit, filter }) {
            const c = collections.get(collection);
            if (!c) return [];
            const out = [];
            for (const { record, vector: v } of c.values()) {
                if (!passesFilter(record, filter)) continue;
                out.push({ record, raw_score: cosine(vector, v) });
            }
            out.sort((a, b) => b.raw_score - a.raw_score);
            return out.slice(0, limit);
        },
        async scroll({ collection, filter, limit }) {
            const c = collections.get(collection);
            if (!c) return { points: [], next_offset: null };
            const out = [];
            for (const { record } of c.values()) {
                if (!passesFilter(record, filter)) continue;
                out.push(record);
                if (out.length >= limit) break;
            }
            return { points: out, next_offset: null };
        },
        async setPayload() { /* not used by the service tests */ },
    };
}

let tmpRoot;
let directories;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-rag-svc-'));
    fs.mkdirSync(path.join(tmpRoot, 'campaigns', 'cid'), { recursive: true });
    directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

async function buildService() {
    const embedder = createDeterministicEmbedder({ dim: 128 });
    const qdrant = createFakeQdrant();
    const service = createMemoryService({ directories, qdrant, embedder });
    return { service, qdrant, embedder };
}

function lore(id, content, extra = {}) {
    return buildMemoryRecord({
        id,
        kind: 'world_lore',
        scope_id: 'cid',
        content,
        world_lore: {
            origin: 'core',
            source_type: 'seed_pack',
            scene_id: null,
            entry_kind: 'history',
            title: id,
            ...(extra.world_lore || {}),
        },
        tags: extra.tags || [],
    });
}

function charMem(id, characterId, content, extra = {}) {
    return buildMemoryRecord({
        id,
        kind: 'character_memory',
        scope_id: `cid/${characterId}`,
        content,
        ...extra,
    });
}

describe('MemoryService leak invariants', () => {
    test('for_character returns only the requested character\'s memory + world + journal slice', async () => {
        const { service } = await buildService();
        await service.write({
            campaignId: 'cid',
            characterId: 'jack',
            record: charMem('jm1', 'jack', 'jack remembers losing a duel'),
        });
        await service.write({
            campaignId: 'cid',
            characterId: 'amelia',
            record: charMem('am1', 'amelia', 'amelia recalls jack losing a duel'),
        });
        await service.write({
            campaignId: 'cid',
            record: lore('wl1', 'duels in the mountain pass have lethal stakes'),
        });

        const slice = await service.for_character({
            campaignId: 'cid',
            characterId: 'jack',
            queryText: 'duel mountain',
        });
        const charContents = slice.character.map(h => h.record.content);
        expect(charContents.some(c => c.includes('jack remembers'))).toBe(true);
        // Strict invariant: amelia's memory must NEVER appear in jack's slice.
        expect(charContents.some(c => c.includes('amelia recalls'))).toBe(false);
    });

    test('for_director never sees character_memory', async () => {
        const { service } = await buildService();
        await service.write({
            campaignId: 'cid',
            characterId: 'jack',
            record: charMem('j1', 'jack', 'jack hates the king'),
        });
        await service.write({
            campaignId: 'cid',
            record: lore('wl', 'the king rules from the obsidian throne'),
        });
        const slice = await service.for_director({ campaignId: 'cid', queryText: 'king' });
        const allContents = [...slice.world, ...slice.director].map(h => h.record.content);
        expect(allContents.some(c => c.includes('jack hates'))).toBe(false);
    });

    test('for_narrator never sees character_memory', async () => {
        const { service } = await buildService();
        await service.write({
            campaignId: 'cid',
            characterId: 'amelia',
            record: charMem('a1', 'amelia', 'amelia is afraid of the goblin king'),
        });
        const slice = await service.for_narrator({ campaignId: 'cid', queryText: 'goblin king' });
        const allContents = [...slice.world, ...slice.narrator].map(h => h.record.content);
        expect(allContents.some(c => c.includes('amelia'))).toBe(false);
    });

    test('for_world payload filter narrows to origin', async () => {
        const { service } = await buildService();
        await service.write({
            campaignId: 'cid',
            record: lore('a', 'core: dragons bow to the obsidian throne'),
        });
        await service.write({
            campaignId: 'cid',
            record: buildMemoryRecord({
                id: 'b', kind: 'world_lore', scope_id: 'cid',
                content: 'generated: the dragon Ashvar fled into the mountains',
                world_lore: { origin: 'generated', source_type: 'add_lore', scene_id: 's1', entry_kind: 'bestiary', title: 'Ashvar' },
            }),
        });
        const onlyCore = await service.for_world({
            campaignId: 'cid',
            queryText: 'dragon',
            filters: { origin: 'core' },
        });
        const onlyGenerated = await service.for_world({
            campaignId: 'cid',
            queryText: 'dragon',
            filters: { origin: 'generated' },
        });
        expect(onlyCore.every(h => h.record.world_lore.origin === 'core')).toBe(true);
        expect(onlyGenerated.every(h => h.record.world_lore.origin === 'generated')).toBe(true);
    });
});

describe('MemoryService disk-first persistence', () => {
    test('writes persist to disk JSONL even when Qdrant later loses state', async () => {
        const { service, qdrant } = await buildService();
        await service.write({
            campaignId: 'cid',
            characterId: 'jack',
            record: charMem('j1', 'jack', 'jack remembers the ledge'),
        });
        const collection = collectionNameFor('character_memory', 'cid', 'jack');
        expect(qdrant.collections.get(collection)?.size).toBe(1);

        // Wipe Qdrant entirely (simulates `docker compose down -v`).
        qdrant.collections.clear();
        expect(qdrant.collections.size).toBe(0);

        // Reconcile from disk → Qdrant should re-have the record.
        const report = await reconcile({ memoryService: service, directories, campaignId: 'cid' });
        expect(report.qdrant_ok).toBe(true);
        expect(report.mirror_records_replayed).toBe(1);
        expect(qdrant.collections.get(collection)?.size).toBe(1);

        // And it's searchable again.
        const slice = await service.for_character({
            campaignId: 'cid',
            characterId: 'jack',
            queryText: 'jack ledge',
        });
        expect(slice.character.length).toBeGreaterThan(0);
    });

    test('two characters named "jack" in two campaigns do not alias', async () => {
        const { service, qdrant } = await buildService();
        fs.mkdirSync(path.join(directories.campaigns, 'cidA'), { recursive: true });
        fs.mkdirSync(path.join(directories.campaigns, 'cidB'), { recursive: true });
        await service.write({
            campaignId: 'cidA',
            characterId: 'jack',
            record: charMem('jA', 'jack', 'jack from A is a bard'),
        });
        await service.write({
            campaignId: 'cidB',
            characterId: 'jack',
            record: charMem('jB', 'jack', 'jack from B is a paladin'),
        });
        const colA = collectionNameFor('character_memory', 'cidA', 'jack');
        const colB = collectionNameFor('character_memory', 'cidB', 'jack');
        expect(colA).not.toBe(colB);
        expect(qdrant.collections.get(colA)?.size).toBe(1);
        expect(qdrant.collections.get(colB)?.size).toBe(1);
    });
});

describe('MemoryService search tool gating happens above this layer', () => {
    test('the service itself is scope-explicit (caller picks the kind)', async () => {
        const { service } = await buildService();
        await service.write({
            campaignId: 'cid',
            record: lore('a', 'aurora festival in the capital', { tags: ['festival', 'capital'] }),
        });
        const tagged = await service.search({
            campaignId: 'cid',
            kind: 'world_lore',
            queryText: 'festival',
            filters: { tags: ['festival'] },
        });
        expect(tagged.length).toBeGreaterThan(0);
    });
});
