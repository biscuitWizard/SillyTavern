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
