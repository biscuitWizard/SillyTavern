/**
 * Skill-check engine.
 *
 * Three exports:
 *   - decide(...)          one structured LLM call, returns SkillCheckDecision
 *   - roll(...)            pure d20 + ability mod + (proficient ? prof) function
 *   - renderRollCard(...)  builds the chat-side payload from outcome + decision
 *
 * Strict-play notes (Phase 9 will lock these via the eval harness):
 *   - The engine clamps DCs into the ruleset's clamp band; it does NOT lower
 *     them otherwise. Adjudicator DCs may go through.
 *   - If the adjudicator picks a skill that doesn't exist in the ruleset, we
 *     throw — we do not silently substitute a similar skill.
 *   - If the adjudicator picks an ability that disagrees with the ruleset's
 *     skill->ability mapping, we override with the ruleset's ability (the
 *     ruleset is the source of truth) and log a warning.
 */

import { LlmError } from '../llm/errors.js';
import { clampDc } from '../rulesets/loader.js';
import {
    buildSkillCheckDecisionSchema,
    validateSkillCheckDecision,
} from './schemas.js';
import { decideSystemPrompt, decideUserPrompt } from './prompts.js';

/**
 * @typedef {import('../rulesets/schemas.d.ts').Ruleset} Ruleset
 * @typedef {import('./schemas.d.ts').SkillCheckDecision} SkillCheckDecision
 * @typedef {import('./schemas.d.ts').RollOutcome} RollOutcome
 * @typedef {import('./schemas.d.ts').RollCard} RollCard
 * @typedef {import('../library/schemas.js').Character} Character
 */

/**
 * Call the adjudicator LLM. Returns a normalized decision: skill is verified
 * to exist, ability is overridden to match the ruleset's skill->ability map,
 * DC is clamped into the ruleset's range.
 *
 * @param {{
 *   ruleset: Ruleset,
 *   intent: string,
 *   actorName: string,
 *   client: import('../llm/client.d.ts').LlmClient,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<SkillCheckDecision>}
 */
export async function decide({ ruleset, intent, actorName, client, signal }) {
    const schema = buildSkillCheckDecisionSchema(ruleset);
    const system = decideSystemPrompt(ruleset);
    const user = decideUserPrompt(intent, actorName);

    let raw;
    try {
        raw = await client.structured({
            system,
            user,
            schema,
            schemaName: 'SkillCheckDecision',
            signal,
        });
    } catch (err) {
        if (err instanceof LlmError) throw err;
        throw new LlmError('adjudicator_failed', `adjudicator: ${err?.message || err}`, false);
    }

    const decision = normalizeDecision(raw, ruleset);
    const validationError = validateSkillCheckDecision(decision, ruleset);
    if (validationError) {
        throw new LlmError('invalid_decision', `adjudicator: ${validationError}`, false);
    }
    return decision;
}

/**
 * Coerce the LLM payload into a normalized SkillCheckDecision: trims fields,
 * applies the skill->ability override, clamps DC, and forces the no-roll
 * shape's optional fields to null. Pure (no LLM).
 *
 * @param {any} raw
 * @param {Ruleset} ruleset
 * @returns {SkillCheckDecision}
 */
export function normalizeDecision(raw, ruleset) {
    const required = !!raw?.required;
    const justification = String(raw?.justification || '').trim();
    if (!required) {
        return {
            required: false,
            skill_id: null,
            ability_id: null,
            dc: null,
            failure_severity: null,
            justification: justification || 'No check required.',
        };
    }
    const skillId = typeof raw?.skill_id === 'string' ? raw.skill_id : '';
    const skill = (ruleset.skills || []).find((s) => s.id === skillId);
    const expectedAbility = skill?.ability_id || null;
    const llmAbility = typeof raw?.ability_id === 'string' && raw.ability_id ? raw.ability_id : null;
    const ability = expectedAbility || llmAbility;
    if (expectedAbility && llmAbility && llmAbility !== expectedAbility) {
        console.warn('[gm] skill_check ability override', {
            skill_id: skillId,
            llm_ability: llmAbility,
            ruleset_ability: expectedAbility,
        });
    }
    const dcNumber = Number(raw?.dc);
    const dc = Number.isFinite(dcNumber) ? clampDc(ruleset, dcNumber) : null;
    const severityId = typeof raw?.failure_severity === 'string' && raw.failure_severity
        ? raw.failure_severity
        : null;
    return {
        required: true,
        skill_id: skillId || null,
        ability_id: ability,
        dc,
        failure_severity: severityId,
        justification: justification || 'Adjudicator did not provide a justification.',
    };
}

/**
 * Pure d20 roll. `decision` must be `required: true`. Pass an explicit `rng`
 * (a function returning [0, 1)) for deterministic tests.
 *
 * @param {{
 *   ruleset: Ruleset,
 *   character: Character,
 *   decision: SkillCheckDecision,
 *   rng?: () => number,
 * }} args
 * @returns {RollOutcome}
 */
export function roll({ ruleset, character, decision, rng }) {
    if (!decision || !decision.required) {
        throw new Error('roll() called on a no-check decision');
    }
    if (!decision.skill_id || decision.dc == null || !decision.ability_id) {
        throw new Error('roll() requires a fully-specified decision (skill_id, dc, ability_id)');
    }
    const skill = (ruleset.skills || []).find((s) => s.id === decision.skill_id);
    if (!skill) {
        throw new Error(`roll(): unknown skill "${decision.skill_id}" in ruleset "${ruleset.id}"`);
    }
    const ability = (ruleset.abilities || []).find((a) => a.id === decision.ability_id);
    const statKey = ability?.stat_key || decision.ability_id;
    const stats = character?.sheet?.stats || {};
    const score = Number(stats[statKey]);
    const abilityScore = Number.isFinite(score) ? score : 10;
    const abilityMod = Math.floor((abilityScore - 10) / 2);
    const skillsList = Array.isArray(character?.sheet?.skills) ? character.sheet.skills : [];
    const proficient = skillsList.includes(decision.skill_id);
    const profBonus = proficient ? Number(stats.proficiency_bonus ?? 2) || 0 : 0;

    const random = typeof rng === 'function' ? rng : Math.random;
    const u = Math.max(0, Math.min(0.9999999999, random()));
    const d20 = Math.floor(u * 20) + 1;

    const total = d20 + abilityMod + profBonus;
    const success = total >= decision.dc;
    const margin = total - decision.dc;
    /** @type {RollOutcome['crit']} */
    let crit = null;
    if (d20 === 20) crit = 'natural_20';
    else if (d20 === 1) crit = 'natural_1';

    return {
        d20,
        ability_modifier: abilityMod,
        proficiency_bonus: profBonus,
        proficient,
        total,
        success,
        margin,
        crit,
    };
}

/**
 * Build the chat-side `RollCard` payload from a decision + outcome + actor.
 * Pure.
 *
 * @param {{
 *   ruleset: Ruleset,
 *   character: Character,
 *   decision: SkillCheckDecision,
 *   outcome: RollOutcome,
 *   intent: string,
 * }} args
 * @returns {RollCard}
 */
export function renderRollCard({ ruleset, character, decision, outcome, intent }) {
    const skill = (ruleset.skills || []).find((s) => s.id === decision.skill_id);
    const ability = (ruleset.abilities || []).find((a) => a.id === decision.ability_id);
    const skillName = skill?.name || decision.skill_id || '';
    const abilityName = ability?.name || decision.ability_id || '';
    const abilityIdUpper = (ability?.id || decision.ability_id || '').toUpperCase();

    const parts = [`d20(${outcome.d20})`];
    parts.push(`${signed(outcome.ability_modifier)} (${abilityIdUpper})`);
    if (outcome.proficient) {
        parts.push(`${signed(outcome.proficiency_bonus)} (prof)`);
    }
    const expression = `${parts.join(' ')} = ${outcome.total} vs DC ${decision.dc}`;

    return {
        actor_id: character.id,
        actor_name: character.name,
        skill_id: decision.skill_id || '',
        skill_name: skillName,
        ability_id: decision.ability_id || '',
        ability_name: abilityName,
        dc: Number(decision.dc),
        breakdown: {
            d20: outcome.d20,
            ability_modifier: outcome.ability_modifier,
            proficiency_bonus: outcome.proficiency_bonus,
            total: outcome.total,
        },
        expression,
        outcome: outcome.success ? 'success' : 'failure',
        severity: decision.failure_severity || null,
        crit: outcome.crit,
        justification: decision.justification || '',
        intent: String(intent || ''),
    };
}

/** @param {number} n */
function signed(n) {
    if (!Number.isFinite(n)) return '+0';
    return n >= 0 ? `+${n}` : `${n}`;
}
