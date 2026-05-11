/**
 * Phase 8 — locked MemoryExtraction prompt + schema (per participant).
 *
 * Companion to `summarize-prompts.js`. After a `SceneSummary` is produced,
 * the pipeline calls this extractor once per participant in the scene,
 * with that character's view of the world (their own sheet, the scene
 * transcript tail, the headline + summary).
 *
 * The output is 0–3 first-person memories the character would carry
 * forward. Each one becomes a `character_memory__{cid}__{character_id}`
 * record with deterministic id, written through `MemoryService.write(...)`.
 *
 * This is the *batch* extractor that complements Phase 7's per-message
 * `writers/opinion.js`: opinion.js captures fresh, message-by-message
 * commitments; this extractor produces broader, scene-spanning
 * reflections. Phase 8 ids are namespaced with `scene-end:{scene_id}` so
 * they cannot collide with opinion.js's per-message ids.
 *
 * The system prompt is locked here; tune via `best-of-n-runner` and
 * refresh fixtures together with the regression keywords below.
 */

import { tag, TAGS } from '../prompts/tags.js';

export const MEMORY_EXTRACTION_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'SceneEndMemoryExtraction',
    type: 'object',
    properties: {
        is_significant: {
            type: 'boolean',
            description: 'False if the scene held nothing worth this character carrying forward.',
        },
        memories: {
            type: 'array',
            description: 'Up to 3 first-person memories from this character\'s point of view.',
            items: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'ONE first-person sentence in this character\'s voice.',
                    },
                    importance: { type: 'number', minimum: 0, maximum: 1 },
                    valence: { type: 'number', minimum: -1, maximum: 1 },
                    tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['content', 'importance', 'valence', 'tags'],
                additionalProperties: false,
            },
            maxItems: 3,
        },
    },
    required: ['is_significant', 'memories'],
    additionalProperties: false,
};

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = [
    'You are a memory extractor for a single tabletop character at the',
    'end of a scene. Your job is to produce up to three first-person',
    'memories that THIS character would still be thinking about',
    'tomorrow.',
    '',
    'Process:',
    '1. Read the scene summary and the transcript tail.',
    '2. Filter to what THIS character witnessed, did, or felt. Ignore',
    '   beats they were not present for or could not perceive.',
    '3. Pick the 0–3 most durable takeaways for them. Most scenes',
    '   warrant 1–2 memories; some warrant zero. Three is the ceiling,',
    '   not the target.',
    '',
    'A durable memory is one of:',
    '- A new opinion about another character or faction.',
    '- A vow, debt, or commitment they made out loud.',
    '- A noteworthy event they personally witnessed and would later',
    '  reference.',
    '- A revealed secret or surprising fact they now know.',
    '',
    'Voice rules:',
    '- Each memory is ONE sentence in first-person, this character\'s',
    '  voice (e.g. "I owe Lila a debt I cannot ignore").',
    '- No third-person summaries. No "the character".',
    '- Importance: 0.5 ordinary, 0.7+ character-defining, 0.9+',
    '  permanent shift.',
    '- Valence: -1 to 1. Strong dislike negative, gratitude positive.',
    '- Tags: 2–4 lowercase keywords (people, factions, themes).',
    '',
    'When the scene held nothing memorable for this character, set',
    '`is_significant: false` and return an empty `memories` array. Do',
    'this aggressively — false positives drown the actor in irrelevant',
    'memories. Output JSON only.',
].join('\n');

/**
 * Build the user-facing prompt body for the per-participant extraction.
 *
 * Strict context isolation: only `character` (the participant being
 * extracted) is rendered. We never include other participants' sheets
 * or memories. This is the system property tested in
 * `tests/gm-core/scenes/end-pipeline.test.js`.
 *
 * @param {{
 *   character: { id: string, name: string, personality?: string, is_player?: boolean },
 *   scene: { id: string, name?: string, location?: string },
 *   summary: { headline: string, summary: string },
 *   transcriptTail: string,
 * }} ctx
 */
export function buildExtractionUser(ctx) {
    const parts = [];

    const charLines = [`${ctx.character.name}${ctx.character.is_player ? ' (player character)' : ''}`];
    if (ctx.character.personality) charLines.push(`Personality: ${truncate(ctx.character.personality, 400)}`);
    parts.push(tag(TAGS.character, charLines.join('\n')));

    const sceneLines = [ctx.scene?.name || ctx.scene?.id || 'Untitled scene'];
    if (ctx.scene?.location) sceneLines.push(`Location: ${ctx.scene.location}`);
    parts.push(tag(TAGS.scene, sceneLines.join('\n')));

    const summaryLines = [];
    if (ctx.summary?.headline) summaryLines.push(`Headline: ${ctx.summary.headline}`);
    if (ctx.summary?.summary) summaryLines.push(ctx.summary.summary);
    if (summaryLines.length) parts.push(tag(TAGS.scene_summary, summaryLines.join('\n')));

    parts.push(tag(TAGS.transcript, (ctx.transcriptTail || '').trim() || '(empty transcript)'));

    parts.push(`What does ${ctx.character.name} carry forward from this scene? 0–3 first-person memories.`);
    return parts.filter(Boolean).join('\n\n');
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
