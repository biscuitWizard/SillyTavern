/**
 * Phase 7 — opinion extractor regression suite.
 *
 * The locked-in prompt for `writers/opinion.js` was picked by a
 * `best-of-n-runner` against the fixtures in `fixtures/opinion-fixtures.js`.
 * This test pins the contract:
 *
 *   - Fake LLM returns the fixture's `expected` payload.
 *   - The writer turns each memory into a `MemoryRecord` written through
 *     `MemoryService` with the right scope (`character_memory__cid__id`).
 *   - `is_significant: false` results in zero writes (false-positive
 *     guard).
 *   - The system prompt the writer sends matches the locked prompt
 *     constant exactly (regression guard against accidental edits).
 *
 * If you intentionally tune the prompt, update `OPINION_SYSTEM_PROMPT`
 * AND each fixture's `expected` in lockstep.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractAndWriteOpinion, OPINION_SYSTEM_PROMPT } from '../../../src/gm-core/rag/writers/opinion.js';
import { createMemoryService } from '../../../src/gm-core/rag/service.js';
import { createDeterministicEmbedder } from '../../../src/gm-core/rag/embedders.js';
import { collectionNameFor } from '../../../src/gm-core/rag/schemas.js';
import { OPINION_FIXTURES } from './fixtures/opinion-fixtures.js';

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

function makeFakeClient(payload, capture) {
    return {
        structured: async ({ system, user, schema, schemaName }) => {
            capture.calls.push({ system, user, schemaName, schema });
            return payload;
        },
        chat: async () => 'unused',
    };
}

describe('opinion extractor — locked prompt', () => {
    test('SYSTEM_PROMPT is the locked variant (guard against accidental edits)', () => {
        // Spot-check: must contain the false-positive guard and the
        // first-person voice rule. If anyone removes these the suite fails
        // and forces a deliberate fixture refresh.
        expect(OPINION_SYSTEM_PROMPT).toContain('false');
        expect(OPINION_SYSTEM_PROMPT).toContain('first-person');
        expect(OPINION_SYSTEM_PROMPT).toContain('Tags');
    });

    for (const fixture of OPINION_FIXTURES) {
        test(`fixture: ${fixture.name}`, async () => {
            const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-op-'));
            fs.mkdirSync(path.join(tmpRoot, 'campaigns'), { recursive: true });
            const directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };
            try {
                const embedder = createDeterministicEmbedder({ dim: 64 });
                const qdrant = createFakeQdrant();
                const service = createMemoryService({ directories, qdrant, embedder });
                const capture = { calls: [] };
                const client = makeFakeClient(fixture.expected, capture);

                const result = await extractAndWriteOpinion({
                    memoryService: service,
                    client,
                    campaignId: 'demo',
                    character: fixture.character,
                    sceneId: 'fixture-scene',
                    sceneIndex: 0,
                    messageIndex: 1,
                    lastMessage: fixture.lastMessage,
                    transcriptTail: fixture.transcriptTail,
                });

                // The writer always issues exactly one structured call,
                // even on the false-positive path.
                expect(capture.calls).toHaveLength(1);
                expect(capture.calls[0].system).toBe(OPINION_SYSTEM_PROMPT);
                expect(capture.calls[0].schemaName).toBe('OpinionExtraction');

                if (fixture.expected.is_significant) {
                    expect(result.wrote).toBe(fixture.expected.memories.length);
                    const collection = collectionNameFor('character_memory', 'demo', fixture.character.id);
                    const stored = qdrant.collections.get(collection);
                    expect(stored?.size).toBe(fixture.expected.memories.length);
                    // Each written record matches the fixture content + tags.
                    for (const expected of fixture.expected.memories) {
                        const matched = result.hits.find(h => h.content === expected.content);
                        expect(matched).toBeTruthy();
                        expect(matched.tags).toEqual(expected.tags);
                        expect(matched.importance).toBeCloseTo(expected.importance);
                        expect(matched.valence).toBeCloseTo(expected.valence);
                    }
                } else {
                    expect(result.wrote).toBe(0);
                    expect(result.hits).toEqual([]);
                }
            } finally {
                fs.rmSync(tmpRoot, { recursive: true, force: true });
            }
        });
    }
});
