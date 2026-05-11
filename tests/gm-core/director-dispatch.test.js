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
 *
 * As of the agent-loop refactor (Phase 8), the loop maintains a real
 * `messages[]` history per turn rather than a single `ctx.last_beat`
 * string. Tests that previously inspected `ctx.last_beat` now snapshot
 * the `messages` argument the loop passes into `directorClient.tool`
 * on each call and assert against the appended `role: 'tool'` result
 * message (and the assistant message with `tool_calls` that preceded it).
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
        has_portrait: false,
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

function snapshotMessage(m) {
    /** @type {Record<string, unknown>} */
    const out = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
}

function decisionToToolCall(decision, idx) {
    const { action, ...args } = decision;
    return {
        id: `call_test_${idx}`,
        name: action,
        arguments: args,
        raw_arguments: JSON.stringify(args),
    };
}

function makeDirector(decisions) {
    const queue = [...decisions];
    /** @type {Array<Array<Record<string, unknown>>>} */
    const calls = [];
    let idx = 0;
    const client = {
        tool: jest.fn(async ({ messages }) => {
            // Snapshot the history the loop passed in for this call so
            // tests can assert on what the Director "saw" at each step,
            // including the new tool_calls / tool_call_id shape.
            calls.push((messages || []).map(snapshotMessage));
            if (queue.length === 0) throw new Error('director queue exhausted');
            return decisionToToolCall(queue.shift(), idx++);
        }),
        chat: jest.fn(async () => 'unused'),
        structured: jest.fn(async () => { throw new Error('director.structured not used in tool-calling mode'); }),
        calls,
    };
    return client;
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
            // After the tool-result history shows the error, Director recovers by ending the turn.
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
        expect(director.tool).toHaveBeenCalledTimes(2);
        // Loop ended cleanly via the recovery, not via a hard error.
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
        // The Director's SECOND call must have seen the tool-error in its
        // history as a proper role:'tool' message, anchored to the matching
        // tool_call_id from the bad speak attempt.
        const secondCall = director.calls[1];
        expect(secondCall).toBeDefined();
        const lastTool = [...secondCall].reverse().find(m => m.role === 'tool');
        expect(lastTool).toBeDefined();
        expect(lastTool.content).toContain('Tool error from `speak`');
        expect(lastTool.content).toContain('unknown_actor');
        // The matching assistant turn carries the bad call's tool_calls.
        const assistantWithCall = [...secondCall].reverse().find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
        expect(assistantWithCall).toBeDefined();
        expect(assistantWithCall.tool_calls[0].id).toBe(lastTool.tool_call_id);
        expect(assistantWithCall.tool_calls[0].function.name).toBe('speak');
    });

    test('speak: <character_id> records the spoken beat in director history so it can decide to end_turn', async () => {
        // Regression test for the runaway-loop bug: previously the actor
        // branch never updated ctx.user_input, so the Director kept seeing
        // the same player input and kept dispatching speak: <actor>.
        // Now the loop maintains a real messages[] history, and the
        // Director sees its own prior "Amelia spoke" beat as a
        // tool-result user message on the next call.
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
        // The Director's SECOND call must carry the speak as an
        // assistant tool_call AND a role:'tool' result, so it knows
        // not to fire the same actor again. There's exactly one
        // user turn (the initial player prompt) — tool results never
        // masquerade as user input any more.
        const secondCall = director.calls[1];
        expect(secondCall).toBeDefined();
        const assistantTurns = secondCall.filter(m => m.role === 'assistant');
        expect(assistantTurns).toHaveLength(1);
        expect(assistantTurns[0].content).toBeNull();
        expect(Array.isArray(assistantTurns[0].tool_calls)).toBe(true);
        expect(assistantTurns[0].tool_calls[0].function.name).toBe('speak');
        const args = JSON.parse(assistantTurns[0].tool_calls[0].function.arguments);
        expect(args.actor).toBe('amelia');
        const toolTurns = secondCall.filter(m => m.role === 'tool');
        expect(toolTurns).toHaveLength(1);
        expect(toolTurns[0].tool_call_id).toBe(assistantTurns[0].tool_calls[0].id);
        expect(toolTurns[0].content).toContain('Amelia');
        expect(toolTurns[0].content).toContain('just spoke');
        const userTurns = secondCall.filter(m => m.role === 'user');
        expect(userTurns).toHaveLength(1);
        expect(userTurns[0].content).toContain('<player_input>');
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

    test('spawn_character: new without `name` is rejected as a recoverable tool_error and the Director can recover', async () => {
        // Schema validation now feeds back into the Director loop as a
        // recoverable `tool_error` instead of halting the turn. The
        // Director sees the validator's complaint in its tool history
        // and gets to pick a different action — here, end_turn — for a
        // clean exit. addParticipant is never called.
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'spawn_character', from_source: 'new', brief: 'a new face', rationale: 'invent' },
            { action: 'end_turn', rationale: 'recovered after invalid_decision' },
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
        // No fatal `error` — the loop must recover.
        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0]).toEqual(expect.objectContaining({
            tool: 'director_decision',
            code: 'invalid_decision',
        }));
        expect(toolErrors[0].message).toMatch(/spawn_character\.name required/);
        expect(addParticipant).not.toHaveBeenCalled();
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
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
