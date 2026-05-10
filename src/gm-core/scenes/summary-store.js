/**
 * Disk-canonical persistence for scene-end `SceneSummary` documents.
 *
 * Layout: `{handle}/campaigns/{cid}/scenes/{scene_id}.summary.json`. Sits
 * next to the scene metadata JSON and the transcript JSONL so a campaign
 * directory remains self-contained.
 *
 * Writes are atomic via `write-file-atomic` (same idiom as the rest of
 * `gm-core/`). Re-writing the same `SceneSummary` is idempotent at the
 * filesystem level — the contents are deterministic given the scene id
 * and transcript, so a second pipeline run replaces the file with the
 * same bytes.
 */

import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { campaignDir } from '../campaigns/store.js';
import { ensureDir } from '../util/io.js';
import { buildSceneSummary } from './schemas.js';

/** @typedef {import('./schemas.js').SceneSummary} SceneSummary */

/**
 * Absolute path to the summary JSON for a given scene.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 */
export function summaryFile(directories, campaignId, sceneId) {
    return path.join(campaignDir(directories, campaignId), 'scenes', `${sanitize(sceneId)}.summary.json`);
}

/**
 * Path stored on `Scene.summary_path` so the frontend / debug tools can
 * resolve the file without re-running the join. Relative to the user
 * handle root (`directories.root`).
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 */
export function summaryRelativePath(directories, campaignId, sceneId) {
    const abs = summaryFile(directories, campaignId, sceneId);
    const root = directories.root;
    if (abs.startsWith(root)) {
        const rel = abs.slice(root.length);
        return rel.startsWith(path.sep) ? rel.slice(path.sep.length) : rel;
    }
    return abs;
}

/**
 * Read a previously written summary. Returns `null` if the file does not
 * exist or fails to parse — callers treat absence as "no summary yet".
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @returns {SceneSummary | null}
 */
export function read(directories, campaignId, sceneId) {
    const file = summaryFile(directories, campaignId, sceneId);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.warn('[gm] summary-store: failed to parse summary', { file, err: String(err) });
        return null;
    }
}

/**
 * Atomically write a `SceneSummary` to disk. The payload is normalised
 * through `buildSceneSummary` first so callers can pass in raw LLM
 * output without leaking unvalidated fields.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {Partial<SceneSummary>} input
 * @returns {SceneSummary}
 */
export function write(directories, campaignId, sceneId, input) {
    const summary = buildSceneSummary({ ...input, scene_id: sceneId, campaign_id: campaignId });
    const file = summaryFile(directories, campaignId, sceneId);
    ensureDir(path.dirname(file));
    writeFileAtomicSync(file, JSON.stringify(summary, null, 4), 'utf8');
    return summary;
}

/**
 * Delete the summary file (used by tests + by the cascade on character /
 * campaign delete). No-op if absent.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 */
export function remove(directories, campaignId, sceneId) {
    const file = summaryFile(directories, campaignId, sceneId);
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
    }
}
