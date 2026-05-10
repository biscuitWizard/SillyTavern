/**
 * Disk store for lore.
 *
 * Layout:
 *   {handle}/campaigns/{cid}/lore/core/*.yaml      authored seed lore (canonical for origin:'core')
 *   {handle}/campaigns/{cid}/lore/generated.jsonl  append-only mirror of origin:'generated' writes
 *
 * Writes are atomic via `write-file-atomic`. Reads are direct fs (cheap;
 * lore packs are small).
 */

import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import yaml from 'yaml';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { campaignDir } from '../campaigns/store.js';
import { ensureDir } from '../util/io.js';
import { validateLoreEntry } from './schemas.js';

/**
 * @typedef {import('./schemas.js').LoreEntry} LoreEntry
 * @typedef {import('./schemas.js').LorePack} LorePack
 */

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function loreCoreDir(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'lore', 'core');
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function loreGeneratedFile(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'lore', 'generated.jsonl');
}

/**
 * List `*.yaml` files in `lore/core/` for a campaign.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {string[]} absolute paths
 */
export function listCoreLoreFiles(directories, campaignId) {
    const dir = loreCoreDir(directories, campaignId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => path.join(dir, f))
        .sort();
}

/**
 * Read a single core-lore YAML file and return its array of LoreEntry.
 * Single-document YAML may either be an array of entries directly, or
 * an object with `entries: LoreEntry[]` / a `LorePack` wrapper.
 *
 * @param {string} filePath
 * @returns {LoreEntry[]}
 */
export function readLoreFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    let parsed;
    try {
        parsed = yaml.parse(text);
    } catch (err) {
        console.warn(`[lore] failed to parse ${filePath}: ${err?.message || err}`);
        return [];
    }
    if (Array.isArray(parsed)) return parsed.filter(e => !validateLoreEntry(e));
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries.filter(e => !validateLoreEntry(e));
    return [];
}

/**
 * Write a YAML file containing an array of LoreEntry. Used by the wizard
 * "paste YAML" step + the auto-extractor.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} fileName        without .yaml extension
 * @param {LoreEntry[]} entries
 * @returns {string} absolute path written
 */
export function writeCoreLoreFile(directories, campaignId, fileName, entries) {
    const dir = loreCoreDir(directories, campaignId);
    ensureDir(dir);
    const safe = sanitize(fileName).toLowerCase().replace(/\s+/g, '-');
    const filePath = path.join(dir, `${safe}.yaml`);
    const body = yaml.stringify({ entries });
    writeFileAtomicSync(filePath, body, 'utf8');
    return filePath;
}

/**
 * Read all generated lore from the JSONL mirror. Returns parsed records.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Array<unknown>}
 */
export function readGeneratedLore(directories, campaignId) {
    const file = loreGeneratedFile(directories, campaignId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
}
