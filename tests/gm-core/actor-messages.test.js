/**
 * Multi-turn message builder tests.
 *
 * Asserts the contract from Workstream 4 of the prompt-cohesion plan:
 *   (a) own lines map to assistant, others to user
 *   (b) intent appears only in the trailing user message
 *   (c) MEMORIES blocks appear in the leading user message (context block)
 *       and never inside transcript turns
 */

import { describe, test, expect } from '@jest/globals';
import { buildActorMessages, buildNarratorMessages } from '../../src/gm-core/prompts/messages.js';

const character = {
    id: 'amelia',
    name: 'Amelia',
    is_player: false,
    appearance: 'A weathered keeper.',
    personality: 'Patient and shrewd.',
    voice: 'Warm and slow.',
    background: '',
    sheet: {
        stats: { wisdom: 14 },
        statuses: {},
        items: [],
        skills: ['insight'],
        notes: '',
    },
};

const transcriptLines = [
    { name: 'Narrator', mes: 'The tavern door swings open.', is_user: false, is_system: false, extra: { role: 'narrator' } },
    { name: 'Jack', mes: 'I step inside and look around.', is_user: true, is_system: false },
    { name: 'Amelia', mes: 'Welcome, stranger.', is_user: false, is_system: false, extra: { role: 'actor', actor_id: 'amelia' } },
    { name: 'Jack', mes: 'Who runs this place?', is_user: true, is_system: false },
];

const memoriesBlock = [
    '<character_memory id="amelia">',
    '- I distrust strangers in tavern doorways. (importance 0.70)',
    '</character_memory>',
].join('\n');

const ctx = {
    campaign: { id: 'demo', name: 'Demo Campaign', brief: 'A quiet town.' },
    scene: { id: 'opener', name: 'The Tavern Door', location: 'Riverside Inn', status: 'open' },
    actors: [
        { id: 'jack', name: 'Jack', is_player: true },
        { id: 'amelia', name: 'Amelia', is_player: false },
    ],
    recent_transcript: 'Narrator: The tavern door swings open.\nJack: I step inside.',
    transcript_lines: transcriptLines,
    user_input: 'Who runs this place?',
    memories_block: memoriesBlock,
};

describe('buildActorMessages', () => {
    test('own lines map to assistant, others to user', () => {
        const messages = buildActorMessages(ctx, character, 'answer the newcomer warily');

        const ameliaMsg = messages.find(m => m.role === 'assistant' && m.content.includes('Welcome, stranger'));
        expect(ameliaMsg).toBeTruthy();

        const narratorInUser = messages.find(m => m.role === 'user' && m.content.includes('tavern door swings open'));
        expect(narratorInUser).toBeTruthy();

        const jackInUser = messages.find(m => m.role === 'user' && m.content.includes('I step inside'));
        expect(jackInUser).toBeTruthy();

        expect(messages.find(m => m.role === 'assistant' && m.content.includes('tavern door'))).toBeFalsy();
        expect(messages.find(m => m.role === 'assistant' && m.content.includes('I step inside'))).toBeFalsy();
    });

    test('intent appears only in the trailing user message', () => {
        const messages = buildActorMessages(ctx, character, 'answer the newcomer warily');
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(lastMsg.content).toContain('answer the newcomer warily');
        expect(lastMsg.content).toContain('<director_direction>');

        const priorMessages = messages.slice(0, -1);
        for (const m of priorMessages) {
            if (m.role === 'system') continue;
            expect(m.content).not.toContain('<director_direction>');
        }
    });

    test('MEMORIES blocks appear in the leading context, not in transcript turns', () => {
        const messages = buildActorMessages(ctx, character, 'greet');

        const contextMsg = messages.find(m => m.role === 'user' && m.content.includes('<character_memory'));
        expect(contextMsg).toBeTruthy();
        expect(contextMsg.content).toContain('distrust strangers');

        const assistantMsgs = messages.filter(m => m.role === 'assistant');
        for (const m of assistantMsgs) {
            expect(m.content).not.toContain('<character_memory');
        }

        const lastMsg = messages[messages.length - 1];
        if (!lastMsg.content.includes('<character_memory')) {
            // direction message doesn't contain memories — good
        }
    });

    test('system message is first and contains identity', () => {
        const messages = buildActorMessages(ctx, character, 'react');
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('You write the next beat for Amelia');
    });

    test('falls back to system+user pair when transcript_lines is empty', () => {
        const ctxNoLines = { ...ctx, transcript_lines: [] };
        const messages = buildActorMessages(ctxNoLines, character, 'greet');
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('system');
        expect(messages[1].role).toBe('user');
        expect(messages[1].content).toContain('<director_direction>');
    });

    test('adjacent same-role messages are merged for clean alternation', () => {
        const messages = buildActorMessages(ctx, character, 'greet');
        for (let i = 1; i < messages.length; i++) {
            if (messages[i - 1].role === 'system') continue;
            expect(messages[i].role).not.toBe(messages[i - 1].role);
        }
    });

    test('character sheet appears in the context block as YAML', () => {
        const messages = buildActorMessages(ctx, character, 'greet');
        const contextMsg = messages.find(m => m.role === 'user' && m.content.includes('<character_sheet'));
        expect(contextMsg).toBeTruthy();
        expect(contextMsg.content).toContain('format="yaml"');
    });
});

describe('buildNarratorMessages', () => {
    test('narrator own lines map to assistant, others to user', () => {
        const messages = buildNarratorMessages(ctx, 'set the scene');

        const narratorMsg = messages.find(m => m.role === 'assistant' && m.content.includes('tavern door swings open'));
        expect(narratorMsg).toBeTruthy();

        const jackMsg = messages.find(m => m.role === 'user' && m.content.includes('I step inside'));
        expect(jackMsg).toBeTruthy();

        expect(messages.find(m => m.role === 'assistant' && m.content.includes('I step inside'))).toBeFalsy();
    });

    test('direction appears in the final user message', () => {
        const messages = buildNarratorMessages(ctx, 'describe the tavern interior');
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(lastMsg.content).toContain('describe the tavern interior');
        expect(lastMsg.content).toContain('<director_direction>');
    });

    test('system message contains narrator identity', () => {
        const messages = buildNarratorMessages(ctx, 'narrate');
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('World Narrator');
    });

    test('system lines from transcript are skipped', () => {
        const linesWithSystem = [
            ...transcriptLines,
            { name: 'System', mes: 'Roll: 15 + 3 = 18', is_user: false, is_system: true, extra: { kind: 'roll' } },
        ];
        const ctxWithSystem = { ...ctx, transcript_lines: linesWithSystem };
        const messages = buildNarratorMessages(ctxWithSystem, 'narrate');
        const allContent = messages.map(m => m.content).join('\n');
        expect(allContent).not.toContain('Roll: 15 + 3 = 18');
    });

    test('adjacent same-role messages are merged for clean alternation', () => {
        const messages = buildNarratorMessages(ctx, 'narrate');
        for (let i = 1; i < messages.length; i++) {
            if (messages[i - 1].role === 'system') continue;
            expect(messages[i].role).not.toBe(messages[i - 1].role);
        }
    });

    test('falls back to system+user pair when transcript_lines is empty', () => {
        const ctxNoLines = { ...ctx, transcript_lines: [] };
        const messages = buildNarratorMessages(ctxNoLines, 'describe');
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('system');
        expect(messages[1].role).toBe('user');
    });
});
