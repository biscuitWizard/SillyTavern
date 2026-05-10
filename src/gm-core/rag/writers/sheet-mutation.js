/**
 * Sheet-mutation audit writer (M8).
 *
 * The Director's `mutate_sheet` action is dispatched by `director/loop.js`
 * after the JSON schema validates and the in-process mutators in
 * `sheets/operations.js` have written through `library/store.js`. Once
 * the on-disk sheet is updated, the loop calls this writer with a
 * one-line summary of what happened so future Director steps (and any
 * later audit / replay tooling) can reason about state changes that
 * were not captured by speak/skill_check.
 *
 * Audit rows land in `director_memory__{cid}` with a low-but-nonzero
 * importance and the active `scene_index` stamped on the payload — same
 * shape as `writeDirectorPacing`, deliberately, so the Director's
 * memory slice surfaces both pacing notes and sheet edits side by side
 * across turns.
 *
 * No new LLM call — the loop already produced the human-readable
 * summary; this writer just persists it.
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
 *   characterId: string,
 *   summary: string,
 *   tags?: string[],
 * }} args
 * @returns {Promise<{ wrote: number, id?: string }>}
 */
export async function writeSheetMutationAudit(args) {
    const { memoryService, campaignId, sceneId, sceneIndex, characterId, summary, tags } = args;
    const note = String(summary || '').trim();
    if (!note) return { wrote: 0 };
    const id = deriveRoleMemoryId({
        campaignId,
        role: `director/${sceneId}/sheet/${characterId}`,
        content: note,
    });
    const baseTags = ['sheet_mutation', `character:${characterId}`];
    if (sceneId) baseTags.push(sceneId);
    const record = buildMemoryRecord({
        id,
        kind: 'director_memory',
        scope_id: campaignId,
        content: note,
        tags: Array.isArray(tags) && tags.length ? [...baseTags, ...tags] : baseTags,
        importance: 0.5,
        valence: 0,
        temporally_blind: false,
        source: `director-mutate-sheet:${sceneId}:${characterId}`,
        scene_index: sceneIndex,
    });
    try {
        await memoryService.write({ campaignId, record });
        return { wrote: 1, id };
    } catch (err) {
        console.warn('[rag.sheet-mutation] write failed', err?.message || err);
        return { wrote: 0 };
    }
}
