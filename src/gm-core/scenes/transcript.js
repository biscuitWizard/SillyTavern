/**
 * Per-scene JSONL transcript reader/writer.
 *
 * Layout: `{handle}/campaigns/{cid}/scenes/{scene_id}.jsonl`. Lines mirror
 * ST's `addOneMessage()` schema so the existing chat substrate can render
 * them without any conversion.
 *
 * Append is serialized through a per-file in-process mutex so two HTTP
 * requests that hit the same scene don't interleave their writes.
 */

import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';

import { campaignDir } from '../campaigns/store.js';
import { ensureDir } from '../util/io.js';

/**
 * @typedef {import('./schemas.js').TranscriptLine} TranscriptLine
 */

/** @type {Map<string, Promise<void>>} */
const fileLocks = new Map();

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 */
export function transcriptFile(directories, campaignId, sceneId) {
    return path.join(campaignDir(directories, campaignId), 'scenes', `${sanitize(sceneId)}.jsonl`);
}

/**
 * Run `task` while holding the per-file mutex. Other appends to the same
 * file queue up; failures don't poison the queue (the mutex only carries the
 * "is the previous task done?" signal).
 *
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
        await previous.catch(() => {}); // swallow upstream errors so later tasks still run
        return await task();
    } finally {
        release();
        if (fileLocks.get(file) && fileLocks.get(file) === previous.then(() => next)) {
            fileLocks.delete(file);
        }
    }
}

/**
 * Append a single TranscriptLine atomically.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {TranscriptLine} line
 * @returns {Promise<void>}
 */
export function appendLine(directories, campaignId, sceneId, line) {
    const file = transcriptFile(directories, campaignId, sceneId);
    return withLock(file, async () => {
        ensureDir(path.dirname(file));
        await fs.promises.appendFile(file, JSON.stringify(line) + '\n', 'utf8');
    });
}

/**
 * Read all lines from a scene's transcript. Optionally skip the first
 * `after` lines (caller-supplied "I have N already" cursor).
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {number} [after]
 * @returns {TranscriptLine[]}
 */
export function readLines(directories, campaignId, sceneId, after = 0) {
    const file = transcriptFile(directories, campaignId, sceneId);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    /** @type {TranscriptLine[]} */
    const out = [];
    const allLines = raw.split('\n');
    for (let i = 0; i < allLines.length; i++) {
        const text = allLines[i];
        if (!text) continue;
        if (i < after) continue;
        try {
            out.push(JSON.parse(text));
        } catch (err) {
            console.warn('[gm] malformed transcript line', { file, lineIndex: i, err: String(err) });
        }
    }
    return out;
}

/**
 * Quick line-count helper used by `SceneStore` to keep `message_count` in
 * sync without re-parsing every record.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 */
export function countLines(directories, campaignId, sceneId) {
    const file = transcriptFile(directories, campaignId, sceneId);
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter(line => line.length > 0).length;
}
