/**
 * Migration 0001: split combined roll+narration transcript lines.
 *
 * Legacy format: a single transcript line with `extra.kind === 'roll'` that
 * contains both `extra.card` AND `extra.narration` (post-roll prose embedded
 * in the same line).
 *
 * New format: the roll line is card-only (`mes: ''`, no narration fields).
 * The consequence prose lives as a separate message line immediately after.
 *
 * This migration rewrites transcript JSONL files in-place, inserting a
 * synthetic narrator/actor message line after each legacy combined roll line.
 * Idempotent: lines that already have empty `extra.narration` (or no field)
 * are skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { campaignDir } from '../../campaigns/store.js';

const MIGRATION_ID = '0001-split-roll-narration';

/**
 * Run the migration for one campaign. Walks all scene transcript files and
 * splits combined roll lines. Skips scenes that have already been migrated.
 *
 * @param {import('../../../users.js').UserDirectoryList} directories
 * @param {string} campaignId
 * @returns {{ migrated: number, skipped: number }}
 */
export function migrate(directories, campaignId) {
    const scenesDir = path.join(campaignDir(directories, campaignId), 'scenes');
    if (!fs.existsSync(scenesDir)) return { migrated: 0, skipped: 0 };

    const markerFile = path.join(scenesDir, 'migrations.json');
    const applied = readApplied(markerFile);
    if (applied.has(MIGRATION_ID)) return { migrated: 0, skipped: 0 };

    const entries = fs.readdirSync(scenesDir).filter(f => f.endsWith('.jsonl'));
    let migrated = 0;
    let skipped = 0;

    for (const file of entries) {
        const filePath = path.join(scenesDir, file);
        const result = migrateFile(filePath);
        if (result.changed) migrated++;
        else skipped++;
    }

    markApplied(markerFile, applied, MIGRATION_ID);
    return { migrated, skipped };
}

/**
 * @param {string} filePath
 * @returns {{ changed: boolean }}
 */
function migrateFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    /** @type {string[]} */
    const output = [];
    let changed = false;

    for (const line of lines) {
        if (!line.trim()) {
            output.push(line);
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch {
            output.push(line);
            continue;
        }

        if (parsed?.extra?.kind === 'roll' && parsed.extra.narration) {
            const narration = parsed.extra.narration;
            const speakerName = parsed.extra.narration_speaker_name || 'Narrator';
            const speakerRole = parsed.extra.narration_speaker_role || 'narrator';
            const speakerActorId = parsed.extra.narration_speaker_id || null;

            // Rewrite the roll line: card-only, drop narration fields
            const cleanedRoll = {
                ...parsed,
                mes: '',
                extra: {
                    role: 'roll',
                    kind: 'roll',
                    card: parsed.extra.card,
                    actor_id: parsed.extra.actor_id,
                    actor_name: parsed.extra.actor_name,
                    intent: parsed.extra.intent,
                },
            };
            output.push(JSON.stringify(cleanedRoll));

            // Insert a synthetic message line for the narration
            const sendDate = parsed.send_date || new Date().toISOString();
            const syntheticMessage = {
                name: speakerName,
                is_user: false,
                is_system: false,
                send_date: bumpDate(sendDate),
                mes: narration,
                extra: {
                    role: speakerRole,
                    actor: speakerActorId || (speakerRole === 'narrator' ? 'narrator' : undefined),
                    actor_id: speakerActorId || undefined,
                },
            };
            if (parsed.extra.narration_speaker_avatar) {
                syntheticMessage.force_avatar = parsed.extra.narration_speaker_avatar;
            }
            output.push(JSON.stringify(syntheticMessage));
            changed = true;
        } else {
            output.push(line);
        }
    }

    if (changed) {
        fs.writeFileSync(filePath, output.join('\n'), 'utf8');
    }
    return { changed };
}

/**
 * @param {string} isoString
 * @returns {string}
 */
function bumpDate(isoString) {
    try {
        const d = new Date(isoString);
        d.setMilliseconds(d.getMilliseconds() + 1);
        return d.toISOString();
    } catch {
        return new Date().toISOString();
    }
}

/**
 * @param {string} markerFile
 * @returns {Set<string>}
 */
function readApplied(markerFile) {
    try {
        const data = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        return new Set(Array.isArray(data.applied) ? data.applied : []);
    } catch {
        return new Set();
    }
}

/**
 * @param {string} markerFile
 * @param {Set<string>} applied
 * @param {string} id
 */
function markApplied(markerFile, applied, id) {
    applied.add(id);
    const data = { applied: [...applied] };
    fs.writeFileSync(markerFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
