/**
 * Bundled lore packs.
 *
 * Packs ship at `data/lore-packs/{slug}/setting.yaml` and contain
 * authored seed lore that the wizard can copy into a new campaign. The
 * pack file is the canonical YAML; copying it into a campaign places it
 * at `{handle}/campaigns/{cid}/lore/core/{pack-id}.yaml`.
 *
 * A pack may also include a `characters` section — structured character
 * definitions (id, name, appearance, personality, voice, background,
 * sheet, starter_memories). `applyLorePack` creates one Character JSON
 * per entry (skipping ids that already exist) and returns the
 * `character_seeds` list so the caller can ingest starter memories into
 * Qdrant immediately.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

import { writeCoreLoreFile } from './store.js';
import * as characterStore from '../library/store.js';

/**
 * @typedef {import('./schemas.js').LorePack} LorePack
 * @typedef {import('./schemas.js').PackCharacter} PackCharacter
 */

const ROOT_GLOBAL = '__ttrpg_lore_packs_root';

/**
 * Override the on-disk lookup root (tests use this).
 * @param {string} dir
 */
export function setLorePacksRoot(dir) {
    /** @type {any} */ (globalThis)[ROOT_GLOBAL] = dir;
}

/**
 * @returns {string}
 */
function packsRoot() {
    /** @type {any} */
    const g = /** @type {any} */(globalThis);
    if (typeof g[ROOT_GLOBAL] === 'string') return g[ROOT_GLOBAL];
    // Resolve relative to repo root: /tank/data/Dev/games/ttrpgtavern/data/lore-packs.
    // We're at src/gm-core/lore/seed-packs.js; go up four to reach the repo root.
    return path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'data', 'lore-packs');
}

/**
 * List all bundled lore packs. Returns metadata only (id + name + counts).
 *
 * @returns {Array<{ id: string, name: string, description?: string, entry_count: number }>}
 */
export function listLorePacks() {
    const root = packsRoot();
    if (!fs.existsSync(root)) return [];
    /** @type {Array<{ id: string, name: string, description?: string, entry_count: number }>} */
    const out = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const settingPath = path.join(root, entry.name, 'setting.yaml');
        if (!fs.existsSync(settingPath)) continue;
        try {
            const text = fs.readFileSync(settingPath, 'utf8');
            const parsed = yaml.parse(text);
            const pack = /** @type {LorePack} */ (parsed) || {};
            out.push({
                id: pack.pack_id || entry.name,
                name: pack.pack_name || entry.name,
                description: pack.description,
                entry_count: Array.isArray(pack.entries) ? pack.entries.length : 0,
            });
        } catch (err) {
            console.warn(`[lore.seed-packs] skip ${entry.name}: ${err?.message || err}`);
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * Load a lore pack by id.
 *
 * @param {string} id
 * @returns {LorePack | null}
 */
export function loadLorePack(id) {
    const settingPath = path.join(packsRoot(), id, 'setting.yaml');
    if (!fs.existsSync(settingPath)) return null;
    try {
        const text = fs.readFileSync(settingPath, 'utf8');
        const parsed = yaml.parse(text);
        if (!parsed) return null;
        return /** @type {LorePack} */ (parsed);
    } catch (err) {
        console.warn(`[lore.seed-packs] load ${id} failed: ${err?.message || err}`);
        return null;
    }
}

/**
 * Copy a bundled pack into a campaign's `lore/core/` and instantiate any
 * characters defined in `pack.characters`.
 *
 * Characters are created with `is_player: false`; any character whose id
 * already exists in the campaign is skipped (idempotent re-application).
 *
 * Returns the list of character seeds (id + starter_memories) so the
 * caller can immediately ingest the memories into Qdrant via
 * `memoryService.write`.  Memories are NOT written to disk here; the
 * caller is responsible for both disk-mirror and Qdrant upsert by calling
 * `memoryService.write` for each entry in `character_seeds[*].memories`.
 *
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaignId: string,
 *   packId: string,
 * }} args
 * @returns {{
 *   written: string,
 *   entry_count: number,
 *   characters_created: number,
 *   characters_skipped: number,
 *   character_seeds: Array<{ character_id: string, memories: string[] }>,
 * } | null}
 */
export function applyLorePack({ directories, campaignId, packId }) {
    const pack = loadLorePack(packId);
    if (!pack) return null;

    const written = writeCoreLoreFile(directories, campaignId, pack.pack_id, pack.entries || []);

    let characters_created = 0;
    let characters_skipped = 0;
    /** @type {Array<{ character_id: string, memories: string[] }>} */
    const character_seeds = [];

    for (const pc of (pack.characters || [])) {
        if (!pc.id || !pc.name) continue;
        const existing = characterStore.get(directories, campaignId, pc.id);
        if (existing) {
            characters_skipped++;
            // Still surface memories so callers can re-sync Qdrant if needed.
            if (Array.isArray(pc.starter_memories) && pc.starter_memories.length > 0) {
                character_seeds.push({ character_id: pc.id, memories: pc.starter_memories });
            }
            continue;
        }
        characterStore.create(directories, campaignId, {
            id: pc.id,
            name: pc.name,
            is_player: false,
            appearance: pc.appearance || '',
            personality: pc.personality || '',
            voice: pc.voice || '',
            background: pc.background || '',
            sheet: pc.sheet || undefined,
        });
        characters_created++;
        if (Array.isArray(pc.starter_memories) && pc.starter_memories.length > 0) {
            character_seeds.push({ character_id: pc.id, memories: pc.starter_memories });
        }
    }

    return { written, entry_count: (pack.entries || []).length, characters_created, characters_skipped, character_seeds };
}
