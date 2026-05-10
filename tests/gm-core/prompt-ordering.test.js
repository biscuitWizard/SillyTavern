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
    '--- BEGIN MEMORIES (character_memory: jack) ---',
    '- I owe Lila a debt I cannot ignore. (importance 0.70)',
    '--- END MEMORIES ---',
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
        const memoriesIdx = user.indexOf('--- BEGIN MEMORIES');
        const sheetIdx = user.indexOf(SHEET_MARKER_KEY);
        expect(memoriesIdx).toBeGreaterThanOrEqual(0);
        expect(sheetIdx).toBeGreaterThanOrEqual(0);
        expect(memoriesIdx).toBeLessThan(sheetIdx);
    });

    test('actorUserPrompt without memories still emits the sheet (defensive: order check is conditional)', () => {
        const ctxNoMem = { ...ctx, memories_block: '' };
        const user = actorUserPrompt(ctxNoMem, character, 'push the door open');
        expect(user).not.toContain('--- BEGIN MEMORIES');
        expect(user).toContain(SHEET_MARKER_KEY);
    });

    test('narratorUserPrompt: any future sheet/character data lives strictly after MEMORIES', () => {
        const user = narratorUserPrompt(ctx, 'set the scene as Jack steps inside');
        const memoriesIdx = user.indexOf('--- BEGIN MEMORIES');
        expect(memoriesIdx).toBeGreaterThanOrEqual(0);
        // Today the Narrator does not render any sheet, so SHEET_MARKER_KEY
        // should be absent. Pin that to detect any future regression that
        // accidentally splices a sheet into the Narrator prompt.
        expect(user).not.toContain(SHEET_MARKER_KEY);
        // The narrator prompt must NOT carry the system prompt by accident.
        const sys = narratorSystemPrompt();
        expect(sys).not.toContain('--- BEGIN MEMORIES');
    });

    test('directorUserPrompt: MEMORIES sits before user input', () => {
        const user = directorUserPrompt(ctx);
        const memoriesIdx = user.indexOf('--- BEGIN MEMORIES');
        const userInputIdx = user.indexOf('# Player input this turn');
        expect(memoriesIdx).toBeGreaterThanOrEqual(0);
        expect(userInputIdx).toBeGreaterThan(memoriesIdx);
        // The initial user prompt must NOT carry a `# LAST BEAT` block any
        // more — that lived under `ctx.last_beat` before the agent-loop
        // refactor; tool results now flow as proper user-role messages
        // appended to the per-turn history.
        expect(user).not.toContain('# LAST BEAT');
        // No sheet content should leak into the Director's prompt either.
        expect(user).not.toContain(SHEET_MARKER_KEY);
        const sys = directorSystemPrompt(ctx);
        expect(sys).not.toContain(SHEET_MARKER_KEY);
    });
});

describe('director history: formatToolResult', () => {
    test('renders a per-step tool-result message that mirrors the dispatcher summary', () => {
        const decision = { action: 'speak', actor: 'amelia', intent: 'greet', rationale: 'NPC turn' };
        const summary = 'Amelia (id: `amelia`) just spoke in response to the player\'s input. Default to end_turn.';
        const out = formatToolResult(decision, summary);
        expect(out).toContain('Tool result for `speak`:');
        expect(out).toContain(summary);
        expect(out).toContain('Decide the next beat.');
    });

    test('handles missing summary by emitting "(no details)" without crashing', () => {
        const decision = { action: 'end_turn' };
        const out = formatToolResult(decision, '');
        expect(out).toContain('Tool result for `end_turn`:');
        expect(out).toContain('(no details)');
    });

    test('falls back to action="unknown" when the decision is malformed', () => {
        // @ts-expect-error testing defensive path
        const out = formatToolResult({}, 'whatever happened');
        expect(out).toContain('Tool result for `unknown`:');
    });
});
