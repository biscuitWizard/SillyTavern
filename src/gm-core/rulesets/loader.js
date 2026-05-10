/**
 * Ruleset YAML loader (Phase 6).
 *
 * A ruleset is three sibling YAML files in a directory named after the
 * ruleset id:
 *
 *   data/rulesets/{id}/skills.yaml
 *   data/rulesets/{id}/dc_guidance.yaml
 *   data/rulesets/{id}/consequences.yaml
 *
 * Lookup precedence:
 *   1. {handle}/rulesets/{id}/  -- per-user pack (overrides bundled)
 *   2. data/rulesets/{id}/      -- bundled, ships with the repo
 *
 * The loader returns the merged Ruleset record with derived fields:
 *   - dc_min/dc_max are clamped to the bands array if `dc_clamp` is missing.
 *   - starter_stats is derived from the abilities table (each stat_key seeded
 *     with 10) plus a small set of conventional keys (hp, max_hp, ac,
 *     proficiency_bonus, level) so the wizard has something to render.
 *   - starter_skills defaults to the empty list.
 *
 * Caching: each unique (handle, id) is parsed once and cached. Cache entries
 * carry the source files' mtimes; reads that find a newer mtime invalidate
 * the entry transparently. This keeps editing-on-disk smooth in dev without
 * needing a server restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import sanitize from 'sanitize-filename';

import { serverDirectory } from '../../server-directory.js';

/**
 * @typedef {import('./schemas.d.ts').Ruleset} Ruleset
 * @typedef {import('./schemas.d.ts').Ability} Ability
 * @typedef {import('./schemas.d.ts').Skill} Skill
 * @typedef {import('./schemas.d.ts').DcBand} DcBand
 * @typedef {import('./schemas.d.ts').Severity} Severity
 * @typedef {import('./schemas.d.ts').RulesetIdSummary} RulesetIdSummary
 */

/**
 * Default keys the wizard expects in `starter_stats` beyond the per-ability
 * scores. Conventional, not pinned by schema; later phases (or user packs)
 * can override by shipping `starter_stats:` in their YAML.
 */
const DEFAULT_STARTER_EXTRA = Object.freeze({
    hp: 10,
    max_hp: 10,
    ac: 10,
    proficiency_bonus: 2,
    level: 1,
});

/** Bundled rulesets root. */
function bundledRoot() {
    return path.join(serverDirectory, 'data', 'rulesets');
}

/**
 * Per-user pack root. Computed from `directories.root` so we don't need to
 * extend USER_DIRECTORY_TEMPLATE for an opt-in feature; a user pack is just
 * a `rulesets/` subdir under their handle's data root.
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 */
function userPackRoot(directories) {
    if (!directories?.root) return null;
    return path.join(directories.root, 'rulesets');
}

/** @type {Map<string, { ruleset: Ruleset, mtimes: Record<string, number>, source: 'user'|'bundled'|'fallback' }>} */
const cache = new Map();

function cacheKey(directories, id) {
    const handle = directories?.root || '__nouser__';
    return `${handle}::${id}`;
}

/**
 * Resolve the directory containing `{id}/skills.yaml` etc. Returns null when
 * neither root has the ruleset.
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 * @param {string} id
 * @returns {{ dir: string, source: 'user'|'bundled' } | null}
 */
function resolveRulesetDir(directories, id) {
    const safe = sanitize(id);
    if (!safe) return null;
    const userRoot = userPackRoot(directories);
    if (userRoot) {
        const userDir = path.join(userRoot, safe);
        if (fs.existsSync(path.join(userDir, 'skills.yaml'))) {
            return { dir: userDir, source: 'user' };
        }
    }
    const bundledDir = path.join(bundledRoot(), safe);
    if (fs.existsSync(path.join(bundledDir, 'skills.yaml'))) {
        return { dir: bundledDir, source: 'bundled' };
    }
    return null;
}

/**
 * Read and parse one YAML file; returns `fallback` if missing. Throws on
 * malformed YAML so loader errors surface loudly during boot rather than
 * silently degrading to an empty ruleset.
 *
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {{ data: T, mtime: number }}
 */
function readYaml(file, fallback) {
    if (!fs.existsSync(file)) {
        return { data: fallback, mtime: 0 };
    }
    const stat = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    const data = parseYaml(raw);
    return { data: data ?? fallback, mtime: stat.mtimeMs };
}

/**
 * Read all three YAML files for `id` from `dir` and merge them into a Ruleset.
 *
 * @param {string} id
 * @param {string} dir
 * @returns {{ ruleset: Ruleset, mtimes: Record<string, number> }}
 */
function buildRuleset(id, dir) {
    const skillsFile = path.join(dir, 'skills.yaml');
    const dcFile = path.join(dir, 'dc_guidance.yaml');
    const sevFile = path.join(dir, 'consequences.yaml');

    const skillsRaw = readYaml(skillsFile, /** @type {any} */({}));
    const dcRaw = readYaml(dcFile, /** @type {any} */({}));
    const sevRaw = readYaml(sevFile, /** @type {any} */({}));

    /** @type {Ability[]} */
    const abilities = Array.isArray(skillsRaw.data?.abilities)
        ? skillsRaw.data.abilities.map(normalizeAbility).filter(Boolean)
        : [];

    /** @type {Skill[]} */
    const skills = [];
    const skillsMap = skillsRaw.data?.skills && typeof skillsRaw.data.skills === 'object'
        ? skillsRaw.data.skills
        : {};
    for (const [skillId, value] of Object.entries(skillsMap)) {
        if (!value || typeof value !== 'object') continue;
        const v = /** @type {any} */ (value);
        skills.push({
            id: String(skillId),
            name: String(v.name || skillId),
            ability_id: String(v.ability || v.ability_id || ''),
            description: String(v.description || ''),
        });
    }

    /** @type {DcBand[]} */
    const dcBands = Array.isArray(dcRaw.data?.bands)
        ? dcRaw.data.bands.map((b) => ({
            id: String(b.id || ''),
            dc: Number(b.dc),
            label: String(b.label || b.id || ''),
            description: String(b.description || ''),
        })).filter((b) => Number.isFinite(b.dc))
        : [];

    const dcMin = Number.isFinite(dcRaw.data?.dc_clamp?.min)
        ? Number(dcRaw.data.dc_clamp.min)
        : (dcBands.length ? Math.min(...dcBands.map((b) => b.dc)) : 1);
    const dcMax = Number.isFinite(dcRaw.data?.dc_clamp?.max)
        ? Number(dcRaw.data.dc_clamp.max)
        : (dcBands.length ? Math.max(...dcBands.map((b) => b.dc)) : 30);

    /** @type {Severity[]} */
    const severities = Array.isArray(sevRaw.data?.severities)
        ? sevRaw.data.severities.map((s) => ({
            id: String(s.id || ''),
            label: String(s.label || s.id || ''),
            description: String(s.description || ''),
        })).filter((s) => s.id)
        : [];

    /** @type {Record<string, number | string>} */
    const starterStats = { ...DEFAULT_STARTER_EXTRA };
    for (const ability of abilities) {
        if (!Object.prototype.hasOwnProperty.call(starterStats, ability.stat_key)) {
            starterStats[ability.stat_key] = 10;
        }
    }
    if (skillsRaw.data?.starter_stats && typeof skillsRaw.data.starter_stats === 'object') {
        Object.assign(starterStats, skillsRaw.data.starter_stats);
    }

    const starterSkills = Array.isArray(skillsRaw.data?.starter_skills)
        ? skillsRaw.data.starter_skills.map(String)
        : [];

    /** @type {Ruleset} */
    const ruleset = {
        id,
        name: String(skillsRaw.data?.name || dcRaw.data?.name || sevRaw.data?.name || id),
        abilities,
        skills,
        dc_bands: dcBands,
        severities,
        dc_min: dcMin,
        dc_max: dcMax,
        starter_stats: starterStats,
        starter_skills: starterSkills,
    };

    return {
        ruleset,
        mtimes: {
            [skillsFile]: skillsRaw.mtime,
            [dcFile]: dcRaw.mtime,
            [sevFile]: sevRaw.mtime,
        },
    };
}

/**
 * @param {any} raw
 * @returns {Ability | null}
 */
function normalizeAbility(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!id) return null;
    const name = String(raw.name || id);
    const stat_key = String(raw.stat_key || raw.statKey || name).toLowerCase();
    return { id, name, stat_key };
}

/**
 * Has any of the `mtimes` files changed since the cache entry was built?
 *
 * @param {Record<string, number>} mtimes
 */
function isStale(mtimes) {
    for (const [file, recorded] of Object.entries(mtimes)) {
        let current = 0;
        try {
            const stat = fs.statSync(file);
            current = stat.mtimeMs;
        } catch (_) { /* missing file: treat as stale */ return true; }
        if (current !== recorded) return true;
    }
    return false;
}

/**
 * Load a ruleset by id, returning null when neither the user pack nor the
 * bundled location has it. Cached + mtime-invalidated.
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 * @param {string} id
 * @returns {Ruleset | null}
 */
export function loadRuleset(directories, id) {
    if (!id) return null;
    const key = cacheKey(directories, id);
    const hit = cache.get(key);
    if (hit && !isStale(hit.mtimes)) {
        return hit.ruleset;
    }
    const resolved = resolveRulesetDir(directories, id);
    if (!resolved) return null;
    const built = buildRuleset(id, resolved.dir);
    cache.set(key, { ruleset: built.ruleset, mtimes: built.mtimes, source: resolved.source });
    return built.ruleset;
}

/**
 * Enumerate every ruleset id discoverable for this user (user pack ids
 * shadow bundled ids of the same name).
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 * @returns {RulesetIdSummary[]}
 */
export function listRulesets(directories) {
    /** @type {Map<string, RulesetIdSummary>} */
    const seen = new Map();
    const visit = (root, source) => {
        if (!root || !fs.existsSync(root)) return;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const id = entry.name;
            if (seen.has(id)) continue;
            const skillsFile = path.join(root, id, 'skills.yaml');
            if (!fs.existsSync(skillsFile)) continue;
            try {
                const ruleset = loadRuleset(directories, id);
                if (!ruleset) continue;
                seen.set(id, { id, name: ruleset.name, source });
            } catch (err) {
                console.warn('[gm] ruleset load failed', { id, err: String(err) });
            }
        }
    };
    visit(userPackRoot(directories), 'user');
    visit(bundledRoot(), 'bundled');
    return Array.from(seen.values());
}

/**
 * Apply the ruleset's DC clamp.
 *
 * @param {Ruleset} ruleset
 * @param {number} dc
 */
export function clampDc(ruleset, dc) {
    const min = Number.isFinite(ruleset.dc_min) ? ruleset.dc_min : 1;
    const max = Number.isFinite(ruleset.dc_max) ? ruleset.dc_max : 30;
    if (!Number.isFinite(dc)) return min;
    return Math.max(min, Math.min(max, Math.trunc(dc)));
}

/** Test-only: drop every cached entry. */
export function _resetCacheForTests() {
    cache.clear();
}
