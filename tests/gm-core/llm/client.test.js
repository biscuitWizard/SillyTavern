import { describe, test, expect, jest, beforeAll } from '@jest/globals';

let openaiBaseBody;
let stripThinkTags;

beforeAll(async () => {
    jest.unstable_mockModule('../../../src/util.js', () => ({
        getConfig: () => ({}),
        getConfigValue: () => undefined,
        setConfigFilePath: () => {},
        color: { red: s => s, green: s => s, yellow: s => s },
    }));
    jest.unstable_mockModule('../../../src/endpoints/secrets.js', () => ({
        readSecret: () => undefined,
        readSecretState: () => ({}),
        SECRET_KEYS: {},
        writeSecret: () => {},
    }));
    const mod = await import('../../../src/gm-core/llm/client.js');
    openaiBaseBody = mod._openaiBaseBody;
    stripThinkTags = mod._stripThinkTags;
});

describe('openaiBaseBody', () => {
    const messages = [{ role: 'system', content: 'hi' }];

    test('does NOT include max_tokens even if the profile carries one', () => {
        const body = openaiBaseBody({
            profile: { model: 'test', source: 'custom', max_tokens: 240 },
            messages,
        });
        expect(body).not.toHaveProperty('max_tokens');
    });

    test('includes temperature when set', () => {
        const body = openaiBaseBody({
            profile: { model: 'test', source: 'custom', temperature: 0.7 },
            messages,
        });
        expect(body.temperature).toBe(0.7);
    });

    test('merges profile.extra into the body', () => {
        const body = openaiBaseBody({
            profile: { model: 'test', source: 'custom', extra: { custom_field: true } },
            messages,
        });
        expect(body.custom_field).toBe(true);
    });

    test('includes reasoning_effort when set on profile', () => {
        const body = openaiBaseBody({
            profile: { model: 'test', source: 'custom', reasoning_effort: 'high' },
            messages,
        });
        expect(body.reasoning_effort).toBe('high');
    });

    test('does not include reasoning_effort when not set', () => {
        const body = openaiBaseBody({
            profile: { model: 'test', source: 'custom' },
            messages,
        });
        expect(body).not.toHaveProperty('reasoning_effort');
    });
});

describe('stripThinkTags', () => {
    test('strips <think>...</think> blocks', () => {
        const input = '<think>reasoning here</think>Clean prose.';
        expect(stripThinkTags(input)).toBe('Clean prose.');
    });

    test('strips <thinking>...</thinking> blocks', () => {
        const input = '<thinking>long reasoning\nmultiline</thinking>\n\nClean output.';
        expect(stripThinkTags(input)).toBe('Clean output.');
    });

    test('strips multiple think blocks', () => {
        const input = '<think>first</think>A<thinking>second</thinking>B';
        expect(stripThinkTags(input)).toBe('AB');
    });

    test('leaves text without think tags unchanged', () => {
        const input = 'Just normal prose.';
        expect(stripThinkTags(input)).toBe(input);
    });

    test('handles null/undefined gracefully', () => {
        expect(stripThinkTags(null)).toBeNull();
        expect(stripThinkTags(undefined)).toBeUndefined();
    });

    test('strips case-insensitively', () => {
        const input = '<THINK>Reasoning</THINK>output';
        expect(stripThinkTags(input)).toBe('output');
    });
});
