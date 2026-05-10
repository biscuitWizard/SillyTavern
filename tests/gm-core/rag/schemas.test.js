/**
 * Phase 7: collection naming and validation.
 *
 *   - All campaign-scoped collections include `__{cid}__` so cross-campaign
 *     character ids never alias.
 *   - `parseCollectionName` is the inverse of `collectionNameFor`.
 *   - `validateMemoryRecord` rejects bad records eagerly.
 */

import { describe, test, expect } from '@jest/globals';

import {
    collectionNameFor,
    parseCollectionName,
    validateMemoryRecord,
    buildMemoryRecord,
    DEFAULT_DECAY,
} from '../../../src/gm-core/rag/schemas.js';

describe('collectionNameFor', () => {
    test('character_memory always carries cid + character_id', () => {
        expect(collectionNameFor('character_memory', 'shadows-of-ironhold', 'jack'))
            .toBe('character_memory__shadows-of-ironhold__jack');
    });

    test('two campaigns can each have a "jack" without collision', () => {
        const a = collectionNameFor('character_memory', 'campaign_a', 'jack');
        const b = collectionNameFor('character_memory', 'campaign_b', 'jack');
        expect(a).not.toBe(b);
    });

    test('world_lore / director_memory / narrator_memory / player_journal carry cid only', () => {
        expect(collectionNameFor('world_lore', 'cid'))
            .toBe('world_lore__cid');
        expect(collectionNameFor('director_memory', 'cid'))
            .toBe('director_memory__cid');
        expect(collectionNameFor('narrator_memory', 'cid'))
            .toBe('narrator_memory__cid');
        expect(collectionNameFor('player_journal', 'cid'))
            .toBe('player_journal__cid');
    });

    test('character_memory without character_id throws', () => {
        expect(() => collectionNameFor('character_memory', 'cid')).toThrow();
    });
});

describe('parseCollectionName', () => {
    test('round-trips world_lore', () => {
        expect(parseCollectionName('world_lore__cid')).toEqual({ kind: 'world_lore', campaign_id: 'cid' });
    });

    test('round-trips character_memory with cid containing a dash', () => {
        expect(parseCollectionName('character_memory__shadows-of-ironhold__jack-0'))
            .toEqual({
                kind: 'character_memory',
                campaign_id: 'shadows-of-ironhold',
                character_id: 'jack-0',
            });
    });

    test('returns null for unknown shapes', () => {
        expect(parseCollectionName('chat_history')).toBeNull();
        expect(parseCollectionName('')).toBeNull();
        expect(parseCollectionName('character_memory__missing')).toBeNull();
    });
});

describe('validateMemoryRecord', () => {
    test('accepts a minimal record', () => {
        const r = buildMemoryRecord({
            id: 'abc', kind: 'character_memory', scope_id: 'cid/jack', content: 'hello',
        });
        expect(validateMemoryRecord(r)).toBeNull();
    });

    test('rejects out-of-range importance', () => {
        const r = buildMemoryRecord({
            id: 'abc', kind: 'character_memory', scope_id: 'cid/jack', content: 'hello',
        });
        r.importance = 2;
        expect(validateMemoryRecord(r)).toMatch(/importance/);
    });

    test('world_lore record requires a payload', () => {
        const r = buildMemoryRecord({
            id: 'abc', kind: 'world_lore', scope_id: 'cid', content: 'fact',
        });
        expect(validateMemoryRecord(r)).toMatch(/world_lore/);
    });

    test('world_lore origin "core" defaults to temporally_blind:true', () => {
        const r = buildMemoryRecord({
            id: 'abc', kind: 'world_lore', scope_id: 'cid', content: 'fact',
            world_lore: { origin: 'core', source_type: 'seed_pack', scene_id: null, entry_kind: 'history', title: 'A fact' },
        });
        expect(r.temporally_blind).toBe(true);
    });

    test('world_lore origin "generated" defaults to temporally_blind:false', () => {
        const r = buildMemoryRecord({
            id: 'abc', kind: 'world_lore', scope_id: 'cid', content: 'fact',
            world_lore: { origin: 'generated', source_type: 'add_lore', scene_id: 's1', entry_kind: 'history', title: 'A fact' },
        });
        expect(r.temporally_blind).toBe(false);
    });
});

describe('DEFAULT_DECAY', () => {
    test('every kind has a decay config', () => {
        for (const kind of ['world_lore', 'character_memory', 'director_memory', 'narrator_memory', 'player_journal']) {
            expect(DEFAULT_DECAY[kind]).toBeDefined();
            expect(DEFAULT_DECAY[kind].half_life).toBeGreaterThan(0);
        }
    });
});
