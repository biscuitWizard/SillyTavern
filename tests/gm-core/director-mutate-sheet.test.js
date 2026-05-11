/**
 * M8: Director `mutate_sheet` schema + dispatcher tests.
 *
 * The Director gains a structured action that applies one or more
 * sheet edits in a single decision. The contract this file pins:
 *
 *   1. Schema accepts a well-formed `mutate_sheet` decision and rejects
 *      malformed variants (missing character_id, empty ops, missing
 *      per-op required fields, unknown discriminator). Strict
 *      `additionalProperties: false` lives in the JSON Schema for
 *      structured-output mode; the lightweight `validateDirectorDecision`
 *      mirrors the basics so the fallback text-mode JSON path is also
 *      covered.
 *   2. Dispatch applies each op in order via the supplied `mutateSheet`
 *      callback, emits ONE `sheet_mutated` event carrying the per-op
 *      results and the final sheet snapshot, and returns a `continue`
 *      summary so the loop appends a tool-result message into the
 *      Director's history — the Director's next call sees what changed
 *      and can decide whether to follow up with a speak or end_turn.
 *   3. Unknown / out-of-scene `character_id` is a recoverable
 *      `tool_error` — never silently mutates and never ends the turn
 *      with an `error`.
 *   4. Idempotence: re-applying the same `set_stat`/`set_status`/
 *      `clear_*` op produces the same on-disk sheet (proven through
 *      the in-memory mutator under test).
 *   5. Audit: when a `MemoryService` is wired and at least one op
 *      succeeded, a one-line `director_memory` row lands via
 *      `writeSheetMutationAudit`, the `sheet_mutated` event carries
 *      `audit_record_id`, and a `memory_write` event is emitted so
 *      the explorer surfaces the change.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { runTurn } from '../../src/gm-core/director/loop.js';
import {
    validateDirectorDecision,
    validateSheetMutationOp,
    SUPPORTED_ACTIONS,
    SUPPORTED_SHEET_MUTATION_OPS,
    directorDecisionJsonSchema,
} from '../../src/gm-core/director/schemas.js';

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
        sheet: {
            stats: { ...(over.stats || {}) },
            statuses: { ...(over.statuses || {}) },
            items: [...(over.items || [])],
            skills: [...(over.skills || [])],
            notes: over.notes || '',
            relationships: { ...(over.relationships || {}) },
        },
        has_portrait: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    };
}

function baseCtx() {
    return {
        campaign: { id: 'demo', name: 'Demo', brief: 'Demo' },
        scene: { id: 'opener', name: 'Opener', location: 'Tavern', status: 'open' },
        actors: [
            { id: 'jack', name: 'Jack', is_player: true },
            { id: 'amelia', name: 'Amelia', is_player: false },
        ],
        recent_transcript: '',
        user_input: 'I drink the potion.',
    };
}

function snapshotMessage(m) {
    /** @type {Record<string, unknown>} */
    const out = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
}

function decisionToToolCall(decision, idx) {
    const { action, ...args } = decision;
    return {
        id: `call_test_${idx}`,
        name: action,
        arguments: args,
        raw_arguments: JSON.stringify(args),
    };
}

function makeDirector(decisions) {
    const queue = [...decisions];
    /** @type {Array<Array<Record<string, unknown>>>} */
    const calls = [];
    let idx = 0;
    const client = {
        tool: jest.fn(async ({ messages }) => {
            calls.push((messages || []).map(snapshotMessage));
            if (queue.length === 0) throw new Error('director queue exhausted');
            return decisionToToolCall(queue.shift(), idx++);
        }),
        chat: jest.fn(async () => 'unused'),
        structured: jest.fn(async () => { throw new Error('director.structured not used in tool-calling mode'); }),
        calls,
    };
    return client;
}

function makeActor() {
    return {
        chat: jest.fn(async () => 'never spoken in this suite'),
        structured: jest.fn(async () => { throw new Error('actor structured not used'); }),
    };
}

/**
 * Build an in-memory character store with a `mutateSheet(id, op)` that
 * mirrors the dispatch wiring in `endpoints/gm.js` — but without
 * touching disk, so the test suite stays hermetic. Returns helpers the
 * tests use to assert on final state.
 */
function makeStore(initialChars) {
    const map = new Map();
    for (const c of initialChars) map.set(c.id, c);

    const findCharacter = (id) => map.get(id) || null;

    const mutateSheet = jest.fn((characterId, op) => {
        const existing = map.get(characterId);
        if (!existing) return null;
        const sheet = existing.sheet;
        let nextSheet = sheet;
        switch (op.op) {
            case 'set_stat':
                nextSheet = { ...sheet, stats: { ...sheet.stats, [op.key]: op.value } };
                break;
            case 'adjust_stat': {
                const current = Number(sheet.stats[op.key] ?? 0);
                nextSheet = { ...sheet, stats: { ...sheet.stats, [op.key]: current + Number(op.delta) } };
                break;
            }
            case 'clear_stat': {
                const next = { ...sheet.stats };
                delete next[op.key];
                nextSheet = { ...sheet, stats: next };
                break;
            }
            case 'set_status':
                nextSheet = { ...sheet, statuses: { ...sheet.statuses, [op.key]: op.value } };
                break;
            case 'clear_status': {
                const next = { ...sheet.statuses };
                delete next[op.key];
                nextSheet = { ...sheet, statuses: next };
                break;
            }
            case 'add_item': {
                const id = op.id || `item-${(sheet.items.length + 1).toString().padStart(3, '0')}`;
                const next = [...sheet.items, {
                    id,
                    name: String(op.name || ''),
                    description: String(op.description || ''),
                    influences: Array.isArray(op.influences) ? [...op.influences] : [],
                }];
                nextSheet = { ...sheet, items: next };
                break;
            }
            case 'update_item': {
                const next = sheet.items.map(it => it.id === op.item_id
                    ? { ...it,
                        ...(op.name !== undefined ? { name: op.name } : {}),
                        ...(op.description !== undefined ? { description: op.description } : {}),
                        ...(op.influences !== undefined ? { influences: [...op.influences] } : {}),
                    }
                    : it);
                nextSheet = { ...sheet, items: next };
                break;
            }
            case 'remove_item': {
                nextSheet = { ...sheet, items: sheet.items.filter(it => it.id !== op.item_id) };
                break;
            }
            default:
                return null;
        }
        const updated = { ...existing, sheet: nextSheet, updated_at: new Date().toISOString() };
        map.set(characterId, updated);
        return updated;
    });

    return { map, findCharacter, mutateSheet };
}

// =====================================================================
// Schema
// =====================================================================

describe('mutate_sheet schema', () => {
    test('SUPPORTED_ACTIONS includes mutate_sheet', () => {
        expect(SUPPORTED_ACTIONS.has('mutate_sheet')).toBe(true);
    });

    test('SUPPORTED_SHEET_MUTATION_OPS lists all 8 op kinds', () => {
        expect([...SUPPORTED_SHEET_MUTATION_OPS].sort()).toEqual([
            'add_item', 'adjust_stat', 'clear_stat', 'clear_status',
            'remove_item', 'set_stat', 'set_status', 'update_item',
        ]);
    });

    test('directorDecisionJsonSchema includes a MutateSheet variant', () => {
        const titles = directorDecisionJsonSchema.oneOf.map(v => v.title);
        expect(titles).toContain('MutateSheet');
        const variant = directorDecisionJsonSchema.oneOf.find(v => v.title === 'MutateSheet');
        // Strict schema-mode requirements.
        expect(variant.additionalProperties).toBe(false);
        expect(new Set(variant.required)).toEqual(new Set(['action', 'character_id', 'ops', 'rationale']));
        expect(variant.properties.ops.type).toBe('array');
        expect(variant.properties.ops.minItems).toBe(1);
        // Each op entry must itself be a discriminated union.
        const opVariantTitles = variant.properties.ops.items.oneOf.map(v => v.title);
        expect(new Set(opVariantTitles)).toEqual(new Set([
            'SetStat', 'AdjustStat', 'ClearStat',
            'SetStatus', 'ClearStatus',
            'AddItem', 'UpdateItem', 'RemoveItem',
        ]));
        for (const v of variant.properties.ops.items.oneOf) {
            expect(v.additionalProperties).toBe(false);
            expect(v.required).toContain('op');
        }
    });

    test('validateDirectorDecision accepts a well-formed mutate_sheet decision', () => {
        const decision = {
            action: 'mutate_sheet',
            character_id: 'jack',
            ops: [
                { op: 'adjust_stat', key: 'hp', delta: -4 },
                { op: 'set_status', key: 'poisoned', value: 'minor' },
            ],
            rationale: 'trap damage',
        };
        expect(validateDirectorDecision(decision)).toBeNull();
    });

    test('validateDirectorDecision rejects malformed mutate_sheet variants', () => {
        // Single test asserting every malformed shape we want to lock
        // down. Written as one test (not test.each) because the eslint
        // plugin chain (jest + playwright) used by this repo doesn't
        // recognise table-driven tests, and the per-case error message
        // is already self-describing via the `case` field.
        /** @type {Array<{ case: string, decision: any, pattern: RegExp }>} */
        const cases = [
            {
                case: 'missing character_id',
                decision: { action: 'mutate_sheet', ops: [{ op: 'clear_stat', key: 'hp' }], rationale: 'r' },
                pattern: /character_id required/,
            },
            {
                case: 'empty ops array',
                decision: { action: 'mutate_sheet', character_id: 'jack', ops: [], rationale: 'r' },
                pattern: /ops required/,
            },
            {
                case: 'ops missing entirely',
                decision: { action: 'mutate_sheet', character_id: 'jack', rationale: 'r' },
                pattern: /ops required/,
            },
            {
                case: 'unknown op discriminator',
                decision: { action: 'mutate_sheet', character_id: 'jack', ops: [{ op: 'mind_control', key: 'hp' }], rationale: 'r' },
                pattern: /not supported/,
            },
            {
                case: 'set_stat missing value',
                decision: { action: 'mutate_sheet', character_id: 'jack', ops: [{ op: 'set_stat', key: 'hp' }], rationale: 'r' },
                pattern: /value must be number or string/,
            },
            {
                case: 'adjust_stat with non-finite delta',
                decision: { action: 'mutate_sheet', character_id: 'jack', ops: [{ op: 'adjust_stat', key: 'hp', delta: 'a lot' }], rationale: 'r' },
                pattern: /delta must be a finite number/,
            },
            {
                case: 'add_item missing name',
                decision: { action: 'mutate_sheet', character_id: 'jack', ops: [{ op: 'add_item' }], rationale: 'r' },
                pattern: /name required/,
            },
            {
                case: 'remove_item missing item_id',
                decision: { action: 'mutate_sheet', character_id: 'jack', ops: [{ op: 'remove_item' }], rationale: 'r' },
                pattern: /item_id required/,
            },
        ];
        const failures = [];
        for (const c of cases) {
            const err = validateDirectorDecision(c.decision);
            if (err === null || !c.pattern.test(err)) {
                failures.push(`[${c.case}] expected error matching ${c.pattern} but got ${JSON.stringify(err)}`);
            }
        }
        expect(failures).toEqual([]);
    });

    test('validateSheetMutationOp surfaces per-op errors with the index in the message', () => {
        expect(validateSheetMutationOp({ op: 'set_stat', key: 'hp', value: 8 }, 0)).toBeNull();
        expect(validateSheetMutationOp({ op: 'set_status', key: 'poisoned', value: 'minor' }, 0)).toBeNull();
        const err = validateSheetMutationOp({ op: 'add_item', name: '   ' }, 3);
        expect(err).toMatch(/ops\[3\]\.name required/);
    });
});

// =====================================================================
// Dispatch
// =====================================================================

describe('mutate_sheet dispatch', () => {
    test('applies ops in order, emits sheet_mutated, threads the result back via the Director\'s history, and the loop continues to end_turn', async () => {
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true, stats: { hp: 12, max_hp: 12 } });
        const amelia = makeChar({ id: 'amelia', name: 'Amelia' });
        const store = makeStore([jack, amelia]);

        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [
                    { op: 'adjust_stat', key: 'hp', delta: -4 },
                    { op: 'set_status', key: 'poisoned', value: 'minor' },
                    { op: 'add_item', name: 'Antidote Vial', description: 'Cures one dose of poison.' },
                ],
                rationale: 'trap snapped, drank potion',
            },
            { action: 'end_turn', rationale: 'sheet updated' },
        ]);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: store.mutateSheet,
        });

        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);

        const sheetMutated = events.filter(e => e.kind === 'sheet_mutated');
        expect(sheetMutated).toHaveLength(1);
        expect(sheetMutated[0]).toEqual(expect.objectContaining({
            character_id: 'jack',
            character_name: 'Jack',
        }));
        expect(sheetMutated[0].ops_applied).toHaveLength(3);
        expect(sheetMutated[0].ops_applied.every(o => o.ok)).toBe(true);
        expect(sheetMutated[0].ops_applied.map(o => o.op)).toEqual([
            'adjust_stat', 'set_status', 'add_item',
        ]);

        expect(store.mutateSheet).toHaveBeenCalledTimes(3);
        const finalJack = store.findCharacter('jack');
        expect(finalJack.sheet.stats.hp).toBe(8);
        expect(finalJack.sheet.stats.max_hp).toBe(12);
        expect(finalJack.sheet.statuses.poisoned).toBe('minor');
        expect(finalJack.sheet.items.map(i => i.name)).toEqual(['Antidote Vial']);

        // The follow-up Director call must have seen the per-op result in
        // its messages[] history — the loop appends a role:'tool' result
        // anchored to the mutate_sheet call's tool_call_id.
        const followupCall = director.calls[1];
        expect(followupCall).toBeDefined();
        const lastTool = [...followupCall].reverse().find(m => m.role === 'tool');
        expect(lastTool).toBeDefined();
        expect(lastTool.content).toContain('Sheet for Jack');
        expect(lastTool.content).toContain('adjust_stat hp -4');
        expect(lastTool.content).toContain('set_status poisoned');
        expect(lastTool.content).toContain('add_item');

        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn',
            reason: 'director',
        }));
    });

    test('idempotent set_stat — applying the same op twice across two decisions yields the same final value', async () => {
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true, stats: { hp: 12 } });
        const store = makeStore([jack]);

        const ctx = baseCtx();
        ctx.actors = [{ id: 'jack', name: 'Jack', is_player: true }];
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [{ op: 'set_stat', key: 'hp', value: 8 }],
                rationale: 'first set',
            },
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [{ op: 'set_stat', key: 'hp', value: 8 }],
                rationale: 'second set (idempotent)',
            },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: store.mutateSheet,
        });

        const sheetMutated = events.filter(e => e.kind === 'sheet_mutated');
        expect(sheetMutated).toHaveLength(2);
        // Final on-disk hp is the same regardless of how many times we set it.
        expect(store.findCharacter('jack').sheet.stats.hp).toBe(8);
        // Both decisions reported success.
        expect(sheetMutated.every(e => e.ops_applied[0].ok)).toBe(true);
    });

    test('character_id not in scene → recoverable tool_error, mutateSheet never called, loop continues', async () => {
        const amelia = makeChar({ id: 'amelia', name: 'Amelia' });
        const store = makeStore([amelia]);
        const ctx = baseCtx();
        // Bran is NOT in the scene roster.
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'bran',
                ops: [{ op: 'set_stat', key: 'hp', value: 1 }],
                rationale: 'oops, off-stage',
            },
            { action: 'end_turn', rationale: 'recover' },
        ]);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: store.mutateSheet,
        });

        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        const toolErrors = events.filter(e => e.kind === 'tool_error');
        expect(toolErrors).toHaveLength(1);
        expect(toolErrors[0].tool).toBe('mutate_sheet');
        expect(toolErrors[0].code).toBe('unknown_character');
        expect(store.mutateSheet).not.toHaveBeenCalled();
        // Recovery call must have seen the tool error in its history.
        const followupCall = director.calls[1];
        expect(followupCall).toBeDefined();
        const lastTool = [...followupCall].reverse().find(m => m.role === 'tool');
        expect(lastTool.content).toContain('Tool error from `mutate_sheet`');
        // Loop ended cleanly via the recovery, not via a hard error.
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'director',
        }));
    });

    test('mutateSheet returning null is reported as a per-op failure but does not crash the loop', async () => {
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true, stats: { hp: 10 } });
        const store = makeStore([jack]);
        const failingMutator = jest.fn((characterId, op) => {
            if (op.op === 'remove_item') return null; // simulate "no such item"
            return store.mutateSheet(characterId, op);
        });

        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [
                    { op: 'set_stat', key: 'hp', value: 7 },
                    { op: 'remove_item', item_id: 'nonexistent' },
                ],
                rationale: 'partial',
            },
            { action: 'end_turn', rationale: 'continue' },
        ]);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: failingMutator,
        });

        const sheetMutated = events.find(e => e.kind === 'sheet_mutated');
        expect(sheetMutated).toBeDefined();
        expect(sheetMutated.ops_applied).toHaveLength(2);
        expect(sheetMutated.ops_applied[0]).toEqual(expect.objectContaining({ op: 'set_stat', ok: true }));
        expect(sheetMutated.ops_applied[1]).toEqual(expect.objectContaining({ op: 'remove_item', ok: false }));
        // The successful op still landed.
        expect(store.findCharacter('jack').sheet.stats.hp).toBe(7);
        // The follow-up Director call sees the partial-failure summary
        // in its history so it knows what landed and what didn't.
        const followupCall = director.calls[1];
        expect(followupCall).toBeDefined();
        const lastTool = [...followupCall].reverse().find(m => m.role === 'tool');
        expect(lastTool.content).toMatch(/1 op applied, 1 failed/);
        expect(lastTool.content).toContain('Some ops failed');
    });

    test('missing mutateSheet callback → unrecoverable error, ends turn with reason=error', async () => {
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true });
        const store = makeStore([jack]);
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [{ op: 'set_stat', key: 'hp', value: 1 }],
                rationale: 'no writer wired',
            },
        ]);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            // mutateSheet intentionally omitted
        });
        const errors = events.filter(e => e.kind === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('no_sheet_writer');
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
            kind: 'end_of_turn', reason: 'error',
        }));
    });

    test('refreshes ctx.actors[i] identity blurbs so a follow-up speak uses the latest character record', async () => {
        // After mutate_sheet, the test invokes speak: <same actor> on the
        // very next decision. The dispatcher should pull the updated
        // character from findCharacter (which the in-memory store
        // refreshes inside mutateSheet) so the actor prompt's sheet YAML
        // reflects the new stats.
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: false, stats: { hp: 10 } });
        const store = makeStore([jack]);
        const ctx = baseCtx();
        ctx.actors = [
            { id: 'pc', name: 'PC', is_player: true },
            { id: 'jack', name: 'Jack', is_player: false },
        ];
        const seenSheetSnapshots = [];
        const actor = {
            chat: jest.fn(async ({ user }) => {
                const m = user.match(/<character_sheet[^>]*>\n([\s\S]*?)<\/character_sheet>/);
                seenSheetSnapshots.push(m ? m[1] : '');
                return 'I groan and sit up.';
            }),
            structured: jest.fn(),
        };
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [{ op: 'set_stat', key: 'hp', value: 3 }],
                rationale: 'took damage',
            },
            { action: 'speak', actor: 'jack', intent: 'react to the wound', rationale: 'voice' },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: actor,
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: store.mutateSheet,
        });
        expect(events.filter(e => e.kind === 'sheet_mutated')).toHaveLength(1);
        expect(events.filter(e => e.kind === 'message')).toHaveLength(1);
        expect(seenSheetSnapshots).toHaveLength(1);
        // The actor's prompt YAML must show hp=3 (the post-mutation value),
        // not the pre-mutation 10.
        expect(seenSheetSnapshots[0]).toMatch(/hp:\s*3\b/);
        expect(seenSheetSnapshots[0]).not.toMatch(/hp:\s*10\b/);
    });
});

// =====================================================================
// Audit
// =====================================================================

describe('mutate_sheet audit (director_memory)', () => {
    test('with MemoryService present: writes a one-line audit row, emits memory_write, and stamps audit_record_id on sheet_mutated', async () => {
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true, stats: { hp: 10 } });
        const store = makeStore([jack]);
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [
                    { op: 'adjust_stat', key: 'hp', delta: -2 },
                    { op: 'set_status', key: 'poisoned', value: 'minor' },
                ],
                rationale: 'audit me',
            },
            { action: 'end_turn', rationale: 'done' },
        ]);

        const writes = [];
        const memoryService = {
            for_director: jest.fn(async () => ({ world: [], director: [] })),
            for_narrator: jest.fn(async () => ({ world: [], narrator: [] })),
            for_character: jest.fn(async () => ({ character: [], world: [], player_journal: [] })),
            search: jest.fn(async () => []),
            write: jest.fn(async ({ campaignId, record }) => {
                writes.push({ campaignId, record });
                return { id: record.id };
            }),
        };

        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: store.mutateSheet,
            memoryService,
            sceneIndex: 7,
        });

        // Exactly one director_memory write for the audit row.
        const auditWrites = writes.filter(w => w.record.kind === 'director_memory');
        expect(auditWrites).toHaveLength(1);
        const rec = auditWrites[0].record;
        expect(auditWrites[0].campaignId).toBe('demo');
        expect(rec.scope_id).toBe('demo');
        expect(rec.scene_index).toBe(7);
        expect(rec.tags).toEqual(expect.arrayContaining(['sheet_mutation', 'character:jack']));
        expect(rec.content).toContain('Sheet for Jack');
        expect(rec.content).toContain('adjust_stat hp -2');
        expect(rec.content).toContain('set_status poisoned');
        expect(rec.source).toBe('director-mutate-sheet:opener:jack');

        // Explorer surface: sheet_mutated carries the audit id and a
        // memory_write event was emitted alongside.
        const sheetMutated = events.find(e => e.kind === 'sheet_mutated');
        expect(sheetMutated.audit_record_id).toBe(rec.id);
        const memoryWrites = events.filter(e => e.kind === 'memory_write' && e.memory_kind === 'director_memory');
        expect(memoryWrites).toHaveLength(1);
        expect(memoryWrites[0].record_id).toBe(rec.id);
    });

    test('without MemoryService: still applies ops + emits sheet_mutated, no crash, no memory_write', async () => {
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true, stats: { hp: 10 } });
        const store = makeStore([jack]);
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [{ op: 'set_stat', key: 'hp', value: 9 }],
                rationale: 'no memory wired',
            },
            { action: 'end_turn', rationale: 'done' },
        ]);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: store.mutateSheet,
            // memoryService deliberately omitted
        });
        expect(events.filter(e => e.kind === 'error')).toHaveLength(0);
        expect(events.filter(e => e.kind === 'memory_write')).toHaveLength(0);
        const sheetMutated = events.find(e => e.kind === 'sheet_mutated');
        expect(sheetMutated.audit_record_id).toBeUndefined();
        expect(store.findCharacter('jack').sheet.stats.hp).toBe(9);
    });

    test('no audit row written when every op failed', async () => {
        const jack = makeChar({ id: 'jack', name: 'Jack', is_player: true, stats: { hp: 10 } });
        const store = makeStore([jack]);
        const memoryService = {
            for_director: jest.fn(async () => ({ world: [], director: [] })),
            write: jest.fn(async () => ({})),
        };
        const ctx = baseCtx();
        const director = makeDirector([
            {
                action: 'mutate_sheet',
                character_id: 'jack',
                ops: [{ op: 'remove_item', item_id: 'no-such' }],
                rationale: 'all-fail',
            },
            { action: 'end_turn', rationale: 'recover' },
        ]);
        const failingMutator = jest.fn(() => null);
        const events = [];
        await runTurn({
            ctx,
            directorClient: director,
            actorClient: makeActor(),
            emit: (e) => events.push(e),
            findCharacter: store.findCharacter,
            mutateSheet: failingMutator,
            memoryService,
            sceneIndex: 1,
        });
        expect(memoryService.write).not.toHaveBeenCalled();
        const sheetMutated = events.find(e => e.kind === 'sheet_mutated');
        expect(sheetMutated.audit_record_id).toBeUndefined();
        expect(sheetMutated.ops_applied[0].ok).toBe(false);
    });
});
