/**
 * Per-actor prompt builders (Phase 5).
 *
 * The Director picks `speak: <character_id>`; the loop resolves the
 * Character record and calls these builders to produce a system+user prompt
 * for the actor LLM.
 *
 * # Context isolation invariants (enforced here, asserted in tests)
 *
 *   1. Actor X's prompt sees only X's sheet. Other characters' sheets,
 *      descriptions, voice notes, etc. never appear here.
 *   2. Director rationale is never echoed.
 *   3. Phase 7 wires RAG: the user prompt carries a MEMORIES block built
 *      from this actor's `character_memory__{cid}__{X}` collection plus a
 *      slice of `world_lore__{cid}` and `player_journal__{cid}`. The HTTP
 *      wrapper builds the block per-actor before dispatch and passes it
 *      via `ctx.memories_block`; this builder splices it. Other actors'
 *      memory collections are physically inaccessible — the leak invariant
 *      is enforced by collection name, not by remembering to pass a filter.
 *   4. The Narrator's prompt is built separately in `narrator/prompts.js`;
 *      this module is character-only.
 *
 * # Sheet-AFTER-RAG ordering (M0 invariant)
 *
 * The character sheet YAML is rendered into the USER prompt, AFTER the
 * MEMORIES block. The system prompt only restates the rule that other
 * actors' sheets are not visible. Two reasons:
 *
 *   - With richer categorized sheets (traits, pulse, relationships) we do
 *     not want the model treating sheet entries as retrieval seeds — RAG
 *     content arrives first so it grounds the reply, then the sheet sits
 *     immediately above the director instruction as authoritative current
 *     state.
 *   - Defense-in-depth: the RAG retrieval query (`pickQueryText` in
 *     `director/loop.js`) is constructed from `ctx.user_input` and the
 *     transcript tail only, never from `character.sheet`. Pinning the
 *     prompt order makes that guarantee structurally observable.
 *
 * The builder takes the active character explicitly (it does not even
 * receive `ctx.actors`) so a future caller cannot accidentally splice in
 * another actor's data.
 */

import { renderSheetYaml } from '../library/yaml.js';
import { tag, TAGS } from '../prompts/tags.js';

/**
 * @typedef {import('../director/prompts.js').TurnContext} TurnContext
 * @typedef {import('../library/schemas.js').Character} Character
 */

/**
 * @param {TurnContext} _ctx
 * @param {Character} character
 * @returns {string}
 */
export function actorSystemPrompt(_ctx, character) {
    const name = character.name || 'Unknown';
    const lines = [
        `You write the next beat for ${name}, an NPC in this scene. Write in close third person, present tense, in ${name}'s voice. You are not the GM, not the narrator, and not a literary device — you give this one character words and body language, and nothing else.`,
        '',
        '# Voice rules',
        `- Write ${name}'s dialogue in quotes and ${name}'s actions in *italics*. Both in third person — "*Gruff wipes the bar*", never "*I wipe the bar*".`,
        '- Stay in fiction. Never address the player as "user" or break the fourth wall.',
        '- Do not narrate the world around you (the World Narrator handles scene description).',
        '- Do not speak for any other character.',
        '- Do not invent skill checks, dice rolls, or numeric outcomes — those are decided by the system.',
        '',
        '# Brevity contract — non-negotiable',
        '1. Default reply: 1-3 sentences. Hard cap: 4 sentences total, including any italic action beat.',
        '2. Maximum 1 italic action beat per reply. Skip it if the dialogue alone delivers the beat.',
        '3. No multi-paragraph replies. One paragraph, ever.',
        '4. End on the line that lands the beat. Do not add a closing thought, summary, or follow-up offer.',
        '5. Do not bait engagement ("So... what now?", "Are you in?", "What do you say?"). Leave silence.',
        '6. Vary sentence length. No two consecutive sentences over 15 words.',
        `BAD (do not produce output like this): *${name} narrows his eyes...* "Aye..." *He leans forward...* "Look here..." *He sighs...* "Ye watch yerself..."`,
        `GOOD: *${name} sets the mug down with a thud.* "Mind yer own business, lad. I won't say it twice."`,
        '',
        '- Only your own sheet is visible to you. Other characters\' sheets are not.',
        '',
        '# Direction handling',
        'You will receive a stage direction telling you WHAT beat to deliver. It is a cue, not a script. Translate it into your own voice and gestures — never quote it back or copy its phrasing.',
        `GOOD: direction says "greet warmly and reassure" — you write *${name} clasps the newcomer's hand.* "You're safe here."`,
        `BAD: direction says "greet warmly" — you repeat "greet warmly" or paste the direction as dialogue.`,
        '',
        '# Identity',
    ];
    if (character.appearance) lines.push(`- Appearance: ${character.appearance}`);
    if (character.personality) lines.push(`- Personality: ${character.personality}`);
    if (character.voice) lines.push(`- Voice: ${character.voice}`);
    if (character.background) lines.push(`- Background: ${character.background}`);
    lines.push('');

    lines.push('# Output');
    lines.push(`Write ${name}'s words and actions only — third person, present tense. No headers, no labels, no meta-commentary.`);
    return lines.join('\n');
}

/**
 * @param {TurnContext} ctx
 * @param {Character} character
 * @param {string} intent
 * @returns {string}
 */
export function actorUserPrompt(ctx, character, intent) {
    const parts = [];

    const campaignLines = [ctx.campaign?.name || ''];
    if (ctx.campaign?.brief) campaignLines.push(String(ctx.campaign.brief).trim());
    parts.push(tag(TAGS.campaign, campaignLines.join('\n')));

    if (ctx.scene) {
        const sceneLines = [`Name: ${ctx.scene.name || ctx.scene.id}`];
        if (ctx.scene.location) sceneLines.push(`Location: ${ctx.scene.location}`);
        parts.push(tag(TAGS.scene, sceneLines.join('\n')));
    }

    if (ctx.recent_transcript && String(ctx.recent_transcript).trim()) {
        parts.push(tag(TAGS.recent, String(ctx.recent_transcript).trim()));
    }

    if (ctx.user_input && String(ctx.user_input).trim()) {
        parts.push(tag(TAGS.player_input, String(ctx.user_input).trim()));
    }

    if (ctx.memories_block && ctx.memories_block.trim()) {
        parts.push(ctx.memories_block.trim());
    }

    const sheetYaml = renderSheetYaml(character.sheet, ctx.sheet_layout);
    if (sheetYaml.trim()) {
        parts.push(tag(TAGS.sheet, sheetYaml, { format: 'yaml' }));
    }

    const directionBody = intent && intent.trim() ? intent.trim() : '(react in character to the latest beat)';
    parts.push(tag(TAGS.director_direction, directionBody));

    parts.push(`Write ${character.name}'s next beat now. Third person, present tense.`);
    return parts.filter(Boolean).join('\n\n');
}

