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
 *  | { action: 'skill_check', actor: string, intent: string, rationale: string }
 *  | { action: 'spawn_character', from_source: 'library' | 'new', ref?: string, brief?: string, on_join_message?: string, rationale: string }
 *  | { action: 'remove_character', character_id: string, on_leave_message?: string, rationale: string }
 *  | { action: 'add_lore', title: string, body: string, tags: string[], rationale: string }
 *  | { action: 'propose_scene', name: string, setting: string, suggested_participants: string[], hooks: string[], rationale: string }
 *  | { action: 'end_turn', rationale: string }
 * )} DirectorDecision
 */

/** Variants the Phase-5 loop dispatcher actually executes. */
export const SUPPORTED_ACTIONS = new Set([
    'speak',
    'spawn_character',
    'remove_character',
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
                actor: { type: 'string' },
                intent: { type: 'string' },
                rationale: { type: 'string' },
            },
            required: ['action', 'actor', 'intent', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'SpawnCharacter',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'spawn_character' },
                from_source: { type: 'string', enum: ['library', 'new'] },
                ref: { type: 'string' },
                brief: { type: 'string' },
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
        case 'end_turn':
            return null;
        case 'skill_check':
        case 'spawn_character':
        case 'remove_character':
        case 'add_lore':
        case 'propose_scene':
            return null;
        default:
            return `unknown action: ${v.action}`;
    }
}
