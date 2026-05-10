/**
 * Phase 7: search_memory tool gating.
 *
 * Per-role gates live in tool.js so the LLM can never tunnel into a
 * scope it shouldn't see, regardless of what it claims in `args.scope`.
 */

import { describe, test, expect } from '@jest/globals';

import { gateAccess, buildSearchMemoryHandler } from '../../../src/gm-core/rag/tool.js';

describe('gateAccess', () => {
    test('Director: world_lore + director_memory only', () => {
        expect(gateAccess('director', 'world_lore')).toBeNull();
        expect(gateAccess('director', 'director_memory')).toBeNull();
        expect(gateAccess('director', 'character_memory')).not.toBeNull();
        expect(gateAccess('director', 'narrator_memory')).not.toBeNull();
        expect(gateAccess('director', 'player_journal')).not.toBeNull();
    });

    test('Narrator: world_lore + narrator_memory only', () => {
        expect(gateAccess('narrator', 'world_lore')).toBeNull();
        expect(gateAccess('narrator', 'narrator_memory')).toBeNull();
        expect(gateAccess('narrator', 'character_memory')).not.toBeNull();
        expect(gateAccess('narrator', 'director_memory')).not.toBeNull();
    });

    test('Actor: own character_memory + world + journal only', () => {
        expect(gateAccess('actor', 'world_lore')).toBeNull();
        expect(gateAccess('actor', 'player_journal')).toBeNull();
        expect(gateAccess('actor', 'character_memory', { requestingCharacterId: 'jack', scopeCharacterId: 'jack' })).toBeNull();
    });

    test('Actor cannot read another actor\'s character_memory', () => {
        expect(gateAccess('actor', 'character_memory', { requestingCharacterId: 'jack', scopeCharacterId: 'amelia' }))
            .toMatch(/own/);
    });
});

describe('buildSearchMemoryHandler', () => {
    function fakeService() {
        const calls = [];
        return {
            calls,
            search: async (args) => {
                calls.push(args);
                return [{
                    record: {
                        id: 'r1', kind: args.kind, content: 'fact', tags: [],
                        importance: 0.5, valence: 0, temporally_blind: false,
                        decay_override: null, source: '', created_at: '', updated_at: '',
                        scope_id: args.campaignId, metadata: {}, scene_index: 0,
                    },
                    raw_score: 0.7,
                    score: 0.6,
                    decay_multiplier: 0.9,
                }];
            },
        };
    }

    test('Director handler routes world_lore search and rejects character_memory', async () => {
        const svc = fakeService();
        const handler = buildSearchMemoryHandler({
            memoryService: svc,
            campaignId: 'cid',
            role: 'director',
        });
        const ok = await handler({ scope: 'world_lore', query: 'kingdom' });
        expect(ok.ok).toBe(true);
        expect(svc.calls[0].kind).toBe('world_lore');
        const denied = await handler({ scope: 'character_memory', query: 'jack' });
        expect(denied.ok).toBe(false);
        expect(denied.error).toMatch(/Director/);
    });

    test('Actor handler can read its own scope but not others', async () => {
        const svc = fakeService();
        const handler = buildSearchMemoryHandler({
            memoryService: svc,
            campaignId: 'cid',
            role: 'actor',
            characterId: 'jack',
        });
        const own = await handler({ scope: 'character_memory', query: 'remember' });
        expect(own.ok).toBe(true);
        const other = await handler({ scope: 'character_memory', query: 'remember', characterId: 'amelia' });
        expect(other.ok).toBe(false);
    });
});
