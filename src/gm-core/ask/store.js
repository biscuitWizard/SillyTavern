/**
 * Ask-mode transcript persistence.
 *
 * Per-campaign JSONL at `{handle}/campaigns/{cid}/ask/transcript.jsonl`.
 * Each line is one entry: a player question or a GM reply, with a stable
 * id and timestamp. Optional `lore_id` on a GM entry links to the
 * `world_lore` record the reply produced.
 *
 * Append is serialised through a per-file mutex (same idiom as
 * `scenes/transcript.js`) so two parallel /ask requests on the same
 * campaign never interleave their writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { campaignDir } from '../campaigns/store.js';
import { ensureDir } from '../util/io.js';

/**
 * @typedef {Object} AskEntry
 * @property {string} id        deterministic short id (sha256 slice)
 * @property {'player' | 'gm'} role
 * @property {string} text
 * @property {string | null} [lore_id]   id of the world_lore record this reply produced, when role === 'gm'
 * @property {string} ts        ISO 8601
 */

/** @type {Map<string, Promise<void>>} */
const fileLocks = new Map();

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function transcriptFile(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'ask', 'transcript.jsonl');
}

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
        if (fileLocks.get(file) && fileLocks.get(file) === previous.then(() => next)) {
            fileLocks.delete(file);
        }
    }
}

/**
 * Read the full Ask transcript. Returns `[]` when the file is missing.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {AskEntry[]}
 */
export function readAll(directories, campaignId) {
    const file = transcriptFile(directories, campaignId);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    /** @type {AskEntry[]} */
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); }
        catch (err) { console.warn('[gm.ask] malformed transcript line', { file, err: String(err) }); }
    }
    return out;
}

/**
 * Append a single entry.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Omit<AskEntry, 'id' | 'ts'> & { id?: string, ts?: string }} entry
 * @returns {Promise<AskEntry>}
 */
export function append(directories, campaignId, entry) {
    const file = transcriptFile(directories, campaignId);
    /** @type {AskEntry} */
    const out = {
        id: entry.id || deriveId(campaignId, entry.role, entry.text),
        role: entry.role,
        text: String(entry.text || ''),
        lore_id: entry.lore_id ?? null,
        ts: entry.ts || new Date().toISOString(),
    };
    return withLock(file, async () => {
        ensureDir(path.dirname(file));
        await fs.promises.appendFile(file, JSON.stringify(out) + '\n', 'utf8');
        return out;
    });
}

/**
 * Build a stable short id for an entry. Collisions are theoretically
 * possible (same role + same text in the same nanosecond) so we mix in
 * `Date.now() * 1000` for uniqueness within a session.
 *
 * @param {string} campaignId
 * @param {string} role
 * @param {string} text
 */
function deriveId(campaignId, role, text) {
    const nanos = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    return createHash('sha256')
        .update(`${campaignId}|${role}|${nanos}|${text}`)
        .digest('hex')
        .slice(0, 16);
}
