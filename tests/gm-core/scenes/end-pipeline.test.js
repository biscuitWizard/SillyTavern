/**
 * Phase 8 — scene-end pipeline regression suite.
 *
 * Covers the public contract from `docs/phases/8-scene-end.md`:
 *   - Deterministic ids: re-running the pipeline on the same scene with
 *     the same LLM output produces the same record ids.
 *   - Idempotency: a second run is a no-op at the JSONL + Qdrant layer.
 *   - Dry-run: returns the structured outputs without writing or
 *     flipping the scene to `closed`.
 *   - Per-participant scope isolation: character A's extraction prompt
 *     never contains character B's name or personality.
 *   - `world_lore` writes carry `source_type: 'scene_end'`,
 *     `origin: 'generated'`, `scene_id: <scene>`.
 *   - Locked-prompt regression: SYSTEM constants contain the phrases
 *     the doc relies on.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSceneEndPipeline } from '../../../src/gm-core/scenes/end-pipeline.js';
import {
    SCENE_SUMMARY_SYSTEM_PROMPT,
    SCENE_SUMMARY_SCHEMA,
} from '../../../src/gm-core/scenes/summarize-prompts.js';
import {
    MEMORY_EXTRACTION_SYSTEM_PROMPT,
    MEMORY_EXTRACTION_SCHEMA,
} from '../../../src/gm-core/scenes/extract-prompts.js';
import * as campaignStore from '../../../src/gm-core/campaigns/store.js';
import * as sceneStore from '../../../src/gm-core/scenes/store.js';
import * as transcriptModule from '../../../src/gm-core/scenes/transcript.js';
import * as summaryStore from '../../../src/gm-core/scenes/summary-store.js';
import { createMemoryService } from '../../../src/gm-core/rag/service.js';
import { createDeterministicEmbedder } from '../../../src/gm-core/rag/embedders.js';
import { collectionNameFor } from '../../../src/gm-core/rag/schemas.js';
import { mirrorPath, readMirrorJsonl } from '../../../src/gm-core/rag/mirror.js';

function createFakeQdrant() {
    /** @type {Map<string, Map<string, any>>} */
    const collections = new Map();
    const ensure = (n) => {
        if (!collections.has(n)) collections.set(n, new Map());
        return collections.get(n);
    };
    return {
        collections,
        async health() { return { ok: true }; },
        async listCollections() { return [...collections.keys()]; },
        async collectionExists(n) { return collections.has(n); },
        async ensureCollection(n) { ensure(n); },
        async dropCollection(n) { collections.delete(n); },
        async upsertMany(n, items) {
            const c = ensure(n);
            for (const { record, vector } of items) c.set(record.id, { record, vector });
        },
        async deletePoint(n, id) { collections.get(n)?.delete(id); },
        async retrievePoints() { return []; },
        async search() { return []; },
        async scroll() { return { points: [], next_offset: null }; },
        async setPayload() {},
    };
}

const SUMMARY_PAYLOAD = {
    headline: 'Jack bargained with the steward for safe passage.',
    summary: 'Jack approached the steward at the Ironhold gate. Amelia waited at the wagon while Jack negotiated. The steward demanded ten silver. Jack paid and they were waved through.',
    key_events: [
        { text: 'Jack paid ten silver to pass the Ironhold gate.', tags: ['ironhold', 'gate', 'payment'], importance: 0.6 },
        { text: 'The steward at Ironhold accepted bribes.', tags: ['ironhold', 'steward'], importance: 0.5 },
    ],
    location_changes: ['Ironhold gate'],
    participant_changes: [],
};

const EXTRACTION_BY_NAME = {
    Jack: {
        is_significant: true,
        memories: [
            { content: 'I paid the Ironhold steward ten silver to be quit of him.', importance: 0.6, valence: -0.3, tags: ['ironhold', 'steward'] },
            { content: 'I will not trust the Ironhold gate guards lightly.', importance: 0.5, valence: -0.4, tags: ['ironhold', 'distrust'] },
        ],
    },
    Amelia: {
        is_significant: true,
        memories: [
            { content: 'Jack handled the steward without losing his temper, which surprised me.', importance: 0.5, valence: 0.4, tags: ['jack', 'admiration'] },
        ],
    },
};

/**
 * Build a fake LLM client. Returns the SceneSummary fixture when the
 * caller asks for `SceneSummary`, and per-character `EXTRACTION_BY_NAME`
 * payloads when the caller asks for `SceneEndMemoryExtraction`.
 *
 * Captured `calls` lets each test assert on the prompts that were
 * actually sent.
 */
function makeFakeClient(capture, overrides = {}) {
    return {
        async structured({ system, user, schema, schemaName }) {
            capture.calls.push({ system, user, schema, schemaName });
            if (schemaName === 'SceneSummary') {
                return overrides.summary ?? SUMMARY_PAYLOAD;
            }
            if (schemaName === 'SceneEndMemoryExtraction') {
                if (overrides.extractionByName) {
                    for (const [name, payload] of Object.entries(overrides.extractionByName)) {
                        if (user.includes(`What does ${name} carry forward`)) return payload;
                    }
                }
                for (const [name, payload] of Object.entries(EXTRACTION_BY_NAME)) {
                    if (user.includes(`What does ${name} carry forward`)) return payload;
                }
                return { is_significant: false, memories: [] };
            }
            if (schemaName === 'SceneEndRecap') {
                return overrides.recap ?? {
                    recap: 'Jack stands beside the wagon as the gate creaks shut behind him.',
                    location: 'Just past the Ironhold gate',
                    time: 'Mid-morning, an hour after the bribe',
                    nearby_characters: ['Amelia'],
                };
            }
            throw new Error(`unexpected schemaName ${schemaName}`);
        },
        async chat() { return ''; },
    };
}

function makeFakeFailingClient(capture, failingSchema) {
    return {
        async structured({ system, user, schema, schemaName }) {
            capture.calls.push({ system, user, schema, schemaName });
            if (schemaName === failingSchema) {
                throw new Error(`forced failure: ${failingSchema}`);
            }
            if (schemaName === 'SceneSummary') return SUMMARY_PAYLOAD;
            if (schemaName === 'SceneEndMemoryExtraction') return { is_significant: false, memories: [] };
            if (schemaName === 'SceneEndRecap') {
                return {
                    recap: 'The PC stands where the scene left them.',
                    location: 'Where the scene ended',
                    time: 'Just after the scene',
                    nearby_characters: [],
                };
            }
            throw new Error(`unexpected schemaName ${schemaName}`);
        },
        async chat() { return ''; },
    };
}

async function setupFixture() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-sceneend-'));
    fs.mkdirSync(path.join(tmpRoot, 'campaigns'), { recursive: true });
    const directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };

    const campaign = campaignStore.create(directories, {
        name: 'Shadows of Ironhold',
        brief: 'A border-fortress campaign about smuggling and oaths.',
    });

    const jack = { id: 'jack', name: 'Jack', is_player: true, personality: 'Stoic, careful, slow to anger.' };
    const amelia = { id: 'amelia', name: 'Amelia', is_player: false, personality: 'Wary scout, sharp-tongued, loyal to Jack.' };

    const scene = sceneStore.create(directories, campaign.id, {
        name: 'At the Ironhold gate',
        location: 'Ironhold gate',
        participants: [amelia.id],
    });

    const transcriptLines = [
        { name: 'Jack', mes: 'Jack approaches the steward at the gate.', is_user: true, is_system: false, send_date: 'a' },
        { name: 'Narrator', mes: 'The steward sneers, hand on his coin pouch.', is_user: false, is_system: false, send_date: 'b', extra: { role: 'narrator' } },
        { name: 'Amelia', mes: 'Try not to start a fight, Jack.', is_user: false, is_system: false, send_date: 'c', extra: { role: 'actor', actor_id: 'amelia' } },
        { name: 'Jack', mes: 'How much for safe passage, friend?', is_user: true, is_system: false, send_date: 'd' },
        { name: 'Narrator', mes: '"Ten silver. Up front." Jack pays. The gate creaks open.', is_user: false, is_system: false, send_date: 'e', extra: { role: 'narrator' } },
    ];
    for (const line of transcriptLines) {
        await transcriptModule.appendLine(directories, campaign.id, scene.id, line);
    }

    const embedder = createDeterministicEmbedder({ dim: 64 });
    const qdrant = createFakeQdrant();
    const memoryService = createMemoryService({ directories, qdrant, embedder });

    return {
        tmpRoot,
        directories,
        campaign,
        scene,
        participants: [jack, amelia],
        embedder,
        qdrant,
        memoryService,
        cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
    };
}

describe('scene-end pipeline — locked prompts', () => {
    test('SCENE_SUMMARY_SYSTEM_PROMPT is the locked variant', () => {
        expect(SCENE_SUMMARY_SYSTEM_PROMPT).toContain('Headline');
        expect(SCENE_SUMMARY_SYSTEM_PROMPT).toContain('Key events');
        expect(SCENE_SUMMARY_SYSTEM_PROMPT).toContain('Stay strictly inside the transcript');
    });

    test('MEMORY_EXTRACTION_SYSTEM_PROMPT is the locked variant', () => {
        expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('first-person');
        expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('is_significant: false');
        expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('Tags');
    });

    test('schemas use strict additionalProperties', () => {
        expect(SCENE_SUMMARY_SCHEMA.additionalProperties).toBe(false);
        expect(MEMORY_EXTRACTION_SCHEMA.additionalProperties).toBe(false);
    });
});

describe('scene-end pipeline — orchestration', () => {
    test('writes character_memory + world_lore (source_type: scene_end) and flips scene to closed', async () => {
        const fx = await setupFixture();
        try {
            const capture = { calls: [] };
            const client = makeFakeClient(capture);

            const result = await runSceneEndPipeline({
                directories: fx.directories,
                campaignId: fx.campaign.id,
                campaign: { name: fx.campaign.name, brief: fx.campaign.brief },
                scene: fx.scene,
                participants: fx.participants,
                memoryService: fx.memoryService,
                client,
                sceneIndex: 1,
            });

            expect(result.dry_run).toBe(false);
            expect(result.summary.headline).toBe(SUMMARY_PAYLOAD.headline);
            expect(result.scene?.status).toBe('closed');
            expect(result.scene?.summary_headline).toBe(SUMMARY_PAYLOAD.headline);
            expect(result.scene?.summary_path).toMatch(/\.summary\.json$/);

            // 2 key events written as world_lore.
            expect(result.key_events_written).toBe(2);
            const worldCol = collectionNameFor('world_lore', fx.campaign.id);
            const worldRecs = [...(fx.qdrant.collections.get(worldCol)?.values() || [])].map(v => v.record);
            expect(worldRecs).toHaveLength(2);
            for (const rec of worldRecs) {
                expect(rec.world_lore.source_type).toBe('scene_end');
                expect(rec.world_lore.origin).toBe('generated');
                expect(rec.world_lore.scene_id).toBe(fx.scene.id);
                expect(rec.source).toMatch(new RegExp(`^scene-end:${fx.scene.id}:event-\\d+$`));
            }

            // Per-character memories landed in the right collection.
            expect(result.memories_extracted.jack).toBe(2);
            expect(result.memories_extracted.amelia).toBe(1);
            const jackCol = collectionNameFor('character_memory', fx.campaign.id, 'jack');
            const ameliaCol = collectionNameFor('character_memory', fx.campaign.id, 'amelia');
            expect(fx.qdrant.collections.get(jackCol)?.size).toBe(2);
            expect(fx.qdrant.collections.get(ameliaCol)?.size).toBe(1);

            // Summary file persisted on disk.
            const persistedSummary = summaryStore.read(fx.directories, fx.campaign.id, fx.scene.id);
            expect(persistedSummary?.headline).toBe(SUMMARY_PAYLOAD.headline);
            expect(persistedSummary?.scene_id).toBe(fx.scene.id);

            // Disk JSONL mirror has the character memories too.
            const jackMirror = readMirrorJsonl(mirrorPath(fx.directories, fx.campaign.id, 'character_memory', 'jack'));
            expect(jackMirror).toHaveLength(2);
            expect(jackMirror.every(r => r.source.startsWith(`scene-end:${fx.scene.id}:slot-`))).toBe(true);
        } finally {
            fx.cleanup();
        }
    });

    test('per-participant prompt isolation: character A\'s prompt does not contain character B\'s name or personality', async () => {
        const fx = await setupFixture();
        try {
            const capture = { calls: [] };
            const client = makeFakeClient(capture);
            await runSceneEndPipeline({
                directories: fx.directories,
                campaignId: fx.campaign.id,
                campaign: { name: fx.campaign.name, brief: fx.campaign.brief },
                scene: fx.scene,
                participants: fx.participants,
                memoryService: fx.memoryService,
                client,
            });
            const extractionCalls = capture.calls.filter(c => c.schemaName === 'SceneEndMemoryExtraction');
            expect(extractionCalls).toHaveLength(2);
            const jackCall = extractionCalls.find(c => c.user.includes('What does Jack carry forward'));
            const ameliaCall = extractionCalls.find(c => c.user.includes('What does Amelia carry forward'));
            expect(jackCall).toBeTruthy();
            expect(ameliaCall).toBeTruthy();
            // Jack's prompt body must not mention Amelia's personality string.
            expect(jackCall.user).not.toContain('Wary scout');
            // Amelia's prompt body must not mention Jack's personality string.
            expect(ameliaCall.user).not.toContain('Stoic, careful');
        } finally {
            fx.cleanup();
        }
    });

    test('idempotency: re-running with force=true upserts the same ids and produces no duplicates', async () => {
        const fx = await setupFixture();
        try {
            const capture = { calls: [] };
            const client = makeFakeClient(capture);

            const first = await runSceneEndPipeline({
                directories: fx.directories,
                campaignId: fx.campaign.id,
                campaign: fx.campaign,
                scene: fx.scene,
                participants: fx.participants,
                memoryService: fx.memoryService,
                client,
            });

            const closedScene = sceneStore.get(fx.directories, fx.campaign.id, fx.scene.id);
            const second = await runSceneEndPipeline({
                directories: fx.directories,
                campaignId: fx.campaign.id,
                campaign: fx.campaign,
                scene: closedScene,
                participants: fx.participants,
                memoryService: fx.memoryService,
                client,
            });

            // Sizes are stable across runs because of deterministic ids.
            const worldCol = collectionNameFor('world_lore', fx.campaign.id);
            const jackCol = collectionNameFor('character_memory', fx.campaign.id, 'jack');
            const ameliaCol = collectionNameFor('character_memory', fx.campaign.id, 'amelia');
            expect(fx.qdrant.collections.get(worldCol)?.size).toBe(2);
            expect(fx.qdrant.collections.get(jackCol)?.size).toBe(2);
            expect(fx.qdrant.collections.get(ameliaCol)?.size).toBe(1);

            // Disk JSONL mirrors match the fake-Qdrant counts.
            const jackMirror = readMirrorJsonl(mirrorPath(fx.directories, fx.campaign.id, 'character_memory', 'jack'));
            expect(jackMirror).toHaveLength(2);

            // Same ids on both runs.
            const firstIds = new Set(Object.keys(first.memories_extracted));
            const secondIds = new Set(Object.keys(second.memories_extracted));
            expect([...firstIds].sort()).toEqual([...secondIds].sort());
        } finally {
            fx.cleanup();
        }
    });

    test('dry_run returns structured outputs without writing or closing', async () => {
        const fx = await setupFixture();
        try {
            const capture = { calls: [] };
            const client = makeFakeClient(capture);

            const result = await runSceneEndPipeline({
                directories: fx.directories,
                campaignId: fx.campaign.id,
                campaign: fx.campaign,
                scene: fx.scene,
                participants: fx.participants,
                memoryService: fx.memoryService,
                client,
                dryRun: true,
            });

            expect(result.dry_run).toBe(true);
            expect(result.summary.headline).toBe(SUMMARY_PAYLOAD.headline);
            expect(result.memories_extracted.jack).toBe(2);
            expect(result.memories_extracted.amelia).toBe(1);
            expect(result.scene).toBeNull();

            // No collection writes.
            const worldCol = collectionNameFor('world_lore', fx.campaign.id);
            expect(fx.qdrant.collections.get(worldCol)).toBeUndefined();

            // No summary on disk.
            expect(summaryStore.read(fx.directories, fx.campaign.id, fx.scene.id)).toBeNull();

            // Scene still active.
            const stillActive = sceneStore.get(fx.directories, fx.campaign.id, fx.scene.id);
            expect(stillActive?.status).toBe('active');
            expect(stillActive?.summary_headline ?? null).toBeNull();
        } finally {
            fx.cleanup();
        }
    });

    test('summary failure throws with stage="summary" and leaves scene active', async () => {
        const fx = await setupFixture();
        try {
            const capture = { calls: [] };
            const client = makeFakeFailingClient(capture, 'SceneSummary');

            await expect(runSceneEndPipeline({
                directories: fx.directories,
                campaignId: fx.campaign.id,
                campaign: fx.campaign,
                scene: fx.scene,
                participants: fx.participants,
                memoryService: fx.memoryService,
                client,
            })).rejects.toMatchObject({ stage: 'summary' });

            const stillActive = sceneStore.get(fx.directories, fx.campaign.id, fx.scene.id);
            expect(stillActive?.status).toBe('active');

            // No writes happened.
            const jackCol = collectionNameFor('character_memory', fx.campaign.id, 'jack');
            expect(fx.qdrant.collections.get(jackCol)).toBeUndefined();
        } finally {
            fx.cleanup();
        }
    });

    test('extraction failure for one participant does not abort the pipeline', async () => {
        const fx = await setupFixture();
        try {
            const capture = { calls: [] };
            // Make Amelia's extraction fail by overriding her payload to throw.
            const client = {
                async structured({ system, user, schema, schemaName }) {
                    capture.calls.push({ system, user, schema, schemaName });
                    if (schemaName === 'SceneSummary') return SUMMARY_PAYLOAD;
                    if (schemaName === 'SceneEndMemoryExtraction') {
                        if (user.includes('What does Amelia carry forward')) {
                            throw new Error('upstream 500');
                        }
                        return EXTRACTION_BY_NAME.Jack;
                    }
                    if (schemaName === 'SceneEndRecap') {
                        return {
                            recap: 'Jack stands beside the wagon as the gate creaks shut behind him.',
                            location: 'Just past the Ironhold gate',
                            time: 'Mid-morning',
                            nearby_characters: ['Amelia'],
                        };
                    }
                    throw new Error('unexpected');
                },
                async chat() { return ''; },
            };

            const result = await runSceneEndPipeline({
                directories: fx.directories,
                campaignId: fx.campaign.id,
                campaign: fx.campaign,
                scene: fx.scene,
                participants: fx.participants,
                memoryService: fx.memoryService,
                client,
            });

            // Jack still got memories; Amelia got zero; warnings array
            // captures the extraction failure.
            expect(result.memories_extracted.jack).toBe(2);
            expect(result.memories_extracted.amelia).toBe(0);
            expect(result.warnings).toEqual(expect.arrayContaining([
                expect.objectContaining({ stage: 'extraction', character_id: 'amelia' }),
            ]));
            // Scene still flips to closed.
            expect(result.scene?.status).toBe('closed');
        } finally {
            fx.cleanup();
        }
    });

    test('deterministic ids: same content produces identical record id across runs', async () => {
        const fx1 = await setupFixture();
        const fx2 = await setupFixture();
        try {
            const c1 = makeFakeClient({ calls: [] });
            const c2 = makeFakeClient({ calls: [] });
            await runSceneEndPipeline({
                directories: fx1.directories,
                campaignId: fx1.campaign.id,
                campaign: fx1.campaign,
                scene: fx1.scene,
                participants: fx1.participants,
                memoryService: fx1.memoryService,
                client: c1,
            });
            await runSceneEndPipeline({
                directories: fx2.directories,
                campaignId: fx2.campaign.id,
                campaign: fx2.campaign,
                scene: fx2.scene,
                participants: fx2.participants,
                memoryService: fx2.memoryService,
                client: c2,
            });
            // Same campaign id + scene id + content → same deterministic id.
            const jack1 = readMirrorJsonl(mirrorPath(fx1.directories, fx1.campaign.id, 'character_memory', 'jack'));
            const jack2 = readMirrorJsonl(mirrorPath(fx2.directories, fx2.campaign.id, 'character_memory', 'jack'));
            const ids1 = new Set(jack1.map(r => r.id));
            const ids2 = new Set(jack2.map(r => r.id));
            expect([...ids1].sort()).toEqual([...ids2].sort());
        } finally {
            fx1.cleanup();
            fx2.cleanup();
        }
    });
});
