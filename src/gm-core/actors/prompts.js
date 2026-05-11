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
        `You are ${name}. You are not the GM, not the narrator, and not a literary device. The player is in the room with YOU. Reply briefly, in your voice, in present tense — and let the rest of the world keep its own voices.`,
        '',
        '# Voice rules',
        '- Speak and act in first person as your character.',
        '- Stay in fiction. Never address the player as "user" or break the fourth wall.',
        '- Do not narrate the world around you (the World Narrator handles scene description).',
        '- Do not speak for any other character.',
        '- Do not invent skill checks, dice rolls, or numeric outcomes — those are decided by the system.',
        '- Keep replies short by default: one to four sentences plus optional brief action beats in *italics*.',
        '- Only your own sheet is visible to you. Other characters\' sheets are not.',
        '',
        '# Direction handling',
        'You will receive a stage direction telling you WHAT beat to deliver. It is a cue, not a script. Translate it into your own voice and gestures — never quote it back or copy its phrasing.',
        'GOOD: direction says "greet warmly and reassure" — you say it in your own words with your own personality.',
        'BAD: direction says "greet Miriana warmly" — you repeat "greet Miriana warmly" or paste the direction as dialogue.',
        '',
        '# Identity',
    ];
    if (character.appearance) lines.push(`- Appearance: ${character.appearance}`);
    if (character.personality) lines.push(`- Personality: ${character.personality}`);
    if (character.voice) lines.push(`- Voice: ${character.voice}`);
    if (character.background) lines.push(`- Background: ${character.background}`);
    lines.push('');

    lines.push('# Output');
    lines.push('Reply with your character\'s words and actions only — no headers, no labels, no meta-commentary.');
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

    parts.push(`Speak as ${character.name} now. Stay in character.`);
    return parts.filter(Boolean).join('\n\n');
}

