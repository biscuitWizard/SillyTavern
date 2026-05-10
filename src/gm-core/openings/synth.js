/**
 * Opening-situation synthesizer.
 *
 * One structured LLM call that produces the initial `CurrentSituation`
 * for a campaign right after chargen. The result is normalised through
 * `buildCurrentSituation` and persisted by the caller via
 * `campaignStore.updateCurrentSituation`.
 *
 * Failure mode is non-fatal: callers swallow errors and leave
 * `current_situation` null, in which case Campaign Main shows a
 * "Generate opening" affordance the player can retry.
 */

import { buildCurrentSituation } from '../campaigns/schemas.js';
import {
    OPENING_SITUATION_SCHEMA,
    OPENING_SITUATION_SYSTEM_PROMPT,
    buildOpeningUser,
} from './prompts.js';
import {
    SCENE_END_RECAP_SCHEMA,
    SCENE_END_RECAP_SYSTEM_PROMPT,
    buildSceneEndRecapUser,
} from './recap-prompts.js';

/** @typedef {import('../campaigns/schemas.js').Campaign} Campaign */
/** @typedef {import('../campaigns/schemas.js').CurrentSituation} CurrentSituation */
/** @typedef {import('../library/schemas.d.ts').Character} Character */

/**
 * @typedef {Object} StructuredClient
 * @property {(args: { system: string, user: string, schema: object, schemaName: string, signal?: AbortSignal }) => Promise<any>} structured
 */

/**
 * Run a single structured call to produce an opening situation.
 *
 * @param {{
 *   campaign: Pick<Campaign, 'name' | 'brief' | 'ruleset_id'>,
 *   playerCharacter: Pick<Character, 'name' | 'appearance' | 'personality' | 'background'>,
 *   client: StructuredClient,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<CurrentSituation>}
 */
export async function synthesizeOpening({ campaign, playerCharacter, client, signal }) {
    if (!campaign || !playerCharacter || !client) {
        throw new Error('synthesizeOpening: missing required arguments');
    }
    const raw = await client.structured({
        system: OPENING_SITUATION_SYSTEM_PROMPT,
        user: buildOpeningUser({ campaign, playerCharacter }),
        schema: OPENING_SITUATION_SCHEMA,
        schemaName: 'OpeningSituation',
        signal,
    });
    const situation = buildCurrentSituation({
        recap: raw?.recap,
        location: raw?.location,
        time: raw?.time,
        nearby_characters: raw?.nearby_characters,
        source: 'chargen',
    });
    if (!situation) {
        throw new Error('synthesizeOpening: LLM returned an unusable payload');
    }
    return situation;
}

/**
 * Compose the next `current_situation` from the just-finished scene's
 * `SceneSummary`. Used by the scene-end pipeline.
 *
 * @param {{
 *   campaign: Pick<Campaign, 'name' | 'brief'>,
 *   playerName?: string,
 *   previousSituation: CurrentSituation | null,
 *   sceneSummary: {
 *     headline?: string,
 *     summary?: string,
 *     location_changes?: string[],
 *     participant_changes?: string[],
 *   },
 *   client: StructuredClient,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<CurrentSituation>}
 */
export async function recapFromSceneEnd({
    campaign,
    playerName,
    previousSituation,
    sceneSummary,
    client,
    signal,
}) {
    if (!campaign || !sceneSummary || !client) {
        throw new Error('recapFromSceneEnd: missing required arguments');
    }
    const raw = await client.structured({
        system: SCENE_END_RECAP_SYSTEM_PROMPT,
        user: buildSceneEndRecapUser({ campaign, playerName, previousSituation, sceneSummary }),
        schema: SCENE_END_RECAP_SCHEMA,
        schemaName: 'SceneEndRecap',
        signal,
    });
    const situation = buildCurrentSituation({
        recap: raw?.recap,
        location: raw?.location,
        time: raw?.time,
        nearby_characters: raw?.nearby_characters,
        source: 'scene_end',
    });
    if (!situation) {
        throw new Error('recapFromSceneEnd: LLM returned an unusable payload');
    }
    return situation;
}
