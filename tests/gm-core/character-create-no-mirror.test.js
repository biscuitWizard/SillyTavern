/**
 * Confirm that creating a character does NOT write to the stock
 * SillyTavern characters directory or mutate settings.json (the mirror
 * layer has been removed).
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
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-no-mirror-'));
    const campaignsDir = path.join(tmpRoot, 'campaigns');
    fs.mkdirSync(campaignsDir, { recursive: true });
    fs.mkdirSync(path.join(campaignsDir, CID), { recursive: true });
    const stCharsDir = path.join(tmpRoot, 'characters');
    fs.mkdirSync(stCharsDir, { recursive: true });
    directories = {
        root: tmpRoot,
        campaigns: campaignsDir,
        characters: stCharsDir,
    };
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

describe('character create does not mirror', () => {
    test('no PNG written to data/{handle}/characters/', () => {
        const before = fs.readdirSync(directories.characters);
        charStore.create(directories, CID, { name: 'TestHero', is_player: true });
        const after = fs.readdirSync(directories.characters);
        expect(after).toEqual(before);
    });

    test('settings.json is not created or mutated', () => {
        const settingsPath = path.join(tmpRoot, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({ power_user: {} }));
        const contentBefore = fs.readFileSync(settingsPath, 'utf8');
        charStore.create(directories, CID, { name: 'TestVillain', is_player: false });
        const contentAfter = fs.readFileSync(settingsPath, 'utf8');
        expect(contentAfter).toBe(contentBefore);
    });

    test('created character has has_portrait false, no st_card_avatar', () => {
        const char = charStore.create(directories, CID, { name: 'FreshChar' });
        expect(char.has_portrait).toBe(false);
        expect(char.st_card_avatar).toBeUndefined();
    });
});
