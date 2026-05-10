/**
 * Phase 7 invariant: temporal decay (and nostalgia) follow VectHare's
 * shape — exponential by default, half-life from config, optional
 * nostalgia inversion, `temporally_blind` opts out entirely.
 */

import { describe, test, expect } from '@jest/globals';

import { applyDecayToHits, computeDecayMultiplier } from '../../../src/gm-core/rag/decay.js';

const FALLBACK = { mode: 'exponential', half_life: 10, floor: 0.2 };

function rec(extra = {}) {
    return {
        id: extra.id || 'r',
        kind: 'character_memory',
        scope_id: 'c1/jack',
        content: 'x',
        tags: [],
        importance: 0.5,
        valence: 0,
        temporally_blind: false,
        decay_override: null,
        source: '',
        created_at: '',
        updated_at: '',
        metadata: {},
        scene_index: 0,
        ...extra,
    };
}

describe('decay.js', () => {
    test('age 0 returns 1.0 multiplier', () => {
        expect(computeDecayMultiplier(rec(), 0, FALLBACK)).toBeCloseTo(1.0, 6);
    });

    test('age = half_life returns 0.5 multiplier (exponential)', () => {
        expect(computeDecayMultiplier(rec(), 10, FALLBACK)).toBeCloseTo(0.5, 6);
    });

    test('age >> half_life clamps to floor', () => {
        expect(computeDecayMultiplier(rec(), 1000, FALLBACK)).toBeCloseTo(0.2, 6);
    });

    test('temporally_blind always returns 1.0', () => {
        expect(computeDecayMultiplier(rec({ temporally_blind: true }), 1000, FALLBACK)).toBe(1.0);
    });

    test('linear mode produces a 1 - age/(2*half_life) curve', () => {
        const cfg = { mode: 'linear', half_life: 10, floor: 0 };
        expect(computeDecayMultiplier(rec(), 0, cfg)).toBeCloseTo(1.0, 6);
        expect(computeDecayMultiplier(rec(), 10, cfg)).toBeCloseTo(0.5, 6);
        expect(computeDecayMultiplier(rec(), 20, cfg)).toBeCloseTo(0, 6);
    });

    test('record-level decay_override wins over the collection fallback', () => {
        // Collection fallback: half_life 10. Record override: half_life 100.
        const r = rec({ decay_override: { mode: 'exponential', half_life: 100, floor: 0 } });
        // At age 10 the override curve is ~0.933, vs fallback 0.5.
        expect(computeDecayMultiplier(r, 10, FALLBACK)).toBeGreaterThan(0.9);
    });

    test('nostalgia mode inverts the curve', () => {
        const r = rec({ decay_override: { mode: 'exponential', half_life: 10, floor: 0, nostalgia: true } });
        // At age 0 the inversion lands at exactly 1.0 (no boost).
        expect(computeDecayMultiplier(r, 0, FALLBACK)).toBeCloseTo(1.0, 6);
        // At age = half_life, the standard curve is 0.5, so nostalgia is 1.5 (capped).
        expect(computeDecayMultiplier(r, 10, FALLBACK)).toBeCloseTo(1.5, 6);
        // Beyond, capped at NOSTALGIA_CAP (1.5).
        expect(computeDecayMultiplier(r, 1000, FALLBACK)).toBeCloseTo(1.5, 6);
    });

    test('applyDecayToHits sorts by post-decay score and breaks ties on importance', () => {
        const hits = [
            { record: rec({ id: 'old',     importance: 0.5, scene_index: 0 }),  raw_score: 0.9 },
            { record: rec({ id: 'recent',  importance: 0.5, scene_index: 10 }), raw_score: 0.6 },
            { record: rec({ id: 'recent2', importance: 0.9, scene_index: 10 }), raw_score: 0.6 },
        ];
        const out = applyDecayToHits(hits, /* currentScene */ 10, FALLBACK);
        // recent (raw 0.6 * decay 1.0 = 0.6) ties with recent2; importance breaks.
        // old (raw 0.9 * decay 0.5 = 0.45) drops below.
        expect(out.map(h => h.record.id)).toEqual(['recent2', 'recent', 'old']);
    });
});
