/**
 * Character + CharacterSheet schemas (Phase 2; KV-stat refactor in Phase 5).
 *
 * The sheet is a flat key-value bag, ported from `srstavern`'s model:
 *
 *   - `stats` — generic key/value store. Any JSON-serializable scalar. Keys
 *     are agreed by convention (e.g. `strength`, `hp`, `max_hp`, `ac`,
 *     `proficiency_bonus`, `level`) but never pinned by this schema. The
 *     starter pack at create time comes from the campaign's
 *     `ruleset_id` via `gm-core/rulesets/index.js`, not from this module.
 *   - `statuses` — first-class but key-value as well.
 *   - `items` — free-form list of `Item` records.
 *   - `skills` — list of skill ids the character is proficient in.
 *   - `notes` — free-form text.
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

/**
 * Build a fresh sheet. Phase 5 makes this purely additive — no stat keys are
 * seeded by default. The caller (the create endpoint) seeds `stats` and
 * `skills` from the active campaign's ruleset before invoking this helper.
 *
 * @param {Partial<CharacterSheet>} [overrides]
 * @returns {CharacterSheet}
 */
export function defaultSheet(overrides = {}) {
    return {
        stats: { ...(overrides.stats || {}) },
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
    if (body.sheet !== undefined) {
        if (!body.sheet || typeof body.sheet !== 'object' || Array.isArray(body.sheet)) {
            return 'sheet must be an object';
        }
        if (body.sheet.stats !== undefined && (typeof body.sheet.stats !== 'object' || Array.isArray(body.sheet.stats) || body.sheet.stats === null)) {
            return 'sheet.stats must be an object';
        }
        if (body.sheet.statuses !== undefined && (typeof body.sheet.statuses !== 'object' || Array.isArray(body.sheet.statuses) || body.sheet.statuses === null)) {
            return 'sheet.statuses must be an object';
        }
        if (body.sheet.skills !== undefined && !Array.isArray(body.sheet.skills)) {
            return 'sheet.skills must be an array';
        }
    }
    return null;
}
