/**
 * Migration 0001: split combined roll+narration transcript lines.
 *
 * Verifies that a fixture transcript with a legacy combined roll line
 * is split into: (1) a card-only roll line with mes='' and no narration
 * fields, and (2) a synthetic narrator/actor message line immediately
 * after. The migration is idempotent — running it twice is a no-op.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as campaignStore from '../../../src/gm-core/campaigns/store.js';
import * as sceneStore from '../../../src/gm-core/scenes/store.js';
import { migrate } from '../../../src/gm-core/scenes/migrations/0001-split-roll-narration.js';

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mig-'));
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

function transcriptPath(directories, cid, sid) {
    return path.join(directories.campaigns || path.join(directories.root, 'campaigns'), cid, 'scenes', `${sid}.jsonl`);
}

function readAllLines(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

describe('migration 0001: split-roll-narration', () => {
    test('splits a combined roll line into card-only + synthetic narrator message', () => {
        const { directories, campaign, scene } = setupCampaign();
        const file = transcriptPath(directories, campaign.id, scene.id);

        const playerLine = {
            name: 'Jack',
            mes: 'I jump the ledge.',
            is_user: true,
            is_system: false,
            send_date: '2026-01-01T00:00:00.000Z',
        };
        const rollLine = {
            name: 'Jack',
            mes: 'Jack lands safely on the far side.',
            is_user: false,
            is_system: true,
            send_date: '2026-01-01T00:00:01.000Z',
            extra: {
                role: 'roll',
                kind: 'roll',
                card: { actor_id: 'jack', skill_id: 'athletics', dc: 12, outcome: 'success' },
                narration: 'Jack lands safely on the far side.',
                actor_id: 'jack',
                actor_name: 'Jack',
                intent: 'jump the ledge',
                narration_speaker_id: null,
                narration_speaker_name: 'Narrator',
                narration_speaker_role: 'narrator',
            },
        };
        const afterLine = {
            name: 'Narrator',
            mes: 'The bridge sways gently.',
            is_user: false,
            is_system: false,
            send_date: '2026-01-01T00:00:02.000Z',
        };

        fs.writeFileSync(file, [playerLine, rollLine, afterLine].map(l => JSON.stringify(l)).join('\n') + '\n');

        const result = migrate(directories, campaign.id);
        expect(result.migrated).toBe(1);

        const lines = readAllLines(file);
        expect(lines).toHaveLength(4);

        // Line 0: player line unchanged.
        expect(lines[0].name).toBe('Jack');
        expect(lines[0].mes).toBe('I jump the ledge.');

        // Line 1: card-only roll line.
        expect(lines[1].mes).toBe('');
        expect(lines[1].extra.kind).toBe('roll');
        expect(lines[1].extra.card).toEqual({ actor_id: 'jack', skill_id: 'athletics', dc: 12, outcome: 'success' });
        expect(lines[1].extra.narration).toBeUndefined();
        expect(lines[1].extra.narration_speaker_id).toBeUndefined();

        // Line 2: synthetic narrator message.
        expect(lines[2].name).toBe('Narrator');
        expect(lines[2].mes).toBe('Jack lands safely on the far side.');
        expect(lines[2].is_user).toBe(false);
        expect(lines[2].is_system).toBe(false);
        expect(lines[2].extra.role).toBe('narrator');

        // Line 3: original after-line unchanged.
        expect(lines[3].mes).toBe('The bridge sways gently.');
    });

    test('splits a combined roll line voiced by an NPC', () => {
        const { directories, campaign, scene } = setupCampaign();
        const file = transcriptPath(directories, campaign.id, scene.id);

        const rollLine = {
            name: 'Jack',
            mes: '"Fine," Amelia mutters.',
            is_user: false,
            is_system: true,
            send_date: '2026-01-01T00:00:01.000Z',
            extra: {
                role: 'roll',
                kind: 'roll',
                card: { actor_id: 'jack', skill_id: 'persuasion', dc: 12, outcome: 'success' },
                narration: '"Fine," Amelia mutters.',
                actor_id: 'jack',
                actor_name: 'Jack',
                intent: 'convince Amelia',
                narration_speaker_id: 'amelia',
                narration_speaker_name: 'Amelia',
                narration_speaker_role: 'actor',
            },
        };

        fs.writeFileSync(file, JSON.stringify(rollLine) + '\n');

        migrate(directories, campaign.id);
        const lines = readAllLines(file);
        expect(lines).toHaveLength(2);

        expect(lines[0].mes).toBe('');
        expect(lines[0].extra.narration).toBeUndefined();

        expect(lines[1].name).toBe('Amelia');
        expect(lines[1].mes).toBe('"Fine," Amelia mutters.');
        expect(lines[1].extra.role).toBe('actor');
        expect(lines[1].extra.actor_id).toBe('amelia');
    });

    test('idempotent: running migration twice produces the same result', () => {
        const { directories, campaign, scene } = setupCampaign();
        const file = transcriptPath(directories, campaign.id, scene.id);

        const rollLine = {
            name: 'Jack',
            mes: 'Jack lands safely.',
            is_user: false,
            is_system: true,
            send_date: '2026-01-01T00:00:01.000Z',
            extra: {
                role: 'roll',
                kind: 'roll',
                card: { actor_id: 'jack', skill_id: 'athletics', dc: 12, outcome: 'success' },
                narration: 'Jack lands safely.',
                actor_id: 'jack',
                actor_name: 'Jack',
                intent: 'jump',
                narration_speaker_id: null,
                narration_speaker_name: 'Narrator',
                narration_speaker_role: 'narrator',
            },
        };

        fs.writeFileSync(file, JSON.stringify(rollLine) + '\n');

        const result1 = migrate(directories, campaign.id);
        expect(result1.migrated).toBe(1);
        const linesAfterFirst = readAllLines(file);

        const result2 = migrate(directories, campaign.id);
        expect(result2.migrated).toBe(0);
        expect(result2.skipped).toBe(0);
        const linesAfterSecond = readAllLines(file);

        expect(linesAfterSecond).toEqual(linesAfterFirst);
    });

    test('no-op for a transcript with no combined roll lines', () => {
        const { directories, campaign, scene } = setupCampaign();
        const file = transcriptPath(directories, campaign.id, scene.id);

        const line = {
            name: 'Narrator',
            mes: 'The tavern is quiet.',
            is_user: false,
            is_system: false,
            send_date: '2026-01-01T00:00:00.000Z',
        };
        fs.writeFileSync(file, JSON.stringify(line) + '\n');

        const result = migrate(directories, campaign.id);
        expect(result.migrated).toBe(0);

        const lines = readAllLines(file);
        expect(lines).toHaveLength(1);
        expect(lines[0].mes).toBe('The tavern is quiet.');
    });
});
