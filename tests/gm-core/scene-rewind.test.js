/**
 * Scene rewind semantics — the truncation step that POST
 * /api/gm/scenes/:id/messages/:line_index/rewind-to-before runs when
 * the player clicks Stop mid-generation.
 *
 * The endpoint's contract:
 *   1. Walk back from `line_index` to the most recent `is_user: true`
 *      line at or before that index.
 *   2. Truncate the transcript so [0..playerIdx-1] is preserved
 *      (the player line AND everything after it are dropped).
 *   3. Return the dropped player line's text so the frontend can
 *      restore it to the input bar.
 *
 * This test exercises the transcript-level truncation directly. The
 * full Express endpoint is not booted — we mirror the helper logic
 * inline so the test locks behaviour without requiring HTTP plumbing.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as campaignStore from '../../src/gm-core/campaigns/store.js';
import * as sceneStore from '../../src/gm-core/scenes/store.js';
import * as transcript from '../../src/gm-core/scenes/transcript.js';

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-rewind-'));
    return { root, campaigns: path.join(root, 'campaigns') };
}

function setupCampaign() {
    const directories = makeDirectories();
    const campaign = campaignStore.create(directories, { name: 'RewindDemo', ruleset_id: 'dnd5e', brief: 'demo' });
    const scene = sceneStore.create(directories, campaign.id, { name: 'Test Scene', location: 'arena' });
    return { directories, campaign, scene };
}

function findPlayerIndex(lines, idx) {
    for (let i = Math.min(idx, lines.length - 1); i >= 0; i--) {
        if (lines[i]?.is_user) return i;
    }
    return -1;
}

describe('scene rewind-to-before: truncation', () => {
    test('drops the player line and everything after it', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'Opening pose', is_user: false, is_system: false, send_date: '0', extra: { role: 'narrator' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'I draw my sword', is_user: true, is_system: false, send_date: '1', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'Steel glints in the light', is_user: false, is_system: false, send_date: '2', extra: { role: 'narrator' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Amelia', mes: 'Watch out!', is_user: false, is_system: false, send_date: '3', extra: { role: 'actor', actor: 'amelia' } });

        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(all).toHaveLength(4);

        const playerIdx = findPlayerIndex(all, 3);
        expect(playerIdx).toBe(1);
        const playerInput = all[playerIdx].mes;
        expect(playerInput).toBe('I draw my sword');

        // Rewind: keep [0..playerIdx-1] = [0..0]
        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, playerIdx - 1);
        expect(kept).toHaveLength(1);
        expect(kept[0].mes).toBe('Opening pose');

        // Verify the file on disk matches
        const afterRewind = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(afterRewind).toHaveLength(1);
        expect(afterRewind[0].mes).toBe('Opening pose');
    });

    test('works when the player line is the very first line (idx 0)', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'Hello world', is_user: true, is_system: false, send_date: '0', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'The world says hi', is_user: false, is_system: false, send_date: '1', extra: { role: 'narrator' } });

        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        const playerIdx = findPlayerIndex(all, 1);
        expect(playerIdx).toBe(0);

        // playerIdx - 1 = -1 → truncateAfter(-1) = empty file
        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, playerIdx - 1);
        expect(kept).toHaveLength(0);

        const afterRewind = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(afterRewind).toHaveLength(0);
    });

    test('preserves earlier turns when rewinding the latest one', async () => {
        const { directories, campaign, scene } = setupCampaign();
        // Turn 1
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'open the door', is_user: true, is_system: false, send_date: '0', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'The door opens.', is_user: false, is_system: false, send_date: '1', extra: { role: 'narrator' } });
        // Turn 2 (the one we want to rewind)
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'step inside', is_user: true, is_system: false, send_date: '2', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'Its dark.', is_user: false, is_system: false, send_date: '3', extra: { role: 'narrator' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Amelia', mes: 'I dont like this.', is_user: false, is_system: false, send_date: '4', extra: { role: 'actor' } });

        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        const playerIdx = findPlayerIndex(all, 4);
        expect(playerIdx).toBe(2);

        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, playerIdx - 1);
        expect(kept).toHaveLength(2);
        expect(kept.map(l => l.mes)).toEqual(['open the door', 'The door opens.']);
    });

    test('dropped lines include the player line itself for cascade purposes', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'scene start', is_user: false, is_system: false, send_date: '0', extra: { role: 'narrator' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'attack', is_user: true, is_system: false, send_date: '1', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'you swing', is_user: false, is_system: false, send_date: '2', extra: { role: 'narrator' } });

        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        const playerIdx = findPlayerIndex(all, 2);
        expect(playerIdx).toBe(1);

        // The dropped slice (for cascade) is allLines.slice(playerIdx)
        const droppedSlice = all.slice(playerIdx);
        expect(droppedSlice).toHaveLength(2);
        expect(droppedSlice[0].mes).toBe('attack');
        expect(droppedSlice[0].is_user).toBe(true);
        expect(droppedSlice[1].mes).toBe('you swing');
        expect(droppedSlice[1].extra?.role).toBe('narrator');
    });
});
