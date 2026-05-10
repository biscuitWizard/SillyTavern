/**
 * Phase 5 Director dispatcher tests.
 *
 * The loop is exercised end-to-end with a hand-rolled `directorClient` that
 * returns a scripted sequence of decisions. We verify:
 *   - `speak: <character_id>` resolves the right character, calls the
 *     actor LLM, emits a `message` event tagged with the actor id, and
 *     refuses to speak for the player character.
 *   - `spawn_character: library, ref: <id>` calls the participant writer
 *     and emits a `state` event with `change: 'spawn'`.
 *   - `spawn_character: new` emits a structured `error` with
 *     `code: 'unsupported_source'` and ends the turn.
 *   - `remove_character` calls the participant writer and emits a `state`
 *     event with `change: 'remove'`.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { runTurn } from '../../src/gm-core/director/loop.js';

function makeChar(over) {
    return {
        id: over.id,
        campaign_id: 'demo',
        name: over.name,
        is_player: !!over.is_player,
        appearance: over.appearance || '',
        personality: over.personality || '',
        voice: over.voice || '',
        background: over.background || '',
        sheet: { stats: {}, statuses: {}, items: [], skills: [], notes: '' },
        st_card_avatar: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    };
}

const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true });
const amelia = makeChar({ id: 'amelia', name: 'Amelia' });
const bran = makeChar({ id: 'bran', name: 'Bran' });

function baseCtx() {
    return {
        campaign: { id: 'demo', name: 'Demo', brief: 'Demo' },
        scene: { id: 'opener', name: 'Opener', location: 'Tavern', status: 'open' },
        actors: [
            { id: 'jack', name: 'Jack', is_player: true },
            { id: 'amelia', name: 'Amelia', is_player: false },
        ],
        recent_transcript: '',
        user_input: 'I push the door.',
    };
}

function makeDirector(decisions) {
    const queue = [...decisions];
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
        structured: jest.fn(async () => { throw new Error('actor structured not used'); }),
    };
}

describe('director dispatch: speak', () => {
    test('speak: <character_id> emits a message event with role=actor and the actor id', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'speak', actor: 'amelia', intent: 'greet warily', rationale: 'NPC turn' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'Welcome, traveller.');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });
        const messages = events.filter(e => e.kind === 'message');
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('actor');
        expect(messages[0].actor).toBe('amelia');
        expect(messages[0].actor_id).toBe('amelia');
        expect(messages[0].name).toBe('Amelia');
        expect(messages[0].text).toBe('Welcome, traveller.');
        expect(events.some(e => e.kind === 'end_of_turn' && e.reason === 'director')).toBe(true);
    });

    test('speak: <pc_id> is rejected as a recoverable tool_error — Director cannot speak for the player', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'speak', actor: 'jack', intent: 'speak as the PC', rationale: 'oops' },
            { action: 'end_turn', rationale: 'recover' },
        ]);
        const actor = makeActor(() => 'should not be called');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0].code).toBe('cannot_speak_for_player');
        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        expect(actor.chat).not.toHaveBeenCalled();
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('speak: <unknown_id> not in scene emits a recoverable tool_error with suggestions and continues', async () => {
        const ctx = baseCtx();
        // Add an off-stage character so the suggestions can include a library hint.
        ctx.library_characters = [{ id: 'bran', name: 'Bran', appearance: 'a stout dwarf' }];
        const director = makeDirector([
            // First step: hallucinate "bartender" (not in scene, not in library).
            { action: 'speak', actor: 'bartender', intent: 'greet the player', rationale: 'oops' },
            // After the tool_error LAST BEAT, Director recovers by ending the turn.
            { action: 'end_turn', rationale: 'no recovery available' },
        ]);
        const actor = makeActor(() => 'should not be called');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });
        // Recoverable error: surfaced as `tool_error`, NOT `error`. Loop continued.
        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0].code).toBe('unknown_actor');
        expect(toolErrors[0].tool).toBe('speak');
        expect(toolErrors[0].suggestions.length).toBeGreaterThan(0);
        expect(actor.chat).not.toHaveBeenCalled();
        // Director was called twice — once for the bad speak, once for the recovery.
        expect(director.structured).toHaveBeenCalledTimes(2);
        // Loop ended cleanly via the recovery, not via a hard error.
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
        // ctx.last_beat should carry the tool error for the second director call.
        expect(ctx.last_beat).toContain('Tool error from `speak`');
        expect(ctx.last_beat).toContain('unknown_actor');
    });

    test('quota: a Director that picks speak: <same actor> twice gets force-ended after one beat', async () => {
        // Local LLMs (qwen2.5:14b et al) routinely chain speak on the same
        // actor even when the prompt says not to. The loop's per-actor
        // speak quota (MAX_SPEAKS_PER_ACTOR=1) is the hard backstop: a
        // second speak for the same actor in the same turn is converted
        // into an end_turn before the actor LLM is called.
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'speak', actor: 'amelia', intent: 'first reply', rationale: 'NPC turn' },
            // Director ignores LAST BEAT and tries to fire Amelia again:
            { action: 'speak', actor: 'amelia', intent: 'follow-up monologue', rationale: 'oops' },
            // Should never be reached — the loop ends the turn at the quota check.
            { action: 'end_turn', rationale: 'unreachable' },
        ]);
        const actor = makeActor(() => 'I look up from my drink.');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });
        // Exactly ONE actor message, NOT two.
        expect(events.filter(e => e.kind === 'message')).toHaveLength(1);
        expect(actor.chat).toHaveBeenCalledTimes(1);
        // The Director was called twice (initial + repeat); the repeat
        // triggered the quota and ended the turn.
        expect(director.structured).toHaveBeenCalledTimes(2);
        // A status event explains the quota close.
        const closing = events.find(e => e.kind === 'status' && e.phase === 'closing');
        expect(closing).toBeDefined();
        expect(closing.message).toMatch(/Speak quota for amelia/i);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'cap',
        }));
    });

    test('speak: <character_id> sets ctx.last_beat (no longer mutates user_input) so Director can decide to end_turn', async () => {
        // Regression test for the runaway-loop bug: previously the actor
        // branch never updated ctx.user_input, so the Director kept seeing
        // the same player input and kept dispatching speak: <actor>.
        const ctx = baseCtx();
        const originalInput = ctx.user_input;
        const director = makeDirector([
            { action: 'speak', actor: 'amelia', intent: 'react to the player', rationale: 'NPC turn' },
            { action: 'end_turn', rationale: 'amelia spoke' },
        ]);
        const actor = makeActor(() => 'I look up from my drink.');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });
        // ctx.user_input must be untouched — actors and narrator should always
        // see the original player input, not a synthetic loop marker.
        expect(ctx.user_input).toBe(originalInput);
        // ctx.last_beat must carry a "spoke" summary so the Director knows
        // not to fire the same actor again.
        expect(ctx.last_beat).toContain('Amelia');
        expect(ctx.last_beat).toContain('just spoke');
        // Exactly one message emitted (no runaway).
        expect(events.filter(e => e.kind === 'message')).toHaveLength(1);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });
});

describe('director dispatch: spawn_character', () => {
    test('spawn_character: library, ref adds participant, emits state event, and continues', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'spawn_character', from_source: 'library', ref: 'bran', rationale: 'enter Bran' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        const addParticipant = jest.fn(async (id) => ({ jack, amelia, bran })[id] || null);
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
            addParticipant,
        });
        expect(addParticipant).toHaveBeenCalledWith('bran');
        const states = events.filter(e => e.kind === 'state');
        expect(states).toHaveLength(1);
        expect(states[0]).toEqual(expect.objectContaining({
            change: 'spawn',
            character_id: 'bran',
            character_name: 'Bran',
        }));
        // ctx.actors must have been mirrored so subsequent steps can reference Bran.
        expect(ctx.actors.some(a => a.id === 'bran')).toBe(true);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });

    test('spawn_character: new without `name` is rejected by the schema validator', async () => {
        // The full spawn_character: new flow is covered in
        // director-dynamic-spawn.test.js; here we just lock in that the
        // schema validator catches missing `name`/`brief` BEFORE the
        // dispatcher runs, so addParticipant is never called.
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'spawn_character', from_source: 'new', brief: 'a new face', rationale: 'invent' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        const addParticipant = jest.fn();
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: () => null,
            addParticipant,
        });
        const errors = events.filter(e => e.kind === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('invalid_decision');
        expect(errors[0].message).toMatch(/spawn_character\.name required/);
        expect(addParticipant).not.toHaveBeenCalled();
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'error' }));
    });

    test('spawn_character: library with already-present id is a no-op', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'spawn_character', from_source: 'library', ref: 'amelia', rationale: 're-enter amelia' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        const addParticipant = jest.fn();
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
            addParticipant,
        });
        // No state event, no add call.
        expect(events.filter(e => e.kind === 'state')).toHaveLength(0);
        expect(addParticipant).not.toHaveBeenCalled();
    });
});

describe('director dispatch: remove_character', () => {
    test('remove_character calls writer and emits state event change=remove', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'remove_character', character_id: 'amelia', rationale: 'she leaves' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        const removeParticipant = jest.fn(async (id) => ({ jack, amelia, bran })[id] || null);
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
            removeParticipant,
        });
        expect(removeParticipant).toHaveBeenCalledWith('amelia');
        const states = events.filter(e => e.kind === 'state');
        expect(states).toHaveLength(1);
        expect(states[0]).toEqual(expect.objectContaining({
            change: 'remove',
            character_id: 'amelia',
            character_name: 'Amelia',
        }));
        expect(ctx.actors.some(a => a.id === 'amelia')).toBe(false);
    });

    test('remove_character with player id is rejected as a recoverable tool_error', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'remove_character', character_id: 'jack', rationale: 'oops' },
            { action: 'end_turn', rationale: 'recover' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        const removeParticipant = jest.fn();
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
            removeParticipant,
        });
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0].code).toBe('cannot_remove_player');
        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        expect(removeParticipant).not.toHaveBeenCalled();
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });
});
