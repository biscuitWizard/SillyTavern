/**
 * JSON-backed SceneStore (Phase 3).
 *
 * Scene metadata lives at `{handle}/campaigns/{cid}/scenes/{scene_id}.json`,
 * the transcript next to it at `{scene_id}.jsonl`. Reads cache per (handle,
 * scene_id) and invalidate on write.
 *
 * Also touches `Campaign.current_scene_id` when scenes are created or ended.
 */

import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';

import { buildScene } from './schemas.js';
import * as campaignStore from '../campaigns/store.js';
import { campaignDir } from '../campaigns/store.js';
import { countLines } from './transcript.js';
import {
    ensureDir,
    nowIso,
    readJson,
    uniqueId,
    writeJson,
} from '../util/io.js';

/** @typedef {import('./schemas.js').Scene} Scene */

/** @type {Map<string, Scene>} */
const cache = new Map();

function cacheKey(handle, id) {
    return `${handle}::${id}`;
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function scenesDir(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'scenes');
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 */
export function sceneFile(directories, campaignId, sceneId) {
    return path.join(scenesDir(directories, campaignId), `${sanitize(sceneId)}.json`);
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {string[]}
 */
export function listIds(directories, campaignId) {
    const dir = scenesDir(directories, campaignId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .sort();
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @returns {Scene | null}
 */
export function get(directories, campaignId, sceneId) {
    const key = cacheKey(directories.root, sceneId);
    if (cache.has(key)) return cache.get(key) ?? null;
    const file = sceneFile(directories, campaignId, sceneId);
    const raw = readJson(file, /** @type {Scene | null} */(null));
    if (raw === null) return null;
    cache.set(key, raw);
    return raw;
}

/**
 * Walk every campaign's `scenes/` directory looking for a Scene with the
 * given id. Used by `/api/gm/scenes/:id` and friends.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} sceneId
 * @returns {{ campaign_id: string, scene: Scene } | null}
 */
export function findById(directories, sceneId) {
    if (!fs.existsSync(directories.campaigns)) return null;
    for (const cid of fs.readdirSync(directories.campaigns)) {
        const cdir = path.join(directories.campaigns, cid);
        if (!fs.statSync(cdir).isDirectory()) continue;
        // Skip campaigns that don't actually have a scene file with this id
        // on disk. The `get(...)` cache is keyed by (handle, sceneId) only
        // — without this guard, a cache hit from a different campaign would
        // be wrongly attributed to `cid`, which then breaks transcript paths
        // built off `findById(...)` results.
        if (!fs.existsSync(sceneFile(directories, cid, sceneId))) continue;
        const scene = get(directories, cid, sceneId);
        if (scene) return { campaign_id: cid, scene };
    }
    return null;
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Scene[]}
 */
export function listAll(directories, campaignId) {
    return listIds(directories, campaignId)
        .map(id => get(directories, campaignId, id))
        .filter(/** @returns {s is Scene} */ (s) => s !== null);
}

/**
 * Create a scene, write its metadata + an empty `.jsonl`, set the campaign's
 * `current_scene_id`.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Partial<Scene>} input
 * @returns {Scene}
 */
export function create(directories, campaignId, input) {
    ensureDir(scenesDir(directories, campaignId));
    const baseName = input.name && input.name.trim().length > 0
        ? input.name
        : `scene-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const id = uniqueId(baseName, listIds(directories, campaignId));
    const scene = buildScene({ ...input, id, campaign_id: campaignId });
    writeJson(sceneFile(directories, campaignId, scene.id), scene);

    const transcriptPath = path.join(scenesDir(directories, campaignId), `${sanitize(scene.id)}.jsonl`);
    if (!fs.existsSync(transcriptPath)) {
        fs.writeFileSync(transcriptPath, '', 'utf8');
    }

    cache.set(cacheKey(directories.root, scene.id), scene);

    try {
        campaignStore.update(directories, campaignId, { current_scene_id: scene.id });
    } catch (err) {
        console.warn('[gm] scene create: failed to set current_scene_id', err);
    }

    return scene;
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {Partial<Scene>} patch
 * @returns {Scene | null}
 */
export function update(directories, campaignId, sceneId, patch) {
    const existing = get(directories, campaignId, sceneId);
    if (!existing) return null;
    /** @type {Scene} */
    const merged = {
        ...existing,
        ...patch,
        id: existing.id,
        campaign_id: existing.campaign_id,
        started_at: existing.started_at,
    };
    writeJson(sceneFile(directories, campaignId, sceneId), merged);
    cache.set(cacheKey(directories.root, sceneId), merged);
    return merged;
}

/**
 * Sync the scene's `message_count` from the transcript file size.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 */
export function refreshMessageCount(directories, campaignId, sceneId) {
    const count = countLines(directories, campaignId, sceneId);
    return update(directories, campaignId, sceneId, { message_count: count });
}

/**
 * Mark a scene `closed`. Clears `Campaign.current_scene_id` if it pointed
 * at this scene. Optionally persists summary metadata produced by the
 * Phase 8 scene-end pipeline (`summary_id`, `summary_headline`,
 * `summary_path`).
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {{ summary_id?: string | null, summary_headline?: string | null, summary_path?: string | null }} [summaryPatch]
 * @returns {Scene | null}
 */
export function endScene(directories, campaignId, sceneId, summaryPatch) {
    /** @type {Partial<Scene>} */
    const patch = {
        status: 'closed',
        ended_at: nowIso(),
    };
    if (summaryPatch && typeof summaryPatch === 'object') {
        if ('summary_id' in summaryPatch) patch.summary_id = summaryPatch.summary_id ?? null;
        if ('summary_headline' in summaryPatch) patch.summary_headline = summaryPatch.summary_headline ?? null;
        if ('summary_path' in summaryPatch) patch.summary_path = summaryPatch.summary_path ?? null;
    }
    const updated = update(directories, campaignId, sceneId, patch);
    if (!updated) return null;

    try {
        const campaign = campaignStore.get(directories, campaignId);
        if (campaign && campaign.current_scene_id === sceneId) {
            campaignStore.update(directories, campaignId, { current_scene_id: null });
        }
    } catch (err) {
        console.warn('[gm] endScene: failed to clear current_scene_id', err);
    }

    return updated;
}
