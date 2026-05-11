/**
 * Ask-mode prompt + JSON schema.
 *
 * Out-of-fiction GM persona: the player asks questions about the world,
 * the campaign, the rules, etc. and the GM answers as a guide — never
 * advancing the story, never narrating in-fiction events.
 *
 * The GM may also emit a `lore_candidate` payload when the answer
 * reveals a durable world fact. The service writes that as a
 * `world_lore` record so future scenes / Ask exchanges can retrieve it.
 */

import { tag, TAGS } from '../prompts/tags.js';

export const ASK_REPLY_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AskReply',
    type: 'object',
    properties: {
        reply: {
            type: 'string',
            description: 'GM\'s out-of-fiction answer to the player\'s question. Plain prose, 1-4 short paragraphs. Never narrate the player\'s actions or advance the scene.',
        },
        lore_candidate: {
            type: ['object', 'null'],
            description: 'Set when the answer reveals a durable world fact worth remembering. Set to null otherwise.',
            properties: {
                title: {
                    type: 'string',
                    description: 'Short, noun-driven title for the lore record (e.g. "The Ironhold gate toll").',
                },
                content: {
                    type: 'string',
                    description: 'One or two sentences of canonical world fact in third person. This is what future RAG queries will retrieve.',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    maxItems: 8,
                    description: 'Lowercase tags grouping the fact (e.g. "ironhold", "gate", "tolls").',
                },
                entry_kind: {
                    type: 'string',
                    enum: [
                        'location', 'faction', 'culture', 'people', 'history',
                        'magic', 'artifact', 'bestiary', 'cosmology', 'language',
                        'pantheon', 'custom',
                    ],
                    description: 'Which world-lore facet this fact belongs to.',
                },
            },
            required: ['title', 'content', 'tags', 'entry_kind'],
            additionalProperties: false,
        },
    },
    required: ['reply', 'lore_candidate'],
    additionalProperties: false,
};

export const ASK_SYSTEM_PROMPT = [
    'You are the GM speaking out-of-fiction with the player. They are',
    'asking questions about the campaign, the world, the rules, the',
    'situation, or the characters around them. You answer as a guide,',
    'NOT as a narrator or actor inside the story.',
    '',
    'Hard rules:',
    '- Never narrate the player\'s actions, decisions, or thoughts.',
    '- Never advance fiction. The story does not move while Ask mode is',
    '  open. If the player wants to take an action, tell them to use',
    '  Plot mode (do NOT pretend an action just happened).',
    '- Stay strictly inside what the campaign brief, current situation,',
    '  scene history, and world lore tell you. If you genuinely don\'t',
    '  know, say so plainly — do not invent canon-breaking facts.',
    '- You may freely speculate or offer GM-side guidance, but flag it',
    '  ("As your GM, I\'d guess...") instead of stating it as canon.',
    '',
    'Reply shape:',
    '- `reply`: 1-4 short paragraphs of clear, conversational prose. No',
    '  in-fiction narration, no second-person ("you do X"), no',
    '  third-person scene description ("Jack feels..."). Talk to the',
    '  player.',
    '- `lore_candidate`: when your answer establishes a NEW durable world',
    '  fact (a place, a person, a faction, a piece of history) that the',
    '  campaign should remember from now on, fill it in. Otherwise set',
    '  it to null. Do not record opinion, conjecture, or already-known',
    '  facts — only fresh canon.',
    '',
    'Output JSON only.',
].join('\n');

/**
 * Format retrieval hits as a compact MEMORIES block for the prompt.
 *
 * @param {Array<{ record: { content: string, world_lore?: { title?: string } } }>} hits
 */
function formatLoreHits(hits) {
    if (!Array.isArray(hits) || hits.length === 0) return '(no world lore on file)';
    const out = [];
    for (let i = 0; i < hits.length; i++) {
        const r = hits[i]?.record;
        if (!r) continue;
        const title = r.world_lore?.title;
        const head = title ? `- ${title}: ` : '- ';
        out.push(`${head}${truncate(r.content, 240)}`);
    }
    return out.length ? out.join('\n') : '(no world lore on file)';
}

/**
 * Format the most recent Ask transcript entries into `Player:` / `GM:` lines.
 *
 * @param {Array<{ role: 'player' | 'gm', text: string }>} entries
 * @param {number} maxChars
 */
function formatAskTail(entries, maxChars = 2400) {
    if (!Array.isArray(entries) || entries.length === 0) return '(no prior Ask exchanges)';
    const parts = [];
    let total = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const ent = entries[i];
        if (!ent || !ent.text) continue;
        const who = ent.role === 'gm' ? 'GM' : 'Player';
        const piece = `${who}: ${ent.text.trim()}`;
        if (total + piece.length + 1 > maxChars && parts.length > 0) break;
        parts.push(piece);
        total += piece.length + 1;
    }
    parts.reverse();
    return parts.join('\n');
}

/**
 * @param {{
 *   campaign: { name?: string, brief?: string, addendum?: string },
 *   playerCharacter: { name?: string, appearance?: string, personality?: string, background?: string } | null,
 *   currentSituation: import('../campaigns/schemas.js').CurrentSituation | null,
 *   recentSceneHeadlines: string[],
 *   loreHits: Array<{ record: { content: string, world_lore?: { title?: string } } }>,
 *   transcriptTail: Array<{ role: 'player' | 'gm', text: string }>,
 *   question: string,
 * }} ctx
 */
export function buildAskUser(ctx) {
    const parts = [];
    const campaignLines = [ctx.campaign?.name || 'Untitled'];
    if (ctx.campaign?.brief) campaignLines.push(`Brief: ${truncate(ctx.campaign.brief, 600)}`);
    if (ctx.campaign?.addendum) campaignLines.push(`GM addendum: ${truncate(ctx.campaign.addendum, 400)}`);
    parts.push(tag(TAGS.campaign, campaignLines.join('\n')));

    if (ctx.playerCharacter) {
        const pcLines = [ctx.playerCharacter.name || 'The PC'];
        if (ctx.playerCharacter.background) pcLines.push(`Background: ${truncate(ctx.playerCharacter.background, 300)}`);
        parts.push(tag(TAGS.player_character, pcLines.join('\n')));
    }

    if (ctx.currentSituation) {
        const sitLines = [];
        if (ctx.currentSituation.recap) sitLines.push(`Recap: ${ctx.currentSituation.recap}`);
        if (ctx.currentSituation.location) sitLines.push(`Location: ${ctx.currentSituation.location}`);
        if (ctx.currentSituation.time) sitLines.push(`Time: ${ctx.currentSituation.time}`);
        if (ctx.currentSituation.nearby_characters?.length) {
            sitLines.push(`Nearby: ${ctx.currentSituation.nearby_characters.join(', ')}`);
        }
        parts.push(tag(TAGS.situation, sitLines.join('\n')));
    } else {
        parts.push(tag(TAGS.situation, '(no situation snapshot on file yet)'));
    }

    if (Array.isArray(ctx.recentSceneHeadlines) && ctx.recentSceneHeadlines.length) {
        const headlines = ctx.recentSceneHeadlines.slice(0, 3).map(h => `- ${truncate(h, 200)}`);
        parts.push(tag(TAGS.scene_history, headlines.join('\n')));
    }

    parts.push(tag(TAGS.world_lore, formatLoreHits(ctx.loreHits)));
    parts.push(tag(TAGS.ask_history, formatAskTail(ctx.transcriptTail)));
    parts.push(tag(TAGS.player_input, String(ctx.question || '').trim() || '(empty question)'));

    parts.push('Produce the AskReply JSON.');
    return parts.filter(Boolean).join('\n\n');
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
