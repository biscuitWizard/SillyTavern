/**
 * Ruleset shape (Phase 6).
 *
 * A loaded ruleset is the merge of three on-disk YAML files:
 *
 *   - skills.yaml        -- abilities + skills (with skill-to-ability mapping)
 *   - dc_guidance.yaml   -- DC bands and clamp range
 *   - consequences.yaml  -- failure-severity ladder
 *
 * Plus the per-ruleset starter pack (`starter_stats`, `starter_skills`) the
 * character wizard uses at create time. Phase 5's in-memory registry seeded
 * those; Phase 6 keeps the same surface so the wizard does not change.
 */

export type SeverityLevel = 'minor' | 'moderate' | 'severe' | 'lethal' | string;

export interface Ability {
    /** Short id used in LLM-facing schemas, e.g. "str". */
    id: string;
    /** Display name, e.g. "Strength". */
    name: string;
    /** Key under `character.sheet.stats` that holds this ability's score. */
    stat_key: string;
}

export interface Skill {
    id: string;
    name: string;
    /** The id of the Ability this skill is keyed to. Source of truth. */
    ability_id: string;
    description: string;
}

export interface DcBand {
    id: string;
    dc: number;
    label: string;
    description: string;
}

export interface Severity {
    id: SeverityLevel;
    label: string;
    description: string;
}

export interface Ruleset {
    id: string;
    name: string;
    abilities: Ability[];
    skills: Skill[];
    dc_bands: DcBand[];
    severities: Severity[];
    /** Lower clamp for DCs; defaults to the lowest band's dc. */
    dc_min: number;
    /** Upper clamp for DCs; defaults to the highest band's dc. */
    dc_max: number;
    /** Starter sheet seed used by the character wizard. */
    starter_stats: Record<string, number | string>;
    starter_skills: string[];
}

export interface RulesetIdSummary {
    id: string;
    name: string;
    source: 'user' | 'bundled' | 'fallback';
}
