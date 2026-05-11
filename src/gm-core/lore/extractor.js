/**
 * Auto-extractor: takes a campaign brief + addendum and asks an LLM to
 * produce a starter `lore/core/` YAML set.
 *
 * Single structured call, intended to be subagent-runnable for prompt
 * tuning. The wizard's "auto-extract from brief" button calls this once
 * and writes the result to `lore/core/auto-extract.yaml`.
 *
 * The schema is the JSON form of `LoreEntry[]`. We keep the call narrow
 * (one shot, structured output) because retrying on different briefs is
 * cheap; iteration on the prompt itself is the slow path.
 */

import { writeCoreLoreFile } from './store.js';

/**
 * @typedef {import('./schemas.js').LoreEntry} LoreEntry
 */

const EXTRACTOR_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'LoreExtraction',
    type: 'object',
    properties: {
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    body: { type: 'string' },
                    entry_kind: {
                        type: 'string',
                        enum: ['location', 'faction', 'culture', 'people', 'history', 'magic', 'artifact', 'bestiary', 'cosmology', 'language', 'pantheon', 'custom'],
                    },
                    tags: { type: 'array', items: { type: 'string' } },
                    importance: { type: 'number' },
                },
                required: ['title', 'body', 'entry_kind', 'tags', 'importance'],
                additionalProperties: false,
            },
        },
    },
    required: ['entries'],
    additionalProperties: false,
};

const SYSTEM_PROMPT = [
    'You extract structured world-lore from a campaign brief.',
    '',
    'Goals:',
    '- Produce 6-12 atomic LoreEntry records covering the most important',
    '  setting facts a Director or Narrator would want at hand.',
    '- Mix entry kinds (locations, factions, history, people, magic, ...)',
    '  in proportion to what the brief actually emphasizes.',
    '- Each `body` is one paragraph (2-5 sentences) of factual prose.',
    '  No second-person, no roleplay, no scene-setting.',
    '- `tags` are short, lowercased, kebab-case keywords (e.g.',
    '  ["northern-coast", "city", "trade"]). 2-5 tags per entry.',
    '- `importance` is 0.4..0.9; pivotal facts (the central conflict,',
    '  the ruling power, the antagonist faction) get 0.85+, atmospheric',
    '  details get 0.4-0.6.',
    '',
    'Strict rules:',
    '- Do NOT invent details that contradict the brief. When the brief is',
    '  silent on something, omit that entry.',
    '- Do NOT include character sheets, stat blocks, or game mechanics.',
    '  Lore is in-fiction setting only.',
    '- Output JSON matching the LoreExtraction schema. No prose, no',
    '  markdown, no commentary.',
].join('\n');

/**
 * @param {{ name: string, brief?: string, addendum?: string }} campaign
 */
function buildUserPrompt(campaign) {
    const lines = [`Campaign: ${campaign.name}`, ''];
    if (campaign.brief?.trim()) {
        lines.push('Brief:');
        lines.push(campaign.brief.trim());
        lines.push('');
    }
    if (campaign.addendum?.trim()) {
        lines.push('Addendum:');
        lines.push(campaign.addendum.trim());
        lines.push('');
    }
    lines.push('Extract LoreEntry records covering the most important setting facts.');
    return lines.join('\n');
}

/**
 * Run the extractor against a campaign and write the result to
 * `lore/core/auto-extract.yaml`. Returns the entries written.
 *
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaignId: string,
 *   campaign: { name: string, brief?: string, addendum?: string },
 *   client: { structured: (args: { system: string, user: string, schema: object, schemaName: string }) => Promise<{ entries: LoreEntry[] }> },
 * }} args
 * @returns {Promise<{ written: string, entries: LoreEntry[] }>}
 */
export async function extractAndWrite({ directories, campaignId, campaign, client }) {
    const result = await client.structured({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(campaign),
        schema: EXTRACTOR_SCHEMA,
        schemaName: 'LoreExtraction',
        role: 'lore',
    });
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    const written = writeCoreLoreFile(directories, campaignId, 'auto-extract', entries);
    return { written, entries };
}

export const EXTRACTOR_SYSTEM_PROMPT = SYSTEM_PROMPT;
export const EXTRACTOR_SCHEMA_DEF = EXTRACTOR_SCHEMA;
