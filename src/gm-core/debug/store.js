/**
 * JSONL file I/O for debug events.
 *
 * Layout:
 *   {handle}/campaigns/{cid}/scenes/{scene_id}/debug-events.jsonl
 *   {handle}/campaigns/{cid}/debug-events.jsonl   (when sceneId is null)
 *
 * Append is serialized through a per-file in-process mutex (same pattern
 * as `scenes/transcript.js`) so concurrent writes never interleave.
 */

import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';

import { campaignDir } from '../campaigns/store.js';
import { ensureDir } from '../util/io.js';

/**
 * @typedef {import('./schemas.js').DebugEvent} DebugEvent
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const DEBUG_FILE = 'debug-events.jsonl';

/** @type {Map<string, Promise<void>>} */
const fileLocks = new Map();

/**
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withLock(file, task) {
    const previous = fileLocks.get(file) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    fileLocks.set(file, previous.then(() => next));
    try {
        await previous.catch(() => {});
        return await task();
    } finally {
        release();
        if (fileLocks.get(file) === previous.then(() => next)) {
            fileLocks.delete(file);
        }
    }
}

/**
 * Path to the debug-events JSONL for a campaign or scene.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string | null | undefined} sceneId
 * @returns {string}
 */
export function debugEventsFile(directories, campaignId, sceneId) {
    const base = campaignDir(directories, campaignId);
    if (sceneId) {
        return path.join(base, 'scenes', sanitize(sceneId), DEBUG_FILE);
    }
    return path.join(base, DEBUG_FILE);
}

/**
 * Append one debug event as a JSON line. Ring-rotates the file if it
 * exceeds 20 MB (rename current → `.1.jsonl`, then start fresh).
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string | null | undefined} sceneId
 * @param {DebugEvent} event
 * @returns {Promise<void>}
 */
export function appendEvent(directories, campaignId, sceneId, event) {
    const file = debugEventsFile(directories, campaignId, sceneId);
    return withLock(file, async () => {
        ensureDir(path.dirname(file));
        if (fs.existsSync(file)) {
            const stat = fs.statSync(file);
            if (stat.size > MAX_FILE_SIZE) {
                const rotated = file.replace(/\.jsonl$/, '.1.jsonl');
                await fs.promises.rename(file, rotated);
                await fs.promises.writeFile(file, '', 'utf8');
            }
        }
        await fs.promises.appendFile(file, JSON.stringify(event) + '\n', 'utf8');
    });
}

/**
 * Read debug events from the JSONL file.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string | null | undefined} sceneId
 * @param {{ since?: string, limit?: number }} [opts]
 * @returns {DebugEvent[]}
 */
export function readEvents(directories, campaignId, sceneId, { since, limit = 500 } = {}) {
    const file = debugEventsFile(directories, campaignId, sceneId);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');

    /** @type {DebugEvent[]} */
    const out = [];
    let pastSince = !since;

    for (const text of lines) {
        if (!text) continue;
        /** @type {DebugEvent} */
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            continue;
        }
        if (!pastSince) {
            if (parsed.id === since) pastSince = true;
            continue;
        }
        out.push(parsed);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Truncate the debug-events file to empty.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string | null | undefined} sceneId
 * @returns {Promise<void>}
 */
export function clearEvents(directories, campaignId, sceneId) {
    const file = debugEventsFile(directories, campaignId, sceneId);
    return withLock(file, async () => {
        if (fs.existsSync(file)) {
            await fs.promises.writeFile(file, '', 'utf8');
        }
    });
}
