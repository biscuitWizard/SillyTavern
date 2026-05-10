/**
 * Skill-check schema types (Phase 6).
 *
 * Three layers:
 *
 *   - SkillCheckDecision: structured-output return from engine.decide().
 *                         Adjudicator-side. Strictly validated against the
 *                         active ruleset.
 *   - RollOutcome:        result of engine.roll() (pure function).
 *   - RollCard:           chat-side payload the frontend renders into a
 *                         styled bubble.
 *
 * Wire shape: per the chosen UX (single combined card with narration inside),
 * the loop emits ONE `kind: 'roll'` event after the post-roll narrator
 * finishes. The event carries `card: RollCard` and `narration: string`.
 */

import type { SeverityLevel } from '../rulesets/schemas.d.ts';

export interface SkillCheckDecision {
    /** True if the rules call for a check; false if no roll needed. */
    required: boolean;
    /** Skill id from the ruleset; required when required=true. */
    skill_id: string | null;
    /**
     * Ability id the LLM picked. The engine overrides this with the
     * ruleset's skill-to-ability mapping if they disagree.
     */
    ability_id: string | null;
    /** DC for the check, drawn from the DC ladder; required when required=true. */
    dc: number | null;
    failure_severity: SeverityLevel | null;
    /** One short sentence explaining the call. Shown on the card. */
    justification: string;
}

export interface RollOutcome {
    d20: number;                  // 1..20
    ability_modifier: number;
    proficiency_bonus: number;    // 0 if not proficient
    proficient: boolean;
    total: number;
    success: boolean;
    margin: number;               // total - dc, signed
    crit: 'natural_20' | 'natural_1' | null;
}

export interface RollCard {
    actor_id: string;
    actor_name: string;
    skill_id: string;
    skill_name: string;
    ability_id: string;
    ability_name: string;
    dc: number;
    breakdown: {
        d20: number;
        ability_modifier: number;
        proficiency_bonus: number;
        total: number;
    };
    expression: string;           // e.g. "d20(15) +2 (STR) +2 (prof) = 19 vs DC 12"
    outcome: 'success' | 'failure';
    severity: SeverityLevel | null;
    crit: 'natural_20' | 'natural_1' | null;
    justification: string;
    intent: string;
}

export const skillCheckDecisionJsonSchema: object;
export function buildSkillCheckDecisionSchema(ruleset: import('../rulesets/schemas.d.ts').Ruleset): object;
export function validateSkillCheckDecision(value: unknown, ruleset: import('../rulesets/schemas.d.ts').Ruleset): string | null;
