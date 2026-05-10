/**
 * Skill-check + post-roll-narrator prompts.
 *
 * `decideSystemPrompt(ruleset)` and `decideUserPrompt(intent, actorName)`
 * are ported from the strict-by-default text in
 * `srstavern/sidecar/srstavern/skillcheck/engine.py` (the prior-art Python
 * sidecar). The adjudicator NEVER sees character memories or world facts —
 * structured-output only. See DESIGN.md "Memory injection rules".
 *
 * Phase 7 invariant: this module MUST NOT import from `../rag/`. The
 * `rag-isolation.test.js` suite reads this file's text and fails the
 * build if the import line ever sneaks in. The only exception in the
 * skillcheck dir is the post-roll narrator helper (`narratorPostRollUserPrompt`)
 * which intentionally does receive the narrator-side MEMORIES block — but
 * that block is built by the caller, not imported here.
 *
 * `narratorPostRollUserPrompt(ctx, outcome)` frames the prose as the direct
 * consequence of the roll. The system prompt re-uses the standard
 * `narratorSystemPrompt()`; we just give the user prompt extra context about
 * the result so the prose lands as fiction-of-consequence rather than
 * generic narration.
 */

/**
 * @param {import('../rulesets/schemas.d.ts').Ruleset} ruleset
 */
export function decideSystemPrompt(ruleset) {
    const skills = (ruleset.skills || []).map((s) => s.id).join(', ');
    const severities = (ruleset.severities || []).map((s) => s.id).join(', ') || 'minor, moderate, severe, lethal';
    const bands = (ruleset.dc_bands || []).length
        ? (ruleset.dc_bands || []).map((b) => `  - ${b.label} (DC ${b.dc}): ${b.description}`).join('\n')
        : '  (no bands defined)';

    return [
        `You are the rules adjudicator for a ${ruleset.id} tabletop scene.`,
        '',
        'Decide whether the actor\'s stated intent requires a skill check and, if',
        'so, return the skill, the DC, and the failure severity. Output JSON',
        'matching the schema you\'ve been given. Do not write prose.',
        '',
        `Available skills: ${skills}.`,
        `Failure severities: ${severities}.`,
        '',
        'DC ladder:',
        bands,
        '',
        'STRICT-PLAY RULES — non-negotiable:',
        '  - Pick the *most appropriate* skill, not the most favorable for the',
        '    actor. If the intent involves threatening someone, that is',
        '    Intimidation even if framed as Persuasion. Pick the skill that',
        '    fits the fiction.',
        '  - Set the DC from the ladder above. Do NOT lower the DC because the',
        '    actor has attempted this before, framed it dramatically, asked for',
        '    a break, or because the action is "cool". The DC is a property of',
        '    the world, not of anyone\'s mood.',
        '  - If the action would have a real consequence, call for a check —',
        '    even if the action is dramatic, narratively pivotal, or heroic.',
        '    "I leap from the rooftop to grab the dragon\'s tail" is an',
        '    Athletics check at a very high DC with severe-to-lethal stakes.',
        '    You do not flinch.',
        '  - Match the failure severity to the fictional consequence. A lethal',
        '    stake stays lethal even when the moment is dramatic. Do not soften',
        '    stakes for narrative comfort.',
        '  - If no check is genuinely needed (e.g. opening an unlocked door,',
        '    walking across a flat empty room), set required=false with a',
        '    one-sentence reason in `justification`. Do not stretch this —',
        '    uncertain stakes require a check.',
        '  - Re-attempts: if the actor retries the same action, the DC does',
        '    NOT drop. If anything it stays the same or goes up (the situation',
        '    usually got worse). Demand an in-fiction reason for the retry.',
        '',
        'You are the rules; the actors are in the world. Adjudicate honestly.',
        'Be slightly adversarial. Be uncompromising.',
        '',
        'When required=false, set skill_id, ability_id, dc, and failure_severity',
        'to null. Always include a one-sentence justification.',
    ].join('\n');
}

/**
 * @param {string} intent
 * @param {string} actorName
 */
export function decideUserPrompt(intent, actorName) {
    return [
        `${actorName} attempts: ${intent || '(no intent given)'}`,
        '',
        'Decide: does the action need a check? If so, which skill, what DC, and',
        'what is at stake on failure?',
    ].join('\n');
}

/**
 * Narrator user-prompt for the post-roll beat. The Narrator system prompt
 * stays the same; this user-side text frames the prose as the consequence of
 * the dice that just landed. Mirrors DESIGN.md's "the Narrator describes the
 * consequence (Jack falls, takes damage)..." narrative.
 *
 * @param {import('../director/prompts.js').TurnContext} ctx
 * @param {{
 *   actor_name: string,
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
 */
export function narratorPostRollUserPrompt(ctx, args) {
    const lines = [];
    lines.push(`# Campaign: ${ctx.campaign?.name || ''}`);
    if (ctx.campaign?.brief) {
        lines.push(String(ctx.campaign.brief).trim());
    }
    lines.push('');
    lines.push('# Scene');
    lines.push(`- Name: ${ctx.scene?.name || ctx.scene?.id || ''}`);
    if (ctx.scene?.location) lines.push(`- Location: ${ctx.scene.location}`);
    lines.push('');

    if (ctx.recent_transcript && ctx.recent_transcript.trim()) {
        lines.push('# Recent transcript');
        lines.push(ctx.recent_transcript.trim());
        lines.push('');
    }

    lines.push('# What just happened — the roll');
    lines.push(`- Actor: ${args.actor_name}`);
    lines.push(`- Intent: ${args.intent || '(unspecified)'}`);
    lines.push(`- Check: ${args.skill_name} (${args.ability_name}) vs DC ${args.dc}`);
    lines.push(`- Result: d20=${args.d20}, total=${args.total} → ${args.success ? 'SUCCESS' : 'FAILURE'}`);
    if (args.crit === 'natural_20') lines.push('- This was a NATURAL 20 — describe it accordingly.');
    if (args.crit === 'natural_1') lines.push('- This was a NATURAL 1 — describe it accordingly.');
    if (!args.success && args.severity) {
        lines.push(`- Failure severity: ${args.severity} — match the fictional consequence to this stake.`);
    }
    lines.push('');

    lines.push('Narrate the immediate consequence in the world. Do not narrate the dice');
    lines.push('themselves — translate the result into fiction (what the actor sees, hears,');
    lines.push('feels; what the world does in response). Three to six sentences.');
    lines.push('Stay in-fiction. No mechanics, no numbers, no fourth wall.');
    return lines.join('\n');
}
