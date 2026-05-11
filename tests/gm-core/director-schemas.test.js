import { describe, test, expect } from '@jest/globals';
import { validateIntentShape, validateDirectorDecision } from '../../src/gm-core/director/schemas.js';

describe('validateIntentShape', () => {
    test('accepts short directives', () => {
        expect(validateIntentShape('greet warmly and reassure')).toBeNull();
        expect(validateIntentShape('warn the newcomer about the dangers')).toBeNull();
    });

    test('accepts contraction-heavy directives (false positive fix)', () => {
        expect(validateIntentShape("tell Kael 'I don't know nothin'' about the lights")).toBeNull();
    });

    test('accepts short cue phrases with single quotes', () => {
        expect(validateIntentShape("say 'no' firmly")).toBeNull();
    });

    test('rejects long embedded speech in single quotes', () => {
        const long = "Ephythithys says 'Come, child, come, there is no need to fear here.' and gestures at the table and the rest of the scene.";
        expect(validateIntentShape(long)).not.toBeNull();
    });

    test('rejects double-quoted dialogue', () => {
        expect(validateIntentShape('say "Hello there, welcome to the tavern, friend"')).not.toBeNull();
    });

    test('rejects paragraph breaks', () => {
        expect(validateIntentShape('greet warmly.\n\nThen turn away.')).not.toBeNull();
    });

    test('rejects oversized intents', () => {
        expect(validateIntentShape('x'.repeat(241))).not.toBeNull();
    });

    test('accepts null/non-string gracefully', () => {
        expect(validateIntentShape(null)).toBeNull();
        expect(validateIntentShape(undefined)).toBeNull();
    });
});

describe('validateDirectorDecision', () => {
    test('rejects missing rationale', () => {
        const err = validateDirectorDecision({ action: 'end_turn' });
        expect(err).toContain('rationale');
    });

    test('accepts valid end_turn with proper rationale', () => {
        const rationale = 'Player greeted the bartender. No stakes. Bartender responded. Turn complete, hand back to player.';
        expect(validateDirectorDecision({ action: 'end_turn', rationale })).toBeNull();
    });

    test('rejects speak without actor', () => {
        const err = validateDirectorDecision({ action: 'speak', rationale: 'x'.repeat(80), intent: 'greet' });
        expect(err).toContain('actor');
    });

    test('rejects rationale shorter than 80 characters', () => {
        const err = validateDirectorDecision({ action: 'end_turn', rationale: 'too short' });
        expect(err).toContain('too short');
        expect(err).toContain('80');
    });

    test('rejects missing rationale', () => {
        const err = validateDirectorDecision({ action: 'end_turn' });
        expect(err).toContain('rationale');
    });

    test('accepts rationale at exactly 80 chars', () => {
        expect(validateDirectorDecision({ action: 'end_turn', rationale: 'x'.repeat(80) })).toBeNull();
    });
});
