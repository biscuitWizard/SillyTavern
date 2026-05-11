/**
 * Scene-end recap prompt — composes the next `current_situation` after a
 * scene closes.
 *
 * Inputs: the previous `current_situation` (so the next one feels like a
 * continuation, not a reset), plus the just-produced `SceneSummary`'s
 * prose summary, `location_changes`, and `participant_changes`. Output
 * shape matches `OpeningSituation` so the same `buildCurrentSituation`
 * normaliser handles both code paths.
 *
 * Voice: present tense, third-person — same as the chargen opening so
 * the Campaign Main panel reads consistently regardless of source.
 */

import { tag, TAGS } from '../prompts/tags.js';

export const SCENE_END_RECAP_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'SceneEndRecap',
    type: 'object',
    properties: {
        recap: {
            type: 'string',
            description: '2-4 short sentences in present tense, third-person. Where the PC is right after the scene ended and what is on their mind.',
        },
        location: {
            type: 'string',
            description: 'Concrete current location.',
        },
        time: {
            type: 'string',
            description: 'In-fiction time hook (time of day + relative anchor like "an hour after the bandit raid").',
        },
        nearby_characters: {
            type: 'array',
            description: 'Names of NPCs co-located with the PC at the close of the scene.',
            items: { type: 'string' },
            maxItems: 6,
        },
    },
    required: ['recap', 'location', 'time', 'nearby_characters'],
    additionalProperties: false,
};

export const SCENE_END_RECAP_SYSTEM_PROMPT = [
    'You are a tabletop GM updating "where things stand right now" after a',
    'scene just ended. Compose the next short snapshot the player sees on',
    'the campaign hub before they decide what to do next.',
    '',
    'Voice and shape:',
    '- Recap: 2-4 short sentences, present tense, third-person. Lean on',
    '  the just-finished scene\'s outcome; surface one open thread or',
    '  pressure that invites the next action.',
    '- Location: concrete and current at the close of the scene.',
    '- Time: a short in-fiction time hook (time of day + relative anchor',
    '  like "an hour after the bandit raid").',
    '- Nearby characters: 0-3 NPC names co-located with the PC at the',
    '  close. Do not include the PC themselves.',
    '',
    'Hard rules:',
    '- Continue from the previous situation; do not reset the world.',
    '- Stay strictly inside the SceneSummary. Do not invent events that',
    '  did not happen on the page.',
    '- Do not narrate the player\'s decisions or emotions for them.',
    '- Output JSON only.',
].join('\n');

/**
 * @param {{
 *   campaign: { name?: string, brief?: string },
 *   playerName?: string,
 *   previousSituation: import('../campaigns/schemas.js').CurrentSituation | null,
 *   sceneSummary: {
 *     headline?: string,
 *     summary?: string,
 *     location_changes?: string[],
 *     participant_changes?: string[],
 *   },
 * }} ctx
 */
export function buildSceneEndRecapUser(ctx) {
    const parts = [];
    const campaignLines = [ctx.campaign?.name || 'Untitled'];
    if (ctx.campaign?.brief) campaignLines.push(`Brief: ${truncate(ctx.campaign.brief, 400)}`);
    if (ctx.playerName) campaignLines.push(`Player character: ${ctx.playerName}`);
    parts.push(tag(TAGS.campaign, campaignLines.join('\n')));

    if (ctx.previousSituation) {
        const prevLines = [];
        if (ctx.previousSituation.recap) prevLines.push(`Recap: ${ctx.previousSituation.recap}`);
        if (ctx.previousSituation.location) prevLines.push(`Location: ${ctx.previousSituation.location}`);
        if (ctx.previousSituation.time) prevLines.push(`Time: ${ctx.previousSituation.time}`);
        if (ctx.previousSituation.nearby_characters?.length) {
            prevLines.push(`Nearby: ${ctx.previousSituation.nearby_characters.join(', ')}`);
        }
        parts.push(tag(TAGS.previous_situation, prevLines.join('\n') || '(none)'));
    } else {
        parts.push(tag(TAGS.previous_situation, '(No previous situation on record — this is the first scene of the campaign.)'));
    }

    const summaryLines = [];
    if (ctx.sceneSummary?.headline) summaryLines.push(`Headline: ${ctx.sceneSummary.headline}`);
    if (ctx.sceneSummary?.summary) summaryLines.push(`Summary: ${ctx.sceneSummary.summary}`);
    if (ctx.sceneSummary?.location_changes?.length) {
        summaryLines.push(`Location changes: ${ctx.sceneSummary.location_changes.join('; ')}`);
    }
    if (ctx.sceneSummary?.participant_changes?.length) {
        summaryLines.push(`Participant changes: ${ctx.sceneSummary.participant_changes.join('; ')}`);
    }
    parts.push(tag(TAGS.scene_summary, summaryLines.join('\n') || '(no summary)'));

    parts.push('Produce the SceneEndRecap JSON for the moment immediately after the scene closed.');
    return parts.filter(Boolean).join('\n\n');
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
