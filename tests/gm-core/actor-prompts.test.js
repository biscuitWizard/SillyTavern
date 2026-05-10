/**
 * Phase 5 invariant: an actor's prompt sees only its own sheet and
 * descriptions, never another actor's. The Director loop achieves this by
 * passing only the active character into `actorSystemPrompt` /
 * `actorUserPrompt` — these tests pin that contract so a future regression
 * (e.g. accidentally splicing `ctx.actors` into the prompt) fails fast.
 */

import { describe, test, expect } from '@jest/globals';
import { actorSystemPrompt, actorUserPrompt } from '../../src/gm-core/actors/prompts.js';

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
    test('Amelia\'s system prompt does not contain Jack\'s identity, sheet, or stat keys', () => {
        const sys = actorSystemPrompt(ctx, amelia);
        // Amelia's own data appears.
        expect(sys).toContain('Amelia');
        expect(sys).toContain('AMELIA_APPEARANCE_MARKER');
        expect(sys).toContain('AMELIA_BACKGROUND_MARKER');
        expect(sys).toContain('AMELIA_SECRET_STAT');
        expect(sys).toContain('AMELIA_HIDDEN_STATUS');
        // Jack's data must not leak.
        expect(sys).not.toContain('Jack Ironwright');
        expect(sys).not.toContain('JACK_BACKGROUND_MARKER');
        expect(sys).not.toContain('JACK_SECRET_STAT');
        expect(sys).not.toContain('JACK_HIDDEN_STATUS');
    });

    test('Jack\'s system prompt does not contain Amelia\'s identity, sheet, or stat keys', () => {
        const sys = actorSystemPrompt(ctx, jack);
        expect(sys).toContain('Jack Ironwright');
        expect(sys).toContain('JACK_BACKGROUND_MARKER');
        expect(sys).toContain('JACK_SECRET_STAT');
        expect(sys).toContain('JACK_HIDDEN_STATUS');
        expect(sys).not.toContain('Amelia Verra');
        expect(sys).not.toContain('AMELIA_BACKGROUND_MARKER');
        expect(sys).not.toContain('AMELIA_SECRET_STAT');
        expect(sys).not.toContain('AMELIA_HIDDEN_STATUS');
    });

    test('user prompt carries scene + transcript but no other-actor sheets', () => {
        const user = actorUserPrompt(ctx, amelia, 'react warily to the strangers');
        expect(user).toContain('Demo Campaign');
        expect(user).toContain('The Tavern Door');
        expect(user).toContain('I push open the door.');
        expect(user).toContain('react warily');
        // The user prompt mentions the active character by name, but must not
        // splice in the other actor's marker-strings, which would only appear
        // if the prompt builder accidentally rendered ctx.actors as YAML.
        expect(user).not.toContain('JACK_BACKGROUND_MARKER');
        expect(user).not.toContain('JACK_SECRET_STAT');
        expect(user).not.toContain('JACK_HIDDEN_STATUS');
    });

    test('builder is per-actor: a hand-built ctx with only the active actor still produces a valid prompt', () => {
        const isolatedCtx = { ...ctx, actors: [ctx.actors[1]] };
        const sys = actorSystemPrompt(isolatedCtx, amelia);
        expect(sys).toContain('Amelia');
        expect(sys).not.toContain('Jack Ironwright');
    });
});
