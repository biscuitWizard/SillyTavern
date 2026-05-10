/**
 * Phase 6: end-to-end Director loop integration for `skill_check`.
 *
 * Mirrors the shape of director-dispatch.test.js: scripted Director picks
 * `skill_check`, scripted adjudicator returns a `SkillCheckDecision`, and
 * the actorClient (used as the post-roll narrator) returns canned prose.
 * We assert exactly one combined `roll` event is emitted with the expected
 * card + narration, and that the loop ends after the Director picks
 * `end_turn`.
 *
 * `required: false` adjudications must NOT emit a `roll` event nor force
 * the narrator; the loop simply continues.
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
        st_card_avatar: null,
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

/**
 * @param {any[]} decisions  scripted DirectorDecision payloads in order
 * @param {any}   adjudicatorReply  the SkillCheckDecision the adjudicator returns
 *
 * Both come back from `structured(...)`. Phase 6 reuses `directorClient` as
 * the adjudicator, so the queue holds a Director decision *then* an
 * adjudicator decision *then* the next Director decision (`end_turn`), and
 * so on.
 */
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

describe('director dispatch: skill_check', () => {
    test('successful roll emits one combined roll event with card + narration', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            // (1) Director picks skill_check
            { action: 'skill_check', actor: 'jack', intent: 'jump the ledge', rationale: 'risky leap' },
            // (2) Adjudicator (same client) returns the decision
            {
                required: true,
                skill_id: 'athletics',
                ability_id: 'str',
                dc: 12,
                failure_severity: 'severe',
                justification: 'long horizontal jump with broken footing',
            },
            // (3) Director closes the turn
            { action: 'end_turn', rationale: 'ledge resolved' },
        ]);
        const actor = makeActor(() => 'Jack lands on the far side, breath ragged.');

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            ruleset,
            // Force a deterministic d20=15 (u*20 = 14.x → +1 = 15).
            rng: () => 0.74,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia })[id] || null,
        });

        const rolls = events.filter(e => e.kind === 'roll');
        expect(rolls).toHaveLength(1);
        const ev = rolls[0];
        expect(ev.actor_id).toBe('jack');
        expect(ev.actor_name).toBe('Jack');
        expect(ev.narration).toBe('Jack lands on the far side, breath ragged.');
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
        // STR 14 -> +2; proficient in athletics -> +2. Total = 19.
        expect(ev.card.breakdown.total).toBe(19);
        expect(ev.card.expression).toBe('d20(15) +2 (STR) +2 (prof) = 19 vs DC 12');
        expect(actor.chat).toHaveBeenCalledTimes(1);

        // The post-roll narrator is called with both the system-prompt
        // boilerplate and a user prompt that mentions the result.
        const userPrompt = actor.chat.mock.calls[0][0].user;
        expect(userPrompt).toMatch(/Athletics.*vs DC 12/);
        expect(userPrompt).toMatch(/SUCCESS/);

        // A status pill of phase=rolling fires before the adjudicator call.
        const statuses = events.filter(e => e.kind === 'status').map(s => s.phase);
        expect(statuses).toContain('rolling');

        // Loop ends because the Director picked end_turn.
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('required=false does not emit a roll event nor force the narrator', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'jack', intent: 'open an unlocked door', rationale: 'no risk' },
            // Adjudicator declines.
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
        // Narrator (actorClient.chat) was NOT called for the no-roll case.
        expect(actor.chat).not.toHaveBeenCalled();
        // A status note about the no-check decision exists.
        const noCheckStatus = events.find(e => e.kind === 'status' && (e.message || '').startsWith('No check needed'));
        expect(noCheckStatus).toBeDefined();
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('skill_check on an actor not in the scene rejects with unknown_actor', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'skill_check', actor: 'bran', intent: 'sneak', rationale: 'oops' },
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
        const errors = events.filter(e => e.kind === 'error');
        expect(errors[0].code).toBe('unknown_actor');
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'error' }));
    });

    /**
     * Phase 6+: Director picks `voice: <npc_id>` for a social check so the
     * target NPC reacts in their own first-person voice via the actor model
     * (e.g. Persuasion against Amelia → Amelia speaks). The post-roll prose
     * MUST come from the actor prompt (which mentions "react now" / "in your
     * own voice"), the roll event MUST credit the speaker, and the actor
     * prompt MUST NOT receive any DC numbers (those are out-of-fiction).
     */
    test('voice: <npc_id> routes post-roll prose through the actor model and credits the NPC', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            // Director picks skill_check with `voice = amelia` so Amelia
            // reacts in her own voice to Jack's persuasion attempt.
            {
                action: 'skill_check',
                actor: 'jack',
                intent: 'convince Amelia to share what she knows',
                voice: 'amelia',
                rationale: 'social check, target should react',
            },
            // Adjudicator: persuasion vs DC 12, success.
            {
                required: true,
                skill_id: 'persuasion',
                ability_id: 'cha',
                dc: 12,
                failure_severity: 'minor',
                justification: 'low-stakes social ask',
            },
            { action: 'end_turn', rationale: 'amelia answered' },
        ]);
        const actor = makeActor(({ system, user }) => {
            // Sanity-check: actor system prompt is *Amelia\'s*, not Jack\'s.
            expect(system).toMatch(/You are Amelia/);
            // Actor user prompt frames it as "react in character", not as
            // a narrator paragraph.
            expect(user).toMatch(/react/i);
            // No mechanics leak into the actor prompt.
            expect(user).not.toMatch(/DC \d+/);
            expect(user).not.toMatch(/d20=/);
            return '"Fine," Amelia mutters. "But you didn\'t hear it from me."';
        });

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
        expect(ev.actor_id).toBe('jack');               // who rolled
        expect(ev.narration_speaker_id).toBe('amelia'); // who voiced the prose
        expect(ev.narration_speaker_name).toBe('Amelia');
        expect(ev.narration_speaker_role).toBe('actor');
        expect(ev.narration).toMatch(/Fine/);
        expect(actor.chat).toHaveBeenCalledTimes(1);
    });

    test('voice: "narrator" (default) keeps the existing narrator path', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            // No `voice` field → default to narrator (environmental check).
            { action: 'skill_check', actor: 'jack', intent: 'climb the wall', rationale: 'environmental' },
            {
                required: true,
                skill_id: 'athletics',
                ability_id: 'str',
                dc: 12,
                failure_severity: 'severe',
                justification: 'wet stone',
            },
            { action: 'end_turn', rationale: 'wall climbed' },
        ]);
        const actor = makeActor(({ system, user }) => {
            expect(system).toMatch(/Narrator/i);
            // Narrator post-roll prompt does include the mechanics scaffold.
            expect(user).toMatch(/DC 12/);
            expect(user).toMatch(/SUCCESS|FAILURE/);
            return 'Jack scrabbles up the slick wall and hauls himself over the lip.';
        });

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
        expect(ev.narration_speaker_role).toBe('narrator');
        expect(ev.narration_speaker_id).toBeNull();
        expect(ev.narration_speaker_name).toBe('Narrator');
    });

    test('voice = self silently falls back to narrator (cannot react to your own attempt)', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            // Bogus: actor and voice both = jack. Should degrade to narrator.
            {
                action: 'skill_check',
                actor: 'jack',
                intent: 'jump the ledge',
                voice: 'jack',
                rationale: 'wrong choice',
            },
            {
                required: true,
                skill_id: 'athletics',
                ability_id: 'str',
                dc: 12,
                failure_severity: 'severe',
                justification: 'risky leap',
            },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(({ system }) => {
            // System prompt MUST be the narrator's, not Jack's.
            expect(system).not.toMatch(/You are Jack/);
            return 'Jack lands on the far side, breath ragged.';
        });

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
        expect(rolls[0].narration_speaker_role).toBe('narrator');
    });

    test('voice = unknown id silently falls back to narrator (no tool error)', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'skill_check',
                actor: 'jack',
                intent: 'persuade Bran',
                voice: 'bran',                 // not in scene
                rationale: 'hallucinated',
            },
            {
                required: true,
                skill_id: 'persuasion',
                ability_id: 'cha',
                dc: 12,
                failure_severity: 'minor',
                justification: 'social ask',
            },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'The room hums with tension.');

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

        const errors = events.filter(e => e.kind === 'error' || e.kind === 'tool_error');
        expect(errors).toHaveLength(0);
        const rolls = events.filter(e => e.kind === 'roll');
        expect(rolls).toHaveLength(1);
        expect(rolls[0].narration_speaker_role).toBe('narrator');
    });

    test('voice = player-character id silently falls back to narrator (player drives PC)', async () => {
        const ruleset = loadDnd5e();
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'skill_check',
                actor: 'amelia',
                intent: 'try to deceive Jack',
                voice: 'jack',                 // jack is the player character
                rationale: 'wrong choice',
            },
            {
                required: true,
                skill_id: 'deception',
                ability_id: 'cha',
                dc: 12,
                failure_severity: 'minor',
                justification: 'social',
            },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(({ system }) => {
            expect(system).not.toMatch(/You are Jack/);
            return 'A pause hangs in the air.';
        });

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
        expect(rolls[0].narration_speaker_role).toBe('narrator');
    });
});
