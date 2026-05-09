/**
 * Scene + transcript schemas (Phase 3).
 *
 * Per ADR 0003 / docs/phases/3-scene-shell.md, scene metadata lives at
 * `{handle}/campaigns/{cid}/scenes/{scene_id}.json` and the transcript at the
 * sibling `{scene_id}.jsonl`. Transcript lines mirror SillyTavern's
 * `addOneMessage()` shape so the existing chat substrate can render them
 * directly.
 */

/**
 * @typedef {Object} Scene
 * @property {string} id
 * @property {string} campaign_id
 * @property {string} name
 * @property {'active' | 'closed'} status
 * @property {string[]} participants  Character ids; in Phase 3 just `[PC.id]`.
 * @property {string} location  Free-form for now.
 * @property {string} started_at
 * @property {string | null} ended_at
 * @property {number} message_count
 */

/**
 * @typedef {Object} TranscriptLine
 * @property {string} name
 * @property {string} [force_avatar]
 * @property {string} mes
 * @property {boolean} is_user
 * @property {boolean} is_system
 * @property {string} send_date
 * @property {object} [extra]
 */

export const SCENE_NAME_MAX = 120;
export const SCENE_LOCATION_MAX = 240;

/**
 * Build a fresh Scene record from create input.
 *
 * @param {Partial<Scene> & { id: string, campaign_id: string }} input
 * @returns {Scene}
 */
export function buildScene(input) {
    const now = new Date().toISOString();
    return {
        id: input.id,
        campaign_id: input.campaign_id,
        name: typeof input.name === 'string' && input.name.trim().length > 0
            ? input.name.trim().slice(0, SCENE_NAME_MAX)
            : `Scene ${new Date().toLocaleString()}`,
        status: input.status ?? 'active',
        participants: Array.isArray(input.participants) ? [...input.participants] : [],
        location: typeof input.location === 'string' ? input.location.slice(0, SCENE_LOCATION_MAX) : '',
        started_at: input.started_at ?? now,
        ended_at: input.ended_at ?? null,
        message_count: typeof input.message_count === 'number' ? input.message_count : 0,
    };
}

/**
 * Validate the user-supplied portion of a Scene create / update.
 *
 * @param {Partial<Scene>} body
 * @returns {string | null}
 */
export function validateSceneInput(body) {
    if (!body || typeof body !== 'object') return 'request body required';
    if (body.name !== undefined && typeof body.name !== 'string') return 'name must be a string';
    if (body.location !== undefined && typeof body.location !== 'string') return 'location must be a string';
    if (body.participants !== undefined && !Array.isArray(body.participants)) return 'participants must be an array';
    return null;
}
