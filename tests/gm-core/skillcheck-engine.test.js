/**
 * Phase 6 skill-check engine.
 *
 * `decide` clamps DCs into the ruleset band and overrides the LLM's
 * `ability_id` when it disagrees with the ruleset's skill->ability mapping.
 * `roll` is pure — given a seeded RNG it always returns the same outcome —
 * and adds the proficiency bonus only when the actor is proficient in the
 * skill.
 *
 * The bundled D&D 5e ruleset is loaded from disk so the tests exercise the
 * real wire schema rather than a hand-crafted minimal ruleset.
 */

import { describe, test, expect } from '@jest/globals';

import { loadRuleset, _resetCacheForTests } from '../../src/gm-core/rulesets/loader.js';
import { decide, roll, renderRollCard, normalizeDecision } from '../../src/gm-core/skillcheck/engine.js';

function makeCharacter(over = {}) {
    return {
        id: over.id || 'jack',
        campaign_id: over.campaign_id || 'demo',
        name: over.name || 'Jack',
        is_player: over.is_player ?? true,
        appearance: '', personality: '', voice: '', background: '',
        sheet: {
            stats: over.stats || { strength: 14, dexterity: 10, constitution: 12, intelligence: 10, wisdom: 10, charisma: 10, proficiency_bonus: 2, hp: 10, max_hp: 10 },
            statuses: {},
            items: [],
            skills: over.skills || [],
            notes: '',
        },
        has_portrait: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    };
}

function fakeRulesetDirectories() {
    // The loader walks user-pack first, then falls through to the bundled
    // YAML in `data/rulesets/`. With no user pack root, it loads the
    // bundled ruleset.
    return null;
}

function loadDnd5e() {
    _resetCacheForTests();
    const ruleset = loadRuleset(fakeRulesetDirectories(), 'dnd5e');
    if (!ruleset) throw new Error('bundled dnd5e ruleset must load for tests');
    return ruleset;
}

/**
 * Mock LLM client: returns a single canned `structured` payload, throws on
 * `chat`.
 */
function mockClient(payload) {
    return {
        structured: async () => payload,
        chat: async () => { throw new Error('mockClient.chat not used'); },
    };
}

/** Mulberry32 — deterministic PRNG. */
function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('engine.decide normalization', () => {
    test('clamps DCs above the ruleset cap', async () => {
        const ruleset = loadDnd5e();
        const client = mockClient({
            required: true,
            skill_id: 'athletics',
            ability_id: 'str',
            dc: 99,
            failure_severity: 'severe',
            justification: 'really high cliff',
        });
        const decision = await decide({ ruleset, intent: 'jump the cliff', actorName: 'Jack', client });
        expect(decision.required).toBe(true);
        expect(decision.dc).toBe(30);
    });

    test('overrides the LLM ability_id when it disagrees with the ruleset mapping', async () => {
        const ruleset = loadDnd5e();
        const client = mockClient({
            required: true,
            skill_id: 'athletics',
            // Athletics is STR in 5e; LLM picked DEX by accident.
            ability_id: 'dex',
            dc: 12,
            failure_severity: 'minor',
            justification: 'misclassified ability',
        });
        const decision = await decide({ ruleset, intent: 'shove', actorName: 'Jack', client });
        expect(decision.ability_id).toBe('str');
    });

    test('required=false collapses optional fields to null', () => {
        const ruleset = loadDnd5e();
        const decision = normalizeDecision({
            required: false,
            skill_id: 'whatever',
            ability_id: 'cha',
            dc: 25,
            failure_severity: 'severe',
            justification: 'no roll needed',
        }, ruleset);
        expect(decision).toEqual({
            required: false,
            skill_id: null,
            ability_id: null,
            dc: null,
            failure_severity: null,
            justification: 'no roll needed',
        });
    });
});

describe('engine.roll', () => {
    test('deterministic given a seeded RNG', () => {
        const ruleset = loadDnd5e();
        const character = makeCharacter({ stats: { strength: 14, proficiency_bonus: 2 }, skills: ['athletics'] });
        const decision = {
            required: true,
            skill_id: 'athletics',
            ability_id: 'str',
            dc: 12,
            failure_severity: 'minor',
            justification: 'jump',
        };
        const rng = makeRng(42);
        const a = roll({ ruleset, character, decision, rng });
        const rng2 = makeRng(42);
        const b = roll({ ruleset, character, decision, rng: rng2 });
        expect(a).toEqual(b);
        expect(a.d20).toBeGreaterThanOrEqual(1);
        expect(a.d20).toBeLessThanOrEqual(20);
        expect(a.ability_modifier).toBe(2);
        expect(a.proficient).toBe(true);
        expect(a.proficiency_bonus).toBe(2);
        expect(a.total).toBe(a.d20 + 2 + 2);
    });

    test('proficiency bonus is omitted when the skill is not in the actor sheet', () => {
        const ruleset = loadDnd5e();
        const character = makeCharacter({ stats: { strength: 14, proficiency_bonus: 2 }, skills: [] });
        const decision = {
            required: true,
            skill_id: 'athletics',
            ability_id: 'str',
            dc: 10,
            failure_severity: 'minor',
            justification: 'untrained',
        };
        const outcome = roll({ ruleset, character, decision, rng: () => 0.5 });
        expect(outcome.proficient).toBe(false);
        expect(outcome.proficiency_bonus).toBe(0);
        expect(outcome.ability_modifier).toBe(2);
        expect(outcome.total).toBe(outcome.d20 + 2);
    });

    test('crit flags fire on natural 20 and natural 1', () => {
        const ruleset = loadDnd5e();
        const character = makeCharacter();
        const decision = {
            required: true,
            skill_id: 'athletics',
            ability_id: 'str',
            dc: 12,
            failure_severity: 'minor',
            justification: 'crit test',
        };
        // Mulberry-style RNG values that map to d20=1 and d20=20 respectively
        // via floor(u*20)+1.
        const crit20 = roll({ ruleset, character, decision, rng: () => 0.999 });
        expect(crit20.d20).toBe(20);
        expect(crit20.crit).toBe('natural_20');

        const crit1 = roll({ ruleset, character, decision, rng: () => 0.0 });
        expect(crit1.d20).toBe(1);
        expect(crit1.crit).toBe('natural_1');
    });
});

describe('renderRollCard', () => {
    test('builds an expression with d20 + ability mod (+ prof when proficient)', () => {
        const ruleset = loadDnd5e();
        const character = makeCharacter({ stats: { strength: 14, proficiency_bonus: 2 }, skills: ['athletics'] });
        const decision = {
            required: true,
            skill_id: 'athletics',
            ability_id: 'str',
            dc: 12,
            failure_severity: 'minor',
            justification: 'jump',
        };
        const outcome = { d20: 15, ability_modifier: 2, proficiency_bonus: 2, proficient: true, total: 19, success: true, margin: 7, crit: null };
        const card = renderRollCard({ ruleset, character, decision, outcome, intent: 'jump' });
        expect(card.outcome).toBe('success');
        expect(card.expression).toBe('d20(15) +2 (STR) +2 (prof) = 19 vs DC 12');
        expect(card.skill_name).toBe('Athletics');
        expect(card.ability_name).toBe('Strength');
        expect(card.severity).toBe('minor');
        expect(card.actor_id).toBe('jack');
    });

    test('omits the prof term when the actor is not proficient', () => {
        const ruleset = loadDnd5e();
        const character = makeCharacter({ stats: { strength: 14, proficiency_bonus: 2 }, skills: [] });
        const decision = {
            required: true,
            skill_id: 'athletics',
            ability_id: 'str',
            dc: 12,
            failure_severity: 'minor',
            justification: 'untrained jump',
        };
        const outcome = { d20: 8, ability_modifier: 2, proficiency_bonus: 0, proficient: false, total: 10, success: false, margin: -2, crit: null };
        const card = renderRollCard({ ruleset, character, decision, outcome, intent: 'jump' });
        expect(card.expression).toBe('d20(8) +2 (STR) = 10 vs DC 12');
        expect(card.outcome).toBe('failure');
    });
});
