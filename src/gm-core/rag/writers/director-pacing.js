/**
 * Director pacing writer — runs at `end_turn`.
 *
 * The Director's `end_turn` decision schema is extended with an optional
 * `pacing_note: string` (one-line directorial recap of the turn). When
 * present, this writer drops it into `director_memory__{cid}` so future
 * Director steps can reason about pacing across turns.
 *
 * No new LLM call — this writer just persists what the Director already
 * emitted.
 */

import { buildMemoryRecord } from '../schemas.js';
import { deriveRoleMemoryId } from './ids.js';

/**
 * @typedef {import('../service.d.ts').MemoryService} MemoryService
 */

/**
 * @param {{
 *   memoryService: MemoryService,
 *   campaignId: string,
 *   sceneId: string,
 *   sceneIndex: number,
 *   pacingNote: string,
 *   tags?: string[],
 * }} args
 * @returns {Promise<{ wrote: number, id?: string }>}
 */
export async function writeDirectorPacing(args) {
    const { memoryService, campaignId, sceneId, sceneIndex, pacingNote, tags } = args;
    const note = String(pacingNote || '').trim();
    if (!note) return { wrote: 0 };
    const id = deriveRoleMemoryId({
        campaignId,
        role: `director/${sceneId}`,
        content: note,
    });
    const record = buildMemoryRecord({
        id,
        kind: 'director_memory',
        scope_id: campaignId,
        content: note,
        tags: Array.isArray(tags) ? [...tags, sceneId] : [sceneId],
        importance: 0.6,
        valence: 0,
        temporally_blind: false,
        source: `director-pacing:${sceneId}`,
        scene_index: sceneIndex,
    });
    try {
        await memoryService.write({ campaignId, record });
        return { wrote: 1, id };
    } catch (err) {
        console.warn('[rag.director-pacing] write failed', err?.message || err);
        return { wrote: 0 };
    }
}
