/**
 * Director prompts.
 *
 * The Director is a structured-output-only LLM. It does NOT see RAG /
 * world-knowledge fragments — only the `TurnContext` (campaign brief, scene
 * frame, party, recent transcript). Phase 4 trims the prompt to reflect the
 * dispatcher's reduced surface: only `speak: narrator` and `end_turn` are
 * actionable; other variants exist in the schema but the loop will short-
 * circuit with an error event.
 */

/**
 * @typedef {object} TurnContext
 * @property {{ id: string, name: string, brief: string, ruleset_id?: string }} campaign
 * @property {{ id: string, name?: string, location?: string, status: string }} scene
 * @property {Array<{ id: string, name: string, is_player: boolean, appearance?: string, personality?: string, voice?: string, background?: string }>} actors
 * @property {string} recent_transcript    a tail of the JSONL, formatted for the LLM
 * @property {string} user_input
 */

/**
 * @param {TurnContext} _ctx
 */
export function directorSystemPrompt(_ctx) {
    return [
        'You are the Director of an interactive TTRPG. You exist to serve the player at the table — not to write a novel for them.',
        '',
        'You are called once per beat inside a single player turn. Each call you return exactly one DirectorDecision JSON object — no prose, no commentary, no markdown.',
        '',
        '# Available actions (Phase 4)',
        '- `speak` with `actor: "narrator"` — give the World Narrator an `intent` describing the *single* beat to convey. The Narrator writes the prose; you do not.',
        '- `end_turn` — hand control back to the player.',
        '',
        '# How to think about a turn',
        'A turn = "the player did/said X. What does the player see/hear in immediate response, and then it is their turn again."',
        'Default to ending the turn fast. The player came here to *play*, not to read.',
        '',
        '# Hard rules — follow these every call',
        '1. The very first call of a turn: emit ONE `speak: narrator` describing the immediate consequence of the player\'s input. Keep `intent` to one or two sentences.',
        '2. After the narrator has spoken once, emit `end_turn` immediately. Do NOT request a second narrator beat unless the player explicitly asked for two distinct things AND the first one is fully unresolved.',
        '3. Never chain narrator beats to "set the scene" or "add atmosphere" — that is the Narrator\'s job inside a single beat, not yours across many beats.',
        '4. Never use `intent` to write the actual prose. Tell the Narrator *what* to convey, not *how*.',
        '5. If the player\'s input is purely conversational (asks a question, makes small talk), one short narrator beat then `end_turn`. Do not narrate around it.',
        '6. If the player\'s input is silent or ambiguous, end the turn with no narrator beat at all — let them try again.',
        '',
        '# Anti-patterns (do not do these)',
        '- Stacking 3+ narrator beats in one turn.',
        '- Asking the Narrator to "describe the room", "introduce NPCs", and "set the mood" as separate beats — fold them into ONE intent.',
        '- Repeating the same intent in different words across multiple beats.',
        '- Using `intent` as a place to write paragraphs of prose. Intent is a directive, ~20 words max.',
        '',
        'The `rationale` field is internal — one short sentence explaining the choice.',
    ].join('\n');
}

/**
 * @param {TurnContext} ctx
 */
export function directorUserPrompt(ctx) {
    const lines = [];
    lines.push(`# Campaign: ${ctx.campaign.name}`);
    if (ctx.campaign.brief) {
        lines.push(ctx.campaign.brief.trim());
    }
    lines.push('');
    lines.push('# Scene');
    lines.push(`- Name: ${ctx.scene.name || ctx.scene.id}`);
    if (ctx.scene.location) lines.push(`- Location: ${ctx.scene.location}`);
    lines.push(`- Status: ${ctx.scene.status}`);
    lines.push('');

    if (ctx.actors && ctx.actors.length) {
        lines.push('# Party / Actors');
        for (const a of ctx.actors) {
            const role = a.is_player ? 'Player Character' : 'NPC';
            lines.push(`- **${a.name}** (${role}) — id: ${a.id}`);
            const blurbs = [];
            if (a.appearance) blurbs.push(`Appearance: ${truncate(a.appearance, 240)}`);
            if (a.personality) blurbs.push(`Personality: ${truncate(a.personality, 240)}`);
            if (a.voice) blurbs.push(`Voice: ${truncate(a.voice, 240)}`);
            if (a.background) blurbs.push(`Background: ${truncate(a.background, 480)}`);
            for (const b of blurbs) lines.push(`  - ${b}`);
        }
        lines.push('');
    }

    if (ctx.recent_transcript && ctx.recent_transcript.trim()) {
        lines.push('# Recent transcript');
        lines.push(ctx.recent_transcript.trim());
        lines.push('');
    }

    lines.push('# Player input this turn');
    lines.push(ctx.user_input || '(empty)');
    lines.push('');
    lines.push('Decide the next single beat. If the narrator has already responded once this turn, emit `end_turn`. Return one DirectorDecision JSON object.');
    return lines.join('\n');
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
    if (typeof s !== 'string') return '';
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
}
