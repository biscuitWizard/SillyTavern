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
    const lines = [];
    lines.push(`Campaign: ${ctx.campaign?.name || 'Untitled'}`);
    if (ctx.campaign?.brief) lines.push(`Brief: ${truncate(ctx.campaign.brief, 400)}`);
    if (ctx.playerName) lines.push(`Player character: ${ctx.playerName}`);
    lines.push('');

    if (ctx.previousSituation) {
        lines.push('Previous "where things stand":');
        if (ctx.previousSituation.recap) lines.push(`- Recap: ${ctx.previousSituation.recap}`);
        if (ctx.previousSituation.location) lines.push(`- Location: ${ctx.previousSituation.location}`);
        if (ctx.previousSituation.time) lines.push(`- Time: ${ctx.previousSituation.time}`);
        if (ctx.previousSituation.nearby_characters?.length) {
            lines.push(`- Nearby: ${ctx.previousSituation.nearby_characters.join(', ')}`);
        }
        lines.push('');
    } else {
        lines.push('(No previous situation on record — this is the first scene of the campaign.)');
        lines.push('');
    }

    lines.push('Scene that just ended:');
    if (ctx.sceneSummary?.headline) lines.push(`- Headline: ${ctx.sceneSummary.headline}`);
    if (ctx.sceneSummary?.summary) lines.push(`- Summary: ${ctx.sceneSummary.summary}`);
    if (ctx.sceneSummary?.location_changes?.length) {
        lines.push(`- Location changes: ${ctx.sceneSummary.location_changes.join('; ')}`);
    }
    if (ctx.sceneSummary?.participant_changes?.length) {
        lines.push(`- Participant changes: ${ctx.sceneSummary.participant_changes.join('; ')}`);
    }

    lines.push('');
    lines.push('Produce the SceneEndRecap JSON for the moment immediately after the scene closed.');
    return lines.join('\n');
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
