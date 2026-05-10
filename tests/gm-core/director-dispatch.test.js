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

    test('speak: <pc_id> is rejected — Director cannot speak for the player', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'speak', actor: 'jack', intent: 'speak as the PC', rationale: 'oops' },
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
        const errors = events.filter(e => e.kind === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('cannot_speak_for_player');
        expect(actor.chat).not.toHaveBeenCalled();
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'error' }));
    });

    test('speak: <unknown_id> not in scene rejected with unknown_actor', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'speak', actor: 'bran', intent: 'wave', rationale: 'oops' },
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
        const errors = events.filter(e => e.kind === 'error');
        expect(errors[0].code).toBe('unknown_actor');
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

    test('spawn_character: new emits unsupported_source error and ends the turn', async () => {
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
        expect(errors[0].code).toBe('unsupported_source');
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

    test('remove_character with player id is rejected', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'remove_character', character_id: 'jack', rationale: 'oops' },
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
        const errors = events.filter(e => e.kind === 'error');
        expect(errors[0].code).toBe('cannot_remove_player');
        expect(removeParticipant).not.toHaveBeenCalled();
    });
});
