/**
 * Plot-mode service.
 *
 * One structured LLM call per intent. Pulls top world lore via
 * `MemoryService.for_world`, builds a prompt with the campaign brief,
 * `current_situation`, recent scene headlines, PC sheet, and the
 * player's stated intent. Returns a binary `PlotDecision`:
 *
 *   { decision: 'pushback', reason, ... }
 *   { decision: 'start_scene', name, location, opening_pose, suggested_participants }
 *
 * The service does NOT perform side effects — no scene creation, no
 * transcript writes. Those happen in the route layer so route-level
 * concerns (sanitise participant names, persist the seeded narrator
 * pose) stay out of the core module.
 */

import { PLOT_DECISION_SCHEMA, PLOT_SYSTEM_PROMPT, buildPlotUser } from './prompts.js';

/** @typedef {import('../campaigns/schemas.js').Campaign} Campaign */
/** @typedef {import('../library/schemas.d.ts').Character} Character */
/** @typedef {import('../rag/service.d.ts').MemoryService} MemoryService */

/**
 * @typedef {Object} StructuredClient
 * @property {(args: { system: string, user: string, schema: object, schemaName: string, signal?: AbortSignal }) => Promise<any>} structured
 */

/**
 * @typedef {{
 *   decision: 'pushback',
 *   reason: string,
 * } | {
 *   decision: 'start_scene',
 *   name: string,
 *   location: string,
 *   opening_pose: string,
 *   suggested_participants: string[],
 * }} PlotDecision
 */

const RECENT_SCENE_HEADLINES = 3;

/**
 * Run one Plot decision pass.
 *
 * @param {{
 *   campaign: Campaign,
 *   playerCharacter: Character | null,
 *   recentSceneHeadlines: string[],
 *   nearbyRoster: string[],
 *   intent: string,
 *   client: StructuredClient,
 *   memoryService: MemoryService | null,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<PlotDecision>}
 */
export async function decide(args) {
    const {
        campaign,
        playerCharacter,
        recentSceneHeadlines,
        nearbyRoster,
        intent,
        client,
        memoryService,
        signal,
    } = args;

    if (!campaign || !client) {
        throw new Error('plot.decide: missing required arguments');
    }
    const trimmedIntent = String(intent || '').trim();
    if (!trimmedIntent) throw new Error('plot.decide: intent is required');

    /** @type {Array<{ record: any }>} */
    let loreHits = [];
    if (memoryService) {
        try {
            loreHits = await memoryService.for_world({
                campaignId: campaign.id,
                queryText: trimmedIntent,
                limit: 6,
            });
        } catch (err) {
            console.warn('[gm.plot] for_world failed', err?.message || err);
        }
    }

    const raw = await client.structured({
        system: PLOT_SYSTEM_PROMPT,
        user: buildPlotUser({
            campaign: { name: campaign.name, brief: campaign.brief, addendum: campaign.addendum },
            playerCharacter,
            currentSituation: campaign.current_situation || null,
            recentSceneHeadlines: (recentSceneHeadlines || []).slice(0, RECENT_SCENE_HEADLINES),
            loreHits,
            nearbyRoster: nearbyRoster || [],
            intent: trimmedIntent,
        }),
        schema: PLOT_DECISION_SCHEMA,
        schemaName: 'PlotDecision',
        signal,
        role: 'plot',
    });

    return normaliseDecision(raw);
}

/**
 * @param {any} raw
 * @returns {PlotDecision}
 */
function normaliseDecision(raw) {
    if (raw?.decision === 'start_scene') {
        const name = String(raw.name || '').trim();
        const location = String(raw.location || '').trim();
        const opening = String(raw.opening_pose || '').trim();
        if (!name || !opening) {
            // Fall back to pushback when the model picked start_scene but
            // failed to produce the required fields.
            return {
                decision: 'pushback',
                reason: 'GM started to set the scene but didn\'t finish — try restating what your character wants to do.',
            };
        }
        const suggested = Array.isArray(raw.suggested_participants)
            ? raw.suggested_participants.map(String).map(s => s.trim()).filter(Boolean).slice(0, 6)
            : [];
        return {
            decision: 'start_scene',
            name: name.slice(0, 120),
            location: location.slice(0, 240),
            opening_pose: opening,
            suggested_participants: suggested,
        };
    }
    const reason = String(raw?.reason || '').trim()
        || 'The GM isn\'t sure that action lands here — restate what your character is trying to do.';
    return { decision: 'pushback', reason: reason.slice(0, 600) };
}
