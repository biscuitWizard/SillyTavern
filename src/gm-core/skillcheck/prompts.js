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
 * @param {import('../rulesets/schemas.d.ts').Ruleset} [ruleset]
 *   Optional. When provided, the user prompt repeats the valid `skill_id`
 *   and `failure_severity` enums verbatim so that text-mode JSON fallbacks
 *   (which bypass JSON-schema enum enforcement) still produce values that
 *   the engine validator will accept. The system prompt already lists
 *   them once; restating them in the user message makes the reminder the
 *   last thing the model reads.
 */
export function decideUserPrompt(intent, actorName, ruleset) {
    const lines = [
        `${actorName} attempts: ${intent || '(no intent given)'}`,
        '',
        'Decide: does the action need a check? If so, which skill, what DC, and',
        'what is at stake on failure?',
    ];
    if (ruleset) {
        const skills = (ruleset.skills || []).map((s) => s.id).join(', ');
        const severities = (ruleset.severities || []).map((s) => s.id).join(', ');
        lines.push('');
        lines.push('STRICT FORMAT — non-negotiable:');
        if (skills) {
            lines.push(`- \`skill_id\` MUST be one of: ${skills}. Lowercase, exact id. NEVER use display-name spellings like "Religion" or "Sleight of Hand" — those will be rejected.`);
        }
        if (severities) {
            lines.push(`- \`failure_severity\` MUST be one of: ${severities}.`);
        }
        lines.push('- If no skill in the list fits, set `required: false` instead of inventing one.');
    }
    return lines.join('\n');
}

