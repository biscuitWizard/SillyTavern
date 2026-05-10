/**
 * Scene regenerate semantics — the truncation step that POST
 * /api/gm/scenes/:id/messages/:line_index/regenerate runs before
 * dispatching a fresh Director turn.
 *
 * The endpoint's contract:
 *   1. Walk back from `line_index` to the most recent `is_user: true`
 *      line at or before that index.
 *   2. Truncate the transcript so [0..playerIdx] is preserved
 *      (everything strictly after is dropped).
 *   3. Run a Director turn with that player line's `mes` as
 *      `user_input`.
 *
 * This test exercises steps 1 and 2 directly against the transcript
 * helpers — the streaming Director turn is covered by
 * director-skillcheck.test.js / director-dispatch.test.js. We don't
 * boot the full Express stack here.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as campaignStore from '../../src/gm-core/campaigns/store.js';
import * as sceneStore from '../../src/gm-core/scenes/store.js';
import * as transcript from '../../src/gm-core/scenes/transcript.js';

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-regen-'));
    return { root, campaigns: path.join(root, 'campaigns') };
}

function setupCampaign() {
    const directories = makeDirectories();
    const campaign = campaignStore.create(directories, { name: 'Demo', ruleset_id: 'dnd5e', brief: 'demo' });
    const scene = sceneStore.create(directories, campaign.id, { name: 'Opener', location: 'tavern' });
    return { directories, campaign, scene };
}

/**
 * Mirror the inline walk-back logic in the regenerate endpoint. Keep
 * this in sync with `src/endpoints/gm.js` if the endpoint changes its
 * algorithm — the test exists to lock that behaviour.
 *
 * @param {Array<{ is_user?: boolean }>} lines
 * @param {number} idx
 * @returns {number}  the resolved player-line index, or -1 when none.
 */
function findPlayerIndex(lines, idx) {
    for (let i = Math.min(idx, lines.length - 1); i >= 0; i--) {
        if (lines[i]?.is_user) return i;
    }
    return -1;
}

describe('scene regenerate: truncation', () => {
    test('walks back to the most recent player input and keeps it', async () => {
        const { directories, campaign, scene } = setupCampaign();
        // Layout:
        //   0: player "I push open the door"
        //   1: narrator "The hinges groan"
        //   2: actor "Amelia: 'Be careful.'"
        //   3: player "I step inside"
        //   4: narrator "The room is dim"
        //   5: actor "Amelia: 'I'll wait here.'"
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'I push open the door', is_user: true,  is_system: false, send_date: '0', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'The hinges groan', is_user: false, is_system: false, send_date: '1', extra: { role: 'narrator' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Amelia', mes: 'Be careful.', is_user: false, is_system: false, send_date: '2', extra: { role: 'actor', actor: 'amelia' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'I step inside', is_user: true, is_system: false, send_date: '3', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'The room is dim', is_user: false, is_system: false, send_date: '4', extra: { role: 'narrator' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Amelia', mes: "I'll wait here.", is_user: false, is_system: false, send_date: '5', extra: { role: 'actor', actor: 'amelia' } });

        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        // From the latest line (5), the most-recent player input is at index 3.
        expect(findPlayerIndex(all, 5)).toBe(3);
        // Truncate after that — keep [0..3], drop [4..5].
        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, 3);
        expect(kept).toHaveLength(4);
        expect(kept[3].mes).toBe('I step inside');

        // The "user_input" we'd run the new Director turn with is the
        // mes of that player line.
        expect(kept[3].mes).toBe('I step inside');
    });

    test('truncation is exclusive of trailing AI beats only — earlier ones are preserved', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'try to climb', is_user: true, is_system: false, send_date: '0', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'You haul up.', is_user: false, is_system: false, send_date: '1', extra: { role: 'narrator' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'try to leap', is_user: true, is_system: false, send_date: '2', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'You leap.', is_user: false, is_system: false, send_date: '3', extra: { role: 'narrator' } });

        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        // Regenerate from the LAST mes (index 3) → walks back to player at 2.
        const playerIdx = findPlayerIndex(all, 3);
        expect(playerIdx).toBe(2);
        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, playerIdx);
        expect(kept.map(l => l.mes)).toEqual(['try to climb', 'You haul up.', 'try to leap']);
    });

    test('with no preceding player input, walk-back returns -1 (endpoint surfaces 409)', async () => {
        const { directories, campaign, scene } = setupCampaign();
        // Only narrator beats — no player input yet.
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Narrator', mes: 'opening pose', is_user: false, is_system: false, send_date: '0', extra: { role: 'narrator' } });
        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(findPlayerIndex(all, 0)).toBe(-1);
    });

    test('regenerating from a roll card walks back past the roll to the player input that triggered it', async () => {
        const { directories, campaign, scene } = setupCampaign();
        await transcript.appendLine(directories, campaign.id, scene.id, { name: 'Jack', mes: 'leap the chasm', is_user: true, is_system: false, send_date: '0', extra: { role: 'player' } });
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Jack', mes: 'Jack lands hard.', is_user: false, is_system: true, send_date: '1',
            extra: {
                role: 'roll',
                kind: 'roll',
                card: { actor_id: 'jack', skill_id: 'athletics', dc: 14, outcome: 'fail' },
                narration: 'Jack lands hard.',
            },
        });
        const all = transcript.readLines(directories, campaign.id, scene.id, 0);
        expect(findPlayerIndex(all, 1)).toBe(0);
        const kept = await transcript.truncateAfter(directories, campaign.id, scene.id, 0);
        expect(kept).toHaveLength(1);
        expect(kept[0].mes).toBe('leap the chasm');
        // After truncation, the regenerate endpoint would re-run the
        // turn with `user_input: 'leap the chasm'`.
    });
});
