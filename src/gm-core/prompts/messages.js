/**
 * Multi-turn message builders for Actor and Narrator calls.
 *
 * Instead of a flat `{ system, user }` pair, these produce a
 * `ChatMessage[]` array where the recent transcript is rendered as
 * proper user/assistant turns. Each actor's own past lines become
 * `role: 'assistant'`, everything else becomes `role: 'user'`.
 *
 * Layout:
 *   [0]  system  — identity, voice rules, direction handling
 *   [1]  user    — campaign + scene + memories + sheet (context block)
 *   ...  alternating user/assistant transcript turns
 *   [N]  user    — <director_direction> + "Write {name}'s next beat now."
 */

import { actorSystemPrompt, actorUserPrompt } from '../actors/prompts.js';
import { narratorSystemPrompt, narratorUserPrompt } from '../narrator/prompts.js';
import { tag, TAGS } from './tags.js';
import { renderSheetYaml } from '../library/yaml.js';

/**
 * @typedef {{ name: string, mes: string, is_user?: boolean, is_system?: boolean, extra?: { role?: string, actor_id?: string } }} TranscriptLine
 * @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} ChatMessage
 */

/**
 * Build a multi-turn message array for an Actor call.
 *
 * @param {import('../director/prompts.js').TurnContext} ctx
 * @param {import('../library/schemas.js').Character} character
 * @param {string} intent
 * @returns {ChatMessage[]}
 */
export function buildActorMessages(ctx, character, intent) {
    const transcriptLines = ctx.transcript_lines;
    if (!Array.isArray(transcriptLines) || transcriptLines.length === 0) {
        return buildFallbackPair(
            actorSystemPrompt(ctx, character),
            actorUserPrompt(ctx, character, intent),
        );
    }

    const messages = [];

    messages.push({ role: 'system', content: actorSystemPrompt(ctx, character) });

    messages.push({ role: 'user', content: buildActorContextBlock(ctx, character) });

    const transcriptMessages = transcriptToTurns(transcriptLines, character.name);
    for (const m of transcriptMessages) messages.push(m);

    // Cold-start primer: when the speaker has no prior assistant turns in
    // the transcript, splice a synthetic one so the model doesn't echo the
    // final user-role instruction verbatim (common with local models).
    if (!transcriptMessages.some(m => m.role === 'assistant')) {
        messages.push({ role: 'assistant', content: '(ready)' });
    }

    const directionBody = intent && intent.trim() ? intent.trim() : '(react in character to the latest beat)';
    messages.push({
        role: 'user',
        content: `${tag(TAGS.director_direction, directionBody)}\n\nWrite ${character.name}'s next beat now. Third person, present tense.`,
    });

    return mergeAdjacentRoles(messages);
}

/**
 * Build a multi-turn message array for a Narrator call.
 *
 * @param {import('../director/prompts.js').TurnContext} ctx
 * @param {string} intent
 * @returns {ChatMessage[]}
 */
export function buildNarratorMessages(ctx, intent) {
    const transcriptLines = ctx.transcript_lines;
    if (!Array.isArray(transcriptLines) || transcriptLines.length === 0) {
        return buildFallbackPair(
            narratorSystemPrompt(),
            narratorUserPrompt(ctx, intent),
        );
    }

    const messages = [];

    messages.push({ role: 'system', content: narratorSystemPrompt() });

    messages.push({ role: 'user', content: buildNarratorContextBlock(ctx) });

    const transcriptMessages = transcriptToTurns(transcriptLines, 'Narrator');
    for (const m of transcriptMessages) messages.push(m);

    const directionBody = intent || '(narrate the beat)';
    messages.push({
        role: 'user',
        content: `${tag(TAGS.director_direction, directionBody)}\n\nWrite the narration prose now. No headers, no labels, no meta-commentary.`,
    });

    return mergeAdjacentRoles(messages);
}

/**
 * Build the context-only user message for an actor (no transcript, no direction).
 *
 * @param {import('../director/prompts.js').TurnContext} ctx
 * @param {import('../library/schemas.js').Character} character
 * @returns {string}
 */
function buildActorContextBlock(ctx, character) {
    const parts = [];

    const campaignLines = [ctx.campaign?.name || ''];
    if (ctx.campaign?.brief) campaignLines.push(String(ctx.campaign.brief).trim());
    parts.push(tag(TAGS.campaign, campaignLines.join('\n')));

    if (ctx.scene) {
        const sceneLines = [`Name: ${ctx.scene.name || ctx.scene.id}`];
        if (ctx.scene.location) sceneLines.push(`Location: ${ctx.scene.location}`);
        parts.push(tag(TAGS.scene, sceneLines.join('\n')));
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

    return parts.filter(Boolean).join('\n\n');
}

/**
 * Build the context-only user message for the narrator (no transcript, no direction).
 *
 * @param {import('../director/prompts.js').TurnContext} ctx
 * @returns {string}
 */
function buildNarratorContextBlock(ctx) {
    const parts = [];

    const campaignLines = [ctx.campaign.name];
    if (ctx.campaign.brief) campaignLines.push(ctx.campaign.brief.trim());
    parts.push(tag(TAGS.campaign, campaignLines.join('\n')));

    const sceneLines = [`Name: ${ctx.scene.name || ctx.scene.id}`];
    if (ctx.scene.location) sceneLines.push(`Location: ${ctx.scene.location}`);
    parts.push(tag(TAGS.scene, sceneLines.join('\n')));

    if (ctx.actors && ctx.actors.length) {
        const partyLines = [];
        for (const a of ctx.actors) {
            if (!a.is_player) continue;
            partyLines.push(`- **${a.name}**${a.appearance ? ` — ${a.appearance.slice(0, 240)}` : ''}`);
        }
        if (partyLines.length) parts.push(tag(TAGS.party, partyLines.join('\n')));
    }

    if (ctx.user_input && String(ctx.user_input).trim()) {
        parts.push(tag(TAGS.player_input, ctx.user_input || '(empty)'));
    }

    if (ctx.memories_block && ctx.memories_block.trim()) {
        parts.push(ctx.memories_block.trim());
    }

    return parts.filter(Boolean).join('\n\n');
}

/**
 * Convert a `TranscriptLine[]` into alternating user/assistant messages.
 *
 * @param {TranscriptLine[]} lines
 * @param {string} selfName  The name whose lines become `assistant`
 * @returns {ChatMessage[]}
 */
function transcriptToTurns(lines, selfName) {
    const messages = [];
    const normalizedSelf = selfName.toLowerCase();

    for (const ln of lines) {
        if (!ln || !ln.mes || !ln.mes.trim()) continue;
        if (ln.is_system) continue;

        const isSelf = ln.name && ln.name.toLowerCase() === normalizedSelf;
        if (isSelf) {
            messages.push({ role: 'assistant', content: ln.mes.trim() });
        } else {
            const prefix = ln.name ? `${ln.name}: ` : '';
            messages.push({ role: 'user', content: `${prefix}${ln.mes.trim()}` });
        }
    }

    return messages;
}

/**
 * Merge adjacent messages of the same role so the chat always alternates
 * cleanly (some providers require strict alternation).
 *
 * @param {ChatMessage[]} messages
 * @returns {ChatMessage[]}
 */
function mergeAdjacentRoles(messages) {
    if (messages.length <= 1) return messages;
    const merged = [messages[0]];
    for (let i = 1; i < messages.length; i++) {
        const prev = merged[merged.length - 1];
        if (messages[i].role === prev.role && messages[i].role !== 'system') {
            prev.content += '\n\n' + messages[i].content;
        } else {
            merged.push({ ...messages[i] });
        }
    }
    return merged;
}

/**
 * @param {string} system
 * @param {string} user
 * @returns {ChatMessage[]}
 */
function buildFallbackPair(system, user) {
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}
