/**
 * Phase 7 backend integration test (real Qdrant + DeterministicEmbedder).
 *
 * Skips itself if Qdrant is not reachable at `TTRPG_QDRANT_URL` (or the
 * default `http://localhost:6333`). When Qdrant is up, this exercise
 * mirrors the pure-FakeQdrant `service.test.js` against the real engine
 * to catch wiring bugs the fake hides:
 *
 *   1. Per-role retrieval matrix:
 *        - `for_character` ⊂ {own char_mem, world_lore, player_journal}
 *        - `for_director`  ⊂ {world_lore, director_memory}
 *        - `for_narrator`  ⊂ {world_lore, narrator_memory}
 *        - `for_player_journal` ⊂ {player_journal}
 *      In each case other actors' character_memory must NEVER appear.
 *   2. Cross-actor leak: writing into `character_memory__{cid}__alice`
 *      must not surface in `character_memory__{cid}__bob` queries.
 *   3. Idempotent re-ingest: writing the same record twice yields a
 *      single point.
 *   4. Disaster-recovery: drop the collections, then `reconcile` from
 *      the disk JSONL mirrors and confirm hits return.
 *
 * To force-skip in CI:    TTRPG_SKIP_QDRANT_INT=1
 * To override the URL:    TTRPG_QDRANT_URL=http://qdrant.local:6333
 *
 * Each test uses a unique `cid` namespace so parallel runs don't stomp,
 * and the suite cleans up its collections in `afterAll`.
 */

import { describe, test, expect, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../../src/gm-core/rag/service.js';
import { createDeterministicEmbedder } from '../../../src/gm-core/rag/embedders.js';
import { createQdrant } from '../../../src/gm-core/rag/qdrant.js';
import { collectionNameFor, buildMemoryRecord, parseCollectionName } from '../../../src/gm-core/rag/schemas.js';
import { reconcile } from '../../../src/gm-core/rag/reconcile.js';

const QDRANT_URL = process.env.TTRPG_QDRANT_URL || 'http://localhost:6333';
const SKIP = process.env.TTRPG_SKIP_QDRANT_INT === '1';

/**
 * Synchronously probe Qdrant once at module load. Jest's `beforeAll` runs
 * AFTER the file is parsed and `test()` calls are registered, so we must
 * decide skip-vs-run before `describe`/`test` are invoked. We block on a
 * tiny request here (≤1.5s) — fast enough to be invisible when Qdrant is
 * down, fast enough not to matter when it's up.
 *
 * If you need a non-blocking variant, use `TTRPG_SKIP_QDRANT_INT=1` to
 * skip explicitly.
 */
const qdrantOk = await probeQdrant();

async function probeQdrant() {
    if (SKIP) return false;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(QDRANT_URL + '/', { signal: ctrl.signal }).catch(() => null);
        clearTimeout(t);
        return !!(res && res.ok);
    } catch (_) {
        return false;
    }
}

const itq = (name, fn, timeout) => {
    if (!qdrantOk) {
        return test.skip(`(qdrant unreachable @ ${QDRANT_URL}) ${name}`, fn, timeout);
    }
    return test(name, fn, timeout);
};

/**
 * Allocate a unique campaign id per test so parallel runs (and reruns)
 * don't collide with leftover collections.
 */
function newCid(label) {
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    return `it-${label}-${stamp}`.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

/**
 * Build a service + tmp dirs + cleanup hook scoped to the test.
 */
async function buildService() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-rag-it-'));
    fs.mkdirSync(path.join(tmpRoot, 'campaigns'), { recursive: true });
    const directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };
    const embedder = createDeterministicEmbedder({ dim: 128 });
    const qdrant = createQdrant({ url: QDRANT_URL });
    const service = createMemoryService({ directories, qdrant, embedder });
    /** @type {string[]} */
    const createdCollections = [];
    const cleanup = async () => {
        try {
            // Drop collections that look like ours (best-effort, never throws).
            const all = await qdrant.listCollections().catch(() => []);
            for (const name of all) {
                const parsed = parseCollectionName(name);
                if (parsed && createdCollections.includes(parsed.campaign_id)) {
                    await qdrant.dropCollection(name).catch(() => {});
                }
            }
        } finally {
            try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* noop */ }
        }
    };
    return { service, qdrant, embedder, directories, tmpRoot, createdCollections, cleanup };
}

const TRACKED_CIDS = new Set();
function track(cid, ctx) {
    TRACKED_CIDS.add(cid);
    if (ctx && !ctx.createdCollections.includes(cid)) ctx.createdCollections.push(cid);
}

/* tracked sweep is the safety net afterAll. */
afterAll(async () => {
    if (SKIP || !qdrantOk) return;
    const qdrant = createQdrant({ url: QDRANT_URL });
    const all = await qdrant.listCollections().catch(() => []);
    for (const name of all) {
        const parsed = parseCollectionName(name);
        if (parsed && TRACKED_CIDS.has(parsed.campaign_id)) {
            await qdrant.dropCollection(name).catch(() => {});
        }
    }
}, 30000);

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

describe('Phase 7 — RAG integration (real Qdrant)', () => {
    itq('per-role retrieval matrix: actor cannot see other actor memory; director/narrator never see character memory', async () => {
        const ctx = await buildService();
        const cid = newCid('rolematrix');
        track(cid, ctx);
        try {
            const { service } = ctx;
            await service.write({
                campaignId: cid,
                characterId: 'alice',
                record: charMem('a1', 'alice', 'Alice owes a debt to the smith'),
            });
            await service.write({
                campaignId: cid,
                characterId: 'bob',
                record: charMem('b1', 'bob', 'Bob hates the smith with a passion'),
            });
            await service.write({
                campaignId: cid,
                record: lore('w1', 'The smith of Westmark forges weapons of legend'),
            });
            await service.write({
                campaignId: cid,
                record: buildMemoryRecord({
                    id: 'd1',
                    kind: 'director_memory',
                    scope_id: cid,
                    content: 'Pacing: hold the smith reveal until act 2',
                }),
            });
            await service.write({
                campaignId: cid,
                record: buildMemoryRecord({
                    id: 'n1',
                    kind: 'narrator_memory',
                    scope_id: cid,
                    content: 'The smith forge glows red even at dusk',
                }),
            });
            await service.write({
                campaignId: cid,
                record: buildMemoryRecord({
                    id: 'p1',
                    kind: 'player_journal',
                    scope_id: cid,
                    content: 'Player wrote: I want a magical sword',
                }),
            });

            const aliceSlice = await service.for_character({ campaignId: cid, characterId: 'alice', queryText: 'Alice owes a debt to the smith' });
            const aliceContents = aliceSlice.character.map(h => h.record.content);
            expect(aliceContents.some(c => c.includes('Alice owes'))).toBe(true);
            expect(aliceContents.some(c => c.includes('Bob hates'))).toBe(false);

            const dirSlice = await service.for_director({ campaignId: cid, queryText: 'pacing smith reveal' });
            const dirAll = [...dirSlice.world, ...dirSlice.director].map(h => h.record.content);
            expect(dirAll.some(c => c.includes('Alice owes'))).toBe(false);
            expect(dirAll.some(c => c.includes('Bob hates'))).toBe(false);
            expect(dirAll.some(c => c.includes('Pacing'))).toBe(true);

            const narrSlice = await service.for_narrator({ campaignId: cid, queryText: 'smith forge glows red dusk' });
            const narrAll = [...narrSlice.world, ...narrSlice.narrator].map(h => h.record.content);
            expect(narrAll.some(c => c.includes('Alice owes'))).toBe(false);
            expect(narrAll.some(c => c.includes('Bob hates'))).toBe(false);
            expect(narrAll.some(c => c.includes('forge glows'))).toBe(true);
        } finally {
            await ctx.cleanup();
        }
    }, 30000);

    itq('cross-actor leak: alice and bob have isolated character_memory collections', async () => {
        const ctx = await buildService();
        const cid = newCid('crossactor');
        track(cid, ctx);
        try {
            const { service } = ctx;
            await service.write({
                campaignId: cid,
                characterId: 'alice',
                record: charMem('a1', 'alice', 'Alice trusts the captain'),
            });
            await service.write({
                campaignId: cid,
                characterId: 'bob',
                record: charMem('b1', 'bob', 'Bob suspects the captain'),
            });
            const bobSlice = await service.for_character({ campaignId: cid, characterId: 'bob', queryText: 'captain' });
            const bobContents = bobSlice.character.map(h => h.record.content);
            expect(bobContents.some(c => c.includes('Bob suspects'))).toBe(true);
            expect(bobContents.some(c => c.includes('Alice trusts'))).toBe(false);
        } finally {
            await ctx.cleanup();
        }
    }, 30000);

    itq('idempotent re-ingest: writing the same record twice does not duplicate the point', async () => {
        const ctx = await buildService();
        const cid = newCid('idempotent');
        track(cid, ctx);
        try {
            const { service, qdrant } = ctx;
            const rec = lore('idem', 'The capital is named Aurora');
            await service.write({ campaignId: cid, record: rec });
            await service.write({ campaignId: cid, record: rec });
            // Use scroll on the world_lore collection and count points.
            const collection = collectionNameFor('world_lore', cid);
            const all = await qdrant.scroll({ collection, limit: 100 });
            expect(all.points.length).toBe(1);
            expect(all.points[0].id).toBe('idem');
        } finally {
            await ctx.cleanup();
        }
    }, 30000);

    itq('disaster recovery: drop all collections, reconcile from disk JSONL, hits return', async () => {
        const ctx = await buildService();
        const cid = newCid('dr');
        track(cid, ctx);
        // Pre-create the campaign directory the reconciler uses to enumerate mirrors.
        fs.mkdirSync(path.join(ctx.directories.campaigns, cid), { recursive: true });
        try {
            const { service, qdrant } = ctx;
            await service.write({ campaignId: cid, record: lore('w1', 'Aurora is the capital') });
            await service.write({
                campaignId: cid,
                characterId: 'alice',
                record: charMem('a1', 'alice', 'Alice is from Aurora'),
            });

            // Wipe every collection that belongs to this campaign.
            const all = await qdrant.listCollections();
            for (const name of all) {
                const parsed = parseCollectionName(name);
                if (parsed && parsed.campaign_id === cid) {
                    await qdrant.dropCollection(name);
                }
            }
            const afterWipe = (await qdrant.listCollections())
                .filter(n => parseCollectionName(n)?.campaign_id === cid);
            expect(afterWipe.length).toBe(0);

            // Reconcile: walks lore/core/*.yaml + every *.jsonl mirror.
            const report = await reconcile({ memoryService: service, directories: ctx.directories, campaignId: cid });
            expect(report.qdrant_ok).toBe(true);
            expect(report.mirror_records_replayed).toBeGreaterThan(0);

            // Hits come back.
            const wlSlice = await service.for_world({ campaignId: cid, queryText: 'Aurora capital' });
            expect(wlSlice.length).toBeGreaterThan(0);
            const aliceSlice = await service.for_character({ campaignId: cid, characterId: 'alice', queryText: 'Aurora' });
            expect(aliceSlice.character.length).toBeGreaterThan(0);
        } finally {
            await ctx.cleanup();
        }
    }, 60000);

    itq('search tool gates: actor cannot retrieve another actor\'s character_memory through service.search', async () => {
        const ctx = await buildService();
        const cid = newCid('toolgate');
        track(cid, ctx);
        try {
            const { service } = ctx;
            await service.write({
                campaignId: cid,
                characterId: 'alice',
                record: charMem('a1', 'alice', 'Alice secret: she is the heir'),
            });
            await service.write({
                campaignId: cid,
                characterId: 'bob',
                record: charMem('b1', 'bob', 'Bob suspects nothing about Alice'),
            });

            // service.search by-kind to alice's collection — only alice's record.
            const aliceHits = await service.search({
                campaignId: cid,
                kind: 'character_memory',
                characterId: 'alice',
                queryText: 'heir',
            });
            expect(aliceHits.some(h => h.record.id === 'a1')).toBe(true);
            expect(aliceHits.some(h => h.record.id === 'b1')).toBe(false);

            const bobHits = await service.search({
                campaignId: cid,
                kind: 'character_memory',
                characterId: 'bob',
                queryText: 'heir',
            });
            expect(bobHits.some(h => h.record.id === 'a1')).toBe(false);
        } finally {
            await ctx.cleanup();
        }
    }, 30000);
});
