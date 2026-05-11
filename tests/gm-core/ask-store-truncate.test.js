/**
 * Ask store truncation tests.
 *
 * Exercises `truncateFromId` and `truncateLast` on a real temp directory.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as askStore from '../../src/gm-core/ask/store.js';

let tmpDir;
let dirs;
const CID = 'test-campaign';

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-store-'));
    const campaignsDir = path.join(tmpDir, 'campaigns');
    fs.mkdirSync(path.join(campaignsDir, CID, 'ask'), { recursive: true });
    dirs = { campaigns: campaignsDir };
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedEntries(count = 4) {
    const entries = [];
    for (let i = 0; i < count; i++) {
        const role = i % 2 === 0 ? 'player' : 'gm';
        const text = `${role} entry ${i}`;
        const ent = await askStore.append(dirs, CID, {
            role,
            text,
            lore_id: role === 'gm' ? `lore-${i}` : null,
        });
        entries.push(ent);
    }
    return entries;
}

describe('Ask store truncation', () => {
    test('truncateFromId removes the target entry and everything after', async () => {
        const entries = await seedEntries(4);
        const removed = await askStore.truncateFromId(dirs, CID, entries[2].id);
        expect(removed).toHaveLength(2);
        expect(removed[0].id).toBe(entries[2].id);
        expect(removed[1].id).toBe(entries[3].id);

        const remaining = askStore.readAll(dirs, CID);
        expect(remaining).toHaveLength(2);
        expect(remaining[0].id).toBe(entries[0].id);
        expect(remaining[1].id).toBe(entries[1].id);
    });

    test('truncateFromId with unknown id returns empty', async () => {
        await seedEntries(4);
        const removed = await askStore.truncateFromId(dirs, CID, 'nonexistent');
        expect(removed).toHaveLength(0);

        const remaining = askStore.readAll(dirs, CID);
        expect(remaining).toHaveLength(4);
    });

    test('truncateFromId on first entry clears the whole transcript', async () => {
        const entries = await seedEntries(4);
        const removed = await askStore.truncateFromId(dirs, CID, entries[0].id);
        expect(removed).toHaveLength(4);

        const remaining = askStore.readAll(dirs, CID);
        expect(remaining).toHaveLength(0);
    });

    test('truncateLast removes the last N entries', async () => {
        const entries = await seedEntries(4);
        const removed = await askStore.truncateLast(dirs, CID, 2);
        expect(removed).toHaveLength(2);
        expect(removed[0].id).toBe(entries[2].id);
        expect(removed[1].id).toBe(entries[3].id);

        const remaining = askStore.readAll(dirs, CID);
        expect(remaining).toHaveLength(2);
    });

    test('truncateLast(0) removes nothing', async () => {
        await seedEntries(4);
        const removed = await askStore.truncateLast(dirs, CID, 0);
        expect(removed).toHaveLength(0);
        expect(askStore.readAll(dirs, CID)).toHaveLength(4);
    });

    test('truncateLast(100) on 4-entry transcript removes all', async () => {
        await seedEntries(4);
        const removed = await askStore.truncateLast(dirs, CID, 100);
        expect(removed).toHaveLength(4);
        expect(askStore.readAll(dirs, CID)).toHaveLength(0);
    });

    test('removed GM entries carry lore_id for cleanup', async () => {
        const entries = await seedEntries(4);
        const removed = await askStore.truncateLast(dirs, CID, 2);
        const withLore = removed.filter(e => e.lore_id);
        expect(withLore.length).toBeGreaterThan(0);
        expect(withLore[0].lore_id).toMatch(/^lore-/);
    });
});
