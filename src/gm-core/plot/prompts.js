/**
 * Plot-mode prompt + JSON schema.
 *
 * The player declares an intended action ("I want to break into the
 * temple at midnight"). The GM persona — informed by the campaign brief,
 * the current `current_situation`, recent scene headlines, top world
 * lore, and the PC sheet — gates the action with a binary outcome:
 *
 *   - `pushback`: the action isn't possible / consistent / sensible
 *     right now; surface a concrete reason.
 *   - `start_scene`: the action warrants a scene; emit name, location,
 *     opening pose, and suggested participants.
 *
 * No multi-round negotiation in this pass — see the plan's "Out of
 * scope" section. The tone leans into the "plot momentum" / "positivity
 * bias" framing: when the action is reasonable, lean into it.
 */

export const PLOT_DECISION_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'PlotDecision',
    type: 'object',
    properties: {
        decision: {
            type: 'string',
            enum: ['pushback', 'start_scene'],
            description: 'Binary gate result.',
        },
        reason: {
            type: ['string', 'null'],
            description: 'When decision === "pushback": one concrete in-fiction reason the action cannot proceed as stated. Null when decision === "start_scene".',
        },
        name: {
            type: ['string', 'null'],
            description: 'When decision === "start_scene": short title for the new scene (e.g. "Breaking into the Temple at Midnight"). Null on pushback.',
        },
        location: {
            type: ['string', 'null'],
            description: 'Concrete location the new scene opens at. Null on pushback.',
        },
        opening_pose: {
            type: ['string', 'null'],
            description: 'A 2-4 sentence narrator pose to seed the scene with. Present tense, third-person. Sets the scene without acting for the PC. Null on pushback.',
        },
        suggested_participants: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 6,
            description: 'NPC names you suggest joining the scene at the start. May be empty when only the PC is present. Names of NPCs from the campaign roster or the current_situation\'s nearby_characters where possible.',
        },
    },
    required: ['decision', 'reason', 'name', 'location', 'opening_pose', 'suggested_participants'],
    additionalProperties: false,
};

export const PLOT_SYSTEM_PROMPT = [
    'You are the GM gating a player\'s declared action. The player has',
    'told you what their character intends to do, say, or attempt next.',
    'Your job is to make ONE call:',
    '',
    '  - "start_scene": the action is plausible, consistent with the',
    '    world and the PC\'s position, and worth playing out at the',
    '    table. Lean into player momentum: when an action is reasonable,',
    '    say yes. Frame the scene so the player has agency — the GM',
    '    sets the stage, not the outcome.',
    '  - "pushback": the action cannot proceed as stated AS-IS. Reasons',
    '    that warrant pushback: physical impossibility (the PC is not',
    '    where they\'d need to be), continuity break (it contradicts',
    '    established lore or the current situation), or the PC simply',
    '    lacks the means right now. Pushback is a redirect, not a',
    '    rejection of the player\'s creativity — phrase it as a fact,',
    '    not a moral judgement.',
    '',
    'Strong defaults:',
    '- Trust the player. If the action is roughly plausible, default to',
    '  start_scene. Pushback is for the obvious cases, not for any time',
    '  you can imagine a complication.',
    '- The opening_pose sets the scene the moment the action begins; it',
    '  must NOT decide the action\'s outcome. The player will play the',
    '  attempt themselves once the scene is live.',
    '',
    'Hard rules:',
    '- Stay strictly inside the brief, current situation, scene history,',
    '  and world lore you are given.',
    '- Do not narrate the player\'s success/failure or interior monologue.',
    '- Pushback `reason` must be one short sentence, concrete, and tied',
    '  to a specific obstacle (location, timing, missing item, NPC',
    '  absent, etc.). No vague "the GM doesn\'t think so".',
    '- For start_scene: opening_pose is 2-4 sentences, present tense,',
    '  third-person, sensory, ending on a beat that invites the player',
    '  to act.',
    '',
    'Output JSON only. Always include all required fields, using null',
    'for the ones that don\'t apply to your decision.',
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
        out.push(`${head}${truncate(r.content, 200)}`);
    }
    return out.length ? out.join('\n') : '(no world lore on file)';
}

/**
 * @param {{
 *   campaign: { name?: string, brief?: string, addendum?: string },
 *   playerCharacter: {
 *     name?: string,
 *     appearance?: string,
 *     personality?: string,
 *     background?: string,
 *     sheet?: { stats?: Record<string, any>, items?: Array<{ name: string }>, skills?: string[] }
 *   } | null,
 *   currentSituation: import('../campaigns/schemas.js').CurrentSituation | null,
 *   recentSceneHeadlines: string[],
 *   loreHits: Array<{ record: { content: string, world_lore?: { title?: string } } }>,
 *   nearbyRoster: string[],
 *   intent: string,
 * }} ctx
 */
export function buildPlotUser(ctx) {
    const lines = [];
    lines.push(`Campaign: ${ctx.campaign?.name || 'Untitled'}`);
    if (ctx.campaign?.brief) lines.push(`Brief: ${truncate(ctx.campaign.brief, 600)}`);
    if (ctx.campaign?.addendum) lines.push(`GM addendum: ${truncate(ctx.campaign.addendum, 400)}`);

    if (ctx.playerCharacter) {
        lines.push('');
        lines.push(`Player character: ${ctx.playerCharacter.name || 'The PC'}`);
        if (ctx.playerCharacter.background) lines.push(`Background: ${truncate(ctx.playerCharacter.background, 240)}`);
        if (ctx.playerCharacter.personality) lines.push(`Personality: ${truncate(ctx.playerCharacter.personality, 200)}`);
        const sheet = ctx.playerCharacter.sheet || {};
        if (Array.isArray(sheet.skills) && sheet.skills.length) {
            lines.push(`Skills: ${sheet.skills.slice(0, 12).join(', ')}`);
        }
        if (Array.isArray(sheet.items) && sheet.items.length) {
            lines.push(`Items: ${sheet.items.slice(0, 8).map(i => i.name).filter(Boolean).join(', ')}`);
        }
    }

    lines.push('');
    if (ctx.currentSituation) {
        lines.push('Where things stand right now:');
        if (ctx.currentSituation.recap) lines.push(`- Recap: ${ctx.currentSituation.recap}`);
        if (ctx.currentSituation.location) lines.push(`- Location: ${ctx.currentSituation.location}`);
        if (ctx.currentSituation.time) lines.push(`- Time: ${ctx.currentSituation.time}`);
        if (ctx.currentSituation.nearby_characters?.length) {
            lines.push(`- Nearby: ${ctx.currentSituation.nearby_characters.join(', ')}`);
        }
    } else {
        lines.push('Where things stand right now: (no situation snapshot on file yet — assume the PC is at a sensible starting beat)');
    }

    if (Array.isArray(ctx.recentSceneHeadlines) && ctx.recentSceneHeadlines.length) {
        lines.push('');
        lines.push('Recent scene history:');
        for (const h of ctx.recentSceneHeadlines.slice(0, 3)) {
            lines.push(`- ${truncate(h, 200)}`);
        }
    }

    lines.push('');
    lines.push('World lore on file (top hits for this intent):');
    lines.push(formatLoreHits(ctx.loreHits));

    if (Array.isArray(ctx.nearbyRoster) && ctx.nearbyRoster.length) {
        lines.push('');
        lines.push(`Known NPCs you may pull into the scene: ${ctx.nearbyRoster.slice(0, 12).join(', ')}`);
    }

    lines.push('');
    lines.push(`Player intent: ${String(ctx.intent || '').trim() || '(empty intent)'}`);
    lines.push('');
    lines.push('Decide now. Produce the PlotDecision JSON.');
    return lines.join('\n');
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
