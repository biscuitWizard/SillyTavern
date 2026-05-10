/**
 * Per-line edit / delete / atomic rewrite helpers for the scene
 * transcript. The chat-log "edit pose" / "delete message" / "regenerate"
 * actions in scene mode all go through these (or the
 * `truncateAfter` cousin for regenerate). The same per-file mutex
 * already used by `appendLine` keeps concurrent calls from
 * interleaving; the writes themselves use `write-file-atomic` so
 * partial writes are never observable by readers.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as campaignStore from '../../src/gm-core/campaigns/store.js';
import * as sceneStore from '../../src/gm-core/scenes/store.js';
import * as transcript from '../../src/gm-core/scenes/transcript.js';

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-tr-'));
    return { root, campaigns: path.join(root, 'campaigns') };
}

function setupCampaign() {
    const directories = makeDirectories();
    const campaign = campaignStore.create(directories, {
        name: 'Demo',
        ruleset_id: 'dnd5e',
        brief: 'demo',
    });
    const scene = sceneStore.create(directories, campaign.id, { name: 'Opener', location: 'tavern' });
    return { directories, campaign, scene };
}

function lineAt(directories, cid, sid, idx) {
    const all = transcript.readLines(directories, cid, sid, 0);
    return all[idx];
}

describe('transcript: rewrite / update / delete', () => {
    test('updateLine patches `mes` in place and preserves siblings', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Jack', mes: 'I push open the door.', is_user: true, is_system: false, send_date: '2026-01-01T00:00:00Z',
        });
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Narrator', mes: 'The hinges groan.', is_user: false, is_system: false, send_date: '2026-01-01T00:00:01Z',
        });

        const updated = await transcript.updateLine(directories, campaign.id, scene.id, 0, { mes: 'I shoulder the door open.' });
        expect(updated.mes).toBe('I shoulder the door open.');
        // Siblings untouched.
        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(all).toHaveLength(2);
        expect(all[0].mes).toBe('I shoulder the door open.');
        expect(all[0].name).toBe('Jack');
        expect(all[1].mes).toBe('The hinges groan.');
    });

    test('updateLine deep-merges `extra` rather than replacing it', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Jack', mes: 'Jack rolls Athletics.', is_user: false, is_system: true, send_date: '2026-01-01T00:00:00Z',
            extra: { kind: 'roll', card: { skill_id: 'athletics', dc: 12 }, narration: 'Jack heaves himself up.' },
        });

        const updated = await transcript.updateLine(directories, campaign.id, scene.id, 0, {
            mes: 'Jack heaves himself up with a grunt.',
            extra: { narration: 'Jack heaves himself up with a grunt.' },
        });
        expect(updated.mes).toBe('Jack heaves himself up with a grunt.');
        // The roll card is preserved; only `extra.narration` changes.
        expect(updated.extra.kind).toBe('roll');
        expect(updated.extra.card).toEqual({ skill_id: 'athletics', dc: 12 });
        expect(updated.extra.narration).toBe('Jack heaves himself up with a grunt.');
    });

    test('updateLine throws an out_of_range error for invalid indices', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Jack', mes: 'go', is_user: true, is_system: false, send_date: '2026-01-01T00:00:00Z',
        });
        await expect(transcript.updateLine(directories, campaign.id, scene.id, 7, { mes: 'x' }))
            .rejects.toThrow(/out of range/);
    });

    test('deleteLine removes a single line and returns it', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Jack', mes: 'first', is_user: true, is_system: false, send_date: '2026-01-01T00:00:00Z',
        });
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Narrator', mes: 'second', is_user: false, is_system: false, send_date: '2026-01-01T00:00:01Z',
        });
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Jack', mes: 'third', is_user: true, is_system: false, send_date: '2026-01-01T00:00:02Z',
        });

        const removed = await transcript.deleteLine(directories, campaign.id, scene.id, 1);
        expect(removed.mes).toBe('second');
        const after = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(after.map(l => l.mes)).toEqual(['first', 'third']);
        expect(transcript.countLines(directories, campaign.id, scene.id)).toBe(2);
    });

    test('truncateAfter keeps [0..idx] inclusive and drops everything after', async () => {
        const { directories, campaign, scene } = setupCampaign();
        for (let i = 0; i < 5; i++) {
            await transcript.appendLine(directories, campaign.id, scene.id, {
                name: 'L', mes: `line ${i}`, is_user: i % 2 === 0, is_system: false,
                send_date: '2026-01-01T00:00:00Z',
            });
        }
        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, 2);
        expect(kept.map(l => l.mes)).toEqual(['line 0', 'line 1', 'line 2']);
        const onDisk = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(onDisk.map(l => l.mes)).toEqual(['line 0', 'line 1', 'line 2']);
        expect(transcript.countLines(directories, campaign.id, scene.id)).toBe(3);
    });

    test('truncateAfter with idx = -1 wipes the file (used by full-reset)', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Jack', mes: 'go', is_user: true, is_system: false, send_date: '2026-01-01T00:00:00Z',
        });
        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, -1);
        expect(kept).toEqual([]);
        expect(transcript.countLines(directories, campaign.id, scene.id)).toBe(0);
    });

    test('rewriteLines replaces the file body atomically; intermediate readers never see a partial line', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'A', mes: 'a', is_user: true, is_system: false, send_date: '2026-01-01T00:00:00Z',
        });
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'B', mes: 'b', is_user: false, is_system: false, send_date: '2026-01-01T00:00:01Z',
        });

        const replacement = [
            { name: 'X', mes: 'x', is_user: true, is_system: false, send_date: '2026-01-02T00:00:00Z' },
        ];
        await transcript.rewriteLines(directories, campaign.id, scene.id, replacement);
        const after = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(after).toHaveLength(1);
        expect(after[0].mes).toBe('x');

        // Empty rewrite zeroes the file.
        await transcript.rewriteLines(directories, campaign.id, scene.id, []);
        expect(transcript.countLines(directories, campaign.id, scene.id)).toBe(0);
    });

    test('concurrent updates on the same file serialise through the mutex', async () => {
        const { directories, campaign, scene } = setupCampaign();
        for (let i = 0; i < 3; i++) {
            await transcript.appendLine(directories, campaign.id, scene.id, {
                name: 'L', mes: `start-${i}`, is_user: false, is_system: false,
                send_date: '2026-01-01T00:00:00Z',
            });
        }
        // Fire 3 concurrent updates on different indices; if the mutex
        // works each will see the prior writes and emit a consistent
        // final state. Without the mutex, a "lost write" would leave
        // some indices unchanged.
        const promises = [
            transcript.updateLine(directories, campaign.id, scene.id, 0, { mes: 'edit-0' }),
            transcript.updateLine(directories, campaign.id, scene.id, 1, { mes: 'edit-1' }),
            transcript.updateLine(directories, campaign.id, scene.id, 2, { mes: 'edit-2' }),
        ];
        await Promise.all(promises);
        const after = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(after.map(l => l.mes)).toEqual(['edit-0', 'edit-1', 'edit-2']);
    });
});
