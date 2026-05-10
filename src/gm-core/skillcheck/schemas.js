/**
 * Skill-check JSON schemas + lightweight runtime validators.
 *
 * The Director picks `skill_check`; the loop dispatches to engine.decide(),
 * which calls the LLM with a STRICTLY-shaped JSON schema (compatible with
 * OpenAI's `response_format: json_schema` and Anthropic's tool-use input
 * schemas via the existing `LlmClient.structured` adapter).
 *
 * `buildSkillCheckDecisionSchema(ruleset)` produces a per-ruleset schema
 * (skill / ability / severity enums baked in from the loaded ruleset). A
 * generic schema with only structural constraints is exported as
 * `skillCheckDecisionJsonSchema` for callers that need a stable type id.
 *
 * `validateSkillCheckDecision(value, ruleset)` is a defensive last-line
 * runtime check that is independent of the LLM client's schema enforcement
 * (because the text-mode JSON fallback does not actually validate).
 */

/**
 * Generic schema, no enums baked in. Useful for tests that don't want to
 * load YAML; the engine itself always uses the per-ruleset variant.
 */
export const skillCheckDecisionJsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'SkillCheckDecision',
    description: 'Adjudicator decision: do we need a roll, and if so, what?',
    type: 'object',
    properties: {
        required: { type: 'boolean' },
        skill_id: { type: ['string', 'null'] },
        ability_id: { type: ['string', 'null'] },
        dc: { type: ['integer', 'null'], minimum: 1, maximum: 40 },
        failure_severity: { type: ['string', 'null'] },
        justification: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['required', 'skill_id', 'ability_id', 'dc', 'failure_severity', 'justification'],
    additionalProperties: false,
};

/**
 * Per-ruleset variant: the LLM is constrained to skill / ability / severity
 * ids that actually exist in the active ruleset. This is what the engine
 * sends through `client.structured`.
 *
 * @param {import('../rulesets/schemas.d.ts').Ruleset} ruleset
 */
export function buildSkillCheckDecisionSchema(ruleset) {
    const skillIds = (ruleset.skills || []).map((s) => s.id);
    const abilityIds = (ruleset.abilities || []).map((a) => a.id);
    const severityIds = (ruleset.severities || []).map((s) => s.id);
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'SkillCheckDecision',
        description: `Adjudicator decision for ruleset "${ruleset.id}".`,
        type: 'object',
        properties: {
            required: {
                type: 'boolean',
                description: 'True if the rules call for a check; false if no roll is needed.',
            },
            skill_id: {
                type: ['string', 'null'],
                enum: skillIds.length > 0 ? [...skillIds, null] : null,
                description: 'Skill id from the ruleset. Required when required=true; null otherwise.',
            },
            ability_id: {
                type: ['string', 'null'],
                enum: abilityIds.length > 0 ? [...abilityIds, null] : null,
                description: 'Ability id from the ruleset. The engine overrides this if it disagrees with the ruleset skill->ability mapping.',
            },
            dc: {
                type: ['integer', 'null'],
                minimum: 1,
                maximum: 40,
                description: `DC for the check (clamped into [${ruleset.dc_min}, ${ruleset.dc_max}]). Required when required=true; null otherwise.`,
            },
            failure_severity: {
                type: ['string', 'null'],
                enum: severityIds.length > 0 ? [...severityIds, null] : null,
                description: 'What is at stake on failure. Required when required=true; null otherwise.',
            },
            justification: {
                type: 'string',
                minLength: 1,
                maxLength: 500,
                description: 'One short sentence explaining the call. Shown on the roll card.',
            },
        },
        required: ['required', 'skill_id', 'ability_id', 'dc', 'failure_severity', 'justification'],
        additionalProperties: false,
    };
}

/**
 * Runtime validator. Returns an error string or null on success. Lenient on
 * the no-check shape (`required=false`), strict on the rolled shape.
 *
 * @param {unknown} value
 * @param {import('../rulesets/schemas.d.ts').Ruleset} ruleset
 * @returns {string | null}
 */
export function validateSkillCheckDecision(value, ruleset) {
    if (!value || typeof value !== 'object') return 'decision must be an object';
    const v = /** @type {any} */ (value);
    if (typeof v.required !== 'boolean') return 'decision.required must be a boolean';
    if (typeof v.justification !== 'string' || v.justification.trim().length === 0) {
        return 'decision.justification must be a non-empty string';
    }
    if (!v.required) {
        return null;
    }
    if (typeof v.skill_id !== 'string' || v.skill_id.length === 0) {
        return 'decision.skill_id required when required=true';
    }
    if (!Number.isFinite(v.dc)) {
        return 'decision.dc required when required=true';
    }
    const skill = (ruleset.skills || []).find((s) => s.id === v.skill_id);
    if (!skill) {
        return `decision.skill_id "${v.skill_id}" is not in ruleset "${ruleset.id}"`;
    }
    if (v.failure_severity !== null && v.failure_severity !== undefined) {
        if (typeof v.failure_severity !== 'string') {
            return 'decision.failure_severity must be a string or null';
        }
        const sev = (ruleset.severities || []).find((s) => s.id === v.failure_severity);
        if (!sev) {
            return `decision.failure_severity "${v.failure_severity}" is not in ruleset "${ruleset.id}"`;
        }
    }
    return null;
}
