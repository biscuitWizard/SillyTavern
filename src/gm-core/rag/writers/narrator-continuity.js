/**
 * Narrator continuity extractor — runs after each Narrator beat.
 *
 * One small structured call extracts {locations_named[],
 * characters_described[], imagery_motifs[]} and writes them to
 * `narrator_memory__{cid}`. Cheap; when nothing of substance was
 * narrated (a pure status beat), we skip the LLM call entirely.
 */

import { buildMemoryRecord } from '../schemas.js';
import { deriveRoleMemoryId } from './ids.js';

/**
 * @typedef {import('../service.d.ts').MemoryService} MemoryService
 */

const CONTINUITY_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'NarratorContinuity',
    type: 'object',
    properties: {
        locations_named: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific places (rooms, landmarks, named regions) that appeared in the prose.',
        },
        characters_described: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific NPCs given a body, voice, or detail in the prose.',
        },
        imagery_motifs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Recurring sensory motifs the Narrator should keep consistent (lighting, weather, smells).',
        },
    },
    required: ['locations_named', 'characters_described', 'imagery_motifs'],
    additionalProperties: false,
};

const SYSTEM_PROMPT = [
    'You are a continuity tracker for the World Narrator.',
    '',
    'Read the Narrator\'s latest beat and extract concrete details that',
    'should stay consistent across future beats: specific places named,',
    'specific NPCs given any defining detail, and recurring sensory',
    'motifs (a particular kind of light, a smell, a wound).',
    '',
    'Rules:',
    '- Concrete only. "the tavern" is not a location; "the Bitter Lake"',
    '  or "the Glimmer Inn" is.',
    '- Atmospheric details only when they are specific and reusable',
    '  ("the rain runs sideways through the gaps in the rafters"). Skip',
    '  generic prose.',
    '- Empty arrays are correct when nothing concrete was added.',
    '- Output JSON only.',
].join('\n');

/**
 * @param {{ sceneName?: string, location?: string, prose: string }} ctx
 */
function buildUserPrompt(ctx) {
    const lines = [];
    if (ctx.sceneName) lines.push(`Scene: ${ctx.sceneName}`);
    if (ctx.location) lines.push(`Location: ${ctx.location}`);
    lines.push('');
    lines.push('Narrator\'s latest beat:');
    lines.push((ctx.prose || '').trim());
    lines.push('');
    lines.push('Extract continuity details from this beat.');
    return lines.join('\n');
}

/**
 * @param {{
 *   memoryService: MemoryService,
 *   client: { structured: (args: { system: string, user: string, schema: object, schemaName: string }) => Promise<any> },
 *   campaignId: string,
 *   sceneId: string,
 *   sceneName?: string,
 *   location?: string,
 *   sceneIndex: number,
 *   prose: string,
 * }} args
 * @returns {Promise<{ wrote: number, hits: any[] }>}
 */
export async function extractAndWriteNarratorContinuity(args) {
    const { memoryService, client, campaignId, sceneId, sceneName, location, sceneIndex, prose } = args;
    if (!prose?.trim() || prose.trim().length < 60) {
        // Tiny beats rarely add continuity worth tracking.
        return { wrote: 0, hits: [] };
    }

    let result;
    try {
        result = await client.structured({
            system: SYSTEM_PROMPT,
            user: buildUserPrompt({ sceneName, location, prose }),
            schema: CONTINUITY_SCHEMA,
            schemaName: 'NarratorContinuity',
        });
    } catch (err) {
        console.warn('[rag.narrator-continuity] extractor failed', err?.message || err);
        return { wrote: 0, hits: [] };
    }

    /** @type {Array<{ category: string, value: string }>} */
    const items = [];
    for (const v of result.locations_named || []) items.push({ category: 'location', value: String(v) });
    for (const v of result.characters_described || []) items.push({ category: 'character', value: String(v) });
    for (const v of result.imagery_motifs || []) items.push({ category: 'imagery', value: String(v) });

    if (items.length === 0) return { wrote: 0, hits: [] };

    let wrote = 0;
    const hits = [];
    let nanos = Date.now() * 1000;
    for (const item of items) {
        const id = deriveRoleMemoryId({
            campaignId,
            role: `narrator/${sceneId}/${item.category}`,
            nanos: nanos++,
            content: item.value,
        });
        const record = buildMemoryRecord({
            id,
            kind: 'narrator_memory',
            scope_id: campaignId,
            content: item.value,
            tags: [item.category, sceneId],
            importance: item.category === 'location' ? 0.7 : (item.category === 'character' ? 0.65 : 0.5),
            valence: 0,
            temporally_blind: false,
            source: `narrator-continuity:${sceneId}`,
            scene_index: sceneIndex,
            metadata: { category: item.category },
        });
        try {
            await memoryService.write({ campaignId, record });
            hits.push(record);
            wrote++;
        } catch (err) {
            console.warn('[rag.narrator-continuity] write failed', err?.message || err);
        }
    }
    return { wrote, hits };
}

export const NARRATOR_CONTINUITY_SYSTEM_PROMPT = SYSTEM_PROMPT;
export const NARRATOR_CONTINUITY_SCHEMA_DEF = CONTINUITY_SCHEMA;
