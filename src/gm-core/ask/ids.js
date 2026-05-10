/**
 * Deterministic id helpers for Ask-mode writes.
 *
 * Ask-mode `world_lore` records derive from a (campaignId + ask entry id +
 * content) tuple so the same player question producing the same lore
 * candidate always lands in the same record id. Re-running the service
 * on the same transcript (e.g. a future replay tool) is therefore
 * idempotent — disk JSONL upsert + Qdrant upsert collapse to a no-op.
 */

import { createHash } from 'node:crypto';

/**
 * @param {{ campaignId: string, askEntryId: string, content: string }} args
 */
export function deriveAskLoreId({ campaignId, askEntryId, content }) {
    return createHash('sha256')
        .update(`${campaignId}|ask|${askEntryId}|${content}`)
        .digest('hex')
        .slice(0, 16);
}
