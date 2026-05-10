/**
 * Phase 6 ruleset loader: bundled YAML loads cleanly, user-pack overrides
 * shadow bundled files, and the cache invalidates when a YAML mtime moves.
 *
 * The loader walks two roots: `data/rulesets/{id}/` (bundled, ships with the
 * repo) and `{handle}/rulesets/{id}/` (user pack). The tests below exercise
 * both paths against a real on-disk tmp dir so the cache + mtime logic gets
 * a real `fs.stat` each time.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRuleset, listRulesets, _resetCacheForTests, clampDc } from '../../src/gm-core/rulesets/loader.js';

let tmpRoot;
let directories;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-ruleset-loader-'));
    directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };
    _resetCacheForTests();
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

describe('bundled D&D 5e ruleset loads cleanly', () => {
    test('skills/abilities/dc bands/severities all resolve', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        expect(ruleset).not.toBeNull();
        expect(ruleset.id).toBe('dnd5e');
        expect(ruleset.abilities).toHaveLength(6);
        expect(ruleset.abilities.map(a => a.id).sort()).toEqual(['cha', 'con', 'dex', 'int', 'str', 'wis']);
        expect(ruleset.abilities.find(a => a.id === 'str').stat_key).toBe('strength');
        expect(ruleset.skills).toHaveLength(18);
        expect(ruleset.skills.find(s => s.id === 'athletics').ability_id).toBe('str');
        expect(ruleset.dc_bands.length).toBeGreaterThanOrEqual(6);
        expect(ruleset.severities.map(s => s.id)).toEqual(expect.arrayContaining(['minor', 'moderate', 'severe', 'lethal']));
        expect(ruleset.dc_min).toBe(5);
        expect(ruleset.dc_max).toBe(30);
    });

    test('starter_stats includes all ability stat_keys plus the conventional extras', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        for (const ability of ruleset.abilities) {
            expect(ruleset.starter_stats[ability.stat_key]).toBe(10);
        }
        expect(ruleset.starter_stats.proficiency_bonus).toBe(2);
        expect(ruleset.starter_stats.level).toBe(1);
        expect(ruleset.starter_stats.hp).toBe(10);
    });
});

describe('user-pack precedence', () => {
    function writeUserSkillsYaml(rulesetId, body) {
        const dir = path.join(tmpRoot, 'rulesets', rulesetId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills.yaml'), body, 'utf8');
        return dir;
    }

    test('user pack overrides bundled file with the same id', () => {
        writeUserSkillsYaml('dnd5e', [
            'version: 1',
            'ruleset: dnd5e',
            'name: "User D&D 5e"',
            'abilities:',
            '  - id: str',
            '    name: Strength',
            '    stat_key: strength',
            'skills:',
            '  athletics:',
            '    name: Athletics',
            '    ability: str',
            '    description: User-overridden athletics.',
            '',
        ].join('\n'));
        _resetCacheForTests();

        const ruleset = loadRuleset(directories, 'dnd5e');
        expect(ruleset).not.toBeNull();
        expect(ruleset.name).toBe('User D&D 5e');
        expect(ruleset.skills).toHaveLength(1);
        expect(ruleset.skills[0].description).toBe('User-overridden athletics.');
    });

    test('listRulesets shows the user pack source for an overridden id', () => {
        writeUserSkillsYaml('dnd5e', [
            'version: 1',
            'ruleset: dnd5e',
            'name: "User D&D 5e"',
            'abilities:',
            '  - id: str',
            '    name: Strength',
            '    stat_key: strength',
            'skills:',
            '  athletics:',
            '    name: Athletics',
            '    ability: str',
            '',
        ].join('\n'));
        _resetCacheForTests();

        const summaries = listRulesets(directories);
        const dnd = summaries.find(s => s.id === 'dnd5e');
        expect(dnd).toBeDefined();
        expect(dnd.source).toBe('user');
    });

    test('cache invalidates when the user file mtime changes', async () => {
        const dir = writeUserSkillsYaml('dnd5e', [
            'version: 1',
            'ruleset: dnd5e',
            'name: "Original"',
            'abilities:',
            '  - id: str',
            '    name: Strength',
            '    stat_key: strength',
            'skills:',
            '  athletics:',
            '    name: Athletics',
            '    ability: str',
            '',
        ].join('\n'));
        _resetCacheForTests();
        const first = loadRuleset(directories, 'dnd5e');
        expect(first.name).toBe('Original');

        // Bump mtime to a value strictly different from the cached one. Some
        // filesystems collapse same-second writes to identical mtimeMs so we
        // wait a beat and rewrite with a known-distinct stamp.
        await new Promise(r => setTimeout(r, 20));
        fs.writeFileSync(path.join(dir, 'skills.yaml'), [
            'version: 1',
            'ruleset: dnd5e',
            'name: "Updated"',
            'abilities:',
            '  - id: str',
            '    name: Strength',
            '    stat_key: strength',
            'skills:',
            '  athletics:',
            '    name: Athletics',
            '    ability: str',
            '',
        ].join('\n'), 'utf8');
        // Force a distinctly later mtime in case the test runs sub-tick.
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(dir, 'skills.yaml'), future, future);

        const second = loadRuleset(directories, 'dnd5e');
        expect(second.name).toBe('Updated');
    });
});

describe('clampDc', () => {
    test('clamps into the ruleset dc range', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        expect(clampDc(ruleset, 0)).toBe(5);
        expect(clampDc(ruleset, 5)).toBe(5);
        expect(clampDc(ruleset, 17)).toBe(17);
        expect(clampDc(ruleset, 99)).toBe(30);
        expect(clampDc(ruleset, 12.7)).toBe(12);
    });
});
