import { describe, test, expect } from '@jest/globals';
import { narratorSystemPrompt } from '../../src/gm-core/narrator/prompts.js';

describe('narrator prompts: brevity contract', () => {
    test('system prompt contains the brevity contract block', () => {
        const sys = narratorSystemPrompt();
        expect(sys).toContain('Brevity contract');
        expect(sys).toContain('Hard cap: 5 sentences');
        expect(sys).toContain('No multi-paragraph');
    });

    test('system prompt bans engagement-bait closers', () => {
        const sys = narratorSystemPrompt();
        expect(sys).toContain('Banned closers');
        expect(sys).toContain('What do you do');
    });

    test('system prompt enforces declarative endings', () => {
        const sys = narratorSystemPrompt();
        expect(sys).toMatch(/last sentence must NOT end with.*\?/);
    });
});
