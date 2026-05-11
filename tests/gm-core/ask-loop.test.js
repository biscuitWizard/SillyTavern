/**
 * Ask agent loop unit tests.
 *
 * Tests the tool-calling agent loop in `src/gm-core/ask/loop.js`.
 * Uses a hand-rolled mock client that returns scripted tool calls.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

let counter = 0;
jest.unstable_mockModule('../../src/gm-core/ask/store.js', () => ({
    append: jest.fn(async (_dirs, _cid, entry) => ({
        id: `ask-entry-${counter++}`,
        ...entry,
        ts: '2026-01-01T00:00:00Z',
    })),
    readAll: jest.fn(() => []),
}));

const { runAskLoop } = await import('../../src/gm-core/ask/loop.js');
const askStore = await import('../../src/gm-core/ask/store.js');

const CAMPAIGN = { id: 'demo', name: 'Demo', brief: 'Demo campaign' };

function makePC() {
    return {
        id: 'jack',
        campaign_id: 'demo',
        name: 'Jack',
        is_player: true,
        appearance: 'Tall and scarred',
        personality: 'Brave',
        voice: 'Gruff',
        background: 'Ex-soldier',
        sheet: {
            stats: { hp: 20, str: 14 },
            statuses: {},
            items: [{ id: 'sword-1', name: 'Iron Sword', description: 'Basic weapon', influences: [] }],
            skills: ['Athletics'],
            notes: '',
        },
        has_portrait: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    };
}

function toolCallResult(name, args, idx = 0) {
    return {
        id: `call_ask_${idx}`,
        name,
        arguments: args,
        raw_arguments: JSON.stringify(args),
    };
}

function makeClient(toolCalls) {
    const queue = [...toolCalls];
    return {
        tool: jest.fn(async () => {
            if (queue.length === 0) throw new Error('mock client: no more calls queued');
            return queue.shift();
        }),
    };
}

describe('Ask agent loop', () => {
    const dirs = { root: '/tmp/test', campaigns: '/tmp/test/campaigns' };

    beforeEach(() => {
        counter = 0;
        askStore.append.mockClear();
        askStore.readAll.mockClear();
    });

    test('answer_player terminates the loop and emits answer event', async () => {
        const events = [];
        const emit = jest.fn(async (ev) => events.push(ev));

        const client = makeClient([
            toolCallResult('answer_player', {
                reply: 'Your HP is currently 20.',
                lore_candidate: null,
            }, 0),
        ]);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: makePC(),
            recentSceneHeadlines: [],
            question: 'What is my HP?',
            client,
            memoryService: null,
            sceneIndex: 0,
            emit,
        });

        expect(client.tool).toHaveBeenCalledTimes(1);

        const answer = events.find(e => e.kind === 'answer');
        expect(answer).toBeTruthy();
        expect(answer.reply).toBe('Your HP is currently 20.');
        expect(answer.lore_id).toBeNull();
    });

    test('mutate_sheet then answer_player: sheet op dispatched correctly', async () => {
        const events = [];
        const emit = jest.fn(async (ev) => events.push(ev));
        const pc = makePC();

        const mutateSheet = jest.fn((charId, op) => {
            if (op.op === 'set_stat' && op.key === 'hp') {
                pc.sheet.stats.hp = op.value;
            }
            return pc;
        });

        const client = makeClient([
            toolCallResult('mutate_sheet', {
                character_id: 'jack',
                ops: [{ op: 'set_stat', key: 'hp', value: 15 }],
                rationale: 'Player asked to set HP to 15',
            }, 0),
            toolCallResult('answer_player', {
                reply: 'Done! Your HP is now 15.',
                lore_candidate: null,
            }, 1),
        ]);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: pc,
            recentSceneHeadlines: [],
            question: 'Set my HP to 15',
            client,
            memoryService: null,
            mutateSheet,
            sceneIndex: 0,
            emit,
        });

        expect(client.tool).toHaveBeenCalledTimes(2);
        expect(mutateSheet).toHaveBeenCalledWith('jack', { op: 'set_stat', key: 'hp', value: 15 });

        const toolStep = events.find(e => e.kind === 'tool_step' && e.tool === 'mutate_sheet');
        expect(toolStep).toBeTruthy();
        expect(toolStep.summary).toContain('set_stat');

        const answer = events.find(e => e.kind === 'answer');
        expect(answer).toBeTruthy();
        expect(answer.reply).toBe('Done! Your HP is now 15.');
    });

    test('mutate_identity for PC emits identity_edit_request', async () => {
        const events = [];
        const emit = jest.fn(async (ev) => events.push(ev));
        const pc = makePC();

        const findCharacter = jest.fn((id) => id === 'jack' ? pc : null);

        const client = makeClient([
            toolCallResult('mutate_identity', {
                character_id: 'jack',
                field: 'appearance',
                value: 'Now has silver hair and glowing eyes',
                rationale: 'Goddess transformed the PC',
            }, 0),
            toolCallResult('answer_player', {
                reply: 'Identity change submitted for your approval.',
                lore_candidate: null,
            }, 1),
        ]);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: pc,
            recentSceneHeadlines: [],
            question: 'Update my appearance to reflect the transformation',
            client,
            memoryService: null,
            findCharacter,
            sceneIndex: 0,
            emit,
        });

        const idReq = events.find(e => e.kind === 'identity_edit_request');
        expect(idReq).toBeTruthy();
        expect(idReq.detail.character_id).toBe('jack');
        expect(idReq.detail.field).toBe('appearance');
        expect(idReq.detail.proposed_value).toBe('Now has silver hair and glowing eyes');
    });

    test('loop enforces step cap and emits error', async () => {
        const events = [];
        const emit = jest.fn(async (ev) => events.push(ev));

        const searchCalls = Array.from({ length: 6 }, (_, i) =>
            toolCallResult('search_memory', { query: `q${i}`, kind: 'world_lore' }, i),
        );

        const client = makeClient(searchCalls);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: makePC(),
            recentSceneHeadlines: [],
            question: 'Tell me everything',
            client,
            memoryService: null,
            sceneIndex: 0,
            emit,
        });

        expect(client.tool).toHaveBeenCalledTimes(6);
        const errorEv = events.find(e => e.kind === 'error' && e.code === 'step_cap');
        expect(errorEv).toBeTruthy();
    });

    test('empty answer_player reply triggers retry', async () => {
        const events = [];
        const emit = jest.fn(async (ev) => events.push(ev));

        const client = makeClient([
            toolCallResult('answer_player', { reply: '', lore_candidate: null }, 0),
            toolCallResult('answer_player', { reply: 'Here you go.', lore_candidate: null }, 1),
        ]);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: makePC(),
            recentSceneHeadlines: [],
            question: 'Hello?',
            client,
            memoryService: null,
            sceneIndex: 0,
            emit,
        });

        expect(client.tool).toHaveBeenCalledTimes(2);
        const answer = events.find(e => e.kind === 'answer');
        expect(answer.reply).toBe('Here you go.');
    });

    test('tool_choice is always required', async () => {
        const client = makeClient([
            toolCallResult('answer_player', { reply: 'ok', lore_candidate: null }, 0),
        ]);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: makePC(),
            recentSceneHeadlines: [],
            question: 'test',
            client,
            memoryService: null,
            sceneIndex: 0,
            emit: jest.fn(),
        });

        const callArgs = client.tool.mock.calls[0][0];
        expect(callArgs.tool_choice).toBe('required');
        expect(callArgs.tools).toBeDefined();
        expect(callArgs.role).toBe('ask');
    });

    test('prompt includes full PC sheet as YAML', async () => {
        const client = makeClient([
            toolCallResult('answer_player', { reply: 'ok', lore_candidate: null }, 0),
        ]);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: makePC(),
            recentSceneHeadlines: ['Scene 1: The tavern brawl'],
            question: 'What stats do I have?',
            client,
            memoryService: null,
            sceneIndex: 0,
            emit: jest.fn(),
        });

        const callArgs = client.tool.mock.calls[0][0];
        const userMsg = callArgs.messages.find(m => m.role === 'user');
        expect(userMsg.content).toContain('hp');
        expect(userMsg.content).toContain('str');
        expect(userMsg.content).toContain('Iron Sword');
    });

    test('askStore.append is called for player entry', async () => {
        const client = makeClient([
            toolCallResult('answer_player', { reply: 'ok', lore_candidate: null }, 0),
        ]);

        await runAskLoop({
            directories: dirs,
            campaign: CAMPAIGN,
            playerCharacter: makePC(),
            recentSceneHeadlines: [],
            question: 'Test question',
            client,
            memoryService: null,
            sceneIndex: 0,
            emit: jest.fn(),
        });

        expect(askStore.append).toHaveBeenCalledTimes(2);
        const playerCall = askStore.append.mock.calls[0];
        expect(playerCall[2].role).toBe('player');
        expect(playerCall[2].text).toBe('Test question');
        const gmCall = askStore.append.mock.calls[1];
        expect(gmCall[2].role).toBe('gm');
    });
});
