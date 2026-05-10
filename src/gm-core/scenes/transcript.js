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
import { sync as writeFileAtomicSync } from 'write-file-atomic';

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

/**
 * Atomically rewrite the entire transcript with the supplied lines.
 *
 * The whole read-mutate-write cycle runs under the per-file mutex so
 * concurrent appends/edits/deletes can't interleave. The write itself
 * uses `write-file-atomic` (temp file + rename), so partial writes are
 * never observable by readers.
 *
 * Use cases (all keyed by line index):
 *   - editing a single line: load → patch [idx] → rewriteLines
 *   - deleting a single line: load → splice [idx] → rewriteLines
 *   - truncating after an index (regenerate flow): load → slice → rewriteLines
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {TranscriptLine[]} lines
 * @returns {Promise<void>}
 */
export function rewriteLines(directories, campaignId, sceneId, lines) {
    const file = transcriptFile(directories, campaignId, sceneId);
    return withLock(file, async () => {
        ensureDir(path.dirname(file));
        const body = lines.map(l => JSON.stringify(l)).join('\n');
        writeFileAtomicSync(file, body.length ? body + '\n' : '', 'utf8');
    });
}

/**
 * Patch a single line by 0-based index. Returns the updated line.
 * Throws if the index is out of range.
 *
 * The patch is shallow-merged into the existing line. To replace the
 * full line shape, pass an object containing every field you want.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {number} idx
 * @param {Partial<TranscriptLine>} patch
 * @returns {Promise<TranscriptLine>}
 */
export async function updateLine(directories, campaignId, sceneId, idx, patch) {
    const file = transcriptFile(directories, campaignId, sceneId);
    return withLock(file, async () => {
        ensureDir(path.dirname(file));
        const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        /** @type {TranscriptLine[]} */
        const lines = raw.split('\n').filter(t => t.length > 0).map((t, i) => {
            try {
                return JSON.parse(t);
            } catch (err) {
                console.warn('[gm] malformed transcript line', { file, lineIndex: i, err: String(err) });
                return null;
            }
        }).filter(Boolean);
        if (idx < 0 || idx >= lines.length) {
            const err = new Error(`transcript line index ${idx} out of range (have ${lines.length})`);
            /** @type {any} */ (err).code = 'out_of_range';
            throw err;
        }
        const merged = { ...lines[idx], ...patch };
        // Deep-merge `extra` so callers can patch one inner field
        // without nuking the rest of ST's metadata.
        if (patch && /** @type {any} */(patch).extra && lines[idx].extra) {
            /** @type {any} */(merged).extra = { ...lines[idx].extra, .../** @type {any} */(patch).extra };
        }
        lines[idx] = merged;
        const body = lines.map(l => JSON.stringify(l)).join('\n');
        writeFileAtomicSync(file, body + '\n', 'utf8');
        return merged;
    });
}

/**
 * Drop a single line by 0-based index. Returns the line that was
 * removed (so the caller can drive RAG cascades, etc.). Throws if the
 * index is out of range.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {number} idx
 * @returns {Promise<TranscriptLine>}
 */
export async function deleteLine(directories, campaignId, sceneId, idx) {
    const file = transcriptFile(directories, campaignId, sceneId);
    return withLock(file, async () => {
        ensureDir(path.dirname(file));
        const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        /** @type {TranscriptLine[]} */
        const lines = raw.split('\n').filter(t => t.length > 0).map((t, i) => {
            try {
                return JSON.parse(t);
            } catch (err) {
                console.warn('[gm] malformed transcript line', { file, lineIndex: i, err: String(err) });
                return null;
            }
        }).filter(Boolean);
        if (idx < 0 || idx >= lines.length) {
            const err = new Error(`transcript line index ${idx} out of range (have ${lines.length})`);
            /** @type {any} */ (err).code = 'out_of_range';
            throw err;
        }
        const [removed] = lines.splice(idx, 1);
        const body = lines.map(l => JSON.stringify(l)).join('\n');
        writeFileAtomicSync(file, body.length ? body + '\n' : '', 'utf8');
        return removed;
    });
}

/**
 * Drop every line strictly after the given index, keeping `[0..idx]`.
 * Used by the regenerate flow: truncate after the player input we want
 * to re-run, then kick off a new Director turn that starts from there.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} sceneId
 * @param {number} idx  inclusive upper bound; the line at this index is preserved.
 * @returns {Promise<TranscriptLine[]>}  the kept lines (so callers can re-emit them).
 */
export async function truncateAfter(directories, campaignId, sceneId, idx) {
    const file = transcriptFile(directories, campaignId, sceneId);
    return withLock(file, async () => {
        ensureDir(path.dirname(file));
        const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        /** @type {TranscriptLine[]} */
        const lines = raw.split('\n').filter(t => t.length > 0).map((t, i) => {
            try {
                return JSON.parse(t);
            } catch (err) {
                console.warn('[gm] malformed transcript line', { file, lineIndex: i, err: String(err) });
                return null;
            }
        }).filter(Boolean);
        // idx may be -1 to truncate the entire file (rare).
        const kept = lines.slice(0, Math.max(0, idx + 1));
        const body = kept.map(l => JSON.stringify(l)).join('\n');
        writeFileAtomicSync(file, body.length ? body + '\n' : '', 'utf8');
        return kept;
    });
}
