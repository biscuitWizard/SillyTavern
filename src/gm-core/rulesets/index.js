/**
 * Ruleset registry (Phase 5 seam).
 *
 * Phase 5 introduces the surface — `getRuleset(id)` returning a small record
 * with a `starter_stats` KV bag and a `starter_skills` list — so the
 * character creation flow stops baking 5e-shaped keys into
 * `library/schemas.js`. Phase 6 swaps this in-memory registry for the YAML
 * loader described in `docs/phases/6-skill-checks.md`; the call sites do
 * not change.
 *
 * Stats are key-value-pair driven. Conventional keys (`strength`, `hp`,
 * `max_hp`, `proficiency_bonus`, …) are agreed by convention, not fixed by
 * schema. Adding or removing keys at runtime is a CRUD on the sheet, not
 * a schema migration.
 */

/**
 * @typedef {Object} Ruleset
 * @property {string} id
 * @property {string} name
 * @property {Record<string, number | string>} starter_stats
 * @property {string[]} starter_skills
 */

/** @type {Record<string, Ruleset>} */
export const RULESETS = {
    dnd5e: {
        id: 'dnd5e',
        name: 'D&D 5e (baseline)',
        starter_stats: {
            strength: 10,
            dexterity: 10,
            constitution: 10,
            intelligence: 10,
            wisdom: 10,
            charisma: 10,
            hp: 10,
            max_hp: 10,
            ac: 10,
            proficiency_bonus: 2,
            level: 1,
        },
        starter_skills: [],
    },
};

/** Default ruleset id when a campaign's `ruleset_id` is missing or unknown. */
export const DEFAULT_RULESET_ID = 'dnd5e';

/**
 * Look up a ruleset by id. Falls back to the default ruleset when the id is
 * unknown so the wizard always has something to seed from.
 *
 * @param {string | undefined | null} id
 * @returns {Ruleset}
 */
export function getRuleset(id) {
    if (id && Object.prototype.hasOwnProperty.call(RULESETS, id)) {
        return RULESETS[id];
    }
    return RULESETS[DEFAULT_RULESET_ID];
}

/**
 * List every registered ruleset id. Used by Phase 6's ruleset-picker UI; in
 * Phase 5 it is exposed for completeness.
 *
 * @returns {string[]}
 */
export function listRulesetIds() {
    return Object.keys(RULESETS);
}
