/**
 * Ruleset registry — Phase 6 swap-in.
 *
 * Phase 5 introduced a tiny in-memory registry that exposed `getRuleset(id)` →
 * `{ id, name, starter_stats, starter_skills }` so the wizard had a single
 * place to seed sheets from. Phase 6 keeps that surface but backs it with the
 * YAML loader: a campaign with `ruleset_id: "dnd5e"` resolves through the
 * filesystem (user pack → bundled), and the loaded record carries the full
 * abilities / skills / DC bands / severity ladder that the skill-check
 * engine needs.
 *
 * Two API styles coexist:
 *
 *   - getRuleset(id)                     -- legacy (no user dirs); returns
 *                                            the bundled ruleset or the
 *                                            in-memory fallback. Kept so the
 *                                            character wizard does not need a
 *                                            `directories` argument it never
 *                                            had.
 *   - getRulesetFor(directories, id)     -- preferred path: respects per-user
 *                                            packs at {handle}/rulesets/{id}/.
 *
 * `listRulesetIds()` returns the union of bundled + (when `directories` is
 * passed) user-pack ids, with user-pack ids shadowing bundled ones.
 */

import { loadRuleset, listRulesets } from './loader.js';

/**
 * @typedef {import('./schemas.d.ts').Ruleset} Ruleset
 */

/**
 * Last-resort fallback used only when neither the user pack nor the bundled
 * YAML can be loaded (e.g. running the unit tests against a fresh tmp dir
 * that has no `data/rulesets/`). Mirrors what Phase 5 shipped so callers
 * that ignore the new fields keep working.
 *
 * @type {Record<string, Ruleset>}
 */
const FALLBACK_RULESETS = {
    dnd5e: {
        id: 'dnd5e',
        name: 'D&D 5e (in-memory fallback)',
        abilities: [
            { id: 'str', name: 'Strength', stat_key: 'strength' },
            { id: 'dex', name: 'Dexterity', stat_key: 'dexterity' },
            { id: 'con', name: 'Constitution', stat_key: 'constitution' },
            { id: 'int', name: 'Intelligence', stat_key: 'intelligence' },
            { id: 'wis', name: 'Wisdom', stat_key: 'wisdom' },
            { id: 'cha', name: 'Charisma', stat_key: 'charisma' },
        ],
        skills: [],
        dc_bands: [],
        severities: [
            { id: 'minor', label: 'Minor setback', description: '' },
            { id: 'moderate', label: 'Moderate consequence', description: '' },
            { id: 'severe', label: 'Severe consequence', description: '' },
            { id: 'lethal', label: 'Lethal', description: '' },
        ],
        dc_min: 5,
        dc_max: 30,
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
 * Look up a ruleset by id, ignoring user packs. Used by the character wizard
 * + sheet panel which don't take a `directories` argument.
 *
 * @param {string | undefined | null} id
 * @returns {Ruleset}
 */
export function getRuleset(id) {
    const target = id || DEFAULT_RULESET_ID;
    const loaded = loadRuleset(null, target) || loadRuleset(null, DEFAULT_RULESET_ID);
    if (loaded) return loaded;
    return FALLBACK_RULESETS[target] || FALLBACK_RULESETS[DEFAULT_RULESET_ID];
}

/**
 * Look up a ruleset by id, honouring per-user packs. Preferred path for any
 * code that already has a `directories` handle (the GM core endpoints, the
 * Director loop's skill-check dispatch).
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 * @param {string | undefined | null} id
 * @returns {Ruleset}
 */
export function getRulesetFor(directories, id) {
    const target = id || DEFAULT_RULESET_ID;
    const loaded = loadRuleset(directories, target) || loadRuleset(directories, DEFAULT_RULESET_ID);
    if (loaded) return loaded;
    return FALLBACK_RULESETS[target] || FALLBACK_RULESETS[DEFAULT_RULESET_ID];
}

/**
 * @param {import('../../users.js').UserDirectoryList | null | undefined} [directories]
 * @returns {string[]}
 */
export function listRulesetIds(directories = null) {
    const ids = new Set();
    for (const summary of listRulesets(directories)) {
        ids.add(summary.id);
    }
    for (const id of Object.keys(FALLBACK_RULESETS)) {
        ids.add(id);
    }
    return Array.from(ids);
}

/**
 * Detailed list with the ruleset's display name and source. Phase 6 endpoint
 * surface uses this for `GET /api/gm/rulesets`.
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 */
export function listRulesetSummaries(directories) {
    return listRulesets(directories);
}
