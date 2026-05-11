/**
 * Opening-situation prompt + JSON schema.
 *
 * One structured LLM call that turns a campaign brief + freshly-created
 * player character into a `CurrentSituation` describing where the PC
 * starts the story. Used after chargen completes; the result is what the
 * Campaign Main "Where things stand" panel renders before any scene has
 * been played.
 *
 * Voice: short, present-tense, factual. The same shape (`recap`,
 * `location`, `time`, `nearby_characters`) is later refreshed by the
 * scene-end pipeline, so both sources land in the same UI slot.
 */

import { tag, TAGS } from '../prompts/tags.js';

export const OPENING_SITUATION_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'OpeningSituation',
    type: 'object',
    properties: {
        recap: {
            type: 'string',
            description: '2-4 short sentences, present tense, third-person. Where is the PC, what just happened, what is on their mind?',
        },
        location: {
            type: 'string',
            description: 'Concrete place name + immediate surroundings, e.g. "The Black Boar inn, Faldenport — common room near the hearth".',
        },
        time: {
            type: 'string',
            description: 'In-fiction time hook, e.g. "Late evening, harvest week" or "Dawn, second day of the journey".',
        },
        nearby_characters: {
            type: 'array',
            description: 'Names of NPCs co-located with the PC at this moment. Empty array is fine.',
            items: { type: 'string' },
            maxItems: 6,
        },
    },
    required: ['recap', 'location', 'time', 'nearby_characters'],
    additionalProperties: false,
};

export const OPENING_SITUATION_SYSTEM_PROMPT = [
    'You are a tabletop GM setting up the very first beat of a campaign.',
    'Given the campaign brief and the freshly-created player character,',
    'write a tight "where the PC is right now" snapshot.',
    '',
    'Voice and shape:',
    '- Recap: 2-4 short sentences, present tense, third-person ("Jack',
    '  stands at the dockside as fog rolls in..."). Ground the PC in a',
    '  specific place with one or two sensory beats and one open',
    '  question or pressure that invites the player to act.',
    '- Location: concrete and named. If the brief implies a region but',
    '  not a precise spot, pick one consistent with the setting.',
    '- Time: a short in-fiction time hook (time of day + season or',
    '  campaign context).',
    '- Nearby characters: 0-3 NPC names you invent or pull from the',
    '  brief. Do not include the PC themselves.',
    '',
    'Hard rules:',
    '- Do not narrate the player\'s decisions or emotions for them.',
    '- Do not advance the plot or open a scene; this is just the moment',
    '  before the player takes their first action.',
    '- Stay consistent with the brief\'s tone and ruleset.',
    '- Output JSON only.',
].join('\n');

/**
 * Build the user-facing prompt body.
 *
 * @param {{
 *   campaign: { name?: string, brief?: string, ruleset_id?: string },
 *   playerCharacter: {
 *     name: string,
 *     appearance?: string,
 *     personality?: string,
 *     background?: string,
 *   },
 * }} ctx
 */
export function buildOpeningUser(ctx) {
    const parts = [];
    const campaignLines = [ctx.campaign?.name || 'Untitled campaign'];
    if (ctx.campaign?.ruleset_id) campaignLines.push(`Ruleset: ${ctx.campaign.ruleset_id}`);
    if (ctx.campaign?.brief) campaignLines.push(`Brief: ${truncate(ctx.campaign.brief, 600)}`);
    parts.push(tag(TAGS.campaign, campaignLines.join('\n')));

    const pcLines = [ctx.playerCharacter?.name || 'The PC'];
    if (ctx.playerCharacter?.background) pcLines.push(`Background: ${truncate(ctx.playerCharacter.background, 400)}`);
    if (ctx.playerCharacter?.personality) pcLines.push(`Personality: ${truncate(ctx.playerCharacter.personality, 240)}`);
    if (ctx.playerCharacter?.appearance) pcLines.push(`Appearance: ${truncate(ctx.playerCharacter.appearance, 240)}`);
    parts.push(tag(TAGS.player_character, pcLines.join('\n')));

    parts.push('Produce the OpeningSituation JSON. The PC has not yet acted; this is the still moment before play begins.');
    return parts.filter(Boolean).join('\n\n');
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
