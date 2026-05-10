/**
 * M1 — sheet layout loader tests.
 *
 * The loader now reads two YAML inputs and exposes a merged
 * `ruleset.sheet_layout` field:
 *
 *   1. `data/rulesets/{id}/sheet_layout.yaml` (bundled or user pack)
 *      — combat-side categories specific to the ruleset.
 *   2. `data/sheet-layouts/universal-social.yaml` (bundled or user pack
 *      at `{handle}/sheet-layouts/universal-social.yaml`) — the
 *      universal Personality / Pulse / Relationships overlay.
 *
 * Merge rule: ruleset categories first, overlay categories appended,
 * skipping overlay categories whose `id` collides with a ruleset
 * category (the ruleset wins).
 *
 * This file pins:
 *   - bundled dnd5e + bundled overlay merge cleanly (real on-disk read);
 *   - user pack overrides bundled (both for the per-ruleset layout and
 *     for the universal overlay);
 *   - missing `sheet_layout.yaml` falls back gracefully to overlay-only
 *     and back to `null` when neither file exists;
 *   - cache invalidates when either file's mtime changes;
 *   - field/category normalization rejects malformed entries cleanly.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRuleset, mergeSheetLayouts, _resetCacheForTests } from '../../src/gm-core/rulesets/loader.js';

let tmpRoot;
let directories;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrpg-sheet-layout-'));
    directories = { root: tmpRoot, campaigns: path.join(tmpRoot, 'campaigns') };
    _resetCacheForTests();
});

afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
});

function writeYaml(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
}

describe('bundled D&D 5e + universal-social merge', () => {
    test('ruleset.sheet_layout has both combat and social categories in order', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        expect(ruleset).not.toBeNull();
        const layout = ruleset.sheet_layout;
        expect(layout).not.toBeNull();
        expect(layout.version).toBeGreaterThanOrEqual(1);
        const ids = layout.categories.map((c) => c.id);
        // Combat side first.
        expect(ids).toEqual(expect.arrayContaining(['abilities', 'combat', 'skills', 'inventory', 'conditions', 'notes']));
        // Universal overlay categories follow.
        expect(ids).toEqual(expect.arrayContaining(['pools', 'traits', 'pulse', 'intimacy', 'relationships']));
        // Order: ruleset categories appear before overlay categories.
        expect(ids.indexOf('abilities')).toBeLessThan(ids.indexOf('traits'));
        expect(ids.indexOf('combat')).toBeLessThan(ids.indexOf('relationships'));
    });

    test('every category survives normalization (id + label + kind set)', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        for (const cat of ruleset.sheet_layout.categories) {
            expect(typeof cat.id).toBe('string');
            expect(cat.id.length).toBeGreaterThan(0);
            expect(typeof cat.label).toBe('string');
            expect(['stats', 'statuses', 'skills', 'items', 'relationships', 'notes']).toContain(cat.kind);
        }
    });

    test('paired-trait fields preserve their paired_with leg', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        const traits = ruleset.sheet_layout.categories.find((c) => c.id === 'traits');
        expect(traits).toBeDefined();
        const dom = traits.fields.find((f) => f.key === 'dom');
        expect(dom).toBeDefined();
        expect(dom.type).toBe('paired');
        expect(dom.paired_with).toEqual(expect.objectContaining({ key: 'shy', label: 'Shy' }));
    });

    test('relationships category exposes per_target_fields rather than fields', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        const rel = ruleset.sheet_layout.categories.find((c) => c.id === 'relationships');
        expect(rel).toBeDefined();
        expect(rel.kind).toBe('relationships');
        expect(Array.isArray(rel.per_target_fields)).toBe(true);
        expect(rel.per_target_fields.length).toBeGreaterThan(0);
        const stage = rel.per_target_fields.find((f) => f.key === 'stage');
        expect(stage).toBeDefined();
        expect(stage.type).toBe('text');
    });

    test('bar fields can carry a max_from_key reference to another stat', () => {
        const ruleset = loadRuleset(directories, 'dnd5e');
        const combat = ruleset.sheet_layout.categories.find((c) => c.id === 'combat');
        const hp = combat.fields.find((f) => f.key === 'hp');
        expect(hp).toBeDefined();
        expect(hp.type).toBe('bar');
        expect(hp.max_from_key).toBe('max_hp');
    });
});

describe('user-pack precedence for the per-ruleset layout', () => {
    function writeMinimalUserRuleset(rulesetId) {
        // The loader needs a `skills.yaml` to even consider a user pack
        // dir as a ruleset — we ship a minimal one alongside the layout.
        writeYaml(path.join(tmpRoot, 'rulesets', rulesetId, 'skills.yaml'), [
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
    }

    test('user-pack sheet_layout.yaml replaces the bundled one', () => {
        writeMinimalUserRuleset('dnd5e');
        writeYaml(path.join(tmpRoot, 'rulesets', 'dnd5e', 'sheet_layout.yaml'), [
            'version: 1',
            'categories:',
            '  - id: vibes',
            '    label: Vibes',
            '    kind: stats',
            '    fields:',
            '      - key: vibe',
            '        label: Vibe',
            '        type: text',
            '        default: "calm"',
            '',
        ].join('\n'));
        _resetCacheForTests();

        const ruleset = loadRuleset(directories, 'dnd5e');
        expect(ruleset).not.toBeNull();
        const ids = ruleset.sheet_layout.categories.map((c) => c.id);
        // The bundled `abilities` category is gone (user-pack layout
        // wholly replaced it); the user-pack `vibes` category is first.
        expect(ids[0]).toBe('vibes');
        expect(ids).not.toContain('abilities');
        expect(ids).not.toContain('combat');
        // Universal overlay still merges in.
        expect(ids).toEqual(expect.arrayContaining(['pools', 'traits', 'relationships']));
    });

    test('user-pack universal-social overlay shadows the bundled overlay', () => {
        // No user-pack ruleset — the loader resolves the ruleset to the
        // bundled dnd5e dir, but the universal overlay is loaded
        // independently and the user pack's copy wins.
        writeYaml(path.join(tmpRoot, 'sheet-layouts', 'universal-social.yaml'), [
            'version: 1',
            'categories:',
            '  - id: tiny_overlay',
            '    label: Tiny Overlay',
            '    kind: stats',
            '    fields:',
            '      - key: courage',
            '        label: Courage',
            '        type: number',
            '        default: 5',
            '',
        ].join('\n'));
        _resetCacheForTests();

        const ruleset = loadRuleset(directories, 'dnd5e');
        const ids = ruleset.sheet_layout.categories.map((c) => c.id);
        // Bundled combat side still appears (per-ruleset layout was not overridden).
        expect(ids).toEqual(expect.arrayContaining(['abilities', 'combat']));
        // The user overlay replaces the bundled one wholesale.
        expect(ids).toContain('tiny_overlay');
        expect(ids).not.toContain('pools');
        expect(ids).not.toContain('relationships');
    });
});

describe('graceful fallback when files are missing', () => {
    test('a ruleset without sheet_layout.yaml still loads with overlay-only categories', () => {
        // Ship a user-pack ruleset with skills but NO sheet_layout.yaml.
        writeYaml(path.join(tmpRoot, 'rulesets', 'tiny', 'skills.yaml'), [
            'version: 1',
            'ruleset: tiny',
            'name: "Tiny System"',
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

        const ruleset = loadRuleset(directories, 'tiny');
        expect(ruleset).not.toBeNull();
        const layout = ruleset.sheet_layout;
        expect(layout).not.toBeNull();
        const ids = layout.categories.map((c) => c.id);
        expect(ids).toEqual(expect.arrayContaining(['pools', 'traits', 'relationships']));
        expect(ids).not.toContain('abilities');
    });

    test('mergeSheetLayouts(null, null) returns null', () => {
        expect(mergeSheetLayouts(null, null)).toBeNull();
    });

    test('mergeSheetLayouts: ruleset id wins over overlay id collision', () => {
        const left = {
            version: 1,
            categories: [{ id: 'shared', label: 'Ruleset Shared', kind: 'stats', fields: [{ key: 'a', label: 'A', type: 'number' }] }],
        };
        const right = {
            version: 1,
            categories: [
                { id: 'shared', label: 'Overlay Shared', kind: 'stats', fields: [{ key: 'b', label: 'B', type: 'number' }] },
                { id: 'unique', label: 'Overlay Unique', kind: 'stats', fields: [] },
            ],
        };
        const merged = mergeSheetLayouts(left, right);
        expect(merged.categories.map((c) => c.id)).toEqual(['shared', 'unique']);
        // Ruleset's `shared` definition is kept.
        expect(merged.categories[0].label).toBe('Ruleset Shared');
        expect(merged.categories[0].fields[0].key).toBe('a');
    });

    test('malformed categories are dropped silently rather than crashing the loader', () => {
        writeYaml(path.join(tmpRoot, 'rulesets', 'broken', 'skills.yaml'), [
            'version: 1',
            'ruleset: broken',
            'name: "Broken"',
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
        writeYaml(path.join(tmpRoot, 'rulesets', 'broken', 'sheet_layout.yaml'), [
            'version: 1',
            'categories:',
            '  - id: ""',                     // dropped: empty id
            '    label: No Id',
            '    kind: stats',
            '  - label: No Id Either',        // dropped: missing id
            '    kind: stats',
            '  - id: bogus',
            '    label: Bogus Kind',
            '    kind: nonsense',             // dropped: unknown kind
            '  - id: good',
            '    label: Good',
            '    kind: stats',
            '    fields:',
            '      - { key: "", label: "Anonymous", type: "number" }',  // dropped: empty key
            '      - { key: pulse, label: "Pulse", type: "weird-type" }',// type coerced to text
            '      - { key: hp, label: "HP", type: "number", default: 10 }',
            '',
        ].join('\n'));
        _resetCacheForTests();

        const ruleset = loadRuleset(directories, 'broken');
        const ids = ruleset.sheet_layout.categories.map((c) => c.id);
        expect(ids).toContain('good');
        expect(ids).not.toContain('');
        expect(ids).not.toContain('bogus');
        const good = ruleset.sheet_layout.categories.find((c) => c.id === 'good');
        // Two surviving fields: pulse (coerced) + hp.
        expect(good.fields.map((f) => f.key)).toEqual(['pulse', 'hp']);
        expect(good.fields.find((f) => f.key === 'pulse').type).toBe('text');
    });
});

describe('cache invalidation across both layout files', () => {
    test('editing the per-ruleset sheet_layout.yaml invalidates the cache', async () => {
        // Ship a user-pack copy of dnd5e so we can mutate its layout file.
        writeYaml(path.join(tmpRoot, 'rulesets', 'dnd5e', 'skills.yaml'), [
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
        const layoutFile = path.join(tmpRoot, 'rulesets', 'dnd5e', 'sheet_layout.yaml');
        writeYaml(layoutFile, [
            'version: 1',
            'categories:',
            '  - id: alpha',
            '    label: Alpha',
            '    kind: stats',
            '    fields:',
            '      - { key: a, label: A, type: number }',
            '',
        ].join('\n'));
        _resetCacheForTests();
        const first = loadRuleset(directories, 'dnd5e');
        expect(first.sheet_layout.categories[0].id).toBe('alpha');

        await new Promise((r) => setTimeout(r, 20));
        writeYaml(layoutFile, [
            'version: 1',
            'categories:',
            '  - id: beta',
            '    label: Beta',
            '    kind: stats',
            '    fields:',
            '      - { key: b, label: B, type: number }',
            '',
        ].join('\n'));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(layoutFile, future, future);

        const second = loadRuleset(directories, 'dnd5e');
        expect(second.sheet_layout.categories[0].id).toBe('beta');
    });

    test('editing the user-pack universal-social overlay invalidates the cache', async () => {
        writeYaml(path.join(tmpRoot, 'rulesets', 'dnd5e', 'skills.yaml'), [
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
        const overlayFile = path.join(tmpRoot, 'sheet-layouts', 'universal-social.yaml');
        writeYaml(overlayFile, [
            'version: 1',
            'categories:',
            '  - id: o1',
            '    label: Overlay One',
            '    kind: stats',
            '    fields:',
            '      - { key: x, label: X, type: number }',
            '',
        ].join('\n'));
        _resetCacheForTests();
        const first = loadRuleset(directories, 'dnd5e');
        expect(first.sheet_layout.categories.map((c) => c.id)).toContain('o1');

        await new Promise((r) => setTimeout(r, 20));
        writeYaml(overlayFile, [
            'version: 1',
            'categories:',
            '  - id: o2',
            '    label: Overlay Two',
            '    kind: stats',
            '    fields:',
            '      - { key: y, label: Y, type: number }',
            '',
        ].join('\n'));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(overlayFile, future, future);

        const second = loadRuleset(directories, 'dnd5e');
        const ids = second.sheet_layout.categories.map((c) => c.id);
        expect(ids).toContain('o2');
        expect(ids).not.toContain('o1');
    });
});
