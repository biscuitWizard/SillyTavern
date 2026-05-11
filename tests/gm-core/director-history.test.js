/**
 * Tests for the Director's per-turn agent-loop history.
 *
 * Two layers under test:
 *
 *   1. `runTurn` (loop.js) — exercises the loop end-to-end with mock
 *      Director / actor / summarizer clients. Asserts that:
 *        - The history grows correctly across loop iterations, with
 *          assistant `tool_calls` and `role: 'tool'` results pairing up
 *          by `tool_call_id`.
 *        - When a mock Director reports `prompt_tokens` over the threshold
 *          via `onUsage`, the loop fires `collapseOlderTurns` exactly once.
 *        - When `onUsage` reports `null`, no collapse is attempted.
 *        - When no `summarizerClient` is wired, the Director's own client
 *          is used as the fallback summariser.
 *
 *   2. `collapseOlderTurns` / `formatToolResult` (history.js) — pure
 *      helpers that we exercise directly with synthetic histories.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { runTurn } from '../../src/gm-core/director/loop.js';
import {
    collapseOlderTurns,
    formatToolResult,
    SUMMARY_TRIGGER_TOKENS,
    SUMMARY_KEEP_LAST_PAIRS,
} from '../../src/gm-core/director/history.js';

/**
 * Convert a legacy `{ action, ...args }` test fixture into the
 * `ToolCallResponse` shape the new `directorClient.tool()` returns.
 * Keeps existing scripted decisions readable without a per-test rewrite.
 *
 * @param {{ action: string } & Record<string, unknown>} decision
 * @param {number} idx
 */
function decisionToToolCall(decision, idx) {
    const { action, ...args } = decision;
    return {
        id: `call_test_${idx}`,
        name: action,
        arguments: args,
        raw_arguments: JSON.stringify(args),
    };
}

/** Snapshot a single chat message preserving tool-call / tool-result fields. */
function snapshotMessage(m) {
    /** @type {Record<string, unknown>} */
    const out = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
}

// =====================================================================
// Fixtures
// =====================================================================

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
        has_portrait: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    };
}

const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true });
const amelia = makeChar({ id: 'amelia', name: 'Amelia' });
const bran = makeChar({ id: 'bran', name: 'Bran' });

function baseCtx() {
    return {
        campaign: { id: 'demo', name: 'Demo', brief: 'Demo' },
        scene: { id: 'opener', name: 'Opener', location: 'Tavern', status: 'open' },
        actors: [
            { id: 'jack', name: 'Jack', is_player: true },
            { id: 'amelia', name: 'Amelia', is_player: false },
            { id: 'bran', name: 'Bran', is_player: false },
        ],
        recent_transcript: '',
        user_input: 'I look around the tavern.',
    };
}

/**
 * Build a Director mock that returns a scripted sequence of decisions
 * AND optionally fires `onUsage` with a per-call usage snapshot drawn
 * from `usagePerCall[i]`. Captures every messages[] argument so tests
 * can introspect, preserving tool_calls / tool_call_id on each message
 * so assertions can pin the new agent-loop wire shape.
 */
function makeDirector({ decisions, usagePerCall }) {
    const decQueue = [...decisions];
    const usageQueue = usagePerCall ? [...usagePerCall] : null;
    /** @type {Array<Array<Record<string, unknown>>>} */
    const calls = [];
    let callIdx = 0;
    const client = {
        tool: jest.fn(async ({ messages, onUsage }) => {
            calls.push((messages || []).map(snapshotMessage));
            if (decQueue.length === 0) throw new Error('director queue exhausted');
            const decision = decQueue.shift();
            if (onUsage) {
                const usage = usageQueue ? usageQueue.shift() : null;
                onUsage(usage ?? null);
            }
            return decisionToToolCall(decision, callIdx++);
        }),
        chat: jest.fn(async () => 'unused'),
        structured: jest.fn(async () => { throw new Error('director.structured not used in tool-calling mode'); }),
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

function makeSummarizer(reply = '- earlier beats happened') {
    return {
        chat: jest.fn(async () => reply),
        structured: jest.fn(async () => { throw new Error('summarizer.structured not used'); }),
    };
}

// =====================================================================
// runTurn: history growth
// =====================================================================

describe('director loop: messages[] history grows across iterations', () => {
    test('every Director call sees its own prior tool calls and the engine\'s tool results', async () => {
        const ctx = baseCtx();
        const director = makeDirector({
            decisions: [
                { action: 'speak', actor: 'amelia', intent: 'greet warmly', rationale: 'NPC turn' },
                { action: 'speak', actor: 'bran', intent: 'follow up', rationale: 'second NPC' },
                { action: 'end_turn', rationale: 'done' },
            ],
        });
        const actor = makeActor(({ user }) => `(${user.length}-char prose)`);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        expect(director.calls).toHaveLength(3);

        // Call #1: just system + initial user.
        expect(director.calls[0]).toHaveLength(2);
        expect(director.calls[0][0].role).toBe('system');
        expect(director.calls[0][1].role).toBe('user');

        // Call #2: prior assistant tool_call + role:'tool' result message appended.
        expect(director.calls[1]).toHaveLength(4);
        expect(director.calls[1][2].role).toBe('assistant');
        expect(director.calls[1][2].content).toBeNull();
        expect(Array.isArray(director.calls[1][2].tool_calls)).toBe(true);
        expect(director.calls[1][2].tool_calls[0].function.name).toBe('speak');
        const args2 = JSON.parse(director.calls[1][2].tool_calls[0].function.arguments);
        expect(args2.actor).toBe('amelia');
        expect(director.calls[1][3].role).toBe('tool');
        expect(director.calls[1][3].tool_call_id).toBe(director.calls[1][2].tool_calls[0].id);
        expect(director.calls[1][3].content).toContain('Amelia');

        // Call #3: two assistant + two tool-result pairs (history of both speaks).
        expect(director.calls[2]).toHaveLength(6);
        expect(director.calls[2][4].role).toBe('assistant');
        expect(director.calls[2][4].tool_calls[0].function.name).toBe('speak');
        const args3 = JSON.parse(director.calls[2][4].tool_calls[0].function.arguments);
        expect(args3.actor).toBe('bran');
        expect(director.calls[2][5].role).toBe('tool');
        expect(director.calls[2][5].tool_call_id).toBe(director.calls[2][4].tool_calls[0].id);
        expect(director.calls[2][5].content).toContain('Bran');

        // Two actor messages emitted, no quotas in play.
        expect(events.filter(e => e.kind === 'message')).toHaveLength(2);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ kind: 'end_of_turn', reason: 'director' }));
    });
});

// =====================================================================
// runTurn: token-budget collapse trigger
// =====================================================================

describe('director loop: collapses history when prompt_tokens exceeds budget', () => {
    test('a single call reporting tokens > SUMMARY_TRIGGER_TOKENS triggers a collapse before the next call', async () => {
        const ctx = baseCtx();
        // Need enough prior pairs that there's actually something to collapse:
        // collapseOlderTurns is a no-op until the history exceeds
        // 2 + SUMMARY_KEEP_LAST_PAIRS * 2 messages. Speak a handful of
        // narrator beats to grow the history first, then trip the budget.
        const speakBeats = [];
        for (let i = 0; i < SUMMARY_KEEP_LAST_PAIRS + 2; i++) {
            speakBeats.push({ action: 'speak', actor: 'narrator', intent: `beat ${i}`, rationale: 'fill history' });
        }
        const director = makeDirector({
            decisions: [
                ...speakBeats,
                { action: 'end_turn', rationale: 'done' },
            ],
            // Stay under the budget for the first calls; spike on the
            // second-to-last so the collapse fires before end_turn.
            usagePerCall: speakBeats
                .map((_, i) => ({ prompt_tokens: i === speakBeats.length - 1 ? SUMMARY_TRIGGER_TOKENS + 100 : 100, completion_tokens: 50, total_tokens: 150 }))
                .concat([{ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }]),
        });
        const actor = makeActor(() => 'narrator beat');
        const summarizer = makeSummarizer('- (synthetic recap)');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            summarizerClient: summarizer,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        // The summariser was invoked exactly once.
        expect(summarizer.chat).toHaveBeenCalledTimes(1);

        // The final Director call (the end_turn one) saw the collapsed
        // history: still 2 pinned + 1 recap + tail pairs.
        const finalCall = director.calls[director.calls.length - 1];
        const recapMsg = finalCall.find(m => m.role === 'user' && /^# Recap of earlier beats this turn/.test(m.content));
        expect(recapMsg).toBeDefined();
        expect(recapMsg.content).toContain('synthetic recap');

        // Tail intact: the final tool-result message reflects the most
        // recent narrator beat that fired before end_turn — and it's
        // now a proper role: 'tool' message, not a `user` stand-in.
        const lastTool = [...finalCall].reverse().find(m => m.role === 'tool');
        expect(lastTool).toBeDefined();
        expect(lastTool.content).toContain('Narrator');
        expect(lastTool.tool_call_id).toEqual(expect.any(String));

        // System prompt + initial user prompt were preserved.
        expect(finalCall[0].role).toBe('system');
        expect(finalCall[1].role).toBe('user');
        expect(finalCall[1].content).toContain('<player_input>');
    });

    test('when usage reports null (provider omits usage), no collapse is attempted', async () => {
        const ctx = baseCtx();
        const speakBeats = [];
        for (let i = 0; i < SUMMARY_KEEP_LAST_PAIRS + 2; i++) {
            speakBeats.push({ action: 'speak', actor: 'narrator', intent: `beat ${i}`, rationale: 'fill history' });
        }
        const director = makeDirector({
            decisions: [...speakBeats, { action: 'end_turn', rationale: 'done' }],
            // Every call returns null usage — the loop must skip the budget check.
            usagePerCall: speakBeats.map(() => null).concat([null]),
        });
        const actor = makeActor(() => 'narrator beat');
        const summarizer = makeSummarizer();
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            summarizerClient: summarizer,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        // Summariser was never invoked because the loop never saw the
        // budget cross.
        expect(summarizer.chat).not.toHaveBeenCalled();
        // No "Recap of earlier beats" message anywhere.
        const finalCall = director.calls[director.calls.length - 1];
        const recap = finalCall.find(m => m.role === 'user' && /^# Recap of earlier beats this turn/.test(m.content));
        expect(recap).toBeUndefined();
    });

    test('no summarizerClient → the Director\'s own client is used as the fallback summariser', async () => {
        const ctx = baseCtx();
        const speakBeats = [];
        for (let i = 0; i < SUMMARY_KEEP_LAST_PAIRS + 2; i++) {
            speakBeats.push({ action: 'speak', actor: 'narrator', intent: `beat ${i}`, rationale: 'fill history' });
        }
        const director = makeDirector({
            decisions: [...speakBeats, { action: 'end_turn', rationale: 'done' }],
            usagePerCall: speakBeats
                .map((_, i) => ({ prompt_tokens: i === speakBeats.length - 1 ? SUMMARY_TRIGGER_TOKENS + 100 : 100, completion_tokens: 50, total_tokens: 150 }))
                .concat([{ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }]),
        });
        const actor = makeActor(() => 'narrator beat');
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            // NO summarizerClient — the loop should fall back to directorClient.chat.
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        // The fallback path uses directorClient.chat for the summariser
        // call. The Director mock's `chat` is normally idle ('unused') —
        // we just need to confirm it was called at least once for the
        // collapse step.
        expect(director.chat).toHaveBeenCalledTimes(1);
    });
});

// =====================================================================
// runTurn: live transcript refresh
// =====================================================================

describe('director loop: Director sees latest transcript each step', () => {
    test('iteration 2 user prompt contains actor prose emitted in iteration 1', async () => {
        const ctx = baseCtx();
        const director = makeDirector({
            decisions: [
                { action: 'speak', actor: 'amelia', intent: 'greet', rationale: 'first' },
                { action: 'end_turn', rationale: 'done' },
            ],
        });
        const ACTOR_PROSE = 'Hello traveller, welcome to my tavern!';
        const actor = makeActor(() => ACTOR_PROSE);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        expect(director.calls).toHaveLength(2);

        // On the second Director call, the user prompt at [1] should
        // contain the actor's prose from the first iteration.
        const secondCallUserPrompt = director.calls[1][1].content;
        expect(secondCallUserPrompt).toContain('Amelia');
        expect(secondCallUserPrompt).toContain(ACTOR_PROSE);
    });

    test('tool result includes truncated actor prose', async () => {
        const ctx = baseCtx();
        const director = makeDirector({
            decisions: [
                { action: 'speak', actor: 'amelia', intent: 'greet', rationale: 'first' },
                { action: 'end_turn', rationale: 'done' },
            ],
        });
        const ACTOR_PROSE = 'Welcome to the tavern, weary traveller.';
        const actor = makeActor(() => ACTOR_PROSE);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        // The tool result message for the speak should contain the prose
        const toolResult = director.calls[1][3];
        expect(toolResult.role).toBe('tool');
        expect(toolResult.content).toContain(ACTOR_PROSE);
    });
});

// =====================================================================
// runTurn: graceful degradation on parse_failed
// =====================================================================

describe('director loop: graceful degradation on parse failure', () => {
    test('parse_failed from directorClient.tool emits degraded end_of_turn, not fatal error', async () => {
        const ctx = baseCtx();
        const { LlmError } = await import('../../src/gm-core/llm/errors.js');
        const client = {
            tool: jest.fn(async () => {
                throw new LlmError('parse_failed', 'could not parse tool choice', true);
            }),
            chat: jest.fn(async () => 'unused'),
            structured: jest.fn(async () => { throw new Error('unused'); }),
        };
        const events = [];
        await runTurn({
            ctx,
            directorClient: client,
            actorClient: { chat: jest.fn(), structured: jest.fn() },
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        const endEvent = events.find(e => e.kind === 'end_of_turn');
        expect(endEvent).toBeDefined();
        expect(endEvent.reason).toBe('degraded');

        const errorEvent = events.find(e => e.kind === 'error');
        expect(errorEvent).toBeDefined();
        expect(errorEvent.code).toBe('parse_failed');
    });

    test('non-parse errors still emit error end_of_turn', async () => {
        const ctx = baseCtx();
        const { LlmError } = await import('../../src/gm-core/llm/errors.js');
        const client = {
            tool: jest.fn(async () => {
                throw new LlmError('network', 'connection refused', true);
            }),
            chat: jest.fn(async () => 'unused'),
            structured: jest.fn(async () => { throw new Error('unused'); }),
        };
        const events = [];
        await runTurn({
            ctx,
            directorClient: client,
            actorClient: { chat: jest.fn(), structured: jest.fn() },
            emit: (e) => events.push(e),
            findCharacter: (id) => ({ jack, amelia, bran })[id] || null,
        });

        const endEvent = events.find(e => e.kind === 'end_of_turn');
        expect(endEvent).toBeDefined();
        expect(endEvent.reason).toBe('error');
    });
});

// =====================================================================
// collapseOlderTurns: pure helper
// =====================================================================

describe('collapseOlderTurns', () => {
    function buildHistory(pairCount) {
        /** @type {Array<{ role: string, content: string }>} */
        const h = [
            { role: 'system', content: 'SYSTEM' },
            { role: 'user', content: 'INITIAL' },
        ];
        for (let i = 0; i < pairCount; i++) {
            h.push({ role: 'assistant', content: `decision-${i}` });
            h.push({ role: 'user', content: `result-${i}` });
        }
        return h;
    }

    test('no-op when history is shorter than fixed prefix + tail + 1 dropped pair', async () => {
        const summarizer = makeSummarizer();
        const history = buildHistory(SUMMARY_KEEP_LAST_PAIRS); // exactly the tail length
        const before = JSON.stringify(history);
        const result = await collapseOlderTurns(history, summarizer);
        expect(result.collapsed).toBe(false);
        expect(JSON.stringify(history)).toBe(before);
        expect(summarizer.chat).not.toHaveBeenCalled();
    });

    test('keeps system + initial + last K pairs verbatim, replaces middle with one recap user message', async () => {
        const summarizer = makeSummarizer('- recap content');
        // Build history with K + 4 pairs so 4 pairs (8 messages) get dropped.
        const history = buildHistory(SUMMARY_KEEP_LAST_PAIRS + 4);
        const originalLength = history.length;
        const result = await collapseOlderTurns(history, summarizer);

        expect(result.collapsed).toBe(true);
        expect(result.droppedCount).toBe(8);
        expect(result.summary).toBe('- recap content');

        // Pinned prefix.
        expect(history[0]).toEqual({ role: 'system', content: 'SYSTEM' });
        expect(history[1]).toEqual({ role: 'user', content: 'INITIAL' });
        // Recap is index 2.
        expect(history[2].role).toBe('user');
        expect(history[2].content).toContain('# Recap of earlier beats this turn');
        expect(history[2].content).toContain('- recap content');
        // Tail K pairs preserved at the end.
        expect(history.length).toBe(originalLength - 8 + 1);
        const tail = history.slice(history.length - SUMMARY_KEEP_LAST_PAIRS * 2);
        expect(tail).toHaveLength(SUMMARY_KEEP_LAST_PAIRS * 2);
        // Last message is the most recent tool-result.
        expect(tail[tail.length - 1].role).toBe('user');
        expect(tail[tail.length - 1].content).toBe(`result-${SUMMARY_KEEP_LAST_PAIRS + 3}`);
    });

    test('summariser is invoked with the dropped slice as the user prompt', async () => {
        const summarizer = makeSummarizer();
        const history = buildHistory(SUMMARY_KEEP_LAST_PAIRS + 2);
        await collapseOlderTurns(history, summarizer);

        expect(summarizer.chat).toHaveBeenCalledTimes(1);
        const callArgs = summarizer.chat.mock.calls[0][0];
        // The dropped pair was `decision-0` / `result-0` and `decision-1` / `result-1`.
        expect(callArgs.user).toContain('decision-0');
        expect(callArgs.user).toContain('result-0');
        expect(callArgs.user).toContain('decision-1');
        expect(callArgs.user).toContain('result-1');
    });

    test('summariser failure falls back to a deterministic recap so the loop never crashes', async () => {
        const failing = {
            chat: jest.fn(async () => { throw new Error('summariser network down'); }),
        };
        const history = buildHistory(SUMMARY_KEEP_LAST_PAIRS + 2);
        // The dropped pairs are decision-0/result-0 and decision-1/result-1.
        // Make decision-0 a parseable JSON string so the fallback can extract
        // its action; leave decision-1 as the fallback "raw text" path.
        history[2] = { role: 'assistant', content: JSON.stringify({ action: 'speak', actor: 'amelia' }) };
        history[3] = { role: 'user', content: 'Tool result for `speak`: Amelia spoke.' };

        const result = await collapseOlderTurns(history, failing);
        expect(result.collapsed).toBe(true);
        expect(result.summary).toContain('speak');
        // Recap message present.
        expect(history[2].role).toBe('user');
        expect(history[2].content).toContain('# Recap of earlier beats this turn');
    });
});

// =====================================================================
// formatToolResult: pure helper
// =====================================================================

describe('formatToolResult', () => {
    test('returns the summary verbatim, without prefix or trailing nudge', () => {
        // In tool-calling mode the result lands inside a role:'tool'
        // message whose preceding assistant turn already named the
        // tool — so we don't repeat the action name, and we drop the
        // "Decide the next beat." trailer that used to leak into the
        // old role:'user' stand-in and read like a fresh user request.
        const out = formatToolResult({ action: 'spawn_character' }, 'Spawned Bob (id: `bob`).');
        expect(out).toBe('Spawned Bob (id: `bob`).');
        expect(out).not.toMatch(/Tool result for/);
        expect(out).not.toMatch(/Decide the next beat/);
    });

    test('falls back to "(no details from `<action>`)" when the summary is empty', () => {
        const out = formatToolResult({ action: 'end_turn' }, '');
        expect(out).toBe('(no details from `end_turn`)');
    });
});
