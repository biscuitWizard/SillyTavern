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
