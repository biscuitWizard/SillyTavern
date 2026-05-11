/**
 * M0 invariant — sheet AFTER RAG.
 *
 * The categorized character sheet YAML must appear in the assembled
 * USER prompt strictly AFTER any spliced MEMORIES block. We pin the
 * order with a marker-string check on each role's prompt builder so a
 * future change that re-introduces the sheet to the system prompt or
 * places it above MEMORIES will fail loudly.
 *
 * The MEMORIES block uses `--- BEGIN MEMORIES` as its header (see
 * `src/gm-core/rag/injection.js`). We synthesize one inline rather than
 * routing through the injection helper, so this test stays free of the
 * RAG service and can run in pure-unit mode.
 */

import { describe, test, expect } from '@jest/globals';
import { actorSystemPrompt, actorUserPrompt } from '../../src/gm-core/actors/prompts.js';
import { narratorSystemPrompt, narratorUserPrompt } from '../../src/gm-core/narrator/prompts.js';
import { directorSystemPrompt, directorUserPrompt } from '../../src/gm-core/director/prompts.js';
import { formatToolResult } from '../../src/gm-core/director/history.js';

const SHEET_MARKER_KEY = 'M0_ORDERING_PROBE_KEY';
const SHEET_MARKER_VALUE = 'M0_ORDERING_PROBE_VALUE';

const memoriesBlock = [
    '<character_memory id="jack">',
    '- I owe Lila a debt I cannot ignore. (importance 0.70)',
    '</character_memory>',
].join('\n');

const character = {
    id: 'jack',
    campaign_id: 'demo',
    name: 'Jack Ironwright',
    is_player: true,
    appearance: 'Tall, scarred jaw.',
    personality: 'Soft-spoken, fast under pressure.',
    voice: 'Low and clipped.',
    background: '',
    sheet: {
        stats: { hp: 24, [SHEET_MARKER_KEY]: SHEET_MARKER_VALUE },
        statuses: {},
        items: [],
        skills: ['perception'],
        notes: '',
    },
};

const ctx = {
    campaign: { id: 'demo', name: 'Demo Campaign', brief: 'A quiet town with old debts.' },
    scene: { id: 'opener', name: 'The Tavern Door', location: 'Riverside Inn', status: 'open' },
    actors: [
        { id: character.id, name: character.name, is_player: true, appearance: character.appearance, personality: character.personality, voice: character.voice },
    ],
    recent_transcript: 'Player: I push open the door.',
    user_input: 'I push open the door.',
    memories_block: memoriesBlock,
};

describe('M0 prompt ordering: sheet AFTER RAG', () => {
    test('actorSystemPrompt does not embed the sheet YAML', () => {
        const sys = actorSystemPrompt(ctx, character);
        expect(sys).not.toContain(SHEET_MARKER_KEY);
        expect(sys).not.toContain(SHEET_MARKER_VALUE);
        // The sheet-isolation rule sentence still belongs in the system prompt.
        expect(sys).toContain('Only your own sheet is visible to you');
    });

    test('actorUserPrompt places sheet YAML after the MEMORIES block', () => {
        const user = actorUserPrompt(ctx, character, 'push the door open');
        const memoriesIdx = user.indexOf('<character_memory');
        const sheetIdx = user.indexOf(SHEET_MARKER_KEY);
        expect(memoriesIdx).toBeGreaterThanOrEqual(0);
        expect(sheetIdx).toBeGreaterThanOrEqual(0);
        expect(memoriesIdx).toBeLessThan(sheetIdx);
    });

    test('actorUserPrompt without memories still emits the sheet (defensive: order check is conditional)', () => {
        const ctxNoMem = { ...ctx, memories_block: '' };
        const user = actorUserPrompt(ctxNoMem, character, 'push the door open');
        expect(user).not.toContain('<character_memory');
        expect(user).toContain(SHEET_MARKER_KEY);
    });

    test('narratorUserPrompt: any future sheet/character data lives strictly after MEMORIES', () => {
        const user = narratorUserPrompt(ctx, 'set the scene as Jack steps inside');
        const memoriesIdx = user.indexOf('<character_memory');
        expect(memoriesIdx).toBeGreaterThanOrEqual(0);
        expect(user).not.toContain(SHEET_MARKER_KEY);
        const sys = narratorSystemPrompt();
        expect(sys).not.toContain('<character_memory');
    });

    test('directorUserPrompt: MEMORIES sits before user input', () => {
        const user = directorUserPrompt(ctx);
        const memoriesIdx = user.indexOf('<character_memory');
        const userInputIdx = user.indexOf('<player_input>');
        expect(memoriesIdx).toBeGreaterThanOrEqual(0);
        expect(userInputIdx).toBeGreaterThan(memoriesIdx);
        expect(user).not.toContain('# LAST BEAT');
        expect(user).not.toContain(SHEET_MARKER_KEY);
        const sys = directorSystemPrompt(ctx);
        expect(sys).not.toContain(SHEET_MARKER_KEY);
    });
});

describe('director history: formatToolResult', () => {
    // Post tool-call refactor: formatToolResult renders the body of a
    // role: 'tool' message. The chat template anchors that result back
    // to the preceding assistant tool_call by tool_call_id, so we no
    // longer prefix with "Tool result for `<action>`:" or trail with
    // "Decide the next beat." — both used to leak into the legacy
    // role: 'user' stand-in and prime the model to treat tool outputs
    // as fresh player speech.
    test('returns the dispatcher summary verbatim, with no engine-side wrapping', () => {
        const decision = { action: 'speak', actor: 'amelia', intent: 'greet', rationale: 'NPC turn' };
        const summary = 'Amelia (id: `amelia`) just spoke in response to the player\'s input. Default to end_turn.';
        const out = formatToolResult(decision, summary);
        expect(out).toBe(summary);
        expect(out).not.toMatch(/Tool result for/);
        expect(out).not.toMatch(/Decide the next beat/);
    });

    test('falls back to "(no details from `<action>`)" when the summary is empty', () => {
        const decision = { action: 'end_turn' };
        const out = formatToolResult(decision, '');
        expect(out).toBe('(no details from `end_turn`)');
    });

    test('falls back to action="unknown" when the decision is malformed', () => {
        // @ts-expect-error testing defensive path
        const out = formatToolResult({}, 'whatever happened');
        expect(out).toBe('whatever happened');
    });

    test('falls back to action="unknown" in the empty-summary branch when the decision is malformed', () => {
        // @ts-expect-error testing defensive path
        const out = formatToolResult({}, '');
        expect(out).toBe('(no details from `unknown`)');
    });
});
