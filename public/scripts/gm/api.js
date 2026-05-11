/**
 * Thin fetch wrapper for the GM core's `/api/gm/*` HTTP surface.
 *
 * All requests reuse SillyTavern's `getRequestHeaders()` so the CSRF token and
 * session cookies get attached transparently. Methods return parsed JSON;
 * non-2xx responses throw an `Error` whose `.status` and `.body` mirror the
 * server reply.
 */

import { getRequestHeaders } from '../../script.js';

const BASE = '/api/gm';

/**
 * @typedef {import('../../../src/gm-core/campaigns/schemas.d.ts').Campaign} Campaign
 * @typedef {import('../../../src/gm-core/campaigns/schemas.d.ts').CampaignSummary} CampaignSummary
 */

class GmApiError extends Error {
    /**
     * @param {number} status
     * @param {string} message
     * @param {unknown} body
     */
    constructor(status, message, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

/**
 * Issue a JSON request to `/api/gm/<path>` and return the parsed response.
 * Throws a `GmApiError` on non-2xx.
 *
 * @param {string} pathSuffix
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(pathSuffix, init = {}) {
    const url = `${BASE}${pathSuffix}`;
    const headers = { ...getRequestHeaders(), ...(init.headers || {}) };
    const response = await fetch(url, { ...init, headers });
    if (response.status === 204) return null;

    let body = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        body = await response.json().catch(() => null);
    } else {
        body = await response.text().catch(() => null);
    }

    if (!response.ok) {
        const message = (body && typeof body === 'object' && body.error) || `${url} ${response.status}`;
        throw new GmApiError(response.status, message, body);
    }
    return body;
}

/* -------- Rulesets (Phase 5) -------- */

/** @returns {Promise<Array<{ id: string, name: string, source: 'user' | 'bundled' | 'fallback' }>>} */
export async function listRulesets() {
    const out = await request('/rulesets');
    return out?.rulesets ?? [];
}

/**
 * @param {string} rulesetId
 * @returns {Promise<{ id: string, name: string, starter_stats: Record<string, number | string>, starter_skills: string[] } | null>}
 */
export async function getRuleset(rulesetId) {
    try {
        const out = await request(`/rulesets/${encodeURIComponent(rulesetId)}`);
        return out?.ruleset ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

/**
 * Fetch only the merged sheet layout (M1) for the requested ruleset.
 * Returns `null` when the ruleset has no layout on disk so callers can
 * fall back to the legacy flat-KV editor without crashing.
 *
 * @param {string} rulesetId
 * @returns {Promise<import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout | null>}
 */
export async function getSheetLayout(rulesetId) {
    try {
        const out = await request(`/rulesets/${encodeURIComponent(rulesetId)}/sheet-layout`);
        return out?.sheet_layout ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

/* -------- Campaigns -------- */

/** @returns {Promise<CampaignSummary[]>} */
export async function listCampaigns() {
    const out = await request('/campaigns');
    return out?.campaigns ?? [];
}

/**
 * @param {string} id
 * @returns {Promise<Campaign | null>}
 */
export async function getCampaign(id) {
    try {
        const out = await request(`/campaigns/${encodeURIComponent(id)}`);
        return out?.campaign ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

/**
 * @param {Partial<Campaign> & { name: string }} body
 * @returns {Promise<Campaign>}
 */
export async function createCampaign(body) {
    const out = await request('/campaigns', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    return out.campaign;
}

/**
 * @param {string} id
 * @param {Partial<Campaign>} patch
 * @returns {Promise<Campaign>}
 */
export async function patchCampaign(id, patch) {
    const out = await request(`/campaigns/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
    return out.campaign;
}

/** @param {string} id */
export async function deleteCampaign(id) {
    await request(`/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* -------- Current situation / opening (chargen + scene-end recap) -------- */

/**
 * Replace the campaign's `current_situation` snapshot. Pass `null` to
 * clear it, or a partial CurrentSituation object. The server normalises
 * the payload via `buildCurrentSituation` and stamps `source: 'manual'`.
 *
 * @param {string} campaignId
 * @param {{ recap?: string, location?: string, time?: string, nearby_characters?: string[] } | null} situation
 * @returns {Promise<{ campaign: Campaign, current_situation: any }>}
 */
export async function patchCurrentSituation(campaignId, situation) {
    return request(`/campaigns/${encodeURIComponent(campaignId)}/current-situation`, {
        method: 'PATCH',
        body: JSON.stringify(situation),
    });
}

/**
 * (Re-)generate the opening "where things stand" snapshot. Used by Campaign
 * Main as a fallback when the chargen-time synth failed or as a manual
 * regenerate.
 *
 * @param {string} campaignId
 * @param {{ director_profile: object }} options
 * @returns {Promise<{ campaign: Campaign, current_situation: any }>}
 */
export async function generateOpening(campaignId, options) {
    if (!options || !options.director_profile) {
        throw new Error('generateOpening requires a director_profile');
    }
    return request(`/campaigns/${encodeURIComponent(campaignId)}/opening`, {
        method: 'POST',
        body: JSON.stringify({ director_profile: options.director_profile }),
    });
}

/* -------- Characters (Phase 2) -------- */

/** @param {string} campaignId */
export async function listCharacters(campaignId) {
    const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/characters`);
    return out?.characters ?? [];
}

/**
 * Create a character. When the body includes `director_profile` AND this
 * is the freshly-created PC for a campaign with no `current_situation`
 * yet, the server will (best-effort) synthesise the opening snapshot in
 * the same request. Caller may inspect `response.opening` for the
 * generated payload (or `opening_error` when synth failed).
 *
 * @param {string} campaignId
 * @param {object} body
 * @returns {Promise<{ character: any, opening: any, opening_error: string | null }>}
 */
export async function createCharacter(campaignId, body) {
    const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/characters`, {
        method: 'POST',
        body: JSON.stringify(body),
    });
    return {
        character: out.character,
        opening: out.opening ?? null,
        opening_error: out.opening_error ?? null,
    };
}

/** @param {string} characterId */
export async function getCharacter(characterId) {
    try {
        const out = await request(`/characters/${encodeURIComponent(characterId)}`);
        return out?.character ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

/** @param {string} characterId */
export async function deleteCharacter(characterId) {
    await request(`/characters/${encodeURIComponent(characterId)}`, { method: 'DELETE' });
}

/**
 * @param {string} characterId
 * @param {Partial<import('../../../src/gm-core/library/schemas.d.ts').Character>} patch
 */
export async function patchCharacter(characterId, patch) {
    const out = await request(`/characters/${encodeURIComponent(characterId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
    return out?.character ?? null;
}

/**
 * Build the portrait URL for a campaign character. The URL includes a
 * cache-busting `v` parameter derived from `updated_at` so the browser
 * re-fetches after identity or portrait changes.
 *
 * @param {{ id: string, campaign_id: string, has_portrait?: boolean, updated_at?: string }} character
 * @returns {string}
 */
export function getPortraitUrl(character) {
    if (!character || !character.campaign_id || !character.id) return '/img/gm/portrait-default.png';
    const base = `${BASE}/campaigns/${encodeURIComponent(character.campaign_id)}/characters/${encodeURIComponent(character.id)}/portrait`;
    const bust = character.updated_at ? `?v=${encodeURIComponent(character.updated_at)}` : '';
    return character.has_portrait !== false ? `${base}${bust}` : '/img/gm/portrait-default.png';
}

/**
 * Upload a portrait image for a character.
 *
 * @param {string} campaignId
 * @param {string} characterId
 * @param {Blob | File} imageBlob
 */
export async function uploadPortrait(campaignId, characterId, imageBlob) {
    const url = `${BASE}/campaigns/${encodeURIComponent(campaignId)}/characters/${encodeURIComponent(characterId)}/portrait`;
    const headers = getRequestHeaders();
    delete headers['Content-Type'];
    const contentType = imageBlob.type || 'image/png';
    headers['Content-Type'] = contentType;
    const buffer = await imageBlob.arrayBuffer();
    const response = await fetch(url, { method: 'PUT', headers, body: buffer });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new GmApiError(response.status, text || `${url} ${response.status}`, text);
    }
    return response.json();
}

/**
 * Atomic setter for a single identity field.
 *
 * @param {string} characterId
 * @param {'appearance'|'personality'|'voice'|'background'|'name'} field
 * @param {string} value
 * @returns {Promise<any>} updated character
 */
export async function setIdentityField(characterId, field, value) {
    const out = await request(`/characters/${encodeURIComponent(characterId)}/identity/${encodeURIComponent(field)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
    });
    return out?.character ?? null;
}

/* -------- Scenes (Phase 3) -------- */

/** @param {string} campaignId */
export async function listScenes(campaignId) {
    const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/scenes`);
    return out?.scenes ?? [];
}

/**
 * @param {string} campaignId
 * @param {{ name?: string, location?: string }} [body]
 */
export async function createScene(campaignId, body = {}) {
    const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/scenes`, {
        method: 'POST',
        body: JSON.stringify(body),
    });
    return out.scene;
}

/** @param {string} sceneId */
export async function getScene(sceneId) {
    try {
        const out = await request(`/scenes/${encodeURIComponent(sceneId)}`);
        return out?.scene ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

/**
 * @param {string} sceneId
 * @param {number} [after]
 */
export async function getSceneTranscript(sceneId, after = 0) {
    const out = await request(`/scenes/${encodeURIComponent(sceneId)}/transcript?after=${after}`);
    return out?.lines ?? [];
}

/**
 * @param {string} sceneId
 * @param {{ name: string, mes: string, is_user: boolean, force_avatar?: string, extra?: object }} line
 */
export async function appendSceneMessage(sceneId, line) {
    const out = await request(`/scenes/${encodeURIComponent(sceneId)}/messages`, {
        method: 'POST',
        body: JSON.stringify(line),
    });
    return out;
}

/**
 * Edit the body text of a single transcript line by 0-based index. The
 * server treats the same index as `mesid` because scene mode replays
 * the JSONL into ST's `chat[]` array 1:1.
 *
 * @param {string} sceneId
 * @param {number} lineIndex
 * @param {string} mes
 * @returns {Promise<{ line: any, scene: any }>}
 */
export async function editSceneMessage(sceneId, lineIndex, mes) {
    return request(`/scenes/${encodeURIComponent(sceneId)}/messages/${encodeURIComponent(String(lineIndex))}`, {
        method: 'PUT',
        body: JSON.stringify({ mes: typeof mes === 'string' ? mes : '' }),
    });
}

/**
 * Delete a single transcript line. The server best-effort cascades any
 * RAG records derived from that line (opinion-extractor character
 * memories + narrator-continuity); the response carries a
 * `cascade.removed` count + any per-record errors.
 *
 * @param {string} sceneId
 * @param {number} lineIndex
 * @returns {Promise<{ removed: any, scene: any, cascade: { attempted: boolean, removed: number, errors: string[] } }>}
 */
export async function deleteSceneMessage(sceneId, lineIndex) {
    return request(`/scenes/${encodeURIComponent(sceneId)}/messages/${encodeURIComponent(String(lineIndex))}`, {
        method: 'DELETE',
    });
}

/**
 * Regenerate the AI-side beats following the most-recent player input
 * at-or-before `lineIndex`. The transcript is truncated to that player
 * line (everything after is dropped) and a fresh Director turn is run
 * with the same player input. Returns the raw `Response` so callers can
 * stream the NDJSON body via `consumeTurnStream` exactly like
 * `startTurn`.
 *
 * @param {string} sceneId
 * @param {number} lineIndex
 * @param {{ director_profile: object, actor_profile: object, summarizer_profile?: object | null }} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
export async function regenerateSceneMessage(sceneId, lineIndex, body, signal) {
    const url = `${BASE}/scenes/${encodeURIComponent(sceneId)}/messages/${encodeURIComponent(String(lineIndex))}/regenerate`;
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new GmApiError(response.status, text || `${url} ${response.status}`, text);
    }
    return response;
}

/**
 * Rewind the transcript to just before the most-recent player line at
 * or before `lineIndex`. The player line and everything after it is
 * dropped. Returns `{ removed: { player_input, count }, scene, cascade }`.
 *
 * @param {string} sceneId
 * @param {number} lineIndex
 * @returns {Promise<{ removed: { player_input: string, count: number }, scene: any, cascade: any }>}
 */
export async function rewindToBefore(sceneId, lineIndex) {
    return request(`/scenes/${encodeURIComponent(sceneId)}/messages/${encodeURIComponent(String(lineIndex))}/rewind-to-before`, {
        method: 'POST',
    });
}

/**
 * Phase 8: triggers the scene-end pipeline. Returns the full payload so
 * the caller can render `memories_extracted` / `summary.headline` in
 * the toast or detail view.
 *
 * @param {string} sceneId
 * @param {{ director_profile: object, actor_profile: object, dry_run?: boolean }} options
 * @returns {Promise<{
 *   scene: any,
 *   summary: any,
 *   memories_extracted: Record<string, number>,
 *   key_events_written: number,
 *   warnings: Array<{ stage: string, character_id?: string, error: string }>,
 *   dry_run: boolean,
 * } | null>}
 */
export async function endScene(sceneId, options) {
    if (!options || !options.director_profile || !options.actor_profile) {
        throw new Error('endScene requires director_profile and actor_profile');
    }
    const query = options.dry_run ? '?dry_run=1' : '';
    const out = await request(`/scenes/${encodeURIComponent(sceneId)}/end${query}`, {
        method: 'POST',
        body: JSON.stringify({
            director_profile: options.director_profile,
            actor_profile: options.actor_profile,
        }),
    });
    return out ?? null;
}

/**
 * Read the per-scene `SceneSummary` JSON (Phase 8). Returns null when the
 * scene has no summary on file (active or closed-pre-Phase-8).
 *
 * @param {string} campaignId
 * @param {string} sceneId
 */
export async function getSceneSummary(campaignId, sceneId) {
    try {
        const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/scenes/${encodeURIComponent(sceneId)}/summary`);
        return out?.summary ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

/* -------- Ask mode (out-of-fiction GM chat) -------- */

/**
 * @typedef {{ id: string, role: 'player' | 'gm', text: string, lore_id?: string | null, ts: string }} AskEntry
 */

/**
 * Read the persistent Ask transcript for a campaign.
 *
 * @param {string} campaignId
 * @returns {Promise<AskEntry[]>}
 */
export async function getAskTranscript(campaignId) {
    const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/ask`);
    return out?.entries ?? [];
}

/**
 * Run one Ask exchange. The server persists both player + GM entries and
 * writes any GM-suggested `lore_candidate` as a `world_lore` record.
 *
 * @param {string} campaignId
 * @param {{ question: string, director_profile: object }} options
 * @returns {Promise<{ reply: string, lore_id: string | null, entries: { player: AskEntry, gm: AskEntry } }>}
 */
export async function postAsk(campaignId, options) {
    if (!options || !options.question || !options.director_profile) {
        throw new Error('postAsk requires question and director_profile');
    }
    return request(`/campaigns/${encodeURIComponent(campaignId)}/ask`, {
        method: 'POST',
        body: JSON.stringify({
            question: options.question,
            director_profile: options.director_profile,
        }),
    });
}

/* -------- Plot mode (intent gate -> scene start) -------- */

/**
 * Run one Plot decision pass. On `start_scene` the response includes the
 * created `scene_id` (transcript already seeded with the GM's
 * opening_pose).
 *
 * @param {string} campaignId
 * @param {{ intent: string, director_profile: object }} options
 * @returns {Promise<
 *   | { decision: 'pushback', reason: string }
 *   | { decision: 'start_scene', scene_id: string, scene: any, opening_pose: string, suggested_participants: string[], suggested_unknown: string[] }
 * >}
 */
export async function postPlot(campaignId, options) {
    if (!options || !options.intent || !options.director_profile) {
        throw new Error('postPlot requires intent and director_profile');
    }
    return request(`/campaigns/${encodeURIComponent(campaignId)}/plot`, {
        method: 'POST',
        body: JSON.stringify({
            intent: options.intent,
            director_profile: options.director_profile,
        }),
    });
}

/**
 * Add a character to the scene's participant list.
 * @param {string} sceneId
 * @param {string} characterId
 */
export async function addSceneParticipant(sceneId, characterId) {
    const out = await request(`/scenes/${encodeURIComponent(sceneId)}/participants`, {
        method: 'POST',
        body: JSON.stringify({ character_id: characterId }),
    });
    return out;
}

/**
 * Remove a character from the scene's participant list.
 * @param {string} sceneId
 * @param {string} characterId
 */
export async function removeSceneParticipant(sceneId, characterId) {
    const out = await request(`/scenes/${encodeURIComponent(sceneId)}/participants/${encodeURIComponent(characterId)}`, {
        method: 'DELETE',
    });
    return out;
}

/* -------- Sheet KV editing (Phase 5) -------- */

/**
 * @param {string} characterId
 * @param {string} key
 * @param {number | string} value
 */
export async function setStat(characterId, key, value) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/stats/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
    });
    return out?.character ?? null;
}

/**
 * @param {string} characterId
 * @param {string} key
 * @param {number} delta
 */
export async function adjustStat(characterId, key, delta) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/stats/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        body: JSON.stringify({ delta }),
    });
    return out?.character ?? null;
}

/**
 * @param {string} characterId
 * @param {string} key
 */
export async function clearStat(characterId, key) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/stats/${encodeURIComponent(key)}`, {
        method: 'DELETE',
    });
    return out?.character ?? null;
}

/**
 * @param {string} characterId
 * @param {string} key
 * @param {string} value
 */
export async function setStatus(characterId, key, value) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/statuses/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
    });
    return out?.character ?? null;
}

/**
 * @param {string} characterId
 * @param {string} key
 */
export async function clearStatus(characterId, key) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/statuses/${encodeURIComponent(key)}`, {
        method: 'DELETE',
    });
    return out?.character ?? null;
}

/** @param {string} characterId */
export async function getSheet(characterId) {
    try {
        const out = await request(`/sheets/${encodeURIComponent(characterId)}`);
        return out?.character ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

/* -------- Sheet items / skills / notes (M4) -------- */

/**
 * Push a new item onto `sheet.items`. Body shape mirrors the server's
 * `addItem` mutator: `{ name, description, influences }`.
 *
 * @param {string} characterId
 * @param {{ name: string, description?: string, influences?: any }} item
 */
export async function addItem(characterId, item) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/items`, {
        method: 'POST',
        body: JSON.stringify(item || {}),
    });
    return out?.character ?? null;
}

/**
 * Patch fields on an existing item by id. Unspecified fields are left
 * untouched.
 *
 * @param {string} characterId
 * @param {string} itemId
 * @param {{ name?: string, description?: string, influences?: any }} patch
 */
export async function updateItem(characterId, itemId, patch) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/items/${encodeURIComponent(itemId)}`, {
        method: 'PUT',
        body: JSON.stringify(patch || {}),
    });
    return out?.character ?? null;
}

/**
 * @param {string} characterId
 * @param {string} itemId
 */
export async function deleteItem(characterId, itemId) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/items/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
    });
    return out?.character ?? null;
}

/**
 * Replace the full `sheet.skills` list in one call. The frontend
 * recomputes the desired set from the skills checklist and ships it
 * here; the server validates membership against the ruleset.
 *
 * @param {string} characterId
 * @param {string[]} skills
 */
export async function setSkills(characterId, skills) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/skills`, {
        method: 'PUT',
        body: JSON.stringify({ skills: Array.isArray(skills) ? skills : [] }),
    });
    return out?.character ?? null;
}

/**
 * @param {string} characterId
 * @param {string} notes
 */
export async function setNotes(characterId, notes) {
    const out = await request(`/sheets/${encodeURIComponent(characterId)}/notes`, {
        method: 'PUT',
        body: JSON.stringify({ notes: typeof notes === 'string' ? notes : '' }),
    });
    return out?.character ?? null;
}

/* -------- Sheet relationships (M2) -------- */

/**
 * List the `other_id` keys present in `sheet.relationships` without
 * fetching the field bag for each one. Lets the panel render the
 * disclosure rows for hidden NPC↔NPC entries cheaply, and only
 * fetch the per-target fields when the user expands a row.
 *
 * @param {string} characterId
 * @returns {Promise<{ character_id: string, other_ids: string[] }>}
 */
export async function listRelationshipKeys(characterId) {
    const path = `/sheets/${encodeURIComponent(characterId)}/relationships`;
    return await request(path);
}

/**
 * Fetch the field bag for a single relationship entry.
 *
 * @param {string} characterId
 * @param {string} otherId
 * @returns {Promise<{ character_id: string, other_id: string, fields: Record<string, number | string> | null }>}
 */
export async function getRelationship(characterId, otherId) {
    const path = `/sheets/${encodeURIComponent(characterId)}`
        + `/relationships/${encodeURIComponent(otherId)}`;
    return await request(path);
}

/**
 * Set a single field on `sheet.relationships[other_id]`. The server
 * rejects writes targeting another campaign's character.
 *
 * @param {string} characterId
 * @param {string} otherId
 * @param {string} field
 * @param {number | string} value
 */
export async function setRelationshipField(characterId, otherId, field, value) {
    const path = `/sheets/${encodeURIComponent(characterId)}`
        + `/relationships/${encodeURIComponent(otherId)}/${encodeURIComponent(field)}`;
    const out = await request(path, {
        method: 'PUT',
        body: JSON.stringify({ value }),
    });
    return out?.character ?? null;
}

/**
 * @param {string} characterId
 * @param {string} otherId
 * @param {string} field
 */
export async function clearRelationshipField(characterId, otherId, field) {
    const path = `/sheets/${encodeURIComponent(characterId)}`
        + `/relationships/${encodeURIComponent(otherId)}/${encodeURIComponent(field)}`;
    const out = await request(path, { method: 'DELETE' });
    return out?.character ?? null;
}

/**
 * Drop the entire `sheet.relationships[other_id]` sub-bag in one call.
 *
 * @param {string} characterId
 * @param {string} otherId
 */
export async function removeRelationship(characterId, otherId) {
    const path = `/sheets/${encodeURIComponent(characterId)}`
        + `/relationships/${encodeURIComponent(otherId)}`;
    const out = await request(path, { method: 'DELETE' });
    return out?.character ?? null;
}

/* -------- Turn (Phase 4) -------- */

/**
 * Start a turn. Returns the raw `Response` so the caller can stream the
 * NDJSON body line-by-line.
 *
 * @param {{
 *   campaign_id: string,
 *   scene_id: string,
 *   user_input: string,
 *   director_profile: object,
 *   actor_profile: object,
 *   summarizer_profile?: object | null,
 * }} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
export async function startTurn(body, signal) {
    const url = `${BASE}/turn`;
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new GmApiError(response.status, text || `${url} ${response.status}`, text);
    }
    return response;
}

/* -------- RAG / Memory Explorer (Phase 7) -------- */

/**
 * Build a `?key=value&key=value` query string from a flat object. Skips
 * `null`, `undefined`, and empty strings; turns arrays into repeated
 * `key=v1&key=v2`. The leading `?` is included when there is at least
 * one parameter.
 *
 * @param {Record<string, string | number | boolean | string[] | null | undefined>} params
 * @returns {string}
 */
function qs(params) {
    const parts = [];
    for (const [key, raw] of Object.entries(params || {})) {
        if (raw === null || raw === undefined || raw === '') continue;
        if (Array.isArray(raw)) {
            for (const item of raw) {
                if (item === null || item === undefined || item === '') continue;
                parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
            }
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(raw))}`);
        }
    }
    return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * @returns {Promise<{ ok: boolean, url?: string, version?: string, error?: string, collections?: string[], embedder?: { provider: string, dim: number } }>}
 */
export async function getRagHealth() {
    return request('/rag/health');
}

/**
 * @param {string} cid
 * @returns {Promise<Array<{ name: string, kind: string, campaign_id: string, character_id?: string }>>}
 */
export async function listRagCollections(cid) {
    const out = await request(`/rag/collections${qs({ cid })}`);
    return out?.collections ?? [];
}

/**
 * List records in a collection. Filters mirror the server's
 * `MemoryService.list` payload filters; only the fields you set are
 * sent.
 *
 * @param {{
 *   cid: string,
 *   kind: string,
 *   characterId?: string,
 *   filters?: { tags?: string[], origin?: string, entry_kind?: string, scene_id?: string, source_type?: string },
 *   limit?: number,
 *   offset?: string | number | null,
 * }} args
 * @returns {Promise<{ records: any[], next_offset: string | number | null }>}
 */
export async function listRagRecords(args) {
    const { cid, kind, characterId, filters = {}, limit, offset } = args;
    if (!cid) throw new GmApiError(400, 'listRagRecords: cid required', null);
    if (!kind) throw new GmApiError(400, 'listRagRecords: kind required', null);
    const params = {
        limit: typeof limit === 'number' ? limit : undefined,
        offset: offset === null || offset === undefined ? undefined : offset,
        tags: Array.isArray(filters.tags) && filters.tags.length ? filters.tags.join(',') : undefined,
        origin: filters.origin || undefined,
        entry_kind: filters.entry_kind || undefined,
        scene_id: filters.scene_id || undefined,
        source_type: filters.source_type || undefined,
    };
    const path = kind === 'character_memory'
        ? `/rag/collections/character_memory/${encodeURIComponent(cid)}/${encodeURIComponent(characterId || '')}`
        : `/rag/collections/${encodeURIComponent(kind)}/${encodeURIComponent(cid)}`;
    const out = await request(`${path}${qs(params)}`);
    return {
        records: out?.records ?? [],
        next_offset: out?.next_offset ?? null,
    };
}

/**
 * @param {{
 *   cid: string,
 *   kind: string,
 *   characterId?: string,
 *   query: string,
 *   top_k?: number,
 *   filters?: object,
 * }} args
 * @returns {Promise<{ hits: Array<{ record: any, raw_score: number, score: number, decay_multiplier: number }> }>}
 */
export async function searchRag(args) {
    const body = {
        campaign_id: args.cid,
        kind: args.kind,
        character_id: args.characterId,
        query: args.query,
        top_k: args.top_k,
        filters: args.filters,
    };
    return request('/rag/search', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

/**
 * @param {{
 *   campaignId: string,
 *   kind: string,
 *   characterId?: string,
 *   record: object,
 * }} args
 */
export async function writeMemory(args) {
    const body = {
        campaign_id: args.campaignId,
        kind: args.kind,
        character_id: args.characterId,
        record: args.record,
    };
    return request('/rag/memories', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

/**
 * @param {{
 *   campaignId: string,
 *   kind: string,
 *   characterId?: string,
 *   id: string,
 *   patch: object,
 * }} args
 */
export async function patchMemory(args) {
    const body = {
        campaign_id: args.campaignId,
        kind: args.kind,
        character_id: args.characterId,
        patch: args.patch,
    };
    const out = await request(`/rag/memories/${encodeURIComponent(args.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
    return out?.record ?? null;
}

/**
 * @param {{
 *   campaignId: string,
 *   kind: string,
 *   characterId?: string,
 *   id: string,
 * }} args
 */
export async function deleteMemory(args) {
    const params = {
        cid: args.campaignId,
        kind: args.kind,
        character_id: args.characterId,
    };
    return request(`/rag/memories/${encodeURIComponent(args.id)}${qs(params)}`, {
        method: 'DELETE',
    });
}

/** @param {string} cid */
export async function reconcileRag(cid) {
    return request(`/rag/reconcile${qs({ cid })}`, { method: 'POST' });
}

/** @returns {Promise<Array<{ id: string, name: string, summary?: string, count?: number }>>} */
export async function listLorePacks() {
    const out = await request('/rag/lore/seed-packs');
    return out?.packs ?? [];
}

/**
 * @param {{ cid: string, pack_id: string }} args
 */
export async function applyLorePack(args) {
    const body = { campaign_id: args.cid, pack_id: args.pack_id };
    return request('/rag/lore/seed-packs', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

/* -------- Lore packs browser (Library tab) -------- */

/**
 * Fetch the full lore pack definition by id (entries + characters).
 *
 * @param {string} id
 * @returns {Promise<import('../../../src/gm-core/lore/schemas.js').LorePack | null>}
 */
export async function getLorePack(id) {
    try {
        const out = await request(`/rag/lore/seed-packs/${encodeURIComponent(id)}`);
        return out?.pack ?? null;
    } catch (err) {
        if (err instanceof GmApiError && err.status === 404) return null;
        throw err;
    }
}

export { GmApiError };
