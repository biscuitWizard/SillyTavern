/**
 * Phase 7: injection block format invariants.
 *
 *   - Empty hits → empty string (caller can splice unconditionally).
 *   - Block carries canonical XML tags (e.g. `<character_memory id="jack">`)
 *     so the transcript-cleanliness assertion can grep for it.
 *   - Dedupes by record id.
 *   - Caps at the requested max.
 */

import { describe, test, expect } from '@jest/globals';

import { formatBlock, formatSections, INJECTION_HEADER_PREFIX, INJECTION_FOOTER } from '../../../src/gm-core/rag/injection.js';

const baseRec = (id, content, extra = {}) => ({
    record: {
        id,
        kind: 'character_memory',
        scope_id: 'cid/jack',
        content,
        tags: [],
        importance: 0.5,
        valence: 0,
        temporally_blind: false,
        decay_override: null,
        source: '',
        created_at: '',
        updated_at: '',
        metadata: {},
        scene_index: 0,
        ...extra,
    },
    raw_score: 0.9,
    score: 0.9,
    decay_multiplier: 1.0,
});

describe('formatBlock', () => {
    test('empty hits → empty string', () => {
        expect(formatBlock([], { kind: 'character_memory' })).toBe('');
    });

    test('opens with <kind id="label"> tag, closes with </kind>', () => {
        const out = formatBlock([baseRec('a', 'first')], { kind: 'character_memory', label: 'jack' });
        expect(out).toContain('<character_memory id="jack">');
        expect(out.trim().endsWith('</character_memory>')).toBe(true);
    });

    test('dedupes by id', () => {
        const out = formatBlock(
            [baseRec('a', 'first'), baseRec('a', 'duplicate'), baseRec('b', 'second')],
            { kind: 'character_memory', max: 5 },
        );
        expect(out).toContain('first');
        expect(out).toContain('second');
        expect(out).not.toContain('duplicate');
    });

    test('respects max', () => {
        const hits = [];
        for (let i = 0; i < 10; i++) hits.push(baseRec(`r${i}`, `content ${i}`));
        const out = formatBlock(hits, { kind: 'world_lore', max: 3 });
        const matches = out.match(/content/g) || [];
        expect(matches).toHaveLength(3);
    });

    test('renders world_lore title prefix when available', () => {
        const r = baseRec('a', 'detail', {
            kind: 'world_lore',
            world_lore: { origin: 'core', source_type: 'seed_pack', scene_id: null, entry_kind: 'history', title: 'The Sundering' },
        });
        const out = formatBlock([r], { kind: 'world_lore' });
        expect(out).toContain('**The Sundering** — detail');
    });
});

describe('formatSections', () => {
    test('drops empty sections cleanly', () => {
        const out = formatSections([
            { kind: 'character_memory', label: 'jack', hits: [] },
            { kind: 'world_lore', hits: [baseRec('a', 'fact', { kind: 'world_lore', world_lore: { origin: 'core', source_type: 'seed_pack', scene_id: null, entry_kind: 'history', title: 'A' } })] },
        ]);
        expect(out).not.toContain('character_memory');
        expect(out).toContain('world_lore');
    });
});
