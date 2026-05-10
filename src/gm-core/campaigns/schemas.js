/**
 * Campaign schema (Phase 1).
 *
 * Canonical state lives at
 * `{handle}/campaigns/{campaign_id}/campaign.json` per ADR 0003.
 *
 * Type definitions are JSDoc here and TypeScript in the sibling .d.ts so
 * downstream modules can `import('./schemas.js').Campaign` for inline types.
 */

/**
 * Banner themes the Campaign Manager renders. `default` is a neutral fallback
 * shown when no theme is set. The string is stored verbatim and looked up by
 * the `gm-campaign-banner.theme-{theme}` CSS class.
 *
 * @typedef {'shadows' | 'frontier' | 'hollow' | 'default'} BannerTheme
 */

/**
 * @typedef {Object} CurrentSituation
 * @property {string} recap - 2-4 sentences summarising "where things stand".
 * @property {string} location - Free-form, e.g. "The Black Boar inn, Faldenport".
 * @property {string} time - Free-form, e.g. "Dawn, the day after the bandit raid".
 * @property {string[]} nearby_characters - Names or ids of NPCs co-located with the PC.
 * @property {string} updated_at - ISO 8601.
 * @property {'chargen' | 'scene_end' | 'manual'} source
 */

/**
 * @typedef {Object} Campaign
 * @property {string} id - Slug; doubles as the campaign directory name.
 * @property {string} name
 * @property {string} brief - Short pitch (<= 280 chars).
 * @property {string} ruleset_id - e.g. `dnd5e`. Phase 6 wires real ruleset loading.
 * @property {string} lore_pack_id - Bundled lore pack applied at creation, or empty string when none.
 * @property {string} addendum - GM addendum injected into Director system prompts.
 * @property {BannerTheme} banner_theme
 * @property {string | null} current_scene_id - Set when a scene is active.
 * @property {CurrentSituation | null} current_situation - "Where the player is right now"; seeded at chargen, refreshed at scene end. Drives Campaign Main + Plot/Ask grounding.
 * @property {string | null} last_played_at - ISO 8601, null when never opened.
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * HTTP response shape used by the Campaign Manager grid.
 *
 * @typedef {Object} CampaignSummary
 * @property {string} id
 * @property {string} name
 * @property {string} brief
 * @property {string} ruleset_id
 * @property {string} lore_pack_id
 * @property {BannerTheme} banner_theme
 * @property {string | null} last_played_at
 * @property {number} scene_count
 */

/** @type {BannerTheme[]} */
export const BANNER_THEMES = ['shadows', 'frontier', 'hollow', 'default'];

export const CAMPAIGN_BRIEF_MAX = 280;
export const CAMPAIGN_NAME_MAX = 80;
export const SITUATION_RECAP_MAX = 1200;
export const SITUATION_LOCATION_MAX = 240;
export const SITUATION_TIME_MAX = 120;
export const SITUATION_NEARBY_MAX = 12;
export const SITUATION_NEARBY_NAME_MAX = 80;

/** @type {ReadonlyArray<'chargen' | 'scene_end' | 'manual'>} */
export const CURRENT_SITUATION_SOURCES = ['chargen', 'scene_end', 'manual'];

/**
 * Normalise + clamp a CurrentSituation payload. Returns `null` when the
 * input is not an object so callers can pass `null` through unchanged.
 *
 * @param {Partial<import('./schemas.js').CurrentSituation> | null | undefined} input
 * @returns {import('./schemas.js').CurrentSituation | null}
 */
export function buildCurrentSituation(input) {
    if (!input || typeof input !== 'object') return null;
    const recap = typeof input.recap === 'string' ? input.recap.trim().slice(0, SITUATION_RECAP_MAX) : '';
    const location = typeof input.location === 'string' ? input.location.trim().slice(0, SITUATION_LOCATION_MAX) : '';
    const time = typeof input.time === 'string' ? input.time.trim().slice(0, SITUATION_TIME_MAX) : '';
    const nearby = Array.isArray(input.nearby_characters)
        ? input.nearby_characters
            .map(n => typeof n === 'string' ? n.trim().slice(0, SITUATION_NEARBY_NAME_MAX) : '')
            .filter(Boolean)
            .slice(0, SITUATION_NEARBY_MAX)
        : [];
    /** @type {'chargen' | 'scene_end' | 'manual'} */
    const source = CURRENT_SITUATION_SOURCES.includes(/** @type {any} */(input.source))
        ? /** @type {any} */(input.source)
        : 'manual';
    return {
        recap,
        location,
        time,
        nearby_characters: nearby,
        updated_at: typeof input.updated_at === 'string' ? input.updated_at : new Date().toISOString(),
        source,
    };
}

/**
 * Build a fresh campaign record, filling defaults for any unspecified field.
 * Caller is responsible for choosing `id`.
 *
 * @param {Partial<Campaign> & { id: string, name: string }} input
 * @returns {Campaign}
 */
export function buildCampaign(input) {
    const now = new Date().toISOString();
    /** @type {BannerTheme} */
    const banner = BANNER_THEMES.includes(/** @type {BannerTheme} */(input.banner_theme))
        ? /** @type {BannerTheme} */(input.banner_theme)
        : 'default';
    return {
        id: input.id,
        name: String(input.name).trim().slice(0, CAMPAIGN_NAME_MAX),
        brief: String(input.brief ?? '').trim().slice(0, CAMPAIGN_BRIEF_MAX),
        ruleset_id: String(input.ruleset_id ?? 'dnd5e'),
        lore_pack_id: String(input.lore_pack_id ?? ''),
        addendum: String(input.addendum ?? ''),
        banner_theme: banner,
        current_scene_id: input.current_scene_id ?? null,
        current_situation: buildCurrentSituation(input.current_situation ?? null),
        last_played_at: input.last_played_at ?? null,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
    };
}

/**
 * Validate the user-supplied portion of a campaign create/update request.
 * Returns `null` when valid; an error message string otherwise.
 *
 * @param {Partial<Campaign>} body
 * @returns {string | null}
 */
export function validateCampaignInput(body) {
    if (!body || typeof body !== 'object') return 'request body required';
    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
            return 'name must be a non-empty string';
        }
        if (body.name.length > CAMPAIGN_NAME_MAX) {
            return `name longer than ${CAMPAIGN_NAME_MAX} chars`;
        }
    }
    if (body.brief !== undefined && typeof body.brief !== 'string') {
        return 'brief must be a string';
    }
    if (body.brief && body.brief.length > CAMPAIGN_BRIEF_MAX) {
        return `brief longer than ${CAMPAIGN_BRIEF_MAX} chars`;
    }
    if (body.ruleset_id !== undefined && typeof body.ruleset_id !== 'string') {
        return 'ruleset_id must be a string';
    }
    if (body.banner_theme !== undefined && !BANNER_THEMES.includes(/** @type {BannerTheme} */(body.banner_theme))) {
        return `banner_theme must be one of: ${BANNER_THEMES.join(', ')}`;
    }
    if (body.addendum !== undefined && typeof body.addendum !== 'string') {
        return 'addendum must be a string';
    }
    return null;
}
