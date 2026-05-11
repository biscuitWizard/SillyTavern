/**
 * Shared XML-tag vocabulary for all GM-core prompt builders.
 *
 * Every prompt section uses these canonical tag names so models see a
 * consistent structure across Director, Narrator, Actor, Adjudicator,
 * scene-end, openings, ask, and plot prompts.
 */

export const TAGS = {
    campaign: 'campaign',
    scene: 'scene',
    actors: 'actors_in_scene',
    library: 'library_characters',
    recent: 'recent_transcript',
    player_input: 'player_input',
    sheet: 'character_sheet',
    director_direction: 'director_direction',
    world_lore: 'world_lore',
    character_memory: 'character_memory',
    director_memory: 'director_memory',
    narrator_memory: 'narrator_memory',
    player_journal: 'player_journal',
    party: 'party',
    transcript: 'transcript',
    situation: 'current_situation',
    scene_history: 'scene_history',
    player_character: 'player_character',
    identity: 'identity',
    previous_situation: 'previous_situation',
    scene_summary: 'scene_summary',
    character: 'character',
    ask_history: 'ask_history',
};

/**
 * Wrap `body` in a matching open/close XML tag pair.
 *
 * @param {string} name    Tag name (use a TAGS constant).
 * @param {string} body    Content between tags. Trimmed; empty body → empty string (no tag emitted).
 * @param {Record<string, string>} [attrs]  Optional key=value attributes on the opening tag.
 * @returns {string}
 */
export function tag(name, body, attrs) {
    const trimmed = (body || '').trim();
    if (!trimmed) return '';
    const attrStr = attrs
        ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')
        : '';
    return `<${name}${attrStr}>\n${trimmed}\n</${name}>`;
}
