import { describe, test, expect } from '@jest/globals';
import { directorSystemPrompt, directorUserPrompt } from '../../src/gm-core/director/prompts.js';

const ctx = {
    campaign: { id: 'demo', name: 'Demo', brief: 'Test' },
    scene: { id: 's1', name: 'Tavern', location: 'The Rusty Nail', status: 'open' },
    actors: [],
    recent_transcript: '',
    user_input: '',
};

describe('director system prompt', () => {
    test('contains rule 7a (trivial-action exception)', () => {
        const sys = directorSystemPrompt(ctx);
        expect(sys).toContain('7a.');
        expect(sys).toContain('NOT every player action is a check');
        expect(sys).toContain('conversational with no immediate stakes');
    });

    test('anti-patterns include casual conversation skill-check warning', () => {
        const sys = directorSystemPrompt(ctx);
        expect(sys).toMatch(/skill_check.*casual conversation|casual conversation.*skill_check/i);
    });

    test('contains spawn-then-speak rule with worked example', () => {
        const sys = directorSystemPrompt(ctx);
        expect(sys).toContain('Spawn-then-speak');
        expect(sys).toContain('spawn_character');
        expect(sys).toContain('barkeep');
    });

    test('contains reasoning contract section with 4-step structure', () => {
        const sys = directorSystemPrompt(ctx);
        expect(sys).toContain('Reasoning contract');
        expect(sys).toContain('rationale');
        expect(sys).toContain('4-step');
        expect(sys).toContain('Minimum 80 characters');
    });

    test('intent examples include tone-cue and contraction-heavy examples', () => {
        const sys = directorSystemPrompt(ctx);
        expect(sys).toContain("say no firmly");
        expect(sys).toContain("doesn't know anything");
    });
});

describe('director user prompt', () => {
    test('renders campaign.addendum when non-empty', () => {
        const ctxWithAddendum = {
            ...ctx,
            campaign: { ...ctx.campaign, addendum: 'Keep tension high, never break character.' },
        };
        const user = directorUserPrompt(ctxWithAddendum);
        expect(user).toContain('GM ADDENDUM');
        expect(user).toContain('Keep tension high');
    });

    test('omits addendum section when addendum is empty', () => {
        const user = directorUserPrompt(ctx);
        expect(user).not.toContain('GM ADDENDUM');
    });
});
