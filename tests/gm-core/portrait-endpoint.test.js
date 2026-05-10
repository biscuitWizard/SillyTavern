/**
 * Portrait endpoint tests: campaign-scoped portrait storage.
 *
 * Exercises the characterStore.portraitFile path, the has_portrait
 * derivation, and round-trip write/read/delete of PNG bytes.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as charStore from '../../src/gm-core/library/store.js';

let tmpRoot;
let directories;
const CID = 'test-campaign';

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-portrait-'));
    const campaignsDir = path.join(tmpRoot, 'campaigns');
    fs.mkdirSync(campaignsDir, { recursive: true });
    fs.mkdirSync(path.join(campaignsDir, CID), { recursive: true });
    directories = {
        root: tmpRoot,
        campaigns: campaignsDir,
        characters: path.join(tmpRoot, 'characters'),
    };
    fs.mkdirSync(directories.characters, { recursive: true });
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

describe('portrait storage', () => {
    test('portraitFile returns expected path beside the JSON', () => {
        const filePath = charStore.portraitFile(directories, CID, 'jack');
        expect(filePath).toContain(CID);
        expect(filePath).toMatch(/jack\.png$/);
    });

    test('has_portrait is false when no PNG exists', () => {
        const char = charStore.create(directories, CID, { name: 'NoPortrait' });
        expect(char.has_portrait).toBe(false);
    });

    test('has_portrait is true when PNG exists on disk', () => {
        const char = charStore.create(directories, CID, { name: 'WithPortrait' });
        const portraitPath = charStore.portraitFile(directories, CID, char.id);
        fs.mkdirSync(path.dirname(portraitPath), { recursive: true });
        fs.writeFileSync(portraitPath, Buffer.from([0x89, 0x50]));
        charStore.invalidateCache(directories, CID, char.id);
        const reloaded = charStore.get(directories, CID, char.id);
        expect(reloaded.has_portrait).toBe(true);
    });

    test('has_portrait updates after portrait delete', () => {
        const char = charStore.create(directories, CID, { name: 'Deleted' });
        const portraitPath = charStore.portraitFile(directories, CID, char.id);
        fs.mkdirSync(path.dirname(portraitPath), { recursive: true });
        fs.writeFileSync(portraitPath, Buffer.from([0x89, 0x50]));
        charStore.invalidateCache(directories, CID, char.id);
        expect(charStore.get(directories, CID, char.id).has_portrait).toBe(true);
        fs.unlinkSync(portraitPath);
        charStore.invalidateCache(directories, CID, char.id);
        expect(charStore.get(directories, CID, char.id).has_portrait).toBe(false);
    });
});

describe('legacy migration', () => {
    test('migrates st_card_avatar PNG on first read', () => {
        const char = charStore.create(directories, CID, { name: 'Legacy' });
        const jsonFile = charStore.characterFile(directories, CID, char.id);
        const rawJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        rawJson.st_card_avatar = 'legacy-test.png';
        delete rawJson.has_portrait;
        fs.writeFileSync(jsonFile, JSON.stringify(rawJson));
        charStore.invalidateCache(directories, CID, char.id);

        const oldPng = path.join(directories.characters, 'legacy-test.png');
        fs.writeFileSync(oldPng, Buffer.from([0x89, 0x50, 0x4E, 0x47]));

        const migrated = charStore.get(directories, CID, char.id);
        expect(migrated.st_card_avatar).toBeUndefined();
        expect(migrated.has_portrait).toBe(true);

        const newPng = charStore.portraitFile(directories, CID, char.id);
        expect(fs.existsSync(newPng)).toBe(true);
    });
});
