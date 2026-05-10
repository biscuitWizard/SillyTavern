/**
 * Phase 7 invariant: characters are not shared across campaigns.
 *
 * Character ids are produced by `uniqueId(name, listIds(directories, cid))`
 * — uniqueness is checked **per campaign**, so two different campaigns can
 * each have a character named `Jack` and both will land at `id: 'jack'`.
 * That's fine on disk (different campaign directories) but it caught a
 * latent bug: the in-process cache used to be keyed `(handle, char_id)`,
 * which meant the second campaign's `get(..., 'jack')` returned the FIRST
 * campaign's Jack from cache.
 *
 * This test pins the cache widening to `(handle, cid, char_id)`.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as charStore from '../../src/gm-core/library/store.js';

let tmpRoot;
let directories;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-cross-campaign-'));
    const campaignsDir = path.join(tmpRoot, 'campaigns');
    fs.mkdirSync(campaignsDir, { recursive: true });
    fs.mkdirSync(path.join(campaignsDir, 'campaign_a'), { recursive: true });
    fs.mkdirSync(path.join(campaignsDir, 'campaign_b'), { recursive: true });
    directories = { root: tmpRoot, campaigns: campaignsDir };
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

describe('cross-campaign character id isolation', () => {
    test('two campaigns can each have a character named Jack with the same id, but distinct data', () => {
        const a = charStore.create(directories, 'campaign_a', {
            name: 'Jack',
            appearance: 'jack from a',
        });
        const b = charStore.create(directories, 'campaign_b', {
            name: 'Jack',
            appearance: 'jack from b',
        });
        expect(a.id).toBe('jack');
        expect(b.id).toBe('jack');
        expect(a.campaign_id).toBe('campaign_a');
        expect(b.campaign_id).toBe('campaign_b');
        expect(a.appearance).toBe('jack from a');
        expect(b.appearance).toBe('jack from b');
    });

    test('cache returns the campaign-correct character even when ids collide', () => {
        charStore.create(directories, 'campaign_a', { name: 'Jack', appearance: 'A' });
        charStore.create(directories, 'campaign_b', { name: 'Jack', appearance: 'B' });

        const fromA = charStore.get(directories, 'campaign_a', 'jack');
        const fromB = charStore.get(directories, 'campaign_b', 'jack');

        expect(fromA?.appearance).toBe('A');
        expect(fromB?.appearance).toBe('B');
    });

    test('updating campaign_a/jack does not bleed into campaign_b/jack', () => {
        charStore.create(directories, 'campaign_a', { name: 'Jack', appearance: 'A' });
        charStore.create(directories, 'campaign_b', { name: 'Jack', appearance: 'B' });

        charStore.update(directories, 'campaign_a', 'jack', { appearance: 'A-edited' });

        const aAfter = charStore.get(directories, 'campaign_a', 'jack');
        const bAfter = charStore.get(directories, 'campaign_b', 'jack');

        expect(aAfter?.appearance).toBe('A-edited');
        expect(bAfter?.appearance).toBe('B');
    });

    test('removing campaign_a/jack does not remove campaign_b/jack', () => {
        charStore.create(directories, 'campaign_a', { name: 'Jack', appearance: 'A' });
        charStore.create(directories, 'campaign_b', { name: 'Jack', appearance: 'B' });

        const removed = charStore.remove(directories, 'campaign_a', 'jack');
        expect(removed).toBe(true);

        expect(charStore.get(directories, 'campaign_a', 'jack')).toBeNull();
        const stillThere = charStore.get(directories, 'campaign_b', 'jack');
        expect(stillThere?.appearance).toBe('B');
    });

    test('listAll is scoped to a single campaign', () => {
        charStore.create(directories, 'campaign_a', { name: 'Jack' });
        charStore.create(directories, 'campaign_a', { name: 'Amelia' });
        charStore.create(directories, 'campaign_b', { name: 'Jack' });

        const ids = charStore.listAll(directories, 'campaign_a').map(c => c.id).sort();
        expect(ids).toEqual(['amelia', 'jack']);
    });
});
