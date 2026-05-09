/**
 * Character + CharacterSheet schemas (Phase 2).
 *
 * Phase 2 ships descriptive characters: the wizard captures name + appearance
 * + personality + voice + background and seeds a 5e-baseline sheet. The
 * stats are not the focus of this phase; the descriptive fields drive
 * Director / Narrator prompts and seed the world. Full sheet editing arrives
 * in Phase 5/10 territory.
 */

/**
 * @typedef {Object} Item
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} influences  Stat keys this item informs; wiring lands in Phase 6+.
 */

/**
 * @typedef {Object} CharacterSheet
 * @property {Record<string, number | string>} stats
 * @property {Record<string, string>} statuses
 * @property {Item[]} items
 * @property {string[]} skills
 * @property {string} notes
 */

/**
 * @typedef {Object} Character
 * @property {string} id
 * @property {string} campaign_id
 * @property {string} name
 * @property {boolean} is_player
 * @property {string} appearance
 * @property {string} personality
 * @property {string} voice
 * @property {string} background
 * @property {CharacterSheet} sheet
 * @property {string | null} st_card_avatar  ST character card filename (e.g. `Jack.png`).
 * @property {string} created_at
 * @property {string} updated_at
 */

export const ABILITY_SCORES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

/** Default 5e baseline stats. */
export function defaultStats() {
    return {
        strength: 10,
        dexterity: 10,
        constitution: 10,
        intelligence: 10,
        wisdom: 10,
        charisma: 10,
        hp: 10,
        max_hp: 10,
        ac: 10,
        proficiency_bonus: 2,
        level: 1,
    };
}

/**
 * Build a fresh sheet, merging any caller overrides over the default stats.
 * @param {Partial<CharacterSheet>} [overrides]
 * @returns {CharacterSheet}
 */
export function defaultSheet(overrides = {}) {
    return {
        stats: { ...defaultStats(), ...(overrides.stats || {}) },
        statuses: { ...(overrides.statuses || {}) },
        items: Array.isArray(overrides.items) ? [...overrides.items] : [],
        skills: Array.isArray(overrides.skills) ? [...overrides.skills] : [],
        notes: typeof overrides.notes === 'string' ? overrides.notes : '',
    };
}

/**
 * Build a full Character record from wizard input.
 *
 * @param {Partial<Character> & { id: string, campaign_id: string, name: string }} input
 * @returns {Character}
 */
export function buildCharacter(input) {
    const now = new Date().toISOString();
    return {
        id: input.id,
        campaign_id: input.campaign_id,
        name: String(input.name).trim(),
        is_player: input.is_player ?? true,
        appearance: String(input.appearance ?? '').trim(),
        personality: String(input.personality ?? '').trim(),
        voice: String(input.voice ?? '').trim(),
        background: String(input.background ?? '').trim(),
        sheet: defaultSheet(input.sheet),
        st_card_avatar: input.st_card_avatar ?? null,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
    };
}

/**
 * Validate the user-facing portion of a Character create/update request.
 *
 * @param {Partial<Character>} body
 * @returns {string | null}
 */
export function validateCharacterInput(body) {
    if (!body || typeof body !== 'object') return 'request body required';
    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
            return 'name must be a non-empty string';
        }
        if (body.name.length > 80) return 'name longer than 80 chars';
    }
    for (const field of ['appearance', 'personality', 'voice', 'background']) {
        const value = /** @type {Record<string, unknown>} */(body)[field];
        if (value !== undefined && typeof value !== 'string') {
            return `${field} must be a string`;
        }
    }
    if (body.is_player !== undefined && typeof body.is_player !== 'boolean') {
        return 'is_player must be a boolean';
    }
    return null;
}
