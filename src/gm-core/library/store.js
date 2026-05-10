/**
 * JSON-backed CharacterStore (Phase 2).
 *
 * Layout:
 *   {handle}/campaigns/{cid}/characters/{char_id}.json
 *
 * Character ids are only unique within a campaign. Two different campaigns
 * can each have a `jack`. The cache key must therefore include the
 * campaign id; without it the cache would return campaign A's Jack when
 * asked for campaign B's Jack.
 *
 * Reads cache per (handle, cid, char_id). Writes invalidate the cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';

import { buildCharacter } from './schemas.js';
import { campaignDir } from '../campaigns/store.js';
import {
    ensureDir,
    nowIso,
    readJson,
    uniqueId,
    writeJson,
} from '../util/io.js';

/**
 * @typedef {import('./schemas.js').Character} Character
 */

/** @type {Map<string, Character>} */
const cache = new Map();

function cacheKey(handle, campaignId, id) {
    return `${handle}::${campaignId}::${id}`;
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 */
export function charactersDir(directories, campaignId) {
    return path.join(campaignDir(directories, campaignId), 'characters');
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 */
export function characterFile(directories, campaignId, characterId) {
    return path.join(charactersDir(directories, campaignId), `${sanitize(characterId)}.json`);
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {string[]}
 */
export function listIds(directories, campaignId) {
    const dir = charactersDir(directories, campaignId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .sort();
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @returns {Character | null}
 */
export function get(directories, campaignId, characterId) {
    const key = cacheKey(directories.root, campaignId, characterId);
    if (cache.has(key)) return cache.get(key) ?? null;
    const file = characterFile(directories, campaignId, characterId);
    const raw = readJson(file, /** @type {Character | null} */(null));
    if (raw === null) return null;
    cache.set(key, raw);
    return raw;
}

/**
 * Walk every campaign's characters directory looking for a Character with the
 * given id. Used by the `/api/gm/characters/:id` route which doesn't take a
 * campaign id in the URL.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} characterId
 * @returns {{ campaign_id: string, character: Character } | null}
 */
export function findById(directories, characterId) {
    if (!fs.existsSync(directories.campaigns)) return null;
    for (const cid of fs.readdirSync(directories.campaigns)) {
        const cdir = path.join(directories.campaigns, cid);
        if (!fs.statSync(cdir).isDirectory()) continue;
        const character = get(directories, cid, characterId);
        if (character) return { campaign_id: cid, character };
    }
    return null;
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {Character[]}
 */
export function listAll(directories, campaignId) {
    return listIds(directories, campaignId)
        .map(id => get(directories, campaignId, id))
        .filter(/** @returns {c is Character} */ (c) => c !== null);
}

/**
 * Create a new character record on disk.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {Partial<Character> & { name: string }} input
 * @returns {Character}
 */
export function create(directories, campaignId, input) {
    ensureDir(charactersDir(directories, campaignId));
    // Honour an explicit id when provided (e.g. from lore-pack seeding);
    // fall back to uniqueId(name) for wizard-created characters.
    const id = (typeof input.id === 'string' && input.id.trim())
        ? input.id.trim()
        : uniqueId(input.name, listIds(directories, campaignId));
    const character = buildCharacter({ ...input, id, campaign_id: campaignId });
    writeJson(characterFile(directories, campaignId, character.id), character);
    cache.set(cacheKey(directories.root, campaignId, character.id), character);
    return character;
}

/**
 * Apply a partial update to an existing character.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 * @param {Partial<Character>} patch
 * @returns {Character | null}
 */
export function update(directories, campaignId, characterId, patch) {
    const existing = get(directories, campaignId, characterId);
    if (!existing) return null;
    /** @type {Character} */
    const merged = {
        ...existing,
        ...patch,
        id: existing.id,
        campaign_id: existing.campaign_id,
        sheet: { ...existing.sheet, ...(patch.sheet || {}) },
        created_at: existing.created_at,
        updated_at: nowIso(),
    };
    writeJson(characterFile(directories, campaignId, characterId), merged);
    cache.set(cacheKey(directories.root, campaignId, characterId), merged);
    return merged;
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @param {string} characterId
 */
export function remove(directories, campaignId, characterId) {
    const file = characterFile(directories, campaignId, characterId);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    cache.delete(cacheKey(directories.root, campaignId, characterId));
    return true;
}
