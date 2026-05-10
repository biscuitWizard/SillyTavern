/**
 * Ask-mode service.
 *
 * One structured LLM call per question. Pulls top world_lore via
 * `MemoryService.for_world`, formats a prompt with the campaign brief,
 * current situation, recent scene headlines, and the most recent Ask
 * exchanges, and asks the GM persona for a short reply plus an optional
 * `lore_candidate` payload.
 *
 * On a non-null candidate the service writes a `world_lore` record with
 * `source_type: 'ask_mode'` so future RAG queries (Ask, Director,
 * Narrator, Actors) can retrieve it. Both player + GM entries are
 * appended to the per-campaign transcript JSONL.
 */

import { ASK_REPLY_SCHEMA, ASK_SYSTEM_PROMPT, buildAskUser } from './prompts.js';
import * as askStore from './store.js';
import { buildMemoryRecord } from '../rag/schemas.js';
import { deriveAskLoreId } from './ids.js';

/** @typedef {import('../campaigns/schemas.js').Campaign} Campaign */
/** @typedef {import('../library/schemas.d.ts').Character} Character */
/** @typedef {import('../rag/service.d.ts').MemoryService} MemoryService */

/**
 * @typedef {Object} StructuredClient
 * @property {(args: { system: string, user: string, schema: object, schemaName: string, signal?: AbortSignal }) => Promise<any>} structured
 */

/**
 * @typedef {Object} AskResult
 * @property {string} reply
 * @property {string | null} lore_id
 * @property {{ player: import('./store.js').AskEntry, gm: import('./store.js').AskEntry }} entries
 */

const ASK_TAIL_ENTRIES = 12;
const RECENT_SCENE_HEADLINES = 3;

/**
 * Run one Ask exchange.
 *
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaign: Campaign,
 *   playerCharacter: Character | null,
 *   recentSceneHeadlines: string[],
 *   question: string,
 *   client: StructuredClient,
 *   memoryService: MemoryService | null,
 *   sceneIndex?: number,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<AskResult>}
 */
export async function ask(args) {
    const {
        directories,
        campaign,
        playerCharacter,
        recentSceneHeadlines,
        question,
        client,
        memoryService,
        sceneIndex = 0,
        signal,
    } = args;

    if (!directories || !campaign || !client) {
        throw new Error('ask: missing required arguments');
    }
    const trimmed = String(question || '').trim();
    if (!trimmed) throw new Error('ask: question is required');

    // Persist the player line FIRST so the transcript is never desynced
    // if the LLM call fails.
    const playerEntry = await askStore.append(directories, campaign.id, {
        role: 'player',
        text: trimmed,
    });

    // Pull world lore relevant to the question. Failure is non-fatal —
    // we still call the LLM, it just gets an empty MEMORIES block.
    /** @type {Array<{ record: any }>} */
    let loreHits = [];
    if (memoryService) {
        try {
            loreHits = await memoryService.for_world({
                campaignId: campaign.id,
                queryText: trimmed,
                limit: 6,
            });
        } catch (err) {
            console.warn('[gm.ask] for_world failed', err?.message || err);
        }
    }

    const transcript = askStore.readAll(directories, campaign.id);
    // The most recent player entry is the one we just wrote; trim the tail
    // for the prompt so we don't echo the question back at ourselves.
    const tailEntries = transcript
        .filter(e => e.id !== playerEntry.id)
        .slice(-ASK_TAIL_ENTRIES);

    const raw = await client.structured({
        system: ASK_SYSTEM_PROMPT,
        user: buildAskUser({
            campaign: { name: campaign.name, brief: campaign.brief, addendum: campaign.addendum },
            playerCharacter,
            currentSituation: campaign.current_situation || null,
            recentSceneHeadlines: (recentSceneHeadlines || []).slice(0, RECENT_SCENE_HEADLINES),
            loreHits,
            transcriptTail: tailEntries,
            question: trimmed,
        }),
        schema: ASK_REPLY_SCHEMA,
        schemaName: 'AskReply',
        signal,
    });

    const reply = String(raw?.reply || '').trim();
    if (!reply) throw new Error('ask: LLM returned an empty reply');

    let loreId = null;
    if (memoryService && raw?.lore_candidate && typeof raw.lore_candidate === 'object') {
        loreId = await tryWriteLore({
            memoryService,
            campaignId: campaign.id,
            sceneIndex,
            playerEntry,
            candidate: raw.lore_candidate,
        });
    }

    const gmEntry = await askStore.append(directories, campaign.id, {
        role: 'gm',
        text: reply,
        lore_id: loreId,
    });

    return { reply, lore_id: loreId, entries: { player: playerEntry, gm: gmEntry } };
}

/**
 * Write the GM-suggested `world_lore` record. Best-effort: failures are
 * logged but don't block the reply being persisted to the transcript.
 *
 * @param {{
 *   memoryService: MemoryService,
 *   campaignId: string,
 *   sceneIndex: number,
 *   playerEntry: import('./store.js').AskEntry,
 *   candidate: { title?: string, content?: string, tags?: string[], entry_kind?: string },
 * }} args
 * @returns {Promise<string | null>}
 */
async function tryWriteLore({ memoryService, campaignId, sceneIndex, playerEntry, candidate }) {
    const title = String(candidate?.title || '').trim();
    const content = String(candidate?.content || '').trim();
    if (!title || !content) return null;

    /** @type {string[]} */
    const tags = Array.isArray(candidate.tags)
        ? candidate.tags.map(String).map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 8)
        : [];
    /** @type {import('../rag/schemas.js').WorldLorePayload['entry_kind']} */
    const entryKind = isValidEntryKind(candidate.entry_kind) ? candidate.entry_kind : 'custom';

    const id = deriveAskLoreId({
        campaignId,
        askEntryId: playerEntry.id,
        content: `${title}\n${content}`,
    });
    const record = buildMemoryRecord({
        id,
        kind: 'world_lore',
        scope_id: campaignId,
        content: `${title}\n\n${content}`,
        tags,
        importance: 0.55,
        valence: 0,
        temporally_blind: false,
        source: `ask_mode:${playerEntry.id}`,
        scene_index: sceneIndex,
        world_lore: {
            origin: 'generated',
            source_type: 'ask_mode',
            scene_id: null,
            entry_kind: entryKind,
            title,
        },
    });
    try {
        await memoryService.write({ campaignId, record });
        return id;
    } catch (err) {
        console.warn('[gm.ask] world_lore write failed', err?.message || err);
        return null;
    }
}

const VALID_ENTRY_KINDS = new Set([
    'location', 'faction', 'culture', 'people', 'history',
    'magic', 'artifact', 'bestiary', 'cosmology', 'language',
    'pantheon', 'custom',
]);
function isValidEntryKind(s) { return typeof s === 'string' && VALID_ENTRY_KINDS.has(s); }
