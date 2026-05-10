/**
 * Scene participant helpers (Phase 5).
 *
 * `scene.participants` is a list of character ids. The Director's
 * `spawn_character` and `remove_character` actions run through these
 * helpers, as does the right-sidebar "Add to scene" affordance.
 *
 * Operations are idempotent:
 *   - Adding a participant who is already in the list is a no-op.
 *   - Removing a participant who is not in the list is a no-op.
 *
 * The PC's id is treated as immutable in `removeParticipant`: callers (the
 * Director loop and the HTTP endpoint) are expected to validate that
 * upstream. The helper itself does not know which id is the PC; it just
 * mutates the list.
 */

import * as sceneStore from './store.js';

/**
 * Add a character to a scene's participant list. Returns the updated Scene
 * record, or null if the scene does not exist.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {string} characterId
 */
export function addParticipant(directories, campaignId, sceneId, characterId) {
    const scene = sceneStore.get(directories, campaignId, sceneId);
    if (!scene) return null;
    const set = new Set(Array.isArray(scene.participants) ? scene.participants : []);
    if (set.has(characterId)) return scene;
    set.add(characterId);
    return sceneStore.update(directories, campaignId, sceneId, {
        participants: Array.from(set),
    });
}

/**
 * Remove a character from a scene's participant list. Returns the updated
 * Scene record, or null if the scene does not exist.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {string} characterId
 */
export function removeParticipant(directories, campaignId, sceneId, characterId) {
    const scene = sceneStore.get(directories, campaignId, sceneId);
    if (!scene) return null;
    const next = (Array.isArray(scene.participants) ? scene.participants : [])
        .filter(id => id !== characterId);
    if (next.length === (scene.participants || []).length) return scene;
    return sceneStore.update(directories, campaignId, sceneId, { participants: next });
}
