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

/* -------- Characters (Phase 2) -------- */

/** @param {string} campaignId */
export async function listCharacters(campaignId) {
    const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/characters`);
    return out?.characters ?? [];
}

/**
 * @param {string} campaignId
 * @param {object} body
 */
export async function createCharacter(campaignId, body) {
    const out = await request(`/campaigns/${encodeURIComponent(campaignId)}/characters`, {
        method: 'POST',
        body: JSON.stringify(body),
    });
    return out.character;
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

/** @param {string} sceneId */
export async function endScene(sceneId) {
    const out = await request(`/scenes/${encodeURIComponent(sceneId)}/end`, { method: 'POST' });
    return out?.scene ?? null;
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

/* -------- Turn (Phase 4) -------- */

/**
 * Start a turn. Returns the raw `Response` so the caller can stream the
 * NDJSON body line-by-line.
 *
 * @param {object} body
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

export { GmApiError };
