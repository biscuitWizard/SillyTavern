/**
 * Deterministic id helpers shared by all writers.
 *
 * Mirrors the id model in `docs/phases/7-rag.md` — disk JSONL is the
 * source of truth on replay, so every id is stable across the same
 * inputs (same content + same scene/message index → same record).
 */

import { createHash } from 'node:crypto';

/**
 * @param {{ campaignId: string, characterId: string, sceneId: string, messageIndex: number, content: string, slot?: number }} args
 */
export function deriveCharacterMemoryId(args) {
    const hash = createHash('sha256')
        .update(`${args.campaignId}|${args.characterId}|${args.sceneId}|${args.messageIndex}|${args.slot || 0}|${args.content}`)
        .digest('hex');
    return hash.slice(0, 16);
}

/**
 * @param {{ campaignId: string, sceneId: string, directorStepIndex: number, content: string }} args
 */
export function deriveAddLoreId(args) {
    const hash = createHash('sha256')
        .update(`${args.campaignId}|${args.sceneId}|${args.directorStepIndex}|${args.content}`)
        .digest('hex');
    return hash.slice(0, 16);
}

/**
 * Director / narrator / player journal ids: include nanoseconds so
 * ad-hoc multiple writes in a single scene don't collide, but the disk
 * JSONL line is the source of truth on replay so it stays deterministic
 * across reconcile passes.
 *
 * @param {{ campaignId: string, role: string, content: string, nanos?: number }} args
 */
export function deriveRoleMemoryId(args) {
    const nanos = args.nanos ?? Date.now() * 1000;
    const hash = createHash('sha256')
        .update(`${args.campaignId}|${args.role}|${nanos}|${args.content}`)
        .digest('hex');
    return hash.slice(0, 16);
}

/**
 * Phase 8: per-character end-of-scene memory id. Distinct from
 * `deriveCharacterMemoryId` (which keys on `messageIndex`) because the
 * scene-end batch extractor doesn't have a single message index — its
 * memories are scene-spanning. Re-running the pipeline on the same
 * transcript produces the same id, so writes are idempotent.
 *
 * @param {{ campaignId: string, characterId: string, sceneId: string, slot: number, content: string }} args
 */
export function deriveSceneEndCharacterMemoryId(args) {
    const hash = createHash('sha256')
        .update(`${args.campaignId}|${args.characterId}|${args.sceneId}|scene-end|${args.slot}|${args.content}`)
        .digest('hex');
    return hash.slice(0, 16);
}

/**
 * Phase 8: world_lore key-event id. Stable across pipeline re-runs so
 * the disk JSONL upsert + Qdrant upsert are no-ops on the second pass.
 *
 * @param {{ campaignId: string, sceneId: string, idx: number, content: string }} args
 */
export function deriveSceneEndKeyEventId(args) {
    const hash = createHash('sha256')
        .update(`${args.campaignId}|${args.sceneId}|key-event|${args.idx}|${args.content}`)
        .digest('hex');
    return hash.slice(0, 16);
}
