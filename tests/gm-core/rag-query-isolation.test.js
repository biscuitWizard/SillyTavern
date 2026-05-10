/**
 * M0 invariant — sheet content NEVER seeds RAG retrieval.
 *
 * `pickQueryText(ctx)` in `src/gm-core/director/loop.js` is the single
 * source of `queryText` for every `MemoryService.search()` call inside
 * the Director loop (Director-side RAG, Actor-side RAG, Narrator-side
 * RAG, post-roll Narrator RAG). It MUST read only from
 * `ctx.user_input` and `ctx.recent_transcript` — never from
 * `ctx.actors[].sheet` or any other character-sheet field.
 *
 * If a future refactor adds the sheet to the retrieval query, RAG
 * results would be biased by the sheet's traits / pulse / relationship
 * keys (post-overhaul layout) and could pull in unrelated memories
 * that match those values. This test plants poison tokens in every
 * sheet field and asserts they never appear in the picked query text.
 */

import { describe, test, expect } from '@jest/globals';
import { pickQueryText } from '../../src/gm-core/director/loop.js';

const POISON = {
    APPEARANCE: 'POISON_TOKEN_APPEARANCE_eaeb',
    PERSONALITY: 'POISON_TOKEN_PERSONALITY_b9c2',
    VOICE: 'POISON_TOKEN_VOICE_3f1d',
    BACKGROUND: 'POISON_TOKEN_BACKGROUND_a07c',
    NOTES: 'POISON_TOKEN_NOTES_5e21',
    STAT_KEY: 'POISON_TOKEN_STAT_KEY_d402',
    STAT_VALUE: 'POISON_TOKEN_STAT_VALUE_91b7',
    STATUS_KEY: 'POISON_TOKEN_STATUS_KEY_72ae',
    STATUS_VALUE: 'POISON_TOKEN_STATUS_VALUE_0c33',
    SKILL: 'POISON_TOKEN_SKILL_64fd',
    ITEM_NAME: 'POISON_TOKEN_ITEM_NAME_8aa1',
    ITEM_DESC: 'POISON_TOKEN_ITEM_DESC_5b09',
    REL_KEY: 'POISON_TOKEN_REL_KEY_44c1',
    REL_VALUE: 'POISON_TOKEN_REL_VALUE_22b8',
};

const POISON_VALUES = Object.values(POISON);

const poisonedCharacter = {
    id: 'jack',
    campaign_id: 'demo',
    name: 'Jack Ironwright',
    is_player: true,
    appearance: POISON.APPEARANCE,
    personality: POISON.PERSONALITY,
    voice: POISON.VOICE,
    background: POISON.BACKGROUND,
    sheet: {
        stats: { hp: 24, [POISON.STAT_KEY]: POISON.STAT_VALUE },
        statuses: { [POISON.STATUS_KEY]: POISON.STATUS_VALUE },
        items: [{ id: 'i1', name: POISON.ITEM_NAME, description: POISON.ITEM_DESC, influences: [] }],
        skills: [POISON.SKILL],
        notes: POISON.NOTES,
        relationships: { amelia: { [POISON.REL_KEY]: POISON.REL_VALUE } },
    },
};

function assertNoPoison(text) {
    for (const tok of POISON_VALUES) {
        expect(text).not.toContain(tok);
    }
}

describe('M0 RAG query isolation: sheet content cannot seed retrieval', () => {
    test('pickQueryText returns user_input when present, ignoring sheet content', () => {
        const ctx = {
            user_input: 'I push open the door.',
            recent_transcript: 'Player: I push open the door.',
            actors: [poisonedCharacter],
        };
        const q = pickQueryText(ctx);
        expect(q).toBe('I push open the door.');
        assertNoPoison(q);
    });

    test('pickQueryText falls back to last transcript line when user_input is empty', () => {
        const ctx = {
            user_input: '',
            recent_transcript: 'Narrator: a fire crackles\nAmelia: welcome stranger',
            actors: [poisonedCharacter],
        };
        const q = pickQueryText(ctx);
        expect(q).toBe('Amelia: welcome stranger');
        assertNoPoison(q);
    });

    test('pickQueryText returns empty string when both inputs are silent (no poison reach-around)', () => {
        const ctx = {
            user_input: '',
            recent_transcript: '',
            actors: [poisonedCharacter],
        };
        const q = pickQueryText(ctx);
        expect(q).toBe('');
        assertNoPoison(q);
    });

    test('pickQueryText does not even read ctx.actors when both inputs carry poison-free text', () => {
        // Sanity check: even if user_input and recent_transcript happen to
        // mention something that LOOKS like a sheet field, the function
        // should pass that through verbatim — it never reaches into actors.
        const ctx = {
            user_input: 'I check my inventory for rope.',
            recent_transcript: '',
            actors: [poisonedCharacter],
        };
        const q = pickQueryText(ctx);
        expect(q).toBe('I check my inventory for rope.');
        assertNoPoison(q);
    });

    test('pickQueryText is pure on its inputs: ctx.actors mutations after the call do not affect output', () => {
        const ctx = {
            user_input: 'open the door',
            recent_transcript: '',
            actors: [poisonedCharacter],
        };
        const q1 = pickQueryText(ctx);
        ctx.actors.push({ ...poisonedCharacter, id: 'amelia' });
        const q2 = pickQueryText(ctx);
        expect(q1).toBe(q2);
        assertNoPoison(q2);
    });
});
