/**
 * Phase 5 invariant: stats are arbitrary KV pairs. The on-disk shape
 * (`Record<string, number | string>`) round-trips arbitrary keys and the
 * `clearStat` mutator removes a key cleanly.
 *
 * Uses a real on-disk store rooted in a tmp dir to confirm that the JSON
 * file written to disk really does carry user-defined keys — the schema
 * does not strip them.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as charStore from '../../src/gm-core/library/store.js';
import * as sheetOps from '../../src/gm-core/sheets/operations.js';
import { defaultSheet } from '../../src/gm-core/library/schemas.js';

let tmpRoot;
let directories;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-sheet-kv-'));
    const campaignsDir = path.join(tmpRoot, 'campaigns');
    fs.mkdirSync(campaignsDir, { recursive: true });
    fs.mkdirSync(path.join(campaignsDir, 'demo'), { recursive: true });
    directories = { root: tmpRoot, campaigns: campaignsDir };
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

describe('sheet KV: arbitrary keys round-trip', () => {
    test('defaultSheet without overrides has empty stats — no implicit 5e seed', () => {
        const sheet = defaultSheet();
        expect(sheet.stats).toEqual({});
        expect(sheet.statuses).toEqual({});
        expect(sheet.skills).toEqual([]);
    });

    test('defaultSheet preserves caller-supplied overrides verbatim', () => {
        const sheet = defaultSheet({
            stats: { favorite_color: 'blue', hits_left: 7 },
            skills: ['streetwise'],
        });
        expect(sheet.stats).toEqual({ favorite_color: 'blue', hits_left: 7 });
        expect(sheet.skills).toEqual(['streetwise']);
    });

    test('stats with arbitrary keys round-trip through JSON on disk', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Test',
            sheet: { stats: { favorite_color: 'blue', hits_left: 7, big_number: 42 } },
        });
        // Read raw from disk to confirm no schema scrubbing happened.
        const file = charStore.characterFile(directories, 'demo', character.id);
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(raw.sheet.stats).toEqual({ favorite_color: 'blue', hits_left: 7, big_number: 42 });
    });

    test('setStat adds a custom key; clearStat removes it', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Test',
            sheet: { stats: { hp: 10 } },
        });
        const after = sheetOps.setStat(directories, 'demo', character.id, 'sanity', 13);
        expect(after).not.toBeNull();
        expect(after.sheet.stats).toEqual({ hp: 10, sanity: 13 });
        const cleared = sheetOps.clearStat(directories, 'demo', character.id, 'sanity');
        expect(cleared).not.toBeNull();
        expect(cleared.sheet.stats).toEqual({ hp: 10 });
        expect(Object.prototype.hasOwnProperty.call(cleared.sheet.stats, 'sanity')).toBe(false);
    });

    test('clearStat on an absent key is a safe no-op (still writes, returns the same shape)', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Test',
            sheet: { stats: { hp: 10 } },
        });
        const after = sheetOps.clearStat(directories, 'demo', character.id, 'unknown_key');
        expect(after).not.toBeNull();
        expect(after.sheet.stats).toEqual({ hp: 10 });
    });

    test('round-trip: create with KV, setStat, clearStat — final disk file matches', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Round Trip',
            sheet: { stats: { strength: 14, dexterity: 12 } },
        });
        sheetOps.setStat(directories, 'demo', character.id, 'mojo', 'high');
        sheetOps.setStat(directories, 'demo', character.id, 'gold', 47);
        sheetOps.clearStat(directories, 'demo', character.id, 'dexterity');
        const file = charStore.characterFile(directories, 'demo', character.id);
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(raw.sheet.stats).toEqual({ strength: 14, mojo: 'high', gold: 47 });
        expect(raw.sheet.stats.dexterity).toBeUndefined();
    });
});

describe('sheet relationships (M2): per-other-character KV grid', () => {
    test('defaultSheet seeds an empty relationships bag', () => {
        const sheet = defaultSheet();
        expect(sheet.relationships).toEqual({});
    });

    test('defaultSheet preserves caller-supplied relationships verbatim', () => {
        const sheet = defaultSheet({
            relationships: {
                amelia: { stage: 'friend', affection: 42 },
                marle: { stage: 'rival', trust: -10 },
            },
        });
        expect(sheet.relationships).toEqual({
            amelia: { stage: 'friend', affection: 42 },
            marle: { stage: 'rival', trust: -10 },
        });
    });

    test('defaultSheet drops malformed relationship entries (non-object values)', () => {
        const sheet = defaultSheet({
            relationships: {
                good: { stage: 'friend' },
                bad_array: ['nope'],
                bad_string: 'still nope',
                bad_null: null,
            },
        });
        expect(sheet.relationships).toEqual({ good: { stage: 'friend' } });
    });

    test('setRelationshipField creates a fresh entry when the other id is new', () => {
        const character = charStore.create(directories, 'demo', { name: 'Jack' });
        const after = sheetOps.setRelationshipField(directories, 'demo', character.id, 'amelia', 'stage', 'friend');
        expect(after).not.toBeNull();
        expect(after.sheet.relationships).toEqual({ amelia: { stage: 'friend' } });
    });

    test('setRelationshipField merges into an existing entry without disturbing other fields', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Jack',
            sheet: { relationships: { amelia: { stage: 'friend', affection: 30 } } },
        });
        const after = sheetOps.setRelationshipField(directories, 'demo', character.id, 'amelia', 'trust', 70);
        expect(after.sheet.relationships).toEqual({
            amelia: { stage: 'friend', affection: 30, trust: 70 },
        });
    });

    test('setRelationshipField does not touch other characters\' entries', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Jack',
            sheet: { relationships: { amelia: { stage: 'friend' }, marle: { stage: 'rival' } } },
        });
        const after = sheetOps.setRelationshipField(directories, 'demo', character.id, 'marle', 'trust', -5);
        expect(after.sheet.relationships.amelia).toEqual({ stage: 'friend' });
        expect(after.sheet.relationships.marle).toEqual({ stage: 'rival', trust: -5 });
    });

    test('clearRelationshipField removes a single field; entry survives if other fields remain', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Jack',
            sheet: { relationships: { amelia: { stage: 'friend', affection: 30, trust: 70 } } },
        });
        const after = sheetOps.clearRelationshipField(directories, 'demo', character.id, 'amelia', 'affection');
        expect(after.sheet.relationships.amelia).toEqual({ stage: 'friend', trust: 70 });
        expect(Object.prototype.hasOwnProperty.call(after.sheet.relationships.amelia, 'affection')).toBe(false);
    });

    test('clearRelationshipField drops the entry entirely when the last field is removed', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Jack',
            sheet: { relationships: { amelia: { stage: 'friend' }, marle: { stage: 'rival' } } },
        });
        const after = sheetOps.clearRelationshipField(directories, 'demo', character.id, 'amelia', 'stage');
        expect(Object.prototype.hasOwnProperty.call(after.sheet.relationships, 'amelia')).toBe(false);
        expect(after.sheet.relationships.marle).toEqual({ stage: 'rival' });
    });

    test('clearRelationshipField on an unknown other id is a safe no-op', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Jack',
            sheet: { relationships: { amelia: { stage: 'friend' } } },
        });
        const after = sheetOps.clearRelationshipField(directories, 'demo', character.id, 'nobody', 'stage');
        expect(after.sheet.relationships).toEqual({ amelia: { stage: 'friend' } });
    });

    test('removeRelationship drops the whole entry; other characters are unaffected', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Jack',
            sheet: { relationships: { amelia: { stage: 'friend' }, marle: { stage: 'rival' } } },
        });
        const after = sheetOps.removeRelationship(directories, 'demo', character.id, 'amelia');
        expect(after.sheet.relationships).toEqual({ marle: { stage: 'rival' } });
    });

    test('removeRelationship on an unknown other id is a safe no-op', () => {
        const character = charStore.create(directories, 'demo', {
            name: 'Jack',
            sheet: { relationships: { amelia: { stage: 'friend' } } },
        });
        const after = sheetOps.removeRelationship(directories, 'demo', character.id, 'nobody');
        expect(after.sheet.relationships).toEqual({ amelia: { stage: 'friend' } });
    });

    test('relationships round-trip cleanly through the JSON file on disk', () => {
        const character = charStore.create(directories, 'demo', { name: 'Jack' });
        sheetOps.setRelationshipField(directories, 'demo', character.id, 'amelia', 'stage', 'friend');
        sheetOps.setRelationshipField(directories, 'demo', character.id, 'amelia', 'affection', 42);
        sheetOps.setRelationshipField(directories, 'demo', character.id, 'marle', 'stage', 'rival');
        sheetOps.removeRelationship(directories, 'demo', character.id, 'marle');

        const file = charStore.characterFile(directories, 'demo', character.id);
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(raw.sheet.relationships).toEqual({ amelia: { stage: 'friend', affection: 42 } });
    });

    test('mutators tolerate a pre-existing sheet on disk that was written before relationships existed', () => {
        // Simulate a legacy on-disk character whose sheet has no
        // `relationships` key. Write the JSON directly so the in-memory
        // cache hasn't seen it yet — `get` will pick it up from disk on
        // first read.
        const charactersDir = charStore.charactersDir(directories, 'demo');
        fs.mkdirSync(charactersDir, { recursive: true });
        const file = charStore.characterFile(directories, 'demo', 'legacy');
        const legacy = {
            id: 'legacy',
            campaign_id: 'demo',
            name: 'Legacy',
            is_player: true,
            appearance: '',
            personality: '',
            voice: '',
            background: '',
            sheet: {
                stats: { hp: 10 },
                statuses: {},
                items: [],
                skills: [],
                notes: '',
                // intentionally no `relationships` key
            },
            st_card_avatar: null,
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
        };
        fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');

        const after = sheetOps.setRelationshipField(directories, 'demo', 'legacy', 'amelia', 'stage', 'friend');
        expect(after).not.toBeNull();
        expect(after.sheet.relationships).toEqual({ amelia: { stage: 'friend' } });
        // Other sheet bags survived intact.
        expect(after.sheet.stats).toEqual({ hp: 10 });
    });
});
