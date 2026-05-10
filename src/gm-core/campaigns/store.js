/**
 * JSON-backed CampaignStore.
 *
 * Layout (per ADR 0003):
 *
 *   {handle}/campaigns/
 *       {campaign_id}/
 *           campaign.json
 *           characters/{char_id}.json   (Phase 2)
 *           scenes/{scene_id}.json      (Phase 3)
 *           scenes/{scene_id}.jsonl     (Phase 3)
 *
 * Reads are cached per (handle, campaign_id) and invalidated on write.
 */

import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';

import { buildCampaign, buildCurrentSituation } from './schemas.js';
import {
    ensureDir,
    nowIso,
    readJson,
    removeDir,
    uniqueId,
    writeJson,
} from '../util/io.js';

const CAMPAIGN_FILE = 'campaign.json';

/**
 * @typedef {import('./schemas.js').Campaign} Campaign
 * @typedef {import('./schemas.js').CampaignSummary} CampaignSummary
 */

/**
 * Per-process cache of `Campaign` records keyed by `${handle}::${id}`.
 * Cleared on write/delete.
 *
 * @type {Map<string, Campaign>}
 */
const cache = new Map();

function cacheKey(handle, id) {
    return `${handle}::${id}`;
}

/**
 * Resolve the path to a campaign directory.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function campaignDir(directories, campaignId) {
    return path.join(directories.campaigns, sanitize(campaignId));
}

/**
 * Resolve the path to a campaign's metadata file.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function campaignFile(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), CAMPAIGN_FILE);
}

/**
 * List all campaign ids found on disk for a user.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {string[]}
 */
export function listIds(directories) {
    if (!fs.existsSync(directories.campaigns)) return [];
    return fs.readdirSync(directories.campaigns, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(name => fs.existsSync(path.join(directories.campaigns, name, CAMPAIGN_FILE)))
        .sort();
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Campaign | null}
 */
export function get(directories, campaignId) {
    const handle = directories.root;
    const key = cacheKey(handle, campaignId);
    if (cache.has(key)) return cache.get(key) ?? null;

    const file = campaignFile(directories, campaignId);
    const raw = readJson(file, /** @type {Campaign | null} */(null));
    if (raw === null) return null;
    // Defensive backfill for fields added after the campaign was first
    // written. Read-side default keeps older on-disk records compatible
    // without a one-shot migration; the next write persists the field.
    if (!('current_situation' in raw)) raw.current_situation = null;
    cache.set(key, raw);
    return raw;
}

/**
 * Count `*.json` scene files inside a campaign's `scenes/` subdir.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
function sceneCount(directories, campaignId) {
    const scenesDir = path.join(campaignDir(directories, campaignId), 'scenes');
    if (!fs.existsSync(scenesDir)) return 0;
    return fs.readdirSync(scenesDir).filter(f => f.endsWith('.json')).length;
}

/**
 * @param {Campaign} c
 * @param {number} sceneCountValue
 * @returns {CampaignSummary}
 */
function toSummary(c, sceneCountValue) {
    return {
        id: c.id,
        name: c.name,
        brief: c.brief,
        ruleset_id: c.ruleset_id,
        banner_theme: c.banner_theme,
        last_played_at: c.last_played_at,
        scene_count: sceneCountValue,
    };
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {CampaignSummary[]}
 */
export function listSummaries(directories) {
    const ids = listIds(directories);
    /** @type {CampaignSummary[]} */
    const out = [];
    for (const id of ids) {
        const c = get(directories, id);
        if (c) out.push(toSummary(c, sceneCount(directories, id)));
    }
    out.sort((a, b) => {
        const at = a.last_played_at ? Date.parse(a.last_played_at) : 0;
        const bt = b.last_played_at ? Date.parse(b.last_played_at) : 0;
        return bt - at;
    });
    return out;
}

/**
 * Create a new campaign, writing `campaign.json` atomically.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Partial<Campaign> & { name: string }} input
 * @returns {Campaign}
 */
export function create(directories, input) {
    ensureDir(directories.campaigns);
    const id = uniqueId(input.name, listIds(directories));
    const campaign = buildCampaign({ ...input, id });
    const file = campaignFile(directories, campaign.id);
    ensureDir(path.dirname(file));
    writeJson(file, campaign);
    cache.set(cacheKey(directories.root, campaign.id), campaign);
    return campaign;
}

/**
 * Apply a partial update to an existing campaign and persist it.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Partial<Campaign>} patch
 * @returns {Campaign | null}
 */
export function update(directories, campaignId, patch) {
    const existing = get(directories, campaignId);
    if (!existing) return null;
    /** @type {Campaign} */
    const merged = {
        ...existing,
        ...patch,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: nowIso(),
    };
    writeJson(campaignFile(directories, campaignId), merged);
    cache.set(cacheKey(directories.root, campaignId), merged);
    return merged;
}

/**
 * Mark a campaign as recently played; updates `last_played_at` to now.
 * Idempotent. Returns the updated record or null if missing.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function touch(directories, campaignId) {
    return update(directories, campaignId, { last_played_at: nowIso() });
}

/**
 * Replace `Campaign.current_situation`. Pass `null` to clear it. Input is
 * normalised through `buildCurrentSituation` so callers may pass partial
 * payloads (e.g. raw LLM output) without leaking unvalidated fields.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Partial<import('./schemas.js').CurrentSituation> | null} situation
 * @returns {Campaign | null}
 */
export function updateCurrentSituation(directories, campaignId, situation) {
    const normalised = situation === null ? null : buildCurrentSituation({
        ...situation,
        updated_at: nowIso(),
    });
    return update(directories, campaignId, { current_situation: normalised });
}

/**
 * Delete a campaign's directory tree.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {boolean} true if removed; false if it did not exist.
 */
export function remove(directories, campaignId) {
    const dir = campaignDir(directories, campaignId);
    if (!fs.existsSync(dir)) return false;
    removeDir(dir);
    cache.delete(cacheKey(directories.root, campaignId));
    return true;
}
