/**
 * Phase 6 (revised): Director loop integration for `skill_check`.
 *
 * The simplified flow:
 *   1. Director picks `skill_check` → adjudicator decides → dice roll.
 *   2. A card-only `roll` event is emitted (no embedded narration).
 *   3. The Director is forced to `speak` next to deliver the consequence.
 *   4. Only then can it `end_turn` or `skill_check` again.
 *
 * `required: false` adjudications still skip the roll entirely.
 */

import { describe, test, expect, jest } from '@jest/globals';

import { runTurn } from '../../src/gm-core/director/loop.js';
import { loadRuleset, _resetCacheForTests } from '../../src/gm-core/rulesets/loader.js';

function loadDnd5e() {
    _resetCacheForTests();
    return loadRuleset(null, 'dnd5e');
}

function makeChar(over) {
    return {
        id: over.id,
        campaign_id: 'demo',
        name: over.name,
        is_player: !!over.is_player,
        appearance: '', personality: '', voice: '', background: '',
        sheet: {
            stats: over.stats || { strength: 14, dexterity: 10, proficiency_bonus: 2 },
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

const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true, stats: { strength: 14, proficiency_bonus: 2 }, skills: ['athletics'] });
const amelia = makeChar({ id: 'amelia', name: 'Amelia' });

function baseCtx() {
    return {
        campaign: { id: 'demo', name: 'Demo', brief: 'Demo' },
        scene: { id: 'opener', name: 'Opener', location: 'Tavern', status: 'open' },
        actors: [
            { id: 'jack', name: 'Jack', is_player: true },
            { id: 'amelia', name: 'Amelia', is_player: false },
        ],
        recent_transcript: '',
        user_input: 'Jack jumps the ledge.',
    };
}

function makeDirector(callQueue) {
    const queue = [...callQueue];
    return {
        structured: jest.fn(async () => {
            if (queue.length === 0) throw new Error('director queue exhausted');
            return queue.shift();
        }),
        chat: jest.fn(async () => 'unused'),
    };
}

function makeActor(replyFn) {
    return {
        chat: jest.fn(async ({ system, user }) => replyFn({ system, user })),
        structured: jest.fn(async () => { throw new Error('actor.structured not used'); }),
    };
}

describe('director dispatch: skill_check (card-only flow)', () => {
    test('successful roll emits a card-only roll event (no narration)', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'jump the ledge', rationale: 'risky leap' },
            {
                required: true,
                skill_id: 'athletics',
                ability_id: 'str',
                dc: 12,
                failure_severity: 'severe',
                justification: 'long horizontal jump with broken footing',
            },
            // Post-roll: Director must speak before end_turn.
            { action: 'speak', actor: 'narrator', intent: 'describe the leap', rationale: 'consequence' },
            { action: 'end_turn', rationale: 'ledge resolved' },
        ]);
        const actor = makeActor(() => 'Jack lands on the far side, breath ragged.');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            rng: () => 0.74,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        const rolls = events.filter(e => e.kind === 'roll');
        expect(rolls).toHaveLength(1);
        const ev = rolls[0];
        expect(ev.actor_id).toBe('jack');
        expect(ev.actor_name).toBe('Jack');
        expect(ev.narration).toBeUndefined();
        expect(ev.narration_speaker_id).toBeUndefined();
        expect(ev.narration_speaker_name).toBeUndefined();
        expect(ev.card).toMatchObject({
            actor_id: 'jack',
            skill_id: 'athletics',
            skill_name: 'Athletics',
            ability_id: 'str',
            dc: 12,
            outcome: 'success',
            severity: 'severe',
        });
        expect(ev.card.breakdown.d20).toBe(15);
        expect(ev.card.breakdown.total).toBe(19);
        expect(ev.card.expression).toBe('d20(15) +2 (STR) +2 (prof) = 19 vs DC 12');

        // The actor LLM is called only for the Director's speak, not
        // inside dispatchSkillCheck.
        expect(actor.chat).toHaveBeenCalledTimes(1);

        const statuses = events.filter(e => e.kind === 'status').map(s => s.phase);
        expect(statuses).toContain('rolling');
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('required=false does not emit a roll event nor force a speak', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'open an unlocked door', rationale: 'no risk' },
            {
                required: false,
                skill_id: null,
                ability_id: null,
                dc: null,
                failure_severity: null,
                justification: 'door is unlocked, no consequence',
            },
            { action: 'end_turn', rationale: 'no roll needed' },
        ]);
        const actor = makeActor(() => 'should not be called');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        expect(events.filter(e => e.kind === 'roll')).toHaveLength(0);
        expect(actor.chat).not.toHaveBeenCalled();
        const noCheckStatus = events.find(e => e.kind === 'status' && (e.message || '').startsWith('No check needed'));
        expect(noCheckStatus).toBeDefined();
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('skill_check on an actor not in the scene emits a recoverable tool_error and the Director can recover', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'bran', intent: 'sneak', rationale: 'oops' },
            { action: 'end_turn', rationale: 'recovered after unknown_actor' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });
        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0]).toEqual(expect.objectContaining({
            tool: 'skill_check',
            code: 'unknown_actor',
        }));
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });
});

describe('director loop: post-roll speak constraint', () => {
    test('end_turn after roll emits tool_error; Director recovers by speaking', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'jump the ledge', rationale: 'risky' },
            {
                required: true,
                skill_id: 'athletics',
                ability_id: 'str',
                dc: 12,
                failure_severity: 'severe',
                justification: 'broken footing',
            },
            // Director tries end_turn immediately — should be rejected.
            { action: 'end_turn', rationale: 'done (wrong)' },
            // Director corrects to speak.
            { action: 'speak', actor: 'narrator', intent: 'describe the leap', rationale: 'consequence' },
            // Now end_turn is allowed.
            { action: 'end_turn', rationale: 'ledge resolved' },
        ]);
        const actor = makeActor(() => 'Jack lands safely.');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            rng: () => 0.74,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        const toolErrors = events.filter(e => e.kind === 'tool_error' && e.code === 'speak_required');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0].tool).toBe('skill_check');

        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('double skill_check after roll emits tool_error', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'jump the ledge', rationale: 'risky' },
            {
                required: true,
                skill_id: 'athletics',
                ability_id: 'str',
                dc: 12,
                failure_severity: 'severe',
                justification: 'broken footing',
            },
            // Director tries another skill_check — should be rejected.
            { action: 'skill_check', actor: 'jack', intent: 'balance on ledge', rationale: 'another roll' },
            // Director corrects to speak.
            { action: 'speak', actor: 'narrator', intent: 'describe the leap', rationale: 'consequence' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'Jack lands safely.');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            rng: () => 0.74,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        const speakRequired = events.filter(e => e.kind === 'tool_error' && e.code === 'speak_required');
        expect(speakRequired).toHaveLength(1);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('repeated end_turn after roll trips rate-limiter and ends turn as error', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        // Director stubbornly tries end_turn 5 times after a roll.
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'jump the ledge', rationale: 'risky' },
            {
                required: true,
                skill_id: 'athletics',
                ability_id: 'str',
                dc: 12,
                failure_severity: 'severe',
                justification: 'broken footing',
            },
            { action: 'end_turn', rationale: 'try 1' },
            { action: 'end_turn', rationale: 'try 2' },
            { action: 'end_turn', rationale: 'try 3' },
            { action: 'end_turn', rationale: 'try 4' },
            { action: 'end_turn', rationale: 'try 5' },
        ]);
        const actor = makeActor(() => 'never');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            rng: () => 0.74,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        const errors = events.filter(e => e.kind === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual(expect.objectContaining({ code: 'tool_error_loop' }));
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'error',
        }));
    });
});

describe('director loop: skill_check recoverable adjudicator errors', () => {
    test('adjudicator returns an out-of-ruleset skill_id → tool_error + Director recovers cleanly', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'recall what this rune means', rationale: 'lore lookup' },
            {
                required: true,
                skill_id: 'Religion',
                ability_id: 'int',
                dc: 12,
                failure_severity: 'minor',
                justification: 'recalling iconography',
            },
            { action: 'end_turn', rationale: 'recovered' },
        ]);
        const actor = makeActor(() => 'never');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        expect(events.filter(e => e.kind === 'roll')).toHaveLength(0);

        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0]).toEqual(expect.objectContaining({
            tool: 'skill_check',
            code: 'invalid_decision',
        }));
        expect(toolErrors[0].message).toMatch(/skill_id "Religion" is not in ruleset "dnd5e"/);
        expect(Array.isArray(toolErrors[0].suggestions)).toBe(true);
        expect(toolErrors[0].suggestions.join('\n')).toMatch(/Valid skill_id values for ruleset "dnd5e"/);

        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });

    test('the same recoverable tool_error repeated more than 3 times trips the rate-limiter', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'iconography', rationale: '1' },
            { required: true, skill_id: 'Religion', ability_id: 'int', dc: 12, failure_severity: 'minor', justification: '1' },
            { action: 'skill_check', actor: 'jack', intent: 'iconography', rationale: '2' },
            { required: true, skill_id: 'Religion', ability_id: 'int', dc: 12, failure_severity: 'minor', justification: '2' },
            { action: 'skill_check', actor: 'jack', intent: 'iconography', rationale: '3' },
            { required: true, skill_id: 'Religion', ability_id: 'int', dc: 12, failure_severity: 'minor', justification: '3' },
            { action: 'skill_check', actor: 'jack', intent: 'iconography', rationale: '4' },
            { required: true, skill_id: 'Religion', ability_id: 'int', dc: 12, failure_severity: 'minor', justification: '4' },
            { action: 'end_turn', rationale: 'should not reach' },
        ]);
        const actor = makeActor(() => 'never');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors.length).toBe(4);
        for (const ev of toolErrors) {
            expect(ev).toEqual(expect.objectContaining({ tool: 'skill_check', code: 'invalid_decision' }));
        }
        const errors = events.filter(e => e.kind === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual(expect.objectContaining({ code: 'tool_error_loop' }));
        expect(errors[0].message).toMatch(/skill_check:invalid_decision/);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'error',
        }));
    });

    test('skill_check with no ruleset is recoverable: tool_error + Director recovers via end_turn', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'jump the ledge', rationale: 'risky leap' },
            { action: 'end_turn', rationale: 'recovered after no_ruleset' },
        ]);
        const actor = makeActor(() => 'never');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0]).toEqual(expect.objectContaining({
            tool: 'skill_check',
            code: 'no_ruleset',
        }));
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });

    test('decideUserPrompt restates valid skill_id and failure_severity values when given a ruleset', async () => {
        const { decideUserPrompt } = await import('../../src/gm-core/skillcheck/prompts.js');
        const ruleset = loadDnd5e();
        const prompt = decideUserPrompt('jump the ledge', 'Jack', ruleset);
        expect(prompt).toMatch(/STRICT FORMAT/);
        expect(prompt).toMatch(/skill_id`\s*MUST/);
        expect(prompt).toMatch(/athletics/);
        expect(prompt).toMatch(/Religion/);
    });
});
