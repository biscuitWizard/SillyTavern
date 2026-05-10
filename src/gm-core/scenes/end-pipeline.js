/**
 * Phase 8 — Scene-end pipeline.
 *
 * Orchestrates everything that has to happen when the player ends a
 * scene: produce a structured `SceneSummary`, run a per-participant
 * `MemoryExtraction`, persist the summary doc, write key events as
 * `world_lore` records, write per-character memories as
 * `character_memory` records, and finally flip the scene to `closed`.
 *
 * The pipeline is the *batch* counterpart to Phase 7's *inline* writers
 * (`writers/opinion.js`, `writers/narrator-continuity.js`, etc.). The
 * inline writers capture per-message beats during a turn; this pipeline
 * captures scene-spanning reflections at the end. Their deterministic
 * id namespaces are disjoint, so neither overwrites the other.
 *
 * Determinism:
 *   - Re-running on the same transcript with the same scene id produces
 *     the same record ids (see `derive*` helpers in
 *     `../rag/writers/ids.js`). Disk JSONL upsert + Qdrant upsert are
 *     no-ops the second time.
 *   - The summary file is rewritten with the same bytes given the same
 *     LLM output (which, in practice, requires the LLM to be
 *     deterministic — fine for tests, "best-effort" in production).
 *
 * Failure mode:
 *   - If the summary call fails, no writes happen, the scene stays
 *     `active`, and the caller surfaces a 502.
 *   - If a per-participant extraction call fails, that participant
 *     contributes zero memories but the rest of the pipeline continues.
 *     The scene still flips to `closed`.
 *   - Individual `memoryService.write(...)` failures are logged and
 *     queued for next-boot reconcile; they do not abort the pipeline.
 */

import * as transcript from './transcript.js';
import * as sceneStore from './store.js';
import * as summaryStore from './summary-store.js';
import * as campaignStore from '../campaigns/store.js';
import { buildSceneSummary } from './schemas.js';
import {
    SCENE_SUMMARY_SCHEMA,
    SCENE_SUMMARY_SYSTEM_PROMPT,
    buildSummaryUser,
} from './summarize-prompts.js';
import {
    MEMORY_EXTRACTION_SCHEMA,
    MEMORY_EXTRACTION_SYSTEM_PROMPT,
    buildExtractionUser,
} from './extract-prompts.js';
import { buildMemoryRecord } from '../rag/schemas.js';
import {
    deriveSceneEndCharacterMemoryId,
    deriveSceneEndKeyEventId,
} from '../rag/writers/ids.js';
import { recapFromSceneEnd } from '../openings/synth.js';

/** @typedef {import('./schemas.js').Scene} Scene */
/** @typedef {import('./schemas.js').SceneSummary} SceneSummary */
/** @typedef {import('../library/schemas.js').Character} Character */
/** @typedef {import('../rag/service.d.ts').MemoryService} MemoryService */

const DEFAULT_TAIL_LINES = 60;
const TAIL_CHAR_CAP = 8000;

/**
 * @typedef {Object} StructuredClient
 * @property {(args: { system: string, user: string, schema: object, schemaName: string, signal?: AbortSignal }) => Promise<any>} structured
 */

/**
 * @typedef {Object} SceneEndPipelineResult
 * @property {boolean} dry_run
 * @property {SceneSummary} summary
 * @property {Record<string, number>} memories_extracted   keyed by character id
 * @property {number} key_events_written
 * @property {Scene | null} scene                           updated scene metadata when persisted; null on dry-run
 * @property {Array<{ stage: string, character_id?: string, error: string }>} warnings
 */

/**
 * Run the scene-end pipeline.
 *
 * Two clients are accepted so the route can route the SceneSummary call
 * through `director_profile` (structurally Director-shaped) and the
 * per-participant extraction through `actor_profile` (more in-character).
 * Callers may pass the same client twice (or a single `client` arg)
 * when they don't care about the split.
 *
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaignId: string,
 *   campaign: { name?: string, brief?: string },
 *   scene: Scene,
 *   participants: Character[],
 *   memoryService: MemoryService,
 *   client?: StructuredClient,
 *   summaryClient?: StructuredClient,
 *   extractionClient?: StructuredClient,
 *   sceneIndex?: number,
 *   tailLines?: number,
 *   dryRun?: boolean,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<SceneEndPipelineResult>}
 */
export async function runSceneEndPipeline(args) {
    const {
        directories,
        campaignId,
        campaign,
        scene,
        participants,
        memoryService,
        client,
        summaryClient,
        extractionClient,
        sceneIndex = 0,
        tailLines = DEFAULT_TAIL_LINES,
        dryRun = false,
        signal,
    } = args;

    const sumClient = summaryClient || client;
    const extClient = extractionClient || client || summaryClient;

    if (!directories || !campaignId || !scene || !memoryService || !sumClient || !extClient) {
        throw new Error('runSceneEndPipeline: missing required arguments');
    }

    const warnings = /** @type {Array<{ stage: string, character_id?: string, error: string }>} */([]);

    const lines = transcript.readLines(directories, campaignId, scene.id, 0);
    const tailSlice = lines.slice(Math.max(0, lines.length - tailLines));
    const transcriptTail = formatTranscriptTail(tailSlice, TAIL_CHAR_CAP);

    /** @type {SceneSummary} */
    let summary;
    try {
        const raw = await sumClient.structured({
            system: SCENE_SUMMARY_SYSTEM_PROMPT,
            user: buildSummaryUser({
                campaign: { name: campaign?.name, brief: campaign?.brief },
                scene,
                participants,
                transcriptTail,
            }),
            schema: SCENE_SUMMARY_SCHEMA,
            schemaName: 'SceneSummary',
            signal,
        });
        summary = buildSceneSummary({
            ...raw,
            scene_id: scene.id,
            campaign_id: campaignId,
        });
    } catch (err) {
        const stageErr = new Error(`scene-end summary call failed: ${err?.message || err}`);
        /** @type {any} */(stageErr).stage = 'summary';
        /** @type {any} */(stageErr).cause = err;
        throw stageErr;
    }

    const extractions = await Promise.all(
        participants.map(async (character) => {
            try {
                const raw = await extClient.structured({
                    system: MEMORY_EXTRACTION_SYSTEM_PROMPT,
                    user: buildExtractionUser({
                        character,
                        scene,
                        summary: { headline: summary.headline, summary: summary.summary },
                        transcriptTail,
                    }),
                    schema: MEMORY_EXTRACTION_SCHEMA,
                    schemaName: 'SceneEndMemoryExtraction',
                    signal,
                });
                return { character, result: normaliseExtraction(raw) };
            } catch (err) {
                warnings.push({
                    stage: 'extraction',
                    character_id: character.id,
                    error: err?.message || String(err),
                });
                return { character, result: { is_significant: false, memories: [] } };
            }
        }),
    );

    /** @type {Record<string, number>} */
    const memoriesExtracted = {};
    let keyEventsWritten = 0;

    if (dryRun) {
        for (const { character, result } of extractions) {
            memoriesExtracted[character.id] = result.is_significant ? result.memories.length : 0;
        }
        return {
            dry_run: true,
            summary,
            memories_extracted: memoriesExtracted,
            key_events_written: summary.key_events.length,
            scene: null,
            warnings,
        };
    }

    for (const { character, result } of extractions) {
        if (!result.is_significant || result.memories.length === 0) {
            memoriesExtracted[character.id] = 0;
            continue;
        }
        let wrote = 0;
        for (let i = 0; i < result.memories.length; i++) {
            const mem = result.memories[i];
            const id = deriveSceneEndCharacterMemoryId({
                campaignId,
                characterId: character.id,
                sceneId: scene.id,
                slot: i,
                content: mem.content,
            });
            const record = buildMemoryRecord({
                id,
                kind: 'character_memory',
                scope_id: `${campaignId}/${character.id}`,
                content: mem.content,
                tags: Array.isArray(mem.tags) ? mem.tags : [],
                importance: mem.importance,
                valence: mem.valence,
                temporally_blind: false,
                source: `scene-end:${scene.id}:slot-${i}`,
                scene_index: sceneIndex,
            });
            try {
                await memoryService.write({ campaignId, characterId: character.id, record });
                wrote++;
            } catch (err) {
                warnings.push({
                    stage: 'character_memory_write',
                    character_id: character.id,
                    error: err?.message || String(err),
                });
            }
        }
        memoriesExtracted[character.id] = wrote;
    }

    for (let i = 0; i < summary.key_events.length; i++) {
        const ev = summary.key_events[i];
        const id = deriveSceneEndKeyEventId({
            campaignId,
            sceneId: scene.id,
            idx: i,
            content: ev.text,
        });
        const record = buildMemoryRecord({
            id,
            kind: 'world_lore',
            scope_id: campaignId,
            content: ev.text,
            tags: Array.isArray(ev.tags) ? ev.tags : [],
            importance: ev.importance,
            valence: 0,
            temporally_blind: false,
            source: `scene-end:${scene.id}:event-${i}`,
            scene_index: sceneIndex,
            world_lore: {
                origin: 'generated',
                source_type: 'scene_end',
                scene_id: scene.id,
                entry_kind: 'history',
                title: truncate(ev.text, 80),
            },
        });
        try {
            await memoryService.write({ campaignId, record });
            keyEventsWritten++;
        } catch (err) {
            warnings.push({
                stage: 'world_lore_write',
                error: err?.message || String(err),
            });
        }
    }

    summaryStore.write(directories, campaignId, scene.id, summary);
    const summaryRel = summaryStore.summaryRelativePath(directories, campaignId, scene.id);

    const updatedScene = sceneStore.endScene(directories, campaignId, scene.id, {
        summary_id: deriveSummaryDocId(campaignId, scene.id),
        summary_headline: summary.headline,
        summary_path: summaryRel,
    });

    // Refresh "where things stand" so Campaign Main shows the post-scene
    // beat instead of stale chargen-time copy. Failure is non-fatal: the
    // scene is still closed, the summary is still written, the player
    // can retry from the hub via POST .../opening (which also drives
    // this same path under the hood once we extend it).
    let recapWritten = false;
    let recapError = null;
    try {
        const camp = campaignStore.get(directories, campaignId);
        const playerName = participants.find(p => p.is_player)?.name;
        const recap = await recapFromSceneEnd({
            campaign: { name: campaign?.name, brief: campaign?.brief },
            playerName,
            previousSituation: camp?.current_situation || null,
            sceneSummary: {
                headline: summary.headline,
                summary: summary.summary,
                location_changes: summary.location_changes,
                participant_changes: summary.participant_changes,
            },
            client: sumClient,
            signal,
        });
        campaignStore.updateCurrentSituation(directories, campaignId, recap);
        recapWritten = true;
    } catch (err) {
        recapError = err?.message || String(err);
        warnings.push({ stage: 'current_situation_recap', error: recapError });
    }

    if (warnings.length > 0) {
        console.warn('[gm] scene-end completed with warnings', { sceneId: scene.id, warnings });
    } else {
        console.info('[gm] scene-end ok', {
            sceneId: scene.id,
            participants: participants.length,
            memories_extracted: memoriesExtracted,
            key_events_written: keyEventsWritten,
            current_situation: recapWritten,
        });
    }

    return {
        dry_run: false,
        summary,
        memories_extracted: memoriesExtracted,
        key_events_written: keyEventsWritten,
        scene: updatedScene,
        warnings,
    };
}

/**
 * Build a stable summary doc id for `Scene.summary_id`. Distinct namespace
 * from the deterministic memory ids so the two cannot collide.
 *
 * @param {string} campaignId
 * @param {string} sceneId
 */
function deriveSummaryDocId(campaignId, sceneId) {
    return `summary:${campaignId}:${sceneId}`;
}

/**
 * @param {any} raw
 */
function normaliseExtraction(raw) {
    if (!raw || typeof raw !== 'object') {
        return { is_significant: false, memories: [] };
    }
    const memories = Array.isArray(raw.memories)
        ? raw.memories
            .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
            .slice(0, 3)
            .map((m) => ({
                content: m.content.trim(),
                importance: clampUnit(m.importance ?? 0.5),
                valence: clampRange(m.valence ?? 0, -1, 1),
                tags: Array.isArray(m.tags) ? m.tags.map(String).filter(Boolean) : [],
            }))
        : [];
    return {
        is_significant: Boolean(raw.is_significant) && memories.length > 0,
        memories,
    };
}

/**
 * Format a transcript tail into the `Name: text` shape both prompts use.
 * Walks backwards from the end so the most recent lines are preserved
 * when the cap is hit.
 *
 * @param {Array<any>} lines
 * @param {number} maxChars
 */
function formatTranscriptTail(lines, maxChars) {
    if (!Array.isArray(lines) || lines.length === 0) return '';
    const parts = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln) continue;
        const who = ln.name || (ln.is_user ? 'Player' : (ln.extra?.role || 'Narrator'));
        const text = (ln.mes || '').trim();
        if (!text) continue;
        const piece = `${who}: ${text}`;
        if (total + piece.length + 1 > maxChars && parts.length > 0) break;
        parts.push(piece);
        total += piece.length + 1;
    }
    parts.reverse();
    return parts.join('\n');
}

/** @param {unknown} n */
function clampUnit(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 0.5;
    if (num < 0) return 0;
    if (num > 1) return 1;
    return num;
}

/** @param {unknown} n @param {number} lo @param {number} hi */
function clampRange(n, lo, hi) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 0;
    if (num < lo) return lo;
    if (num > hi) return hi;
    return num;
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
