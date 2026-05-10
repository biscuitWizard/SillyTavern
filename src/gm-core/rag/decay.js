/**
 * Temporal decay + nostalgia for retrieval scoring.
 *
 * Ported from VectHare's `core/temporal-decay.js`. Pure functions; no
 * Qdrant, no I/O, no async. The `MemoryService` calls `applyDecayToHits`
 * after Qdrant returns raw cosines so the cheap payload-filter work
 * happens DB-side and the recency multiplier happens in JS.
 *
 * Age unit is `scenes_elapsed` (campaign-relative), not wall-clock —
 * TTRPG sessions span weeks but story-relative age is what matters.
 *
 * Modes:
 *   - decay (default): older → lower multiplier (multiplier ≤ 1).
 *     `mode: 'exponential'` → `multiplier = max(floor, 0.5 ^ (age / half_life))`.
 *     `mode: 'linear'`      → `multiplier = max(floor, 1 - age / (2*half_life))`.
 *   - nostalgia (decay_override.nostalgia === true): older → higher.
 *     The same shape inverted around 1, capped at 1.5×.
 *   - temporally_blind: returns 1.0 (record opts out of decay entirely).
 */

const NOSTALGIA_CAP = 1.5;

/**
 * @typedef {import('./schemas.d.ts').DecayConfig} DecayConfig
 * @typedef {import('./schemas.d.ts').MemoryRecord} MemoryRecord
 * @typedef {import('./schemas.d.ts').RetrievalHit} RetrievalHit
 */

/**
 * Compute the multiplier for one record. Branches on:
 *   1. `temporally_blind: true` → 1.0 (no decay).
 *   2. record-level override (`decay_override`) wins over collection default.
 *   3. nostalgia flag inverts the curve.
 *
 * @param {MemoryRecord} record
 * @param {number} ageScenes
 * @param {DecayConfig} fallback   collection-level config used when override is null
 * @returns {number}
 */
export function computeDecayMultiplier(record, ageScenes, fallback) {
    if (!record) return 1.0;
    if (record.temporally_blind) return 1.0;
    const cfg = record.decay_override || fallback;
    if (!cfg) return 1.0;
    const age = Math.max(0, Number(ageScenes) || 0);
    const halfLife = Math.max(1, Number(cfg.half_life) || 1);
    const floor = clamp01(Number(cfg.floor));
    const isNostalgia = cfg.nostalgia === true;

    let raw;
    if (cfg.mode === 'linear') {
        raw = 1 - age / (2 * halfLife);
    } else {
        raw = Math.pow(0.5, age / halfLife);
    }

    if (isNostalgia) {
        // Invert: older → larger multiplier, capped at NOSTALGIA_CAP.
        // `raw` shrinks with age in the standard curve; subtract from 2 so
        // age=0 → 1.0, age=halfLife → 1.5, age=2*halfLife → 1.75 (capped).
        const inverted = 2 - raw;
        return Math.min(NOSTALGIA_CAP, Math.max(1.0, inverted));
    }

    // Standard decay: clamp into [floor, 1].
    if (raw < floor) raw = floor;
    if (raw > 1) raw = 1;
    return raw;
}

/**
 * Compute the post-decay score for a single hit.
 *
 * @param {{ record: MemoryRecord, raw_score: number }} hit
 * @param {number} currentSceneIndex   for computing ageScenes from `record.scene_index`
 * @param {DecayConfig} fallback
 * @returns {RetrievalHit}
 */
export function applyDecayToHit(hit, currentSceneIndex, fallback) {
    const ageScenes = Math.max(0, (Number(currentSceneIndex) || 0) - (Number(hit.record.scene_index) || 0));
    const multiplier = computeDecayMultiplier(hit.record, ageScenes, fallback);
    return {
        record: hit.record,
        raw_score: hit.raw_score,
        score: hit.raw_score * multiplier,
        decay_multiplier: multiplier,
    };
}

/**
 * Apply decay to a list of hits and re-sort by post-decay score (descending).
 *
 * @param {Array<{ record: MemoryRecord, raw_score: number }>} hits
 * @param {number} currentSceneIndex
 * @param {DecayConfig} fallback
 * @returns {RetrievalHit[]}
 */
export function applyDecayToHits(hits, currentSceneIndex, fallback) {
    if (!Array.isArray(hits) || hits.length === 0) return [];
    const out = hits.map(h => applyDecayToHit(h, currentSceneIndex, fallback));
    out.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Tie-break by importance, then by recency (lower ageScenes wins).
        const ai = a.record.importance ?? 0.5;
        const bi = b.record.importance ?? 0.5;
        if (bi !== ai) return bi - ai;
        const aIdx = Number(a.record.scene_index) || 0;
        const bIdx = Number(b.record.scene_index) || 0;
        return bIdx - aIdx;
    });
    return out;
}

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}
