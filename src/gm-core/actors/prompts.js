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
        `You are ${name}, a character in an interactive TTRPG scene.`,
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
    const lines = [];
    lines.push(`# Campaign: ${ctx.campaign?.name || ''}`);
    if (ctx.campaign?.brief) {
        lines.push(String(ctx.campaign.brief).trim());
    }
    lines.push('');

    if (ctx.scene) {
        lines.push('# Scene');
        const sceneName = ctx.scene.name || ctx.scene.id;
        lines.push(`- Name: ${sceneName}`);
        if (ctx.scene.location) lines.push(`- Location: ${ctx.scene.location}`);
        lines.push('');
    }

    if (ctx.recent_transcript && String(ctx.recent_transcript).trim()) {
        lines.push('# Recent transcript');
        lines.push(String(ctx.recent_transcript).trim());
        lines.push('');
    }

    if (ctx.user_input && String(ctx.user_input).trim()) {
        lines.push('# Player just said / did');
        lines.push(String(ctx.user_input).trim());
        lines.push('');
    }

    if (ctx.memories_block && ctx.memories_block.trim()) {
        lines.push(ctx.memories_block.trim());
        lines.push('');
    }

    const sheetYaml = renderSheetYaml(character.sheet, ctx.sheet_layout);
    if (sheetYaml.trim()) {
        lines.push('# Your character sheet');
        lines.push('```yaml');
        lines.push(sheetYaml);
        lines.push('```');
        lines.push('');
    }

    lines.push(`# Director instruction for ${character.name}`);
    lines.push(intent && intent.trim() ? intent.trim() : '(react in character to the latest beat)');
    lines.push('');
    lines.push(`Speak as ${character.name} now. Stay in character.`);
    return lines.join('\n');
}

/**
 * Build the user prompt for an actor that is reacting to a skill check
 * directed at them. The Director picks `skill_check.voice = <this actor>`
 * for social checks (persuade, intimidate, deceive, charm) so the target
 * NPC responds in their own first-person voice rather than via a generic
 * narrator paragraph.
 *
 * The actor system prompt (`actorSystemPrompt`) is reused unchanged — the
 * isolation invariants still hold (only this character's sheet is in the
 * system prompt). This builder just frames the user-side text as
 * "someone just rolled X against you; react in character."
 *
 * @param {TurnContext} ctx
 * @param {Character} character   the NPC reacting (the target of the check)
 * @param {{
 *   actor_name: string,          who attempted the check (usually the PC)
 *   skill_name: string,
 *   ability_name: string,
 *   dc: number,
 *   total: number,
 *   d20: number,
 *   success: boolean,
 *   severity: string | null,
 *   crit: 'natural_20' | 'natural_1' | null,
 *   intent: string,
 * }} args
 * @returns {string}
 */
export function actorPostRollUserPrompt(ctx, character, args) {
    const lines = [];
    lines.push(`# Campaign: ${ctx.campaign?.name || ''}`);
    if (ctx.campaign?.brief) {
        lines.push(String(ctx.campaign.brief).trim());
    }
    lines.push('');

    if (ctx.scene) {
        lines.push('# Scene');
        const sceneName = ctx.scene.name || ctx.scene.id;
        lines.push(`- Name: ${sceneName}`);
        if (ctx.scene.location) lines.push(`- Location: ${ctx.scene.location}`);
        lines.push('');
    }

    if (ctx.recent_transcript && String(ctx.recent_transcript).trim()) {
        lines.push('# Recent transcript');
        lines.push(String(ctx.recent_transcript).trim());
        lines.push('');
    }

    if (ctx.memories_block && ctx.memories_block.trim()) {
        lines.push(ctx.memories_block.trim());
        lines.push('');
    }

    // The result is rendered in pure-fiction terms — no DC numbers, no
    // success flags. The actor LLM gets a succinct "what happened to you"
    // brief and reacts in character.
    lines.push(`# What just happened — ${args.actor_name} attempted: ${args.intent || '(an action against you)'}`);
    const verdict = args.crit === 'natural_20'
        ? `${args.actor_name} pulled it off brilliantly — a near-perfect attempt, hard to resist.`
        : args.crit === 'natural_1'
            ? `${args.actor_name} fumbled it badly — the attempt landed flat or worse.`
            : args.success
                ? `${args.actor_name} succeeded at the attempt.`
                : args.severity === 'severe' || args.severity === 'lethal'
                    ? `${args.actor_name} failed badly — you saw right through it (or it backfired hard).`
                    : `${args.actor_name} failed the attempt — it didn't land the way they hoped.`;
    lines.push(`- ${verdict}`);
    lines.push('');

    lines.push(`# Your reaction as ${character.name}`);
    lines.push('React now, in your own voice — your immediate words, body language, and any short action.');
    lines.push('Stay in character. Do NOT narrate the dice or mention numbers or DCs.');
    lines.push('Three or four sentences is plenty; one short paragraph at most.');
    lines.push(`Speak as ${character.name} now.`);
    return lines.join('\n');
}
