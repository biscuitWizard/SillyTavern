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
 * @property {string | null} [summary_id]        Phase 8: deterministic id of the scene-end summary doc.
 * @property {string | null} [summary_headline]  Phase 8: cached one-line headline for the history row.
 * @property {string | null} [summary_path]      Phase 8: relative path to `{scene_id}.summary.json`.
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

/**
 * @typedef {Object} SceneSummaryKeyEvent
 * @property {string} text          narrative description
 * @property {string[]} tags
 * @property {number} importance    0..1
 */

/**
 * @typedef {Object} SceneSummary
 * @property {string} scene_id
 * @property {string} campaign_id
 * @property {string} headline                    one-sentence headline (~SCENE_HEADLINE_MAX chars)
 * @property {string} summary                     3–6 sentence prose summary
 * @property {SceneSummaryKeyEvent[]} key_events  each becomes a world_lore record
 * @property {string[]} location_changes
 * @property {string[]} participant_changes       who joined / left
 * @property {string} generated_at                ISO 8601
 */

export const SCENE_NAME_MAX = 120;
export const SCENE_LOCATION_MAX = 240;
export const SCENE_HEADLINE_MAX = 200;

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
        summary_id: input.summary_id ?? null,
        summary_headline: typeof input.summary_headline === 'string'
            ? input.summary_headline.slice(0, SCENE_HEADLINE_MAX)
            : (input.summary_headline ?? null),
        summary_path: input.summary_path ?? null,
    };
}

/**
 * Normalise a `SceneSummary` payload, clamping arrays/strings and stamping
 * `generated_at`. Treats unknown fields as discardable.
 *
 * @param {Partial<SceneSummary> & { scene_id: string, campaign_id: string }} input
 * @returns {SceneSummary}
 */
export function buildSceneSummary(input) {
    const now = new Date().toISOString();
    const headline = typeof input.headline === 'string'
        ? input.headline.trim().slice(0, SCENE_HEADLINE_MAX)
        : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    const keyEvents = Array.isArray(input.key_events)
        ? input.key_events
            .filter(ev => ev && typeof ev.text === 'string' && ev.text.trim().length > 0)
            .map(ev => ({
                text: ev.text.trim(),
                tags: Array.isArray(ev.tags) ? ev.tags.map(String).filter(Boolean) : [],
                importance: clampUnit(ev.importance ?? 0.5),
            }))
        : [];
    return {
        scene_id: input.scene_id,
        campaign_id: input.campaign_id,
        headline,
        summary,
        key_events: keyEvents,
        location_changes: Array.isArray(input.location_changes)
            ? input.location_changes.map(String).filter(Boolean)
            : [],
        participant_changes: Array.isArray(input.participant_changes)
            ? input.participant_changes.map(String).filter(Boolean)
            : [],
        generated_at: input.generated_at ?? now,
    };
}

/** @param {unknown} n */
function clampUnit(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 0.5;
    if (num < 0) return 0;
    if (num > 1) return 1;
    return num;
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
