/**
 * Opinion extractor — runs after each actor reply.
 *
 * One small structured LLM call asks "did this actor commit anything to
 * memory?" and produces 0–2 first-person memories with importance and
 * valence. Writes go through `MemoryService.write()` so they hit the
 * disk JSONL mirror and the per-character Qdrant collection in one path.
 *
 * False-positive guarded by an `is_significant` boolean — the model
 * picks "nothing memorable here" explicitly, which is much more reliable
 * than coercing it to return zero items.
 *
 * The system prompt is locked here for now; the
 * `prompt-tune-opinion` subagent ran A/B variants against fixtures and
 * picked this version.
 */

import { buildMemoryRecord } from '../schemas.js';
import { deriveCharacterMemoryId } from './ids.js';

/**
 * @typedef {import('../service.d.ts').MemoryService} MemoryService
 * @typedef {import('../../library/schemas.js').Character} Character
 */

const OPINION_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'OpinionExtraction',
    type: 'object',
    properties: {
        is_significant: { type: 'boolean' },
        memories: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'First-person sentence the actor would carry forward.' },
                    importance: { type: 'number', minimum: 0, maximum: 1 },
                    valence: { type: 'number', minimum: -1, maximum: 1, description: 'How the actor feels about it.' },
                    tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['content', 'importance', 'valence', 'tags'],
                additionalProperties: false,
            },
            maxItems: 2,
        },
    },
    required: ['is_significant', 'memories'],
    additionalProperties: false,
};

const SYSTEM_PROMPT = [
    'You are a memory extractor for a single tabletop character.',
    '',
    'Read the latest message they sent in a scene and decide whether',
    'they would commit anything specific to memory. Most beats are not',
    'memorable; saying hello, glancing around the room, or generic',
    'banter does not warrant a memory.',
    '',
    'Memorable beats are:',
    '- A new specific opinion they formed about another character or',
    '  faction ("Jack does not flinch under pressure"; "I do not trust',
    '  the steward").',
    '- A new commitment, decision, or vow they made out loud.',
    '- A noteworthy event they witnessed and would later reference.',
    '- A revealed secret or surprising piece of information.',
    '',
    'Voice rules:',
    '- Each memory is ONE first-person sentence in the character\'s',
    '  voice (e.g. "I owe Lila a debt I cannot ignore").',
    '- Importance: 0.5 for ordinary commitments, 0.7+ for character-',
    '  defining beats, 0.9+ for permanent shifts.',
    '- Valence: -1 to 1. Strong dislike negative, gratitude positive.',
    '- Tags: 2-4 lowercase keywords (e.g. ["lila", "debt", "promise"]).',
    '',
    'When nothing significant happened, set `is_significant: false` and',
    'return an empty `memories` array. Do this aggressively — false',
    'positives drown the actor in irrelevant memories. Output JSON only.',
].join('\n');

/**
 * @param {{ character: Character, scene: { id: string, name?: string }, transcriptTail: string, lastMessage: string }} ctx
 */
function buildUserPrompt(ctx) {
    const lines = [`Character: ${ctx.character.name}`];
    if (ctx.character.personality) lines.push(`Personality: ${ctx.character.personality}`);
    lines.push('');
    if (ctx.transcriptTail?.trim()) {
        lines.push('Recent transcript:');
        lines.push(ctx.transcriptTail.trim());
        lines.push('');
    }
    lines.push(`Latest message from ${ctx.character.name}:`);
    lines.push(ctx.lastMessage.trim());
    lines.push('');
    lines.push(`Decide: did ${ctx.character.name} commit anything specific to memory in that latest message? If so, write it as their first-person memory.`);
    return lines.join('\n');
}

/**
 * @param {{
 *   memoryService: MemoryService,
 *   client: { structured: (args: { system: string, user: string, schema: object, schemaName: string }) => Promise<any> },
 *   campaignId: string,
 *   character: Character,
 *   sceneId: string,
 *   sceneIndex: number,
 *   messageIndex: number,
 *   lastMessage: string,
 *   transcriptTail: string,
 * }} args
 * @returns {Promise<{ wrote: number, hits: any[] }>}
 */
export async function extractAndWriteOpinion(args) {
    const { memoryService, client, campaignId, character, sceneId, sceneIndex, messageIndex, lastMessage, transcriptTail } = args;
    if (!lastMessage?.trim()) return { wrote: 0, hits: [] };

    /** @type {{ is_significant: boolean, memories: Array<{ content: string, importance: number, valence: number, tags: string[] }> }} */
    let result;
    try {
        result = await client.structured({
            system: SYSTEM_PROMPT,
            user: buildUserPrompt({ character, scene: { id: sceneId }, transcriptTail, lastMessage }),
            schema: OPINION_SCHEMA,
            schemaName: 'OpinionExtraction',
            role: 'opinion_writer',
        });
    } catch (err) {
        console.warn('[rag.opinion] extractor failed', err?.message || err);
        return { wrote: 0, hits: [] };
    }
    if (!result?.is_significant || !Array.isArray(result.memories) || result.memories.length === 0) {
        return { wrote: 0, hits: [] };
    }

    let wrote = 0;
    const hits = [];
    for (let i = 0; i < result.memories.length; i++) {
        const mem = result.memories[i];
        const id = deriveCharacterMemoryId({
            campaignId,
            characterId: character.id,
            sceneId,
            messageIndex,
            content: mem.content,
            slot: i,
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
            source: `opinion-extractor:${sceneId}:msg-${messageIndex}`,
            scene_index: sceneIndex,
        });
        try {
            await memoryService.write({ campaignId, characterId: character.id, record });
            hits.push(record);
            wrote++;
        } catch (err) {
            console.warn('[rag.opinion] write failed', err?.message || err);
        }
    }
    return { wrote, hits };
}

export const OPINION_SYSTEM_PROMPT = SYSTEM_PROMPT;
export const OPINION_SCHEMA_DEF = OPINION_SCHEMA;
