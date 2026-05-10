#!/usr/bin/env node
/**
 * tools/consolidate-candidates.js
 *
 * Reads the 285 per-chapter candidate JSONs produced by the srstavern lore
 * extractor and consolidates them into a ttrpgtavern LorePack without
 * requiring any LLM calls. All the hard LLM extraction work is already done
 * and cached; this script just groups, deduplicates, and formats.
 *
 * Output: data/lore-packs/ascent-to-divinity/setting.yaml
 *
 * Usage:
 *   node tools/consolidate-candidates.js
 *   node tools/consolidate-candidates.js --candidates-dir /path/to/_cache/candidates
 *   node tools/consolidate-candidates.js --output-dir data/lore-packs --campaign-id my-campaign
 *
 * Merge strategy (no LLM):
 *   - Lore:       group by (kind, normalizeTitle(title)); keep the highest-confidence
 *                 candidate as primary; append materially new body text from lower-confidence
 *                 siblings; union all tags.
 *   - Characters: group by (tier, normalizeTitle(name)); pick primary by highest confidence;
 *                 merge description/personality/voice/starting_memories, deduplicating
 *                 near-identical sentences; fold result into a `people` lore entry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Allowed vocabularies (mirrors ttrpgtavern src/gm-core/lore/schemas.js)
// ---------------------------------------------------------------------------

const ALLOWED_ENTRY_KINDS = new Set([
    'location', 'faction', 'culture', 'people', 'history',
    'magic', 'artifact', 'bestiary', 'cosmology', 'language', 'pantheon', 'custom',
]);

const ALLOWED_TAGS = new Set([
    'location', 'city', 'region', 'landmark', 'tavern', 'temple', 'wilderness', 'plane',
    'faction', 'organization', 'guild', 'order', 'government', 'criminal', 'noble_house', 'cult',
    'culture', 'people', 'ancestry', 'language',
    'history', 'era', 'war', 'treaty',
    'magic', 'artifact', 'spell_system',
    'bestiary', 'species',
    'cosmology', 'pantheon', 'religion', 'deity',
    'economy', 'law', 'tradition', 'custom',
]);

// ---------------------------------------------------------------------------
// Title normalisation (mirrors Python normalize_title in extract.py)
// ---------------------------------------------------------------------------

const STRIP_TOKENS = [
    'the ', 'a ', 'an ', 'city of ', 'kingdom of ', 'land of ',
    'house of ', 'order of ', 'temple of ', 'god of ', 'goddess of ',
    'lord ', 'lady ', 'king ', 'queen ', 'saint ',
];

function normalizeTitle(title) {
    let t = title.trim().toLowerCase();
    t = t.replace(/\([^)]*\)/g, ' ');   // strip parenthetical
    t = t.split(',')[0];                  // strip trailing comma clause
    for (const tok of STRIP_TOKENS) {
        if (t.startsWith(tok)) {
            t = t.slice(tok.length);
        }
    }
    t = t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return t || 'untitled';
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function filterTags(tags) {
    const seen = new Set();
    const out = [];
    for (const raw of (tags || [])) {
        const norm = raw.trim().toLowerCase().replace(/\s+/g, '_');
        if (ALLOWED_TAGS.has(norm) && !seen.has(norm)) {
            seen.add(norm);
            out.push(norm);
        }
    }
    return out;
}

function unionTags(...tagLists) {
    const seen = new Set();
    const out = [];
    for (const list of tagLists) {
        for (const t of (list || [])) {
            if (!seen.has(t)) { seen.add(t); out.push(t); }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Body merge helpers
// ---------------------------------------------------------------------------

/**
 * Sentence-split a body into a list of trimmed, non-empty sentences.
 * @param {string} body
 * @returns {string[]}
 */
function toSentences(body) {
    return (body || '')
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * Very lightweight similarity check: two sentences are "near-duplicate" if
 * their lowercased normalised forms share > 60% of their words.
 * Used to avoid appending near-identical sentences from different chapters.
 */
function areSimilar(a, b) {
    const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean));
    const wordsB = b.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    if (wordsA.size === 0 || wordsB.length === 0) return false;
    let overlap = 0;
    for (const w of wordsB) if (wordsA.has(w)) overlap++;
    const similarity = overlap / Math.max(wordsA.size, wordsB.length);
    return similarity > 0.6;
}

/**
 * Merge multiple body strings, deduplicating near-identical sentences.
 * The primary body leads; unique sentences from siblings are appended.
 * @param {string} primaryBody
 * @param {string[]} siblingBodies
 * @returns {string}
 */
function mergeBodies(primaryBody, siblingBodies) {
    const primary = toSentences(primaryBody);
    const merged = [...primary];

    for (const sibling of siblingBodies) {
        for (const sent of toSentences(sibling)) {
            const isDupe = merged.some(existing => areSimilar(existing, sent));
            if (!isDupe) {
                merged.push(sent);
            }
        }
    }

    // Re-join, wrapping at ~100 chars per "paragraph" (every ~4 sentences)
    const chunks = [];
    for (let i = 0; i < merged.length; i += 4) {
        chunks.push(merged.slice(i, i + 4).join(' '));
    }
    return chunks.join('\n\n');
}

/**
 * Merge character text fields, deduplicating near-identical sentences.
 * @param {string[]} values
 * @returns {string}
 */
function mergeTextField(values) {
    const sentences = [];
    for (const v of values.filter(Boolean)) {
        for (const sent of toSentences(v)) {
            if (!sentences.some(ex => areSimilar(ex, sent))) {
                sentences.push(sent);
            }
        }
    }
    return sentences.join(' ');
}

/**
 * Merge starting_memories lists, deduplicating near-identical entries.
 * Cap at 5 (matches the extractor's MAX_STARTING_MEMORIES).
 * @param {string[][]} memoryLists
 * @returns {string[]}
 */
function mergeMemories(memoryLists) {
    const merged = [];
    for (const list of memoryLists) {
        for (const mem of (list || [])) {
            if (!merged.some(ex => areSimilar(ex, mem))) {
                merged.push(mem);
            }
        }
    }
    return merged.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Tier importance defaults
// ---------------------------------------------------------------------------

const TIER_IMPORTANCE = { deity: 0.85, mortal_permanent: 0.65 };

// ---------------------------------------------------------------------------
// Consolidate lore group
// ---------------------------------------------------------------------------

/**
 * @param {string} kind
 * @param {Array<{title:string, body:string, tags:string[], confidence:number}>} candidates
 * @returns {{ id:string, title:string, entry_kind:string, importance:number, tags:string[], body:string }}
 */
function consolidateLoreGroup(kind, candidates) {
    candidates.sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1));
    const primary = candidates[0];
    const siblings = candidates.slice(1);

    const mergedBody = siblings.length > 0
        ? mergeBodies(primary.body, siblings.map(s => s.body))
        : primary.body;

    const mergedTags = filterTags(unionTags(...candidates.map(c => c.tags)));
    const importance = primary.confidence ?? 1.0;
    const slug = normalizeTitle(primary.title);

    return {
        id: slug,
        title: primary.title,
        entry_kind: kind,
        importance: Math.round(importance * 100) / 100,
        origin: 'core',
        source_type: 'seed_pack',
        ...(mergedTags.length > 0 ? { tags: mergedTags } : {}),
        body: mergedBody.trim(),
    };
}

// ---------------------------------------------------------------------------
// Consolidate character group → people lore entry
// ---------------------------------------------------------------------------

/**
 * @param {string} tier
 * @param {Array<{name:string, role:string, description:string, personality:string, voice:string, starting_memories:string[], confidence:number}>} candidates
 * @returns {{ id:string, title:string, entry_kind:'people', importance:number, tags:string[], body:string }}
 */
function consolidateCharacterGroup(tier, candidates) {
    candidates.sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1));
    const primary = candidates[0];

    const description = mergeTextField(candidates.map(c => c.description));
    const role = primary.role || candidates.find(c => c.role)?.role || '';
    const personality = mergeTextField(candidates.map(c => c.personality));
    const voice = mergeTextField(candidates.map(c => c.voice));
    const startingMemories = mergeMemories(candidates.map(c => c.starting_memories));

    const bodyParts = [];
    if (description) bodyParts.push(description.trim());
    if (role) bodyParts.push(`Role: ${role.trim()}`);
    if (personality) bodyParts.push(`Personality: ${personality.trim()}`);
    if (voice) bodyParts.push(`Voice: ${voice.trim()}`);
    if (startingMemories.length > 0) {
        const memLines = startingMemories.map(m => `  - ${m}`).join('\n');
        bodyParts.push(`Memories (first-person, pre-plot):\n${memLines}`);
    }

    const body = bodyParts.join('\n\n') || primary.name;
    const tags = tier === 'deity' ? ['people', 'deity', 'cosmology'] : ['people'];
    const importance = TIER_IMPORTANCE[tier] ?? 0.65;

    return {
        id: normalizeTitle(primary.name),
        title: primary.name,
        entry_kind: 'people',
        importance,
        origin: 'core',
        source_type: 'seed_pack',
        tags,
        body: body.trim(),
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    // Parse CLI args
    const args = process.argv.slice(2);
    const getArg = (flag, def) => {
        const i = args.indexOf(flag);
        return i !== -1 && args[i + 1] ? args[i + 1] : def;
    };

    const defaultCandidatesDir = path.resolve(REPO_ROOT, '../srstavern/extracted/_cache/candidates');
    const candidatesDir = getArg('--candidates-dir', defaultCandidatesDir);
    const outputDir = path.resolve(REPO_ROOT, getArg('--output-dir', 'data/lore-packs'));
    const campaignId = getArg('--campaign-id', 'ascent-to-divinity');
    const seriesUrl = getArg(
        '--series-url',
        'https://www.scribblehub.com/series/580870/this-ascent-to-divinity-is-lewder-than-expected/',
    );

    console.log(`[consolidate] candidates dir : ${candidatesDir}`);
    console.log(`[consolidate] output dir     : ${outputDir}`);
    console.log(`[consolidate] campaign id    : ${campaignId}`);

    // Load all candidate files
    if (!fs.existsSync(candidatesDir)) {
        console.error(`[consolidate] ERROR: candidates directory not found: ${candidatesDir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(candidatesDir).filter(f => f.endsWith('.json'));
    console.log(`[consolidate] found ${files.length} candidate files`);

    /** @type {Map<string, Array>} loreGroups: key = "kind::normalizedTitle" */
    const loreGroups = new Map();
    /** @type {Map<string, Array>} charGroups: key = "tier::normalizedName" */
    const charGroups = new Map();

    let totalLoreCandidates = 0;
    let totalCharCandidates = 0;
    let parseErrors = 0;

    for (const file of files) {
        const filePath = path.join(candidatesDir, file);
        let data;
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.warn(`[consolidate] WARN: parse error in ${file}: ${err.message}`);
            parseErrors++;
            continue;
        }

        for (const lore of (data.lore || [])) {
            if (!lore.kind || !ALLOWED_ENTRY_KINDS.has(lore.kind)) continue;
            if (!lore.title?.trim() || !lore.body?.trim()) continue;
            const key = `${lore.kind}::${normalizeTitle(lore.title)}`;
            if (!loreGroups.has(key)) loreGroups.set(key, []);
            loreGroups.get(key).push(lore);
            totalLoreCandidates++;
        }

        for (const char of (data.characters || [])) {
            if (!char.name?.trim()) continue;
            const tier = char.tier === 'deity' ? 'deity' : 'mortal_permanent';
            const key = `${tier}::${normalizeTitle(char.name)}`;
            if (!charGroups.has(key)) charGroups.set(key, []);
            charGroups.get(key).push({ ...char, tier });
            totalCharCandidates++;
        }
    }

    console.log(
        `[consolidate] loaded: ${totalLoreCandidates} lore candidates in ${loreGroups.size} groups, ` +
        `${totalCharCandidates} character candidates in ${charGroups.size} groups ` +
        `(${parseErrors} parse errors)`,
    );

    // Consolidate lore groups
    const entries = [];
    const seenIds = new Set();

    for (const [groupKey, candidates] of [...loreGroups.entries()].sort()) {
        const kind = groupKey.split('::')[0];
        const entry = consolidateLoreGroup(kind, candidates);

        // Guarantee unique id
        let id = entry.id;
        if (seenIds.has(id)) {
            let suffix = 2;
            while (seenIds.has(`${id}-${suffix}`)) suffix++;
            id = `${id}-${suffix}`;
            entry.id = id;
        }
        seenIds.add(id);
        entries.push(entry);
    }

    // Consolidate character groups → people entries
    for (const [groupKey, candidates] of [...charGroups.entries()].sort()) {
        const tier = groupKey.split('::')[0];
        const entry = consolidateCharacterGroup(tier, candidates);

        let id = entry.id;
        if (seenIds.has(id)) {
            let suffix = 2;
            while (seenIds.has(`${id}-${suffix}`)) suffix++;
            id = `${id}-${suffix}`;
            entry.id = id;
        }
        seenIds.add(id);
        entries.push(entry);
    }

    console.log(`[consolidate] consolidated: ${entries.length} total entries`);

    // Build LorePack
    const seriesSlug = seriesUrl.replace(/\/$/, '').split('/').pop()?.replace(/-/g, ' ') ?? campaignId;
    const packName = campaignId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const pack = {
        pack_id: campaignId,
        pack_name: packName,
        description:
            `Auto-extracted from the ScribbleHub serial "${seriesSlug}" ` +
            `(${files.length} chapters processed). ` +
            'Contains locations, factions, magic systems, history, artifacts, ' +
            'cosmology, and permanent setting characters. ' +
            'Generated by tools/consolidate-candidates.js from cached chapter extractions.',
        entries,
    };

    // Validate entries against ttrpgtavern schema requirements
    let validationErrors = 0;
    for (const entry of entries) {
        if (!entry.title?.trim()) { console.warn(`[consolidate] WARN: entry ${entry.id} missing title`); validationErrors++; }
        if (!entry.body?.trim()) { console.warn(`[consolidate] WARN: entry ${entry.id} missing body`); validationErrors++; }
        if (!ALLOWED_ENTRY_KINDS.has(entry.entry_kind)) { console.warn(`[consolidate] WARN: entry ${entry.id} invalid entry_kind: ${entry.entry_kind}`); validationErrors++; }
    }
    if (validationErrors > 0) {
        console.warn(`[consolidate] ${validationErrors} validation warning(s) — review output before use`);
    }

    // Write output
    const outDir = path.join(outputDir, campaignId);
    fs.mkdirSync(outDir, { recursive: true });

    const settingPath = path.join(outDir, 'setting.yaml');
    fs.writeFileSync(settingPath, yaml.stringify(pack, { lineWidth: 100, defaultStringType: 'PLAIN' }), 'utf8');

    // Write a companion review JSON (entry counts + entry_kind breakdown)
    const kindCounts = {};
    for (const e of entries) kindCounts[e.entry_kind] = (kindCounts[e.entry_kind] ?? 0) + 1;
    const reviewPath = path.join(outDir, '_consolidation-report.json');
    fs.writeFileSync(
        reviewPath,
        JSON.stringify(
            {
                generated_by: 'tools/consolidate-candidates.js',
                campaign_id: campaignId,
                series_url: seriesUrl,
                candidate_files_processed: files.length,
                lore_candidate_count: totalLoreCandidates,
                lore_group_count: loreGroups.size,
                character_candidate_count: totalCharCandidates,
                character_group_count: charGroups.size,
                total_entries: entries.length,
                entries_by_kind: kindCounts,
                parse_errors: parseErrors,
            },
            null,
            2,
        ),
        'utf8',
    );

    console.log(`\n[consolidate] done`);
    console.log(`  setting.yaml             -> ${settingPath}`);
    console.log(`  _consolidation-report.json -> ${reviewPath}`);
    console.log(`\n  entries by kind:`);
    for (const [kind, count] of Object.entries(kindCounts).sort()) {
        console.log(`    ${kind.padEnd(12)} ${count}`);
    }
    console.log(`  total: ${entries.length} entries`);
}

main().catch(err => {
    console.error('[consolidate] fatal:', err);
    process.exit(1);
});
