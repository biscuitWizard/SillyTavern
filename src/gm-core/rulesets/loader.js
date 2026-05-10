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
 * @typedef {import('./schemas.d.ts').SheetLayout} SheetLayout
 * @typedef {import('./schemas.d.ts').SheetCategory} SheetCategory
 * @typedef {import('./schemas.d.ts').SheetField} SheetField
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

/** Bundled sheet-layout overlays root (universal-social.yaml lives here). */
function bundledLayoutsRoot() {
    return path.join(serverDirectory, 'data', 'sheet-layouts');
}

/**
 * Per-user pack root for sheet-layout overlays. Mirrors `userPackRoot`
 * but at `{handle}/sheet-layouts/`.
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 */
function userLayoutsRoot(directories) {
    if (!directories?.root) return null;
    return path.join(directories.root, 'sheet-layouts');
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
 * Resolve the universal social overlay path. Per-user pack wins over
 * bundled (mirrors the ruleset precedence). Returns null when no file
 * exists at either location.
 *
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 */
function resolveUniversalSocialPath(directories) {
    const userRoot = userLayoutsRoot(directories);
    if (userRoot) {
        const p = path.join(userRoot, 'universal-social.yaml');
        if (fs.existsSync(p)) return p;
    }
    const p = path.join(bundledLayoutsRoot(), 'universal-social.yaml');
    if (fs.existsSync(p)) return p;
    return null;
}

/**
 * Normalize a single SheetField record. Drops fields that are missing a
 * key and coerces enum-ish values into known shapes.
 *
 * @param {any} raw
 * @returns {SheetField | null}
 */
function normalizeSheetField(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const key = String(raw.key || '').trim();
    if (!key) return null;
    /** @type {SheetField['type']} */
    let type = String(raw.type || 'text');
    if (!['number', 'bar', 'text', 'paired'].includes(type)) {
        type = 'text';
    }
    /** @type {SheetField} */
    const field = {
        key,
        label: String(raw.label || key),
        type,
    };
    if (raw.required) field.required = true;
    if (raw.default !== undefined) field.default = raw.default;
    if (Number.isFinite(raw.min)) field.min = Number(raw.min);
    if (Number.isFinite(raw.max)) field.max = Number(raw.max);
    if (raw.max_from_key) field.max_from_key = String(raw.max_from_key);
    if (raw.description) field.description = String(raw.description);
    if (raw.paired_with && typeof raw.paired_with === 'object') {
        const pairedKey = String(raw.paired_with.key || '').trim();
        if (pairedKey) {
            field.paired_with = {
                key: pairedKey,
                label: String(raw.paired_with.label || pairedKey),
            };
            if (raw.paired_with.default !== undefined) {
                field.paired_with.default = Number(raw.paired_with.default);
            }
        }
    }
    return field;
}

/**
 * Normalize a single SheetCategory record. Drops categories that are
 * missing an id or have an unknown kind.
 *
 * @param {any} raw
 * @returns {SheetCategory | null}
 */
function normalizeSheetCategory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!id) return null;
    const kind = String(raw.kind || 'stats');
    if (!['stats', 'statuses', 'skills', 'items', 'relationships', 'notes'].includes(kind)) {
        return null;
    }
    /** @type {SheetCategory} */
    const cat = {
        id,
        label: String(raw.label || id),
        kind: /** @type {SheetCategory['kind']} */ (kind),
    };
    if (Array.isArray(raw.fields)) {
        cat.fields = raw.fields.map(normalizeSheetField).filter(Boolean);
    }
    if (Array.isArray(raw.per_target_fields)) {
        cat.per_target_fields = raw.per_target_fields.map(normalizeSheetField).filter(Boolean);
    }
    if (raw.show_all_from_ruleset) cat.show_all_from_ruleset = true;
    if (raw.wizard_step) cat.wizard_step = true;
    if (raw.sidebar_highlight) cat.sidebar_highlight = true;
    if (raw.description) cat.description = String(raw.description);
    return cat;
}

/**
 * Coerce the parsed YAML body into a SheetLayout. Returns null when no
 * categories survive normalization (so an empty file does not masquerade
 * as a usable layout).
 *
 * @param {any} raw
 * @returns {SheetLayout | null}
 */
function normalizeSheetLayout(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cats = Array.isArray(raw.categories)
        ? raw.categories.map(normalizeSheetCategory).filter(Boolean)
        : [];
    if (!cats.length) return null;
    const version = Number.isFinite(raw.version) ? Number(raw.version) : 1;
    return { version, categories: cats };
}

/**
 * Merge a ruleset-side layout with the universal overlay. The ruleset's
 * categories come first; overlay categories whose `id` collides with a
 * ruleset category are skipped (the ruleset wins for shared ids).
 *
 * Returns null when both layouts are null/empty.
 *
 * @param {SheetLayout | null} rulesetLayout
 * @param {SheetLayout | null} overlay
 * @returns {SheetLayout | null}
 */
export function mergeSheetLayouts(rulesetLayout, overlay) {
    const left = rulesetLayout?.categories || [];
    const right = overlay?.categories || [];
    if (!left.length && !right.length) return null;
    const seen = new Set();
    /** @type {SheetCategory[]} */
    const merged = [];
    for (const cat of left) {
        if (!cat || seen.has(cat.id)) continue;
        seen.add(cat.id);
        merged.push(cat);
    }
    for (const cat of right) {
        if (!cat || seen.has(cat.id)) continue;
        seen.add(cat.id);
        merged.push(cat);
    }
    const version = Math.max(rulesetLayout?.version || 1, overlay?.version || 1);
    return { version, categories: merged };
}

/**
 * Read all YAML files for `id` from `dir` plus the universal social
 * overlay and merge them into a Ruleset.
 *
 * @param {string} id
 * @param {string} dir
 * @param {import('../../users.js').UserDirectoryList | null | undefined} directories
 * @returns {{ ruleset: Ruleset, mtimes: Record<string, number> }}
 */
function buildRuleset(id, dir, directories) {
    const skillsFile = path.join(dir, 'skills.yaml');
    const dcFile = path.join(dir, 'dc_guidance.yaml');
    const sevFile = path.join(dir, 'consequences.yaml');
    const layoutFile = path.join(dir, 'sheet_layout.yaml');

    const skillsRaw = readYaml(skillsFile, /** @type {any} */({}));
    const dcRaw = readYaml(dcFile, /** @type {any} */({}));
    const sevRaw = readYaml(sevFile, /** @type {any} */({}));
    const layoutRaw = readYaml(layoutFile, /** @type {any} */(null));
    const overlayPath = resolveUniversalSocialPath(directories);
    const overlayRaw = overlayPath
        ? readYaml(overlayPath, /** @type {any} */(null))
        : { data: null, mtime: 0 };

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

    const rulesetLayout = normalizeSheetLayout(layoutRaw.data);
    const overlay = normalizeSheetLayout(overlayRaw.data);
    const sheetLayout = mergeSheetLayouts(rulesetLayout, overlay);

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
        sheet_layout: sheetLayout,
    };

    /**
     * Only record mtimes for files that actually exist on disk. `readYaml`
     * returns mtime: 0 for missing files; including those in `mtimes`
     * would force `isStale` to invalidate the cache on every read for any
     * ruleset whose `sheet_layout.yaml` is absent.
     *
     * @type {Record<string, number>}
     */
    const mtimes = {};
    if (skillsRaw.mtime > 0) mtimes[skillsFile] = skillsRaw.mtime;
    if (dcRaw.mtime > 0) mtimes[dcFile] = dcRaw.mtime;
    if (sevRaw.mtime > 0) mtimes[sevFile] = sevRaw.mtime;
    if (layoutRaw.mtime > 0) mtimes[layoutFile] = layoutRaw.mtime;
    if (overlayPath && overlayRaw.mtime > 0) mtimes[overlayPath] = overlayRaw.mtime;
    return { ruleset, mtimes };
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
    const built = buildRuleset(id, resolved.dir, directories);
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
