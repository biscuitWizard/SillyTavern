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
 *  | { op: 'set_stat', key: string, value: number | string }
 *  | { op: 'adjust_stat', key: string, delta: number }
 *  | { op: 'clear_stat', key: string }
 *  | { op: 'set_status', key: string, value: string }
 *  | { op: 'clear_status', key: string }
 *  | { op: 'add_item', name: string, description?: string, influences?: string[] }
 *  | { op: 'update_item', item_id: string, name?: string, description?: string, influences?: string[] }
 *  | { op: 'remove_item', item_id: string }
 * )} SheetMutationOp
 *
 * @typedef {(
 *  | { action: 'speak', actor: 'narrator' | string, intent: string, rationale: string }
 *  | { action: 'skill_check', actor: string, intent: string, rationale: string }
 *  | { action: 'search_library', query: string, rationale: string }
 *  | { action: 'spawn_character', from_source: 'library' | 'new', ref?: string, name?: string, brief?: string, on_join_message?: string, rationale: string }
 *  | { action: 'remove_character', character_id: string, on_leave_message?: string, rationale: string }
 *  | { action: 'add_lore', title: string, body: string, tags: string[], rationale: string }
 *  | { action: 'mutate_sheet', character_id: string, ops: SheetMutationOp[], rationale: string }
 *  | { action: 'mutate_identity', character_id: string, field: 'appearance'|'personality'|'voice'|'background', value: string, rationale: string }
 *  | { action: 'propose_scene', name: string, setting: string, suggested_participants: string[], hooks: string[], rationale: string }
 *  | { action: 'end_turn', rationale: string }
 * )} DirectorDecision
 *
 * After a `skill_check` resolves, the Director's NEXT decision MUST be a
 * `speak` (narrator or in-scene NPC) to deliver the consequence. The loop
 * enforces this via `pendingPostRollSpeak` — picking `end_turn` or another
 * `skill_check` before the consequence is voiced emits a `tool_error`.
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
    'mutate_sheet',
    'mutate_identity',
    'end_turn',
]);

/** The identity field names the Director may rewrite via `mutate_identity`. */
export const IDENTITY_FIELDS = new Set(['appearance', 'personality', 'voice', 'background']);

/**
 * The set of `mutate_sheet.ops[].op` discriminator values the dispatcher
 * understands. New ops require both a schema variant below AND an entry
 * in the dispatch table in `director/loop.js`.
 */
export const SUPPORTED_SHEET_MUTATION_OPS = new Set([
    'set_stat',
    'adjust_stat',
    'clear_stat',
    'set_status',
    'clear_status',
    'add_item',
    'update_item',
    'remove_item',
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
                    maxLength: 240,
                    description: 'DIRECTIVE, NOT PROSE. ~20 words max. Tell the actor WHAT beat to deliver and at what emotional pitch. Never include quoted dialogue, never write the actor\'s lines for them. GOOD: "welcome the newcomer warmly, then steer them toward the dais". BAD: "Ephythithys smiles and says \'Come, child...\'".',
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
                intent: { type: 'string', maxLength: 240, description: 'Short description of what the actor is trying to do. ~20 words max. No prose, no dialogue.' },
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
            title: 'MutateSheet',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'mutate_sheet' },
                character_id: {
                    type: 'string',
                    description: 'Character whose sheet is being mutated. MUST be the player character or an NPC currently in the scene roster.',
                },
                ops: {
                    type: 'array',
                    minItems: 1,
                    description: 'Ordered list of one or more sheet mutations to apply atomically (per-op; the dispatch is sequential, not transactional). Each item is a discriminated union by `op`.',
                    items: {
                        type: 'object',
                        oneOf: [
                            {
                                title: 'SetStat',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'set_stat' },
                                    key: { type: 'string', description: 'Stat key (e.g. "hp", "ac", "armor"). Free-form; the layout decides which keys are surfaced in the UI.' },
                                    value: {
                                        oneOf: [{ type: 'number' }, { type: 'string' }],
                                        description: 'Scalar value. Use a number for numeric stats; strings are accepted for free-form text stats.',
                                    },
                                },
                                required: ['op', 'key', 'value'],
                                additionalProperties: false,
                            },
                            {
                                title: 'AdjustStat',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'adjust_stat' },
                                    key: { type: 'string' },
                                    delta: { type: 'number', description: 'Signed integer or float to add to the current numeric value. Missing keys are treated as 0.' },
                                },
                                required: ['op', 'key', 'delta'],
                                additionalProperties: false,
                            },
                            {
                                title: 'ClearStat',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'clear_stat' },
                                    key: { type: 'string' },
                                },
                                required: ['op', 'key'],
                                additionalProperties: false,
                            },
                            {
                                title: 'SetStatus',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'set_status' },
                                    key: { type: 'string', description: 'Status / condition key (e.g. "poisoned", "blessed", "on_fire").' },
                                    value: { type: 'string', description: 'Severity / qualifier (e.g. "minor", "stage_2", "1_round").' },
                                },
                                required: ['op', 'key', 'value'],
                                additionalProperties: false,
                            },
                            {
                                title: 'ClearStatus',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'clear_status' },
                                    key: { type: 'string' },
                                },
                                required: ['op', 'key'],
                                additionalProperties: false,
                            },
                            {
                                title: 'AddItem',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'add_item' },
                                    name: { type: 'string', description: 'Short display name (e.g. "Iron Sword").' },
                                    description: { type: 'string' },
                                    influences: { type: 'array', items: { type: 'string' }, description: 'Stat keys this item informs.' },
                                },
                                required: ['op', 'name'],
                                additionalProperties: false,
                            },
                            {
                                title: 'UpdateItem',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'update_item' },
                                    item_id: { type: 'string' },
                                    name: { type: 'string' },
                                    description: { type: 'string' },
                                    influences: { type: 'array', items: { type: 'string' } },
                                },
                                required: ['op', 'item_id'],
                                additionalProperties: false,
                            },
                            {
                                title: 'RemoveItem',
                                type: 'object',
                                properties: {
                                    op: { type: 'string', const: 'remove_item' },
                                    item_id: { type: 'string' },
                                },
                                required: ['op', 'item_id'],
                                additionalProperties: false,
                            },
                        ],
                    },
                },
                rationale: { type: 'string' },
            },
            required: ['action', 'character_id', 'ops', 'rationale'],
            additionalProperties: false,
        },
        {
            title: 'MutateIdentity',
            type: 'object',
            properties: {
                action: { type: 'string', const: 'mutate_identity' },
                character_id: {
                    type: 'string',
                    description: 'Character whose identity field is being rewritten. MUST be currently in the scene roster.',
                },
                field: {
                    type: 'string',
                    enum: ['appearance', 'personality', 'voice', 'background'],
                    description: 'Which identity field to update. "appearance" — physical description; "personality" — core traits and disposition; "voice" — how they speak; "background" — backstory summary.',
                },
                value: {
                    type: 'string',
                    description: 'The full replacement text for the field. Write in second or third person, as the player will read this directly on the character sheet.',
                },
                rationale: { type: 'string' },
            },
            required: ['action', 'character_id', 'field', 'value', 'rationale'],
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
 * Check whether an `intent` string looks like prose rather than a short
 * stage direction. Returns a human-readable error string or null on pass.
 *
 * Flags:
 *   - length > 240
 *   - contains paragraph breaks
 *   - contains paired quotation marks with 6+ chars between them
 *     (i.e. embedded dialogue)
 *
 * @param {string} intent
 * @returns {string | null}
 */
export function validateIntentShape(intent) {
    if (typeof intent !== 'string') return null;
    if (intent.length > 240) {
        return `intent is ${intent.length} chars (max 240). Shorten it to a brief directive — tell the actor WHAT to convey, not HOW.`;
    }
    if (/\n\n/.test(intent)) {
        return 'intent contains paragraph breaks — it should be a single short directive, not prose.';
    }
    if (/"[^"]{6,}"/.test(intent) || /\u201c[^\u201d]{6,}\u201d/.test(intent)) {
        return 'intent contains quoted dialogue — write a directive like "greet warmly and reassure", not the character\'s actual lines.';
    }
    if (/'[^']{6,}'/.test(intent) && intent.length > 80) {
        return 'intent contains what looks like embedded speech — keep it to a short directive, not scripted dialogue.';
    }
    return null;
}

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
            return validateIntentShape(v.intent);
        case 'skill_check':
            if (typeof v.actor !== 'string' || !v.actor) return 'skill_check.actor required';
            if (typeof v.intent !== 'string') return 'skill_check.intent required';
            return validateIntentShape(v.intent);
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
        case 'mutate_sheet': {
            if (typeof v.character_id !== 'string' || !v.character_id.trim()) {
                return 'mutate_sheet.character_id required';
            }
            if (!Array.isArray(v.ops) || v.ops.length === 0) {
                return 'mutate_sheet.ops required (non-empty array)';
            }
            for (let i = 0; i < v.ops.length; i++) {
                const opErr = validateSheetMutationOp(v.ops[i], i);
                if (opErr) return opErr;
            }
            return null;
        }
        case 'remove_character':
        case 'add_lore':
        case 'propose_scene':
            return null;
        case 'mutate_identity': {
            if (typeof v.character_id !== 'string' || !v.character_id.trim()) {
                return 'mutate_identity.character_id required';
            }
            if (!IDENTITY_FIELDS.has(v.field)) {
                return `mutate_identity.field must be one of: ${[...IDENTITY_FIELDS].join(', ')}`;
            }
            if (typeof v.value !== 'string') {
                return 'mutate_identity.value must be a string';
            }
            return null;
        }
        default:
            return `unknown action: ${v.action}`;
    }
}

/**
 * Per-op runtime validation. Returns a string error or null.
 *
 * @param {unknown} value
 * @param {number} idx
 * @returns {string | null}
 */
export function validateSheetMutationOp(value, idx = 0) {
    if (!value || typeof value !== 'object') return `mutate_sheet.ops[${idx}] must be an object`;
    const o = /** @type {any} */ (value);
    if (typeof o.op !== 'string') return `mutate_sheet.ops[${idx}].op must be a string`;
    if (!SUPPORTED_SHEET_MUTATION_OPS.has(o.op)) return `mutate_sheet.ops[${idx}].op "${o.op}" is not supported`;
    switch (o.op) {
        case 'set_stat':
            if (typeof o.key !== 'string' || !o.key.trim()) return `mutate_sheet.ops[${idx}].key required`;
            if (typeof o.value !== 'number' && typeof o.value !== 'string') return `mutate_sheet.ops[${idx}].value must be number or string`;
            return null;
        case 'adjust_stat':
            if (typeof o.key !== 'string' || !o.key.trim()) return `mutate_sheet.ops[${idx}].key required`;
            if (typeof o.delta !== 'number' || !Number.isFinite(o.delta)) return `mutate_sheet.ops[${idx}].delta must be a finite number`;
            return null;
        case 'clear_stat':
        case 'clear_status':
            if (typeof o.key !== 'string' || !o.key.trim()) return `mutate_sheet.ops[${idx}].key required`;
            return null;
        case 'set_status':
            if (typeof o.key !== 'string' || !o.key.trim()) return `mutate_sheet.ops[${idx}].key required`;
            if (typeof o.value !== 'string') return `mutate_sheet.ops[${idx}].value must be a string`;
            return null;
        case 'add_item':
            if (typeof o.name !== 'string' || !o.name.trim()) return `mutate_sheet.ops[${idx}].name required`;
            if (o.description !== undefined && typeof o.description !== 'string') return `mutate_sheet.ops[${idx}].description must be a string`;
            if (o.influences !== undefined && (!Array.isArray(o.influences) || o.influences.some(s => typeof s !== 'string'))) {
                return `mutate_sheet.ops[${idx}].influences must be a string[]`;
            }
            return null;
        case 'update_item':
            if (typeof o.item_id !== 'string' || !o.item_id.trim()) return `mutate_sheet.ops[${idx}].item_id required`;
            if (o.name !== undefined && typeof o.name !== 'string') return `mutate_sheet.ops[${idx}].name must be a string`;
            if (o.description !== undefined && typeof o.description !== 'string') return `mutate_sheet.ops[${idx}].description must be a string`;
            if (o.influences !== undefined && (!Array.isArray(o.influences) || o.influences.some(s => typeof s !== 'string'))) {
                return `mutate_sheet.ops[${idx}].influences must be a string[]`;
            }
            return null;
        case 'remove_item':
            if (typeof o.item_id !== 'string' || !o.item_id.trim()) return `mutate_sheet.ops[${idx}].item_id required`;
            return null;
        default:
            return `mutate_sheet.ops[${idx}].op "${o.op}" is not supported`;
    }
}
