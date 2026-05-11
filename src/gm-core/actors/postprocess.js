/**
 * Post-processing for actor/narrator prose returned by the LLM.
 *
 * The primary defence is prompt-side (cold-start primer turn, third-person
 * instruction wording), but local models occasionally echo the closing
 * instruction verbatim. This module strips known prompt fragments so they
 * never reach the player-visible transcript.
 */

/**
 * Strip known prompt-echo patterns from actor/narrator prose.
 *
 * @param {string} text  Raw prose from the LLM.
 * @param {{ name?: string }} [character]  The speaking character (for name-specific patterns).
 * @returns {string}  Cleaned prose.
 */
export function stripPromptEcho(text, character) {
    if (typeof text !== 'string') return '';
    let cleaned = text;

    const name = character?.name || '';

    // Strip leading <director_direction>...</director_direction> block
    cleaned = cleaned.replace(/^\s*<director_direction>[\s\S]*?<\/director_direction>\s*/i, '');

    // Strip fenced/code-block wrappers around echoed instructions
    // (must run BEFORE the bare-text strip so we remove the whole fence)
    cleaned = cleaned.replace(/\n*```(?:[^\n]*)?\n([\s\S]*?)\n```/g, (block, inner) => {
        if (/speak as .* now|write .*'s next beat now|stay in character/i.test(inner)) {
            return '';
        }
        return block;
    });

    // Strip the bare closing instruction text
    if (name) {
        const escaped = escapeRegExp(name);
        const patterns = [
            new RegExp(`\\s*Speak as ${escaped} now\\.\\s*Stay in character\\.\\s*`, 'gi'),
            new RegExp(`\\s*Write ${escaped}'s next beat now\\.\\s*Third person,\\s*present tense\\.\\s*`, 'gi'),
        ];
        for (const pat of patterns) {
            cleaned = cleaned.replace(pat, '');
        }
    }

    // Collapse double blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/** @param {string} s */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
