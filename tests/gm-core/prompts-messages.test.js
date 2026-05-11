import { describe, test, expect } from '@jest/globals';
import { buildActorMessages } from '../../src/gm-core/prompts/messages.js';

const character = {
    id: 'gruff',
    campaign_id: 'demo',
    name: 'Gruff',
    is_player: false,
    appearance: 'Burly innkeeper',
    personality: 'Gruff',
    voice: 'Low growl',
    background: 'Ran the tavern for years',
    sheet: { stats: {}, statuses: {}, items: [], skills: [], notes: '' },
};

const baseCtx = {
    campaign: { id: 'demo', name: 'Demo', brief: 'Test' },
    scene: { id: 's1', name: 'Tavern', location: 'The Rusty Nail', status: 'open' },
    actors: [{ id: 'gruff', name: 'Gruff', is_player: false }],
    recent_transcript: '',
    user_input: 'I walk in.',
};

describe('buildActorMessages: cold-start primer', () => {
    test('splices a synthetic (ready) assistant turn when speaker has no prior lines', () => {
        const ctx = {
            ...baseCtx,
            transcript_lines: [
                { name: 'Narrator', mes: 'The door creaks open.', is_user: false },
                { name: 'Player', mes: 'I walk in.', is_user: true },
            ],
        };
        const msgs = buildActorMessages(ctx, character, 'greet the newcomer');
        const assistantMsgs = msgs.filter(m => m.role === 'assistant');
        expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
        expect(assistantMsgs[0].content).toContain('(ready)');
    });

    test('does NOT splice a primer when speaker already has assistant lines in transcript', () => {
        const ctx = {
            ...baseCtx,
            transcript_lines: [
                { name: 'Gruff', mes: '"Evening."', is_user: false },
                { name: 'Player', mes: 'I walk in.', is_user: true },
            ],
        };
        const msgs = buildActorMessages(ctx, character, 'greet the newcomer');
        const readyMsgs = msgs.filter(m => m.role === 'assistant' && m.content.includes('(ready)'));
        expect(readyMsgs.length).toBe(0);
    });

    test('trailing user message uses third-person instruction', () => {
        const ctx = {
            ...baseCtx,
            transcript_lines: [
                { name: 'Player', mes: 'Hello.', is_user: true },
            ],
        };
        const msgs = buildActorMessages(ctx, character, 'greet warmly');
        const lastUser = msgs.filter(m => m.role === 'user').pop();
        expect(lastUser.content).toContain("Write Gruff's next beat now. Third person, present tense.");
        expect(lastUser.content).not.toContain('Speak as');
    });
});
