/**
 * `add_lore` writer — handles the Director's `add_lore` action.
 *
 * Phase 6 declared the `add_lore` schema variant but the dispatcher
 * rejected it ("not yet implemented"). Phase 7 wires it: the Director
 * picks `add_lore` when something canonical happens (a new faction is
 * named, a piece of history is revealed) and we land it in
 * `world_lore__{cid}` with `origin: 'generated'` and the active
 * scene_id stamped on the payload.
 *
 * Generated facts default to NOT temporally_blind so they decay slowly
 * over scenes; they can be promoted to core via a PATCH that sets
 * `origin: 'core'` and `temporally_blind: true`.
 */

import { buildMemoryRecord } from '../schemas.js';
import { deriveAddLoreId } from './ids.js';
import { upsertRecordInJsonl, mirrorPath } from '../mirror.js';

/**
 * @typedef {import('../service.d.ts').MemoryService} MemoryService
 */

/**
 * Coarse heuristic for `entry_kind` when the Director picks `add_lore`
 * but doesn't say which kind. Used as a last-resort fallback; we'd
 * rather the Director schema requested it explicitly, but the existing
 * schema only ships `title/body/tags`. We tag-sniff here so the explorer
 * filters still mostly work.
 *
 * @param {string[]} tags
 * @returns {import('../schemas.d.ts').WorldLoreEntryKind}
 */
function pickEntryKind(tags) {
    const set = new Set((tags || []).map(t => String(t).toLowerCase()));
    if (set.has('location') || set.has('city') || set.has('region')) return 'location';
    if (set.has('faction') || set.has('group') || set.has('order')) return 'faction';
    if (set.has('person') || set.has('npc') || set.has('character')) return 'people';
    if (set.has('history') || set.has('event') || set.has('lore')) return 'history';
    if (set.has('magic') || set.has('spell') || set.has('arcane')) return 'magic';
    if (set.has('artifact') || set.has('item') || set.has('relic')) return 'artifact';
    if (set.has('beast') || set.has('monster') || set.has('creature')) return 'bestiary';
    if (set.has('cosmology') || set.has('plane')) return 'cosmology';
    if (set.has('language') || set.has('tongue')) return 'language';
    if (set.has('pantheon') || set.has('god') || set.has('deity')) return 'pantheon';
    if (set.has('culture') || set.has('custom') || set.has('tradition')) return 'culture';
    return 'custom';
}

/**
 * @param {{
 *   memoryService: MemoryService,
 *   campaignId: string,
 *   sceneId: string,
 *   sceneIndex: number,
 *   directorStepIndex: number,
 *   decision: { title: string, body: string, tags?: string[] },
 * }} args
 * @returns {Promise<{ wrote: number, id?: string, record?: any }>}
 */
export async function writeAddLore(args) {
    const { memoryService, campaignId, sceneId, sceneIndex, directorStepIndex, decision } = args;
    const title = String(decision?.title || '').trim();
    const body = String(decision?.body || '').trim();
    if (!title || !body) return { wrote: 0 };

    const tags = Array.isArray(decision.tags) ? decision.tags.map(String) : [];
    const entryKind = pickEntryKind(tags);

    const id = deriveAddLoreId({
        campaignId,
        sceneId,
        directorStepIndex,
        content: `${title}\n${body}`,
    });
    const record = buildMemoryRecord({
        id,
        kind: 'world_lore',
        scope_id: campaignId,
        content: `${title}\n\n${body}`,
        tags,
        importance: 0.6,
        valence: 0,
        temporally_blind: false,
        source: `add_lore:${sceneId}:step-${directorStepIndex}`,
        scene_index: sceneIndex,
        world_lore: {
            origin: 'generated',
            source_type: 'add_lore',
            scene_id: sceneId,
            entry_kind: entryKind,
            title,
        },
    });
    try {
        await memoryService.write({ campaignId, record });
        return { wrote: 1, id, record };
    } catch (err) {
        // Even when the service write fails the disk mirror has the
        // line; surface the partial success so callers know.
        console.warn('[rag.lore-add] service.write failed', err?.message || err);
        try {
            const file = mirrorPath(memoryService.directories, campaignId, 'world_lore');
            upsertRecordInJsonl(file, record);
        } catch (innerErr) {
            console.warn('[rag.lore-add] disk fallback failed too', innerErr?.message || innerErr);
        }
        return { wrote: 0 };
    }
}

export { pickEntryKind };
