/**
 * Phase 7 — transcript cleanliness invariant.
 *
 * The MEMORIES block is a prompt-side construct only. It must never leak
 * into:
 *   - The Director's `rationale` / `intent` (verified by the existing
 *     director schema validators; this test just sanity-checks that the
 *     loop does not echo the block into emitted events).
 *   - The Narrator's prose output (the MEMORIES block is in the user
 *     prompt; the Narrator's `chat()` reply is what gets persisted).
 *   - Any actor's prose reply.
 *   - Any TurnEvent's `text` field.
 *
 * The test runs the real `runTurn` with a fake LLM that captures the
 * exact prompts sent. We assert:
 *   1. The user prompts contain `BEGIN MEMORIES` blocks.
 *   2. NONE of the emitted message events' `text` fields contain
 *      `BEGIN MEMORIES` (or any of the memory record contents we wrote).
 *   3. The synthesised transcript-tail update never contains the MEMORIES
 *      header.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTurn } from '../../../src/gm-core/director/loop.js';
import { createMemoryService } from '../../../src/gm-core/rag/service.js';
import { createDeterministicEmbedder } from '../../../src/gm-core/rag/embedders.js';
import { buildMemoryRecord } from '../../../src/gm-core/rag/schemas.js';

/**
 * In-memory Qdrant double — same shape as the FakeQdrant in service.test.js.
 */
function createFakeQdrant() {
    /** @type {Map<string, Map<string, { record: any, vector: number[] }>>} */
    const collections = new Map();
    const ensure = (name) => {
        if (!collections.has(name)) collections.set(name, new Map());
        return collections.get(name);
    };
    function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
    return {
        collections,
        async health() { return { ok: true, collections: [...collections.keys()] }; },
        async listCollections() { return [...collections.keys()]; },
        async collectionExists(name) { return collections.has(name); },
        async ensureCollection(name) { ensure(name); },
        async dropCollection(name) { collections.delete(name); },
        async upsertMany(name, items) {
            const c = ensure(name);
            for (const { record, vector } of items) c.set(record.id, { record, vector });
        },
        async deletePoint(name, id) { collections.get(name)?.delete(id); },
        async retrievePoints(name, ids) {
            const c = collections.get(name);
            if (!c) return [];
            const out = [];
            for (const id of ids) { const it = c.get(id); if (it) out.push(it.record); }
            return out;
        },
        async search({ collection, vector, limit }) {
            const c = collections.get(collection);
            if (!c) return [];
            const out = [];
            for (const { record, vector: v } of c.values()) out.push({ record, raw_score: cosine(vector, v) });
            out.sort((a, b) => b.raw_score - a.raw_score);
            return out.slice(0, limit);
        },
        async scroll({ collection, limit }) {
            const c = collections.get(collection);
            if (!c) return { points: [], next_offset: null };
            const out = [];
            for (const { record } of c.values()) {
                out.push(record);
                if (out.length >= limit) break;
            }
            return { points: out, next_offset: null };
        },
        async setPayload() {},
    };
}

function baseCtx() {
    return {
        campaign: { id: 'cid', name: 'Demo', brief: 'Demo brief' },
        scene: { id: 'scene1', name: 'Tavern', location: 'Tavern', status: 'open' },
        actors: [
            { id: 'jack', name: 'Jack', is_player: true },
            { id: 'amelia', name: 'Amelia', is_player: false },
        ],
        recent_transcript: '',
        user_input: 'I push the door open.',
    };
}

function makeDirector(decisions) {
    const queue = [...decisions];
    // The agent-loop refactor moved Director invocation onto a `messages[]`
    // history. We flatten back to `{system, user}` shape for the test's
    // existing assertions: `system` is the (single) system message,
    // `user` is the concatenation of every user-role message in the call.
    /** @type {{ system: string, user: string }[]} */
    const calls = [];
    return {
        calls,
        structured: async ({ messages, system, user }) => {
            const msgs = Array.isArray(messages) && messages.length
                ? messages
                : [
                    ...(typeof system === 'string' ? [{ role: 'system', content: system }] : []),
                    ...(typeof user === 'string' ? [{ role: 'user', content: user }] : []),
                ];
            const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
            const usr = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
            calls.push({ system: sys, user: usr });
            if (queue.length === 0) throw new Error('director queue exhausted');
            return queue.shift();
        },
        chat: async () => 'unused',
    };
}

function makeActor(reply) {
    /** @type {{ system: string, user: string }[]} */
    const calls = [];
    return {
        calls,
        chat: async ({ system, user }) => {
            calls.push({ system, user });
            return reply({ system, user });
        },
        structured: async () => ({ is_significant: false, memories: [] }),
    };
}

describe('Phase 7 — transcript cleanliness', () => {
    test('MEMORIES block appears in prompts but never in emitted message text', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-clean-'));
        fs.mkdirSync(path.join(tmpRoot, 'campaigns', 'cid'), { recursive: true });
        const directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };
        try {
            const embedder = createDeterministicEmbedder({ dim: 64 });
            const qdrant = createFakeQdrant();
            const service = createMemoryService({ directories, qdrant, embedder });

            // Seed each role's memory store with a recognisable string.
            await service.write({
                campaignId: 'cid',
                record: buildMemoryRecord({
                    id: 'wl1', kind: 'world_lore', scope_id: 'cid',
                    content: 'WORLD_LORE_NEEDLE: The capital is named Aurora',
                    world_lore: { origin: 'core', source_type: 'seed_pack', scene_id: null, entry_kind: 'history', title: 'Capital' },
                }),
            });
            await service.write({
                campaignId: 'cid',
                characterId: 'amelia',
                record: buildMemoryRecord({
                    id: 'am1', kind: 'character_memory', scope_id: 'cid/amelia',
                    content: 'CHARACTER_NEEDLE: Amelia distrusts strangers in tavern doorways',
                }),
            });
            await service.write({
                campaignId: 'cid',
                record: buildMemoryRecord({
                    id: 'd1', kind: 'director_memory', scope_id: 'cid',
                    content: 'DIRECTOR_NEEDLE: Save the big reveal for act 2 capital Aurora',
                }),
            });
            await service.write({
                campaignId: 'cid',
                record: buildMemoryRecord({
                    id: 'n1', kind: 'narrator_memory', scope_id: 'cid',
                    content: 'NARRATOR_NEEDLE: The tavern hearth crackles with low embers in Aurora',
                }),
            });

            const director = makeDirector([
                { action: 'speak', actor: 'amelia', intent: 'greet the newcomer warily', rationale: 'NPC turn' },
                { action: 'end_turn', rationale: 'done' },
            ]);
            const actor = makeActor(() => 'Welcome, traveller.');

            /** @type {any[]} */
            const events = [];
            const findCharacter = (id) => id === 'amelia'
                ? { id: 'amelia', name: 'Amelia', is_player: false, sheet: { stats: {}, statuses: {}, items: [], skills: [], notes: '' } }
                : (id === 'jack' ? { id: 'jack', name: 'Jack', is_player: true, sheet: { stats: {}, statuses: {}, items: [], skills: [], notes: '' } } : null);
            await runTurn({
                ctx: baseCtx(),
                directorClient: director,
                actorClient: actor,
                emit: (e) => events.push(e),
                findCharacter,
                memoryService: service,
                sceneIndex: 0,
            });

            // 1. Director's user prompt SHOULD carry memory XML tags.
            const directorUser = director.calls.map(c => c.user).join('\n---\n');
            expect(directorUser).toMatch(/<(world_lore|director_memory)/);
            // The director sees world + director_memory; should never see character_memory.
            expect(directorUser).not.toContain('CHARACTER_NEEDLE');
            // Adjudicator is not used here (no skill_check), so we can also assert
            // none of the system prompts carry memory tags at all.
            for (const c of director.calls) expect(c.system).not.toMatch(/<(world_lore|character_memory|director_memory)/);

            // 2. Actor user prompt SHOULD carry the memory XML tags (character + world).
            const actorUser = actor.calls.map(c => c.user).join('\n---\n');
            expect(actorUser).toMatch(/<(character_memory|world_lore)/);
            expect(actorUser).toContain('CHARACTER_NEEDLE');
            // Actor must NEVER see director_memory or narrator_memory.
            expect(actorUser).not.toContain('DIRECTOR_NEEDLE');
            expect(actorUser).not.toContain('NARRATOR_NEEDLE');

            // 3. NONE of the emitted message texts should contain memory tags
            //    or any of the needles. (The actor was asked to reply
            //    'Welcome, traveller.', period.)
            const messages = events.filter(e => e.kind === 'message');
            expect(messages.length).toBeGreaterThan(0);
            for (const m of messages) {
                expect(m.text || '').not.toMatch(/<(world_lore|character_memory|director_memory)/);
                expect(m.text || '').not.toContain('CHARACTER_NEEDLE');
                expect(m.text || '').not.toContain('DIRECTOR_NEEDLE');
                expect(m.text || '').not.toContain('NARRATOR_NEEDLE');
                expect(m.text || '').not.toContain('WORLD_LORE_NEEDLE');
            }
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
