/**
 * Phase 7: embedder contracts.
 *
 *   - DeterministicEmbedder is stable (same input → same output) and the
 *     output is L2-normalised.
 *   - Cosine similarity is higher for related strings than for unrelated
 *     ones, so the rest of the RAG suite can rely on it for fixture data.
 */

import { describe, test, expect } from '@jest/globals';

import { createDeterministicEmbedder } from '../../../src/gm-core/rag/embedders.js';

function cosine(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}

describe('DeterministicEmbedder', () => {
    test('same text produces the same vector', async () => {
        const e = createDeterministicEmbedder({ dim: 64 });
        const a = await e.embed('the quick brown fox');
        const b = await e.embed('the quick brown fox');
        expect(a).toEqual(b);
    });

    test('vectors are L2-normalised (length ~1)', async () => {
        const e = createDeterministicEmbedder({ dim: 256 });
        const v = await e.embed('Eldoria is a continent of warring city-states');
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        expect(norm).toBeGreaterThan(0.95);
        expect(norm).toBeLessThan(1.05);
    });

    test('related strings cosine higher than unrelated', async () => {
        const e = createDeterministicEmbedder({ dim: 256 });
        const subject = await e.embed('Amelia owes a debt to her sister Lila');
        const close = await e.embed('Amelia and her sister Lila have a debt to settle');
        const far = await e.embed('the goblin king rules from the obsidian throne');
        expect(cosine(subject, close)).toBeGreaterThan(cosine(subject, far));
    });

    test('embedBatch returns one vector per input in order', async () => {
        const e = createDeterministicEmbedder({ dim: 64 });
        const out = await e.embedBatch(['alpha', 'beta', 'gamma']);
        expect(out).toHaveLength(3);
        expect(out[0]).toEqual(await e.embed('alpha'));
        expect(out[1]).toEqual(await e.embed('beta'));
        expect(out[2]).toEqual(await e.embed('gamma'));
    });

    test('empty string returns a zero vector', async () => {
        const e = createDeterministicEmbedder({ dim: 16 });
        const v = await e.embed('');
        expect(v).toHaveLength(16);
        expect(v.every(x => x === 0)).toBe(true);
    });
});
