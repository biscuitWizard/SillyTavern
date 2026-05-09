/**
 * World Narrator prompts.
 *
 * The Narrator is the prose voice of the world. The Director hands it an
 * `intent` (a one-sentence direction) plus the full TurnContext, and the
 * Narrator returns prose to render directly into the scene transcript.
 *
 * Phase 4 keeps the narrator deliberately minimal: no RAG retrieval, no
 * world-fact injection — just the campaign brief, scene frame, party, and
 * recent transcript tail.
 */

export function narratorSystemPrompt() {
    return [
        'You are the World Narrator for an interactive TTRPG.',
        '',
        'Voice:',
        '- Second-person present tense ("You step into the smoky tavern…").',
        '- Sensory and economical. Three to six sentences is a typical beat.',
        '- Avoid speaking for the player character\'s thoughts, choices, or dialog unless explicitly requested.',
        '- NPC dialog is fine when the Director\'s `intent` calls for it; mark it with quotation marks.',
        '',
        'Style rules:',
        '- Show, don\'t tell: prefer details (smell, sound, light, posture) to summary statements.',
        '- Stay in-fiction. Do not break the fourth wall, do not address the player as "user" or "you the user".',
        '- Do not narrate dice rolls, mechanics, or numbers unless the intent says to.',
        '- Do not ask "what do you do next?" at the end — the UI handles that affordance.',
    ].join('\n');
}

/**
 * @param {import('../director/prompts.js').TurnContext} ctx
 * @param {string} intent
 */
export function narratorUserPrompt(ctx, intent) {
    const lines = [];
    lines.push(`# Campaign: ${ctx.campaign.name}`);
    if (ctx.campaign.brief) {
        lines.push(ctx.campaign.brief.trim());
    }
    lines.push('');
    lines.push('# Scene');
    lines.push(`- Name: ${ctx.scene.name || ctx.scene.id}`);
    if (ctx.scene.location) lines.push(`- Location: ${ctx.scene.location}`);
    lines.push('');

    if (ctx.actors && ctx.actors.length) {
        lines.push('# Party');
        for (const a of ctx.actors) {
            if (!a.is_player) continue;
            lines.push(`- **${a.name}**${a.appearance ? ` — ${truncate(a.appearance, 240)}` : ''}`);
        }
        lines.push('');
    }

    if (ctx.recent_transcript && ctx.recent_transcript.trim()) {
        lines.push('# Recent transcript');
        lines.push(ctx.recent_transcript.trim());
        lines.push('');
    }

    lines.push('# Player\'s latest input');
    lines.push(ctx.user_input || '(empty)');
    lines.push('');
    lines.push('# Director intent for this beat');
    lines.push(intent || '(narrate the beat)');
    lines.push('');
    lines.push('Write the narration prose now. No headers, no labels, no meta-commentary.');
    return lines.join('\n');
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
    if (typeof s !== 'string') return '';
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
}
