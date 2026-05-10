/**
 * Director decision schemas.
 *
 * Phase 4 ships the full union (so adding a variant later is a JSON-schema
 * extension, not a contract bump) but the loop dispatcher only handles
 * `speak: narrator` and `end_turn`. All other actions emit a structured
 * error event and end the turn — preserving the invariant that adding a
 * Director capability requires explicit dispatch wiring.
 *
 * The exported `directorDecisionJsonSchema` is the canonical schema used
 * by the LLM client's `structured()` mode. The JSDoc typedef above is the
 * mirror for in-process use.
 */

/**
 * @typedef {(
 *  | { action: 'speak', actor: 'narrator' | string, intent: string, rationale: string }
 *  | { action: 'skill_check', actor: string, intent: string, voice?: 'narrator' | string, rationale: string }
 *  | { action: 'search_library', query: string, rationale: string }
 *  | { action: 'spawn_character', from_source: 'library' | 'new', ref?: string, name?: string, brief?: string, on_join_message?: string, rationale: string }
 *  | { action: 'remove_character', character_id: string, on_leave_message?: string, rationale: string }
 *  | { action: 'add_lore', title: string, body: string, tags: string[], rationale: string }
 *  | { action: 'propose_scene', name: string, setting: string, suggested_participants: string[], hooks: string[], rationale: string }
 *  | { action: 'end_turn', rationale: string }
 * )} DirectorDecision
 *
 * `skill_check.voice` controls who delivers the post-roll prose:
 *   - `'narrator'` (default): the World Narrator describes the world's
 *     reaction. Right for environmental checks (climb, perceive, sneak past
 *     a hazard, lockpick).
 *   - `'<character_id>'` of an in-scene NPC: that NPC reacts in their own
 *     voice via the actor model. Right for social/interactive checks
 *     directed at a specific person (persuade, deceive, intimidate, charm).
 *     The id MUST be in the current scene roster and MUST NOT be the
 *     actor performing the check (you cannot react to your own attempt).
 */

/** Variants the loop dispatcher actually executes. Phase 7 adds `add_lore`,
 * which records a generated world-lore entry into the campaign-scoped
 * `world_lore__{cid}` collection (origin: 'generated'). The
 * `search_library` and `spawn_character: from_source='new'` paths are
 * Phase 5/6 follow-on work that turns "the player named someone off-stage"
 * from a hard error into a recoverable tool flow. */
export const SUPPORTED_ACTIONS = new Set([
    'speak',
    'skill_check',
    'search_library',
    'spawn_character',
    'remove_character',
    'add_lore',
    'end_turn',
]);

/**
 * Hand-written JSON Schema (Draft 2020-12) for the DirectorDecision union.
 * `oneOf` discriminated by `action`. Strict mode-friendly: every variant
 * sets `additionalProperties: false` and lists every property in `required`.
 *
 * @type {object}
 */
export const directorDecisionJsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'DirectorDecision',
    description: 'A single dispatch decision the Director makes inside a turn loop.',
    type: 'object',
    oneOf: [
        {
            title: 'Speak',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'speak' },
                actor: {
                    type: 'string',
                    description: 'Actor id ("narrator" for the World Narrator, otherwise an actor id).',
                },
                intent: {
                    type: 'string',
                    description: 'What this actor should attempt to convey or do this beat.',
                },
                rationale: { type: 'string' },
            },
            required: ['action', 'actor', 'intent', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'SkillCheck',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'skill_check' },
                actor: { type: 'string', description: 'Character id attempting the action.' },
                intent: { type: 'string' },
                voice: {
                    type: 'string',
                    description: 'Who delivers the post-roll consequence prose. Use "narrator" for environmental / world checks; use the in-scene character id of the target for social checks (so they react in their own voice). Defaults to "narrator" if omitted.',
                },
                rationale: { type: 'string' },
            },
            required: ['action', 'actor', 'intent', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'SearchLibrary',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'search_library' },
                query: {
                    type: 'string',
                    description: 'Free-text query searched against off-stage character name, appearance, and background.',
                },
                rationale: { type: 'string' },
            },
            required: ['action', 'query', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'SpawnCharacter',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'spawn_character' },
                from_source: { type: 'string', enum: ['library', 'new'] },
                ref: {
                    type: 'string',
                    description: 'For from_source: "library", the character id to bring on-stage.',
                },
                name: {
                    type: 'string',
                    description: 'For from_source: "new", the short display name of the character (e.g. "Mira", "the bartender").',
                },
                brief: {
                    type: 'string',
                    description: 'For from_source: "new", a one-sentence description of who they are and how they read (appearance, role, voice).',
                },
                on_join_message: { type: 'string' },
                rationale: { type: 'string' },
            },
            required: ['action', 'from_source', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'RemoveCharacter',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'remove_character' },
                character_id: { type: 'string' },
                on_leave_message: { type: 'string' },
                rationale: { type: 'string' },
            },
            required: ['action', 'character_id', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'AddLore',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'add_lore' },
                title: { type: 'string' },
                body: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                entry_kind: {
                    type: 'string',
                    description: 'Optional categorical tag: faction | place | event | item | concept | npc-fact | misc.',
                },
                importance: { type: 'number' },
                rationale: { type: 'string' },
            },
            required: ['action', 'title', 'body', 'tags', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'ProposeScene',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'propose_scene' },
                name: { type: 'string' },
                setting: { type: 'string' },
                suggested_participants: { type: 'array', items: { type: 'string' } },
                hooks: { type: 'array', items: { type: 'string' } },
                rationale: { type: 'string' },
            },
            required: ['action', 'name', 'setting', 'suggested_participants', 'hooks', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'EndTurn',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'end_turn' },
                rationale: { type: 'string' },
                pacing_note: {
                    type: 'string',
                    description: 'Optional one-line pacing note recorded into director_memory for future turns.',
                },
            },
            required: ['action', 'rationale'],
            additionalProperties: false,
        },
    ],
};

/**
 * Lightweight runtime check for a Director decision, just covering the bits
 * the dispatcher actually reads. The LLM client already enforces the schema
 * via structured-output mode where supported; this is a defensive last
 * line for the fallback text-mode JSON path.
 *
 * @param {unknown} value
 * @returns {string | null} error string or null on success
 */
export function validateDirectorDecision(value) {
    if (!value || typeof value !== 'object') return 'decision must be an object';
    const v = /** @type {any} */ (value);
    if (typeof v.action !== 'string') return 'decision.action must be a string';
    if (typeof v.rationale !== 'string') return 'decision.rationale must be a string';

    switch (v.action) {
        case 'speak':
            if (typeof v.actor !== 'string' || !v.actor) return 'speak.actor required';
            if (typeof v.intent !== 'string') return 'speak.intent required';
            return null;
        case 'skill_check':
            if (typeof v.actor !== 'string' || !v.actor) return 'skill_check.actor required';
            if (typeof v.intent !== 'string') return 'skill_check.intent required';
            // `voice` is optional. If present it must be a non-empty string.
            // The dispatcher does the semantic check (in-scene, not the same
            // as `actor`) so it can degrade gracefully to narrator instead
            // of failing the whole turn over a hallucinated voice id.
            if (v.voice !== undefined && (typeof v.voice !== 'string' || !v.voice.trim())) {
                return 'skill_check.voice, when set, must be a non-empty string ("narrator" or an in-scene character id)';
            }
            return null;
        case 'search_library':
            if (typeof v.query !== 'string' || !v.query.trim()) return 'search_library.query required';
            return null;
        case 'end_turn':
            return null;
        case 'spawn_character':
            if (v.from_source === 'new') {
                if (typeof v.name !== 'string' || !v.name.trim()) return 'spawn_character.name required when from_source is "new"';
                if (typeof v.brief !== 'string' || !v.brief.trim()) return 'spawn_character.brief required when from_source is "new"';
            }
            return null;
        case 'remove_character':
        case 'add_lore':
        case 'propose_scene':
            return null;
        default:
            return `unknown action: ${v.action}`;
    }
}
