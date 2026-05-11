/**
 * Phase 5 invariant: an actor's prompt sees only its own sheet and
 * descriptions, never another actor's. The Director loop achieves this by
 * passing only the active character into `actorSystemPrompt` /
 * `actorUserPrompt` — these tests pin that contract so a future regression
 * (e.g. accidentally splicing `ctx.actors` into the prompt) fails fast.
 */

import { describe, test, expect } from '@jest/globals';
import { actorSystemPrompt, actorUserPrompt } from '../../src/gm-core/actors/prompts.js';
import { renderSheetYaml } from '../../src/gm-core/library/yaml.js';

/** Compact layout used by the M3 assertions (no need to load YAML for a unit test). */
const layout = {
    version: 1,
    categories: [
        {
            id: 'abilities', label: 'Abilities', kind: 'stats',
            fields: [
                { key: 'strength', label: 'STR', type: 'number' },
                { key: 'wisdom', label: 'WIS', type: 'number' },
            ],
        },
        {
            id: 'combat', label: 'Combat', kind: 'stats',
            fields: [
                { key: 'hp', label: 'HP', type: 'bar', max_from_key: 'max_hp' },
                { key: 'max_hp', label: 'Max HP', type: 'number' },
            ],
        },
        { id: 'skills', label: 'Skills', kind: 'skills', show_all_from_ruleset: true },
        { id: 'inventory', label: 'Inventory', kind: 'items' },
        { id: 'conditions', label: 'Conditions', kind: 'statuses' },
        { id: 'relationships', label: 'Relationships', kind: 'relationships', per_target_fields: [] },
    ],
};

const jack = {
    id: 'jack',
    campaign_id: 'demo',
    name: 'Jack Ironwright',
    is_player: true,
    appearance: 'Tall, sun-bleached hair, scarred jaw.',
    personality: 'Soft-spoken in calm rooms, fast and final under pressure.',
    voice: 'Low and clipped; idioms from the river country.',
    background: 'Veteran of the JACK_BACKGROUND_MARKER border wars.',
    sheet: {
        stats: { strength: 16, hp: 24, max_hp: 24, JACK_SECRET_STAT: 99 },
        statuses: { JACK_HIDDEN_STATUS: 'tracking the heist' },
        items: [],
        skills: ['perception'],
        notes: '',
    },
};

const amelia = {
    id: 'amelia',
    campaign_id: 'demo',
    name: 'Amelia Verra',
    is_player: false,
    appearance: 'Weathered keeper, AMELIA_APPEARANCE_MARKER short grey beard.',
    personality: 'Patient and shrewd.',
    voice: 'Warm and slow.',
    background: 'AMELIA_BACKGROUND_MARKER ran the tavern through three regimes.',
    sheet: {
        stats: { wisdom: 14, AMELIA_SECRET_STAT: 7 },
        statuses: { AMELIA_HIDDEN_STATUS: 'sizes up the strangers' },
        items: [],
        skills: ['insight'],
        notes: '',
    },
};

const ctx = {
    campaign: { id: 'demo', name: 'Demo Campaign', brief: 'A quiet town with old debts.' },
    scene: { id: 'opener', name: 'The Tavern Door', location: 'Riverside Inn', status: 'open' },
    actors: [
        { id: jack.id, name: jack.name, is_player: true, appearance: jack.appearance, personality: jack.personality, voice: jack.voice, background: jack.background },
        { id: amelia.id, name: amelia.name, is_player: false, appearance: amelia.appearance, personality: amelia.personality, voice: amelia.voice, background: amelia.background },
    ],
    recent_transcript: 'Player: I push open the door.',
    user_input: 'I push open the door.',
};

describe('actor prompts: per-actor scope', () => {
    // M0: the sheet YAML now lives in the USER prompt (after the MEMORIES
    // block) rather than the SYSTEM prompt. Per-actor isolation is still
    // the property under test — sheet markers may live in either prompt
    // depending on the M0/M3 changes — so the assertions check the
    // combined output of (system + user) for both presence (own data) and
    // absence (other actor's data).

    test('Amelia\'s prompts contain Amelia\'s identity + sheet but never Jack\'s', () => {
        const sys = actorSystemPrompt(ctx, amelia);
        const user = actorUserPrompt(ctx, amelia, 'react warily to the strangers');
        const combined = `${sys}\n${user}`;
        expect(combined).toContain('Amelia');
        expect(combined).toContain('AMELIA_APPEARANCE_MARKER');
        expect(combined).toContain('AMELIA_BACKGROUND_MARKER');
        expect(combined).toContain('AMELIA_SECRET_STAT');
        expect(combined).toContain('AMELIA_HIDDEN_STATUS');
        expect(combined).not.toContain('Jack Ironwright');
        expect(combined).not.toContain('JACK_BACKGROUND_MARKER');
        expect(combined).not.toContain('JACK_SECRET_STAT');
        expect(combined).not.toContain('JACK_HIDDEN_STATUS');
    });

    test('Jack\'s prompts contain Jack\'s identity + sheet but never Amelia\'s', () => {
        const sys = actorSystemPrompt(ctx, jack);
        const user = actorUserPrompt(ctx, jack, 'push the door open and step in');
        const combined = `${sys}\n${user}`;
        expect(combined).toContain('Jack Ironwright');
        expect(combined).toContain('JACK_BACKGROUND_MARKER');
        expect(combined).toContain('JACK_SECRET_STAT');
        expect(combined).toContain('JACK_HIDDEN_STATUS');
        expect(combined).not.toContain('Amelia Verra');
        expect(combined).not.toContain('AMELIA_BACKGROUND_MARKER');
        expect(combined).not.toContain('AMELIA_SECRET_STAT');
        expect(combined).not.toContain('AMELIA_HIDDEN_STATUS');
    });

    test('system prompt is sheet-free; sheet lives in the user prompt (M0 invariant)', () => {
        const sys = actorSystemPrompt(ctx, amelia);
        const user = actorUserPrompt(ctx, amelia, 'react warily to the strangers');
        // System prompt covers identity + voice rules but not the KV stat values.
        expect(sys).not.toContain('AMELIA_SECRET_STAT');
        expect(sys).not.toContain('AMELIA_HIDDEN_STATUS');
        // Sheet YAML (with the markers) is in the user prompt.
        expect(user).toContain('AMELIA_SECRET_STAT');
        expect(user).toContain('AMELIA_HIDDEN_STATUS');
    });

    test('user prompt carries scene + transcript but no other-actor sheets', () => {
        const user = actorUserPrompt(ctx, amelia, 'react warily to the strangers');
        expect(user).toContain('Demo Campaign');
        expect(user).toContain('The Tavern Door');
        expect(user).toContain('I push open the door.');
        expect(user).toContain('react warily');
        expect(user).not.toContain('JACK_BACKGROUND_MARKER');
        expect(user).not.toContain('JACK_SECRET_STAT');
        expect(user).not.toContain('JACK_HIDDEN_STATUS');
    });

    test('builder is per-actor: a hand-built ctx with only the active actor still produces a valid prompt', () => {
        const isolatedCtx = { ...ctx, actors: [ctx.actors[1]] };
        const sys = actorSystemPrompt(isolatedCtx, amelia);
        const user = actorUserPrompt(isolatedCtx, amelia, 'react warily');
        expect(sys).toContain('Amelia');
        expect(`${sys}\n${user}`).not.toContain('Jack Ironwright');
    });
});

describe('M3: layout-aware sheet YAML in actor prompts', () => {
    const jackWithRel = {
        ...jack,
        sheet: {
            ...jack.sheet,
            stats: { strength: 16, wisdom: 12, hp: 24, max_hp: 24, JACK_SECRET_STAT: 99, custom_player_added_key: 'preserve me' },
            statuses: { JACK_HIDDEN_STATUS: 'tracking the heist', on_fire: 'minor' },
            items: [{ id: 'i1', name: 'Iron Sword', description: 'cold to the touch', influences: ['strength'] }],
            relationships: { amelia: { stage: 'wary', affection: 30 } },
        },
    };
    const ameliaWithRel = {
        ...amelia,
        sheet: {
            ...amelia.sheet,
            stats: { wisdom: 14, AMELIA_SECRET_STAT: 7 },
            relationships: { jack: { stage: 'host', affection: 50 } },
        },
    };

    test('user prompt emits one block per layout category (categorized YAML)', () => {
        const ctxWithLayout = { ...ctx, sheet_layout: layout };
        const user = actorUserPrompt(ctxWithLayout, jackWithRel, 'push the door open');
        // Category-named YAML keys appear (the M3 contract).
        expect(user).toContain('abilities:');
        expect(user).toContain('combat:');
        expect(user).toContain('skills:');
        expect(user).toContain('inventory:');
        expect(user).toContain('conditions:');
        expect(user).toContain('relationships:');
        // The legacy flat `stats:` / `statuses:` / `items:` / `notes:`
        // headers should NOT appear when the layout is in play (they're
        // replaced by the categorized blocks).
        const inFenced = extractYamlFence(user);
        expect(inFenced).toMatch(/^abilities:$/m);
        expect(inFenced).not.toMatch(/^stats:$/m);
        expect(inFenced).not.toMatch(/^statuses:$/m);
        // Category content is correctly assigned.
        expect(inFenced).toMatch(/^abilities:\n(?:.*\n)*?  strength: 16/m);
        expect(inFenced).toMatch(/^combat:\n(?:.*\n)*?  hp: 24/m);
        expect(inFenced).toMatch(/^conditions:\n(?:.*\n)*?  on_fire: minor/m);
    });

    test('player-added stats survive under an `other:` block (extras footer)', () => {
        const ctxWithLayout = { ...ctx, sheet_layout: layout };
        const user = actorUserPrompt(ctxWithLayout, jackWithRel, 'push the door open');
        const inFenced = extractYamlFence(user);
        expect(inFenced).toContain('other:');
        expect(inFenced).toContain('custom_player_added_key: preserve me');
        // The hidden-status secret marker is in `conditions:` (it's a
        // status), not `other:` — `kind: statuses` without explicit
        // fields renders every status key.
        expect(user).toContain('JACK_HIDDEN_STATUS');
        expect(user).toContain('JACK_SECRET_STAT'); // moved to `other:` because layout doesn't claim it
    });

    test('relationships block contains only the active actor\'s entries (no cross-actor leak)', () => {
        const ctxWithLayout = { ...ctx, sheet_layout: layout };
        // Render Jack's prompt: only Jack's `amelia` relationship, never
        // Amelia's `jack` entry.
        const userJack = actorUserPrompt(ctxWithLayout, jackWithRel, 'react');
        const inJack = extractYamlFence(userJack);
        expect(inJack).toMatch(/^relationships:\n  amelia:\n/m);
        expect(inJack).toContain('stage: wary');
        expect(inJack).not.toContain('stage: host'); // that's Amelia's view
        // And vice-versa for Amelia's prompt.
        const userAmelia = actorUserPrompt(ctxWithLayout, ameliaWithRel, 'react');
        const inAmelia = extractYamlFence(userAmelia);
        expect(inAmelia).toMatch(/^relationships:\n  jack:\n/m);
        expect(inAmelia).toContain('stage: host');
        expect(inAmelia).not.toContain('stage: wary');
    });

    test('M0 ordering invariant still holds with the categorized renderer', () => {
        const ctxWithLayout = {
            ...ctx,
            sheet_layout: layout,
            memories_block: '<character_memory id="jack">\n- a memory.\n</character_memory>',
        };
        const user = actorUserPrompt(ctxWithLayout, jackWithRel, 'react');
        const memoriesIdx = user.indexOf('<character_memory');
        const sheetIdx = user.indexOf('<character_sheet');
        expect(memoriesIdx).toBeGreaterThanOrEqual(0);
        expect(sheetIdx).toBeGreaterThanOrEqual(0);
        expect(memoriesIdx).toBeLessThan(sheetIdx);
    });

    test('flat fallback: when no layout is supplied, the legacy `stats:` / `statuses:` shape is emitted', () => {
        const flat = renderSheetYaml(jackWithRel.sheet);
        // The flat path uses bag-named keys.
        expect(flat).toMatch(/^stats:$/m);
        expect(flat).toMatch(/^statuses:$/m);
        expect(flat).toMatch(/^relationships:$/m);
        // Categorized keys do NOT appear in the flat output.
        expect(flat).not.toMatch(/^abilities:$/m);
        expect(flat).not.toMatch(/^combat:$/m);
    });

    test('renderSheetYaml is pure: passing two different sheets never bleeds keys between them', () => {
        const out1 = renderSheetYaml(jackWithRel.sheet, layout);
        const out2 = renderSheetYaml(ameliaWithRel.sheet, layout);
        expect(out1).toContain('JACK_SECRET_STAT');
        expect(out1).toContain('Iron Sword');
        expect(out2).not.toContain('JACK_SECRET_STAT');
        expect(out2).not.toContain('Iron Sword');
        expect(out2).toContain('AMELIA_SECRET_STAT');
        expect(out1).not.toContain('AMELIA_SECRET_STAT');
    });
});

/** Pull the contents of the `<character_sheet format="yaml">` block out of a prompt. */
function extractYamlFence(prompt) {
    const m = /<character_sheet[^>]*>\n([\s\S]*?)\n<\/character_sheet>/m.exec(prompt);
    return m ? m[1] : '';
}
