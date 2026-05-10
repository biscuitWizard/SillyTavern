/**
 * Phase 8 — locked SceneSummary prompt + schema.
 *
 * One structured LLM call that turns a scene's transcript tail into:
 *   - a one-sentence headline,
 *   - a 3–6 sentence prose summary,
 *   - a small set of `key_events` (each becomes a `world_lore` record),
 *   - location and participant changes the world should remember.
 *
 * The system prompt is locked here for regression-testing — a unit test
 * asserts the SYSTEM constant contains key phrases so accidental edits
 * fail the build. Tune via the `best-of-n-runner` workflow against
 * `tests/gm-core/scenes/fixtures/summary-fixtures.js`, then re-pin the
 * regression keywords in lockstep.
 */

export const SCENE_SUMMARY_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'SceneSummary',
    type: 'object',
    properties: {
        headline: {
            type: 'string',
            description: 'One-sentence headline (max ~25 words). Concrete and noun-driven, not vague.',
        },
        summary: {
            type: 'string',
            description: '3–6 sentence prose summary in past tense, third-person.',
        },
        key_events: {
            type: 'array',
            description: 'Discrete events the world should remember. Each becomes a world_lore record.',
            items: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Single sentence, third-person past tense.' },
                    tags: { type: 'array', items: { type: 'string' } },
                    importance: { type: 'number', minimum: 0, maximum: 1 },
                },
                required: ['text', 'tags', 'importance'],
                additionalProperties: false,
            },
            maxItems: 8,
        },
        location_changes: {
            type: 'array',
            description: 'Locations entered, left, discovered, or destroyed during the scene.',
            items: { type: 'string' },
            maxItems: 8,
        },
        participant_changes: {
            type: 'array',
            description: 'Characters who entered or left the scene mid-way (not the starting roster).',
            items: { type: 'string' },
            maxItems: 8,
        },
    },
    required: ['headline', 'summary', 'key_events', 'location_changes', 'participant_changes'],
    additionalProperties: false,
};

export const SCENE_SUMMARY_SYSTEM_PROMPT = [
    'You are a tabletop scene summarizer. Read the transcript of a',
    'completed scene and produce a structured summary the campaign will',
    'use as long-term world memory.',
    '',
    'Voice and shape:',
    '- Headline: ONE sentence, concrete, naming the people and the stakes',
    '  ("Jack bargained with the steward for safe passage through the',
    '  Ironhold pass"). Avoid generic openers like "The party..." or',
    '  "A scene where...".',
    '- Summary: 3–6 sentences, third-person past tense. Cover what',
    '  happened, who chose what, and how it ended. No spoilers, no',
    '  speculation about future scenes.',
    '- Key events: discrete things the world should remember (a vow',
    '  spoken aloud, a doorway opened, a body left behind, a fact',
    '  revealed). Each is ONE past-tense sentence. Importance:',
    '  0.4 routine, 0.6 meaningful, 0.8+ scene-defining. Skip filler.',
    '- Location changes: places entered, left, discovered, or destroyed.',
    '  Skip locations that were merely mentioned but never visited.',
    '- Participant changes: characters who joined or left mid-scene.',
    '  Do NOT list the starting roster.',
    '',
    'Hard rules:',
    '- Stay strictly inside the transcript. Do not invent details that',
    '  are not on the page.',
    '- Do not narrate dice mechanics ("rolled a 17"). Narrate the',
    '  outcome ("cleared the gap").',
    '- Empty arrays are fine. Output JSON only.',
].join('\n');

/**
 * Build the user-facing prompt body for the summary call.
 *
 * @param {{
 *   campaign: { name?: string, brief?: string },
 *   scene: { id: string, name?: string, location?: string, started_at?: string },
 *   participants: Array<{ id: string, name: string, is_player?: boolean }>,
 *   transcriptTail: string,
 * }} ctx
 */
export function buildSummaryUser(ctx) {
    const lines = [];
    lines.push(`Campaign: ${ctx.campaign?.name || 'Untitled'}`);
    if (ctx.campaign?.brief) {
        lines.push(`Brief: ${truncate(ctx.campaign.brief, 600)}`);
    }
    lines.push('');
    lines.push(`Scene: ${ctx.scene?.name || ctx.scene?.id || 'Untitled scene'}`);
    if (ctx.scene?.location) lines.push(`Starting location: ${ctx.scene.location}`);
    if (ctx.scene?.started_at) lines.push(`Started: ${ctx.scene.started_at}`);

    const roster = (ctx.participants || [])
        .map(p => p.is_player ? `${p.name} (PC)` : p.name)
        .filter(Boolean);
    if (roster.length > 0) {
        lines.push(`Starting roster: ${roster.join(', ')}`);
    }

    lines.push('');
    lines.push('Transcript:');
    lines.push((ctx.transcriptTail || '').trim() || '(empty transcript)');
    lines.push('');
    lines.push('Produce the SceneSummary JSON. Stay strictly inside the transcript.');
    return lines.join('\n');
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
