/**
 * Director dispatch tests for the dynamic-spawn flow:
 *
 *   - `search_library` returns a tool result with matched off-stage
 *     characters via the messages[] history (a synthetic user-role
 *     "Tool result for `search_library`" message visible to the next
 *     Director call) and emits no chat events.
 *   - `spawn_character` with `from_source: 'new'` creates a transient
 *     in-memory character: visible in `ctx.actors`, NOT persisted yet,
 *     emits a `state` event marked `ephemeral: true`.
 *   - First successful `speak` for that transient promotes it: calls
 *     `createCharacter` to write it to disk, calls `addParticipant`, and
 *     emits a second `state` event with `promoted: true`.
 *   - A transient that never speaks is gone at end of turn — no
 *     `createCharacter` call, no participants write, no on-disk record.
 *   - `remove_character` for an un-promoted transient is a memory-only
 *     drop with no `removeParticipant` call.
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
const marle = makeChar({ id: 'marle', name: 'Marle the Investigator' });
const oldBartender = makeChar({ id: 'old_bartender', name: 'Greta the Bartender', appearance: 'a stout woman with rolled sleeves' });

function baseCtx() {
    return {
        campaign: { id: 'demo', name: 'Shadows of Ironhold', brief: '' },
        scene: { id: 'tavern', name: 'Tavern', location: 'The Salted Hand', status: 'open' },
        actors: [
            { id: 'jack', name: 'Jack', is_player: true },
            { id: 'marle', name: 'Marle the Investigator', is_player: false },
        ],
        library_characters: [
            { id: 'old_bartender', name: 'Greta the Bartender', appearance: 'a stout woman with rolled sleeves' },
        ],
        recent_transcript: '',
        user_input: 'I ask the bartender, "What do you know about me?"',
    };
}

function makeDirector(decisions) {
    const queue = [...decisions];
    /** @type {Array<Array<{ role: string, content: string }>>} */
    const calls = [];
    const client = {
        structured: jest.fn(async ({ messages }) => {
            calls.push((messages || []).map(m => ({ role: m.role, content: m.content })));
            if (queue.length === 0) throw new Error('director queue exhausted');
            return queue.shift();
        }),
        chat: jest.fn(async () => 'unused'),
        calls,
    };
    return client;
}

function makeActor(replyFn) {
    return {
        chat: jest.fn(async ({ system, user }) => replyFn({ system, user })),
        structured: jest.fn(async () => { throw new Error('actor.structured not used'); }),
    };
}

describe('search_library', () => {
    test('returns matched off-stage characters via the messages[] history without emitting chat events', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'search_library', query: 'bartender', rationale: 'check if one already exists' },
            { action: 'end_turn', rationale: 'director will spawn from library next turn' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, marle, old_bartender: oldBartender })[id] || null,
        });
        // No chat-visible events from the search itself (only the status
        // pings from the per-step iteration).
        expect(events.filter(e => e.kind === 'message')).toHaveLength(0);
        expect(events.filter(e => e.kind === 'state')).toHaveLength(0);
        expect(events.filter(e => e.kind === 'tool_error')).toHaveLength(0);
        // The Director sees the matches via the second call's messages[]
        // history — the loop appended a synthetic user "Tool result for
        // `search_library`" message after the dispatcher returned.
        const secondCall = director.calls[1];
        expect(secondCall).toBeDefined();
        const lastUser = [...secondCall].reverse().find(m => m.role === 'user');
        expect(lastUser).toBeDefined();
        expect(lastUser.content).toContain('search_library');
        expect(lastUser.content).toContain('old_bartender');
        expect(lastUser.content).toContain('Greta the Bartender');
        // Loop terminates cleanly.
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });

    test('empty library yields a "no matches, invent one" tool result in the next call\'s history', async () => {
        const ctx = baseCtx();
        ctx.library_characters = [];
        const director = makeDirector([
            { action: 'search_library', query: 'bartender', rationale: 'first check' },
            { action: 'end_turn', rationale: 'will invent next turn' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: () => null,
        });
        const secondCall = director.calls[1];
        const lastUser = [...secondCall].reverse().find(m => m.role === 'user');
        expect(lastUser.content).toMatch(/no off-stage characters/i);
        expect(lastUser.content).toContain('spawn_character');
    });
});

describe('spawn_character: from_source = "new" (transient, promote-on-speak)', () => {
    test('spawn-new mirrors into ctx.actors, emits ephemeral state, does NOT call createCharacter or addParticipant', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'spawn_character',
                from_source: 'new',
                name: 'the bartender',
                brief: 'a thick-necked tavern keeper wiping a glass',
                rationale: 'player addressed someone off-stage',
            },
            { action: 'end_turn', rationale: 'never spoke; bartender vanishes' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        const createCharacter = jest.fn();
        const addParticipant = jest.fn();
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, marle })[id] || null,
            createCharacter,
            addParticipant,
        });
        expect(createCharacter).not.toHaveBeenCalled();
        expect(addParticipant).not.toHaveBeenCalled();
        const stateEvts = events.filter(e => e.kind === 'state');
        expect(stateEvts).toHaveLength(1);
        expect(stateEvts[0]).toEqual(expect.objectContaining({
            change: 'spawn',
            character_name: 'the bartender',
            ephemeral: true,
        }));
        // Mirrored into ctx.actors so subsequent steps could `speak` them.
        expect(ctx.actors.some(a => a.id === stateEvts[0].character_id)).toBe(true);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });

    test('spawn-new + speak promotes the transient: createCharacter and addParticipant fire, second state event has promoted:true', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'spawn_character',
                from_source: 'new',
                name: 'the bartender',
                brief: 'a thick-necked tavern keeper',
                rationale: 'address player',
            },
            // Loop mirrored "the_bartender" into ctx.actors with id derived
            // from the slugified name. The director can see it via the
            // (synthetic) actor list and address it on its next call.
            // We pre-compute the id below to drive the script.
            { action: 'speak', actor: 'the_bartender', intent: 'gruff acknowledgement', rationale: 'NPC speaks' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'I keep wiping the glass. "Maybe."');
        const events = [];
        const persisted = makeChar({ id: 'the_bartender', name: 'the bartender', appearance: 'a thick-necked tavern keeper' });
        const createCharacter = jest.fn(() => persisted);
        const addParticipant = jest.fn(() => persisted);
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, marle })[id] || null,
            createCharacter,
            addParticipant,
        });
        // Promote-on-speak fired: persistence + participant write.
        expect(createCharacter).toHaveBeenCalledTimes(1);
        expect(createCharacter.mock.calls[0][0]).toEqual(expect.objectContaining({
            name: 'the bartender',
            is_player: false,
            appearance: 'a thick-necked tavern keeper',
        }));
        expect(addParticipant).toHaveBeenCalledTimes(1);
        expect(addParticipant.mock.calls[0][0]).toBe('the_bartender');
        // Two state.spawn events: one ephemeral, one promoted.
        const spawnEvts = events.filter(e => e.kind === 'state' && e.change === 'spawn');
        expect(spawnEvts).toHaveLength(2);
        expect(spawnEvts[0].ephemeral).toBe(true);
        expect(spawnEvts[1].promoted).toBe(true);
        // The actor LLM was called and its message emitted.
        expect(actor.chat).toHaveBeenCalledTimes(1);
        const messages = events.filter(e => e.kind === 'message');
        expect(messages).toHaveLength(1);
        expect(messages[0].actor).toBe('the_bartender');
        expect(messages[0].text).toContain('wiping the glass');
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });

    test('spawn-new without name or brief surfaces a recoverable tool_error and lets the Director recover', async () => {
        // The validator gates the dispatcher and surfaces `invalid_decision`
        // as a `tool_error` event so the Director can pick a different
        // action on its next step (here, end_turn) instead of halting the
        // turn. This preserves the invariant that the Director's structured
        // output must be schema-valid while keeping the surface forgiving.
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'spawn_character', from_source: 'new', rationale: 'forgot fields' },
            { action: 'end_turn', rationale: 'recovered after invalid_decision' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: () => null,
            createCharacter: jest.fn(),
            addParticipant: jest.fn(),
        });
        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0]).toEqual(expect.objectContaining({
            tool: 'director_decision',
            code: 'invalid_decision',
        }));
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });
});

describe('remove_character: transient', () => {
    test('removing a transient character that never spoke uses memory-only path (no removeParticipant call)', async () => {
        const ctx = baseCtx();
        const director = makeDirector([
            { action: 'spawn_character', from_source: 'new', name: 'a passing courier', brief: 'a winded young runner', rationale: 'flavor' },
            { action: 'remove_character', character_id: 'a_passing_courier', rationale: 'changed mind' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const actor = makeActor(() => 'never');
        const events = [];
        const removeParticipant = jest.fn();
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, marle })[id] || null,
            createCharacter: jest.fn(),
            addParticipant: jest.fn(),
            removeParticipant,
        });
        expect(removeParticipant).not.toHaveBeenCalled();
        const removeEvts = events.filter(e => e.kind === 'state' && e.change === 'remove');
        expect(removeEvts).toHaveLength(1);
        expect(removeEvts[0].character_id).toBe('a_passing_courier');
        expect(ctx.actors.some(a => a.id === 'a_passing_courier')).toBe(false);
    });
});
