import { describe, test, expect } from '@jest/globals';
import { stripPromptEcho } from '../../src/gm-core/actors/postprocess.js';

describe('stripPromptEcho', () => {
    const char = { name: 'Gruff the Innkeeper' };

    test('returns clean text unchanged', () => {
        const prose = '*Gruff wipes the bar.* "What do you want?"';
        expect(stripPromptEcho(prose, char)).toBe(prose);
    });

    test('strips old-style "Speak as X now. Stay in character." suffix', () => {
        const prose = '*Gruff nods slowly.*\n\nSpeak as Gruff the Innkeeper now. Stay in character.';
        expect(stripPromptEcho(prose, char)).toBe('*Gruff nods slowly.*');
    });

    test('strips new-style "Write X\'s next beat now." suffix', () => {
        const prose = '"Fine."\n\nWrite Gruff the Innkeeper\'s next beat now. Third person, present tense.';
        expect(stripPromptEcho(prose, char)).toBe('"Fine."');
    });

    test('strips leading <director_direction> block', () => {
        const prose = '<director_direction>warn the newcomer</director_direction>\n\n*Gruff glares.* "Get out."';
        expect(stripPromptEcho(prose, char)).toBe('*Gruff glares.* "Get out."');
    });

    test('strips instruction echoed inside a code block', () => {
        const prose = '*Gruff nods.*\n\n```\nSpeak as Gruff the Innkeeper now. Stay in character.\n```';
        expect(stripPromptEcho(prose, char)).toBe('*Gruff nods.*');
    });

    test('preserves unrelated code blocks', () => {
        const prose = '*Gruff recites the code:*\n\n```\nopen sesame\n```';
        expect(stripPromptEcho(prose, char)).toBe(prose);
    });

    test('collapses triple blank lines to double', () => {
        const prose = 'Line one.\n\n\n\nLine two.';
        expect(stripPromptEcho(prose, char)).toBe('Line one.\n\nLine two.');
    });

    test('handles null/undefined text gracefully', () => {
        expect(stripPromptEcho(null, char)).toBe('');
        expect(stripPromptEcho(undefined, char)).toBe('');
    });

    test('handles missing character gracefully', () => {
        const prose = 'Some text. Speak as Someone now. Stay in character.';
        expect(stripPromptEcho(prose)).toBe('Some text. Speak as Someone now. Stay in character.');
    });
});
