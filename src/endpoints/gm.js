/**
 * TTRPG Tavern GM core HTTP routes.
 *
 * One router that exposes the GM core (campaigns, characters, scenes, turn
 * loop) to the frontend. Mounted at `/api/gm` from `src/server-startup.js`.
 *
 * Phase 1 ships `/campaigns/*`. Phases 2/3/4 extend the same router with
 * `/characters/*`, `/sheets/*`, `/scenes/*`, and `/turn`.
 */

import express from 'express';

import * as campaignStore from '../gm-core/campaigns/store.js';
import { validateCampaignInput, buildCurrentSituation } from '../gm-core/campaigns/schemas.js';
import { synthesizeOpening } from '../gm-core/openings/synth.js';
import { ask as runAsk } from '../gm-core/ask/service.js';
import * as askStore from '../gm-core/ask/store.js';
import { decide as runPlotDecide } from '../gm-core/plot/service.js';
import * as characterStore from '../gm-core/library/store.js';
import { validateCharacterInput } from '../gm-core/library/schemas.js';
import * as sheetOps from '../gm-core/sheets/operations.js';
import * as sceneStore from '../gm-core/scenes/store.js';
import { validateSceneInput } from '../gm-core/scenes/schemas.js';
import * as transcript from '../gm-core/scenes/transcript.js';
import * as summaryStore from '../gm-core/scenes/summary-store.js';
import { runSceneEndPipeline } from '../gm-core/scenes/end-pipeline.js';
import { writeStCardForCharacter, removeStCardForCharacter } from '../gm-core/integrations/st-card-mirror.js';
import { mirrorCharacterToPersona } from '../gm-core/integrations/st-persona-mirror.js';
import { createLlmClient } from '../gm-core/llm/client.js';
import { runTurn } from '../gm-core/director/loop.js';
import { getRuleset, getRulesetFor, listRulesetSummaries } from '../gm-core/rulesets/index.js';
import * as participants from '../gm-core/scenes/participants.js';
import { ragRouter } from '../gm-core/rag/routes.js';
import { createQdrant } from '../gm-core/rag/qdrant.js';
import { resolveEmbedder } from '../gm-core/rag/embedders.js';
import { createMemoryService } from '../gm-core/rag/service.js';
import { reconcile, readPendingDeletes, writePendingDeletes, readRootPendingDeletes, writeRootPendingDeletes } from '../gm-core/rag/reconcile.js';
import { ingestCore } from '../gm-core/lore/ingest.js';
import { collectionNameFor, parseCollectionName } from '../gm-core/rag/schemas.js';

export const router = express.Router();
router.use('/rag', ragRouter);

/**
 * Lazy per-handle MemoryService cache. The /turn route uses this to inject
 * RAG into prompt builders + run the writers; cascade deletes use it too.
 *
 * @type {Map<string, { qdrant: any, embedder: any, service: any }>}
 */
const memoryServiceCache = new Map();

/**
 * Debounce reconcile-on-load to one run per campaign per session. Worst
 * case the LLM-driven extractors fall behind for a turn or two before the
 * service catches up; that's far better than triggering reconcile on
 * every campaign GET.
 *
 * @type {Map<string, number>}
 */
const reconcileOnceCache = new Map();

/**
 * Read the optional `rag:` block from config.yaml. Errors are non-fatal —
 * if config.yaml has no `rag` section we ship sensible defaults.
 */
let ragConfigCache = null;
function readRagConfig() {
    if (ragConfigCache) return ragConfigCache;
    try {
        // The server-time `getConfig` is registered globally as
        // `globalThis.getConfigValue` by `src/server-startup.js`; if it's
        // not yet available we fall back to env vars.
        /** @type {any} */
        const g = globalThis;
        const fromConfig = g.getConfigValue?.('rag', {}) || {};
        ragConfigCache = {
            embedder_provider: fromConfig.embedder_provider || process.env.TTRPG_RAG_EMBEDDER || 'deterministic',
            embedder_model: fromConfig.embedder_model,
            embedder_dim: fromConfig.embedder_dim,
            ollama_url: fromConfig.ollama_url || process.env.TTRPG_OLLAMA_URL,
            mirror_enabled: fromConfig.mirror_enabled !== false,
            top_k_overrides: fromConfig.top_k_overrides || {},
        };
    } catch (_) {
        ragConfigCache = {
            embedder_provider: process.env.TTRPG_RAG_EMBEDDER || 'deterministic',
            mirror_enabled: true,
            top_k_overrides: {},
        };
    }
    return ragConfigCache;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 */
async function getMemoryService(directories) {
    const cached = memoryServiceCache.get(directories.root);
    if (cached) return cached.service;
    const cfg = readRagConfig();
    const qdrant = createQdrant({ url: process.env.TTRPG_QDRANT_URL });
    const embedder = await resolveEmbedder(cfg);
    const service = createMemoryService({
        directories,
        qdrant,
        embedder,
        topK: cfg.top_k_overrides,
        getCurrentSceneIndex: (cid) => {
            try {
                const camp = campaignStore.get(directories, cid);
                if (!camp || !camp.current_scene_id) return 0;
                const found = sceneStore.findById(directories, camp.current_scene_id);
                if (!found) return 0;
                return computeSceneIndex(found.scene);
            } catch (_) {
                return 0;
            }
        },
    });
    memoryServiceCache.set(directories.root, { qdrant, embedder, service });
    return service;
}

/* -------- Rulesets (Phase 6: YAML-backed) -------- */

/**
 * GET /api/gm/rulesets
 *
 * List every ruleset id discoverable on disk (user pack ids shadow bundled
 * ones of the same name). The wizard uses this to populate its picker once
 * Phase 10 ships custom-pack support; until then it surfaces the bundled
 * `dnd5e` entry.
 */
router.get('/rulesets', (request, response) => {
    try {
        const summaries = listRulesetSummaries(request.user.directories);
        return response.json({ rulesets: summaries });
    } catch (error) {
        console.error('[gm] list rulesets failed', error);
        return response.status(500).json({ error: 'failed to list rulesets' });
    }
});

/**
 * GET /api/gm/rulesets/:id
 *
 * Returns the full Ruleset record (abilities, skills, DC bands, severity
 * ladder, plus `starter_stats` / `starter_skills` for the wizard). Honours
 * per-user packs at `{handle}/rulesets/{id}/` overriding the bundled file.
 */
router.get('/rulesets/:id', (request, response) => {
    const ruleset = getRulesetFor(request.user.directories, request.params.id);
    return response.json({ ruleset });
});

/**
 * GET /api/gm/rulesets/:id/sheet-layout
 *
 * Return only the merged sheet layout for the requested ruleset (M1).
 * The sheet panel, wizard, and sidebar all hit this when they render
 * the category-driven UI; pulling just the layout keeps the response
 * tight when the rest of the ruleset isn't needed (e.g. the panel
 * fetches the full ruleset for skill names but the sidebar doesn't).
 */
router.get('/rulesets/:id/sheet-layout', (request, response) => {
    const ruleset = getRulesetFor(request.user.directories, request.params.id);
    return response.json({ sheet_layout: ruleset.sheet_layout || null });
});

/* -------- Campaigns -------- */

/**
 * GET /api/gm/campaigns
 *
 * List all campaigns belonging to the current user as `CampaignSummary[]`.
 */
router.get('/campaigns', (request, response) => {
    try {
        const summaries = campaignStore.listSummaries(request.user.directories);
        return response.json({ campaigns: summaries });
    } catch (error) {
        console.error('[gm] listSummaries failed', error);
        return response.status(500).json({ error: 'failed to list campaigns' });
    }
});

/**
 * GET /api/gm/campaigns/:id
 *
 * Returns the full `Campaign` record. Phase 7 also fires a one-shot
 * background reconcile on first load: if Qdrant lost state since the
 * last process boot, the disk mirror is replayed transparently. Errors
 * are swallowed because reconcile is best-effort.
 */
router.get('/campaigns/:id', (request, response) => {
    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, request.params.id);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const reconcileKey = `${directories.root}::${campaign.id}`;
    if (!reconcileOnceCache.has(reconcileKey)) {
        reconcileOnceCache.set(reconcileKey, Date.now());
        getMemoryService(directories)
            .then(service => reconcile({
                memoryService: service,
                directories,
                campaignId: campaign.id,
                loreIngest: { ingestCore },
            }))
            .then(report => {
                if (report?.qdrant_ok && (report.core_lore_upserted || report.mirror_records_replayed || report.pending_deletes_drained || report.pending_upserts_drained)) {
                    console.log(`[gm.reconcile] ${campaign.id}: core+${report.core_lore_upserted} replayed=${report.mirror_records_replayed} pd=${report.pending_deletes_drained} pu=${report.pending_upserts_drained}`);
                }
            })
            .catch(err => {
                console.warn('[gm.reconcile] background reconcile failed', err?.message || err);
                reconcileOnceCache.delete(reconcileKey);
            });
    }

    return response.json({ campaign });
});

/**
 * POST /api/gm/campaigns
 *
 * Create a new campaign. Body fields (all optional except `name`):
 *   { name, brief, ruleset_id, banner_theme, addendum }
 */
router.post('/campaigns', (request, response) => {
    const body = request.body ?? {};
    if (!body.name) return response.status(400).json({ error: 'name is required' });
    const validationError = validateCampaignInput(body);
    if (validationError) return response.status(400).json({ error: validationError });

    try {
        const campaign = campaignStore.create(request.user.directories, body);
        return response.status(201).json({ campaign });
    } catch (error) {
        console.error('[gm] create campaign failed', error);
        return response.status(500).json({ error: 'failed to create campaign' });
    }
});

/**
 * PATCH /api/gm/campaigns/:id
 *
 * Update mutable fields. Immutable fields (`id`, `created_at`) are ignored.
 */
router.patch('/campaigns/:id', (request, response) => {
    const validationError = validateCampaignInput(request.body ?? {});
    if (validationError) return response.status(400).json({ error: validationError });

    const updated = campaignStore.update(request.user.directories, request.params.id, request.body ?? {});
    if (!updated) return response.status(404).json({ error: 'campaign not found' });
    return response.json({ campaign: updated });
});

/**
 * DELETE /api/gm/campaigns/:id
 *
 * Recursively remove the campaign directory **and** its Qdrant
 * collections (`*__{cid}` and `*__{cid}__*`). Disk is canonical, so
 * Qdrant cascade comes first; if any drop fails we queue the remaining
 * collection names to a *root-level* pending-deletes file (the
 * campaign dir is about to vanish) so the next boot reconcile can
 * finish the cleanup.
 */
router.delete('/campaigns/:id', async (request, response) => {
    const directories = request.user.directories;
    const cid = request.params.id;
    const campaign = campaignStore.get(directories, cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    let qdrantCollectionsDropped = 0;
    /** @type {Array<{ collection: string }>} */
    const queued = [];
    try {
        const service = await getMemoryService(directories);
        const all = await service.qdrant.listCollections().catch(() => []);
        const matches = all.filter(name => {
            const parsed = parseCollectionName(name);
            return parsed && parsed.campaign_id === cid;
        });
        for (const name of matches) {
            try {
                await service.qdrant.dropCollection(name);
                qdrantCollectionsDropped++;
            } catch (err) {
                console.warn('[gm.cascade] drop failed', name, err?.message || err);
                queued.push({ collection: name });
            }
        }
    } catch (err) {
        console.warn('[gm.cascade] qdrant cascade failed; queuing all', err?.message || err);
        queued.push({ collection: collectionNameFor('world_lore', cid) });
        queued.push({ collection: collectionNameFor('director_memory', cid) });
        queued.push({ collection: collectionNameFor('narrator_memory', cid) });
        queued.push({ collection: collectionNameFor('player_journal', cid) });
    }

    if (queued.length) {
        const existing = readRootPendingDeletes(directories);
        for (const item of queued) {
            if (!existing.some(e => e.collection === item.collection)) {
                existing.push(item);
            }
        }
        writeRootPendingDeletes(directories, existing);
    }

    const removed = campaignStore.remove(directories, cid);
    if (!removed) return response.status(404).json({ error: 'campaign not found' });
    return response.json({
        removed: true,
        qdrant_collections_dropped: qdrantCollectionsDropped,
        qdrant_collections_queued: queued.length,
    });
});

/* -------- Current situation (post-chargen / scene-end recap) -------- */

/**
 * POST /api/gm/campaigns/:cid/opening
 *
 * (Re-)generate the opening `current_situation` for a campaign. Requires a
 * `director_profile` in the body (same shape the /turn route uses). Used by
 * Campaign Main as a fallback when the chargen-time synth failed or was
 * skipped, and as a "regenerate" affordance.
 */
router.post('/campaigns/:cid/opening', async (request, response) => {
    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const body = request.body ?? {};
    if (!body.director_profile || typeof body.director_profile !== 'object') {
        return response.status(400).json({ error: 'director_profile is required' });
    }

    const characters = characterStore.listAll(directories, campaign.id);
    const player = characters.find(c => c.is_player) || null;
    if (!player) {
        return response.status(409).json({ error: 'campaign has no player character yet' });
    }

    let client;
    try {
        client = createLlmClient({ userDirectories: directories, profile: body.director_profile });
    } catch (err) {
        return response.status(400).json({ error: 'invalid director_profile', details: err?.message || String(err) });
    }

    try {
        const opening = await synthesizeOpening({
            campaign: { name: campaign.name, brief: campaign.brief, ruleset_id: campaign.ruleset_id },
            playerCharacter: {
                name: player.name,
                appearance: player.appearance,
                personality: player.personality,
                background: player.background,
            },
            client,
        });
        const updated = campaignStore.updateCurrentSituation(directories, campaign.id, opening);
        return response.json({ campaign: updated, current_situation: updated?.current_situation ?? opening });
    } catch (err) {
        console.error('[gm] /opening synth failed', err);
        return response.status(502).json({ error: 'opening synth failed', details: err?.message || String(err) });
    }
});

/**
 * PATCH /api/gm/campaigns/:cid/current-situation
 *
 * Manual edit of the "where things stand" snapshot. Clamping is handled by
 * `buildCurrentSituation`; passing a body of `null` clears the field.
 */
router.patch('/campaigns/:cid/current-situation', (request, response) => {
    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const body = request.body ?? null;
    let situation;
    if (body === null) {
        situation = null;
    } else if (typeof body === 'object') {
        situation = buildCurrentSituation({ ...body, source: 'manual' });
    } else {
        return response.status(400).json({ error: 'body must be null or an object' });
    }

    const updated = campaignStore.updateCurrentSituation(directories, campaign.id, situation);
    if (!updated) return response.status(404).json({ error: 'campaign not found' });
    return response.json({ campaign: updated, current_situation: updated.current_situation });
});

/* -------- Ask mode (out-of-fiction GM chat) -------- */

/**
 * GET /api/gm/campaigns/:cid/ask
 *
 * Returns the per-campaign Ask transcript so the panel can render history
 * on mount. Empty array when the file does not exist yet.
 */
router.get('/campaigns/:cid/ask', (request, response) => {
    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });
    try {
        const entries = askStore.readAll(directories, campaign.id);
        return response.json({ entries });
    } catch (error) {
        console.error('[gm.ask] read transcript failed', error);
        return response.status(500).json({ error: 'failed to read ask transcript' });
    }
});

/**
 * POST /api/gm/campaigns/:cid/ask
 *
 * Run one Ask exchange. Body:
 *   { question: string, director_profile: LlmProfile }
 *
 * Returns the GM reply, the two persisted transcript entries, and the
 * id of the world_lore record created (when the GM emitted a
 * `lore_candidate`).
 */
router.post('/campaigns/:cid/ask', async (request, response) => {
    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const body = request.body ?? {};
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return response.status(400).json({ error: 'question is required' });
    if (!body.director_profile || typeof body.director_profile !== 'object') {
        return response.status(400).json({ error: 'director_profile is required' });
    }

    let client;
    try {
        client = createLlmClient({ userDirectories: directories, profile: body.director_profile });
    } catch (err) {
        return response.status(400).json({ error: 'invalid director_profile', details: err?.message || String(err) });
    }

    const characters = characterStore.listAll(directories, campaign.id);
    const player = characters.find(c => c.is_player) || null;
    const allScenes = sceneStore.listAll(directories, campaign.id);
    const recentSceneHeadlines = allScenes
        .slice()
        .sort((a, b) => Date.parse(b.started_at || '') - Date.parse(a.started_at || ''))
        .map(s => typeof s.summary_headline === 'string' ? s.summary_headline.trim() : '')
        .filter(Boolean);

    let memoryService = null;
    let sceneIndex = 0;
    try {
        memoryService = await getMemoryService(directories);
        if (campaign.current_scene_id) {
            const found = sceneStore.findById(directories, campaign.current_scene_id);
            if (found) sceneIndex = computeSceneIndex(found.scene);
        }
    } catch (err) {
        console.warn('[gm.ask] memory service unavailable; running RAG-free', err?.message || err);
    }

    const abortController = new AbortController();
    request.on('close', () => {
        if (!response.writableEnded) abortController.abort();
    });

    try {
        const result = await runAsk({
            directories,
            campaign,
            playerCharacter: player,
            recentSceneHeadlines,
            question,
            client,
            memoryService,
            sceneIndex,
            signal: abortController.signal,
        });
        campaignStore.touch(directories, campaign.id);
        return response.json({
            reply: result.reply,
            lore_id: result.lore_id,
            entries: result.entries,
        });
    } catch (err) {
        console.error('[gm.ask] failed', err);
        return response.status(502).json({ error: 'ask failed', details: err?.message || String(err) });
    }
});

/* -------- Plot mode (intent gate -> scene start) -------- */

/**
 * POST /api/gm/campaigns/:cid/plot
 *
 * Run one Plot decision pass. Body:
 *   { intent: string, director_profile: LlmProfile }
 *
 * On `start_scene`, the route also creates the Scene, maps any suggested
 * NPC names to existing campaign character ids, and seeds the
 * transcript with the GM's `opening_pose` as a narrator system message
 * so the scene view loads grounded in the GM's setup.
 */
router.post('/campaigns/:cid/plot', async (request, response) => {
    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const body = request.body ?? {};
    const intent = typeof body.intent === 'string' ? body.intent.trim() : '';
    if (!intent) return response.status(400).json({ error: 'intent is required' });
    if (!body.director_profile || typeof body.director_profile !== 'object') {
        return response.status(400).json({ error: 'director_profile is required' });
    }

    const characters = characterStore.listAll(directories, campaign.id);
    const player = characters.find(c => c.is_player) || null;
    if (!player) return response.status(409).json({ error: 'campaign has no player character yet' });

    let client;
    try {
        client = createLlmClient({ userDirectories: directories, profile: body.director_profile });
    } catch (err) {
        return response.status(400).json({ error: 'invalid director_profile', details: err?.message || String(err) });
    }

    const allScenes = sceneStore.listAll(directories, campaign.id);
    const recentSceneHeadlines = allScenes
        .slice()
        .sort((a, b) => Date.parse(b.started_at || '') - Date.parse(a.started_at || ''))
        .map(s => typeof s.summary_headline === 'string' ? s.summary_headline.trim() : '')
        .filter(Boolean);

    // Roster the GM may pull NPCs from: campaign characters minus the PC,
    // plus the current_situation's nearby_characters (which may be names
    // the GM invented at chargen and never persisted as Characters yet).
    const nearbyRoster = [
        ...characters.filter(c => !c.is_player).map(c => c.name),
        ...((campaign.current_situation?.nearby_characters) || []),
    ];

    let memoryService = null;
    try {
        memoryService = await getMemoryService(directories);
    } catch (err) {
        console.warn('[gm.plot] memory service unavailable; running RAG-free', err?.message || err);
    }

    const abortController = new AbortController();
    request.on('close', () => {
        if (!response.writableEnded) abortController.abort();
    });

    /** @type {import('../gm-core/plot/service.js').PlotDecision} */
    let decision;
    try {
        decision = await runPlotDecide({
            campaign,
            playerCharacter: player,
            recentSceneHeadlines,
            nearbyRoster,
            intent,
            client,
            memoryService,
            signal: abortController.signal,
        });
    } catch (err) {
        console.error('[gm.plot] failed', err);
        return response.status(502).json({ error: 'plot failed', details: err?.message || String(err) });
    }

    if (decision.decision === 'pushback') {
        return response.json({ decision: 'pushback', reason: decision.reason });
    }

    // Scene start path: map suggested NPC names to existing character ids
    // (case-insensitive). Names without a match are still surfaced to the
    // client as `suggested_unknown` so the user can decide whether to
    // wire them up later — they're not added to the participants list.
    const npcByLowerName = new Map();
    for (const c of characters) {
        if (!c.is_player) npcByLowerName.set(c.name.trim().toLowerCase(), c.id);
    }
    /** @type {string[]} */
    const participantIds = [player.id];
    /** @type {string[]} */
    const suggestedUnknown = [];
    for (const name of decision.suggested_participants) {
        const id = npcByLowerName.get(name.trim().toLowerCase());
        if (id && !participantIds.includes(id)) participantIds.push(id);
        else if (!id) suggestedUnknown.push(name);
    }

    let scene;
    try {
        scene = sceneStore.create(directories, campaign.id, {
            name: decision.name,
            location: decision.location,
            participants: participantIds,
        });
    } catch (err) {
        console.error('[gm.plot] scene create failed', err);
        return response.status(500).json({ error: 'failed to create scene' });
    }

    // Seed the transcript with the GM's opening pose so the scene view
    // loads with the GM's setup already on the page. Marked
    // `is_user: false`, `is_system: false`, `extra.role: 'narrator'` so
    // it renders through the existing narrator bubble path.
    try {
        await transcript.appendLine(directories, campaign.id, scene.id, {
            name: 'Narrator',
            mes: decision.opening_pose,
            is_user: false,
            is_system: false,
            send_date: new Date().toISOString(),
            extra: { role: 'narrator', source: 'plot_mode' },
        });
        sceneStore.refreshMessageCount(directories, campaign.id, scene.id);
    } catch (err) {
        // The scene exists either way; surface a warning but don't fail.
        console.warn('[gm.plot] failed to seed opening_pose', err?.message || err);
    }

    campaignStore.touch(directories, campaign.id);

    return response.json({
        decision: 'start_scene',
        scene_id: scene.id,
        scene,
        opening_pose: decision.opening_pose,
        suggested_participants: decision.suggested_participants,
        suggested_unknown: suggestedUnknown,
    });
});

/* -------- Characters (Phase 2) -------- */

/**
 * GET /api/gm/campaigns/:cid/characters
 *
 * List all characters belonging to a campaign.
 */
router.get('/campaigns/:cid/characters', (request, response) => {
    const campaign = campaignStore.get(request.user.directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });
    try {
        const characters = characterStore.listAll(request.user.directories, campaign.id);
        return response.json({ characters });
    } catch (error) {
        console.error('[gm] list characters failed', error);
        return response.status(500).json({ error: 'failed to list characters' });
    }
});

/**
 * POST /api/gm/campaigns/:cid/characters
 *
 * Create a character. Phase 2 only ships the player character creation flow
 * (`is_player: true`). Server enforces a single PC per campaign.
 */
router.post('/campaigns/:cid/characters', async (request, response) => {
    const campaign = campaignStore.get(request.user.directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const body = request.body ?? {};
    if (!body.name) return response.status(400).json({ error: 'name is required' });
    const validationError = validateCharacterInput(body);
    if (validationError) return response.status(400).json({ error: validationError });

    try {
        const wantsPlayer = body.is_player !== false;
        if (wantsPlayer) {
            const existing = characterStore.listAll(request.user.directories, campaign.id);
            if (existing.some(c => c.is_player)) {
                return response.status(409).json({ error: 'campaign already has a player character' });
            }
        }

        // Seed the sheet from the campaign's ruleset when the caller did not
        // ship one. Phase 5 moves the 5e-shaped defaults out of the schema
        // module and into a per-ruleset starter pack so non-5e packs can
        // ship their own conventional KV bag in Phase 6.
        const ruleset = getRuleset(campaign.ruleset_id);
        const incomingSheet = body.sheet && typeof body.sheet === 'object' ? body.sheet : {};
        const seededSheet = {
            stats: incomingSheet.stats && Object.keys(incomingSheet.stats).length > 0
                ? incomingSheet.stats
                : { ...ruleset.starter_stats },
            statuses: incomingSheet.statuses || {},
            items: Array.isArray(incomingSheet.items) ? incomingSheet.items : [],
            skills: Array.isArray(incomingSheet.skills) && incomingSheet.skills.length > 0
                ? incomingSheet.skills
                : [...ruleset.starter_skills],
            notes: typeof incomingSheet.notes === 'string' ? incomingSheet.notes : '',
        };

        let character = characterStore.create(request.user.directories, campaign.id, {
            ...body,
            is_player: wantsPlayer,
            sheet: seededSheet,
        });

        const stCardAvatar = writeStCardForCharacter(request.user.directories, character);
        if (stCardAvatar && stCardAvatar !== character.st_card_avatar) {
            const updated = characterStore.update(request.user.directories, campaign.id, character.id, {
                st_card_avatar: stCardAvatar,
            });
            if (updated) character = updated;
        }

        if (character.is_player) {
            mirrorCharacterToPersona(request.user.directories, character);
        }

        campaignStore.touch(request.user.directories, campaign.id);

        // Best-effort opening synth: if the wizard sent a director_profile
        // and this is the freshly-created PC for a campaign that has no
        // current_situation yet, generate the "where you start" snapshot
        // before responding so Campaign Main has something to render on
        // the player's next paint. Failure is non-fatal — the frontend
        // shows a "Generate opening" button as the fallback.
        let opening = null;
        let openingError = null;
        const reloadedCampaign = campaignStore.get(request.user.directories, campaign.id) || campaign;
        if (
            character.is_player
            && reloadedCampaign
            && !reloadedCampaign.current_situation
            && body.director_profile
            && typeof body.director_profile === 'object'
        ) {
            try {
                const client = createLlmClient({
                    userDirectories: request.user.directories,
                    profile: body.director_profile,
                });
                opening = await synthesizeOpening({
                    campaign: {
                        name: reloadedCampaign.name,
                        brief: reloadedCampaign.brief,
                        ruleset_id: reloadedCampaign.ruleset_id,
                    },
                    playerCharacter: {
                        name: character.name,
                        appearance: character.appearance,
                        personality: character.personality,
                        background: character.background,
                    },
                    client,
                });
                campaignStore.updateCurrentSituation(request.user.directories, campaign.id, opening);
            } catch (err) {
                openingError = err?.message || String(err);
                console.warn('[gm] opening synth failed', openingError);
            }
        }

        return response.status(201).json({ character, opening, opening_error: openingError });
    } catch (error) {
        console.error('[gm] create character failed', error);
        return response.status(500).json({ error: 'failed to create character' });
    }
});

/**
 * GET /api/gm/characters/:char_id
 *
 * Lookup a character by id without specifying a campaign id (the wizard /
 * party panel use this).
 */
router.get('/characters/:char_id', (request, response) => {
    const found = characterStore.findById(request.user.directories, request.params.char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });
    return response.json({ character: found.character });
});

/**
 * PATCH /api/gm/characters/:char_id
 *
 * Update mutable fields on a character.
 */
router.patch('/characters/:char_id', (request, response) => {
    const found = characterStore.findById(request.user.directories, request.params.char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });

    const validationError = validateCharacterInput(request.body ?? {});
    if (validationError) return response.status(400).json({ error: validationError });

    const updated = characterStore.update(request.user.directories, found.campaign_id, found.character.id, request.body ?? {});
    if (!updated) return response.status(404).json({ error: 'character not found' });

    const stCardAvatar = writeStCardForCharacter(request.user.directories, updated);
    if (stCardAvatar && stCardAvatar !== updated.st_card_avatar) {
        const finalUpdate = characterStore.update(request.user.directories, found.campaign_id, updated.id, { st_card_avatar: stCardAvatar });
        if (finalUpdate) {
            if (finalUpdate.is_player) mirrorCharacterToPersona(request.user.directories, finalUpdate);
            return response.json({ character: finalUpdate });
        }
    }

    if (updated.is_player) mirrorCharacterToPersona(request.user.directories, updated);
    return response.json({ character: updated });
});

/**
 * PUT /api/gm/characters/:char_id/identity/:field
 *
 * Atomic setter for one identity field (appearance, personality, voice,
 * background, name). Used by the sheet panel's direct-edit inputs and by
 * the frontend's Director-proposal approval bubble.
 */
const ALLOWED_IDENTITY_FIELDS = new Set(['appearance', 'personality', 'voice', 'background', 'name']);

router.put('/characters/:char_id/identity/:field', (request, response) => {
    const { char_id, field } = request.params;
    if (!ALLOWED_IDENTITY_FIELDS.has(field)) {
        return response.status(400).json({
            error: `unknown identity field "${field}"; allowed: appearance, personality, voice, background, name`,
        });
    }

    const found = characterStore.findById(request.user.directories, char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });

    const value = (request.body ?? {}).value;
    if (typeof value !== 'string') {
        return response.status(400).json({ error: 'body.value must be a string' });
    }

    const validationError = validateCharacterInput({ [field]: value });
    if (validationError) return response.status(400).json({ error: validationError });

    const updated = characterStore.update(request.user.directories, found.campaign_id, found.character.id, { [field]: value });
    if (!updated) return response.status(404).json({ error: 'character not found' });

    const stCardAvatar = writeStCardForCharacter(request.user.directories, updated);
    if (stCardAvatar && stCardAvatar !== updated.st_card_avatar) {
        const finalUpdate = characterStore.update(request.user.directories, found.campaign_id, updated.id, { st_card_avatar: stCardAvatar });
        if (finalUpdate) {
            if (finalUpdate.is_player) mirrorCharacterToPersona(request.user.directories, finalUpdate);
            return response.json({ character: finalUpdate });
        }
    }

    if (updated.is_player) mirrorCharacterToPersona(request.user.directories, updated);
    return response.json({ character: updated });
});

/**
 * DELETE /api/gm/characters/:char_id
 *
 * Drop `character_memory__{cid}__{char_id}` from Qdrant before deleting
 * the disk record. On Qdrant failure we queue the drop to the campaign's
 * pending-deletes file; the JSON character file is still removed because
 * the disk is canonical and a stale Qdrant collection is harmless until
 * the next boot reconcile picks up the queue.
 */
router.delete('/characters/:char_id', async (request, response) => {
    const directories = request.user.directories;
    const found = characterStore.findById(directories, request.params.char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });

    const collection = collectionNameFor('character_memory', found.campaign_id, found.character.id);
    try {
        const service = await getMemoryService(directories);
        await service.qdrant.dropCollection(collection);
    } catch (err) {
        console.warn('[gm.cascade] character qdrant drop failed; queuing', err?.message || err);
        const queue = readPendingDeletes(directories, found.campaign_id);
        if (!queue.some(q => q.collection === collection)) {
            queue.push({ collection });
            writePendingDeletes(directories, found.campaign_id, queue);
        }
    }

    const removed = characterStore.remove(directories, found.campaign_id, found.character.id);
    if (!removed) return response.status(404).json({ error: 'character not found' });
    removeStCardForCharacter(directories, found.character);

    // Remove the disk mirror JSONL too (best-effort).
    try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const mirrorFile = path.join(campaignStore.campaignDir(directories, found.campaign_id), 'characters', `${found.character.id}.memories.jsonl`);
        if (fs.existsSync(mirrorFile)) fs.unlinkSync(mirrorFile);
    } catch (err) {
        console.warn('[gm.cascade] failed to remove character memory mirror', err?.message || err);
    }

    return response.status(204).end();
});

/* -------- Sheets (Phase 2 — granular mutators) -------- */

/**
 * Helper that resolves a character + campaign and forwards to a mutator.
 * Used by every `/sheets/:char_id/...` route.
 *
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {(directories: import('../users.js').UserDirectoryList, campaignId: string, characterId: string) => any} fn
 */
function withCharacter(request, response, fn) {
    const found = characterStore.findById(request.user.directories, request.params.char_id);
    if (!found) {
        response.status(404).json({ error: 'character not found' });
        return;
    }
    try {
        const result = fn(request.user.directories, found.campaign_id, found.character.id);
        if (!result) {
            response.status(404).json({ error: 'character not found' });
            return;
        }
        response.json({ character: result });
    } catch (error) {
        console.error('[gm] sheet operation failed', error);
        response.status(500).json({ error: 'sheet operation failed' });
    }
}

/** GET /api/gm/sheets/:char_id — read sheet (returns full character). */
router.get('/sheets/:char_id', (request, response) => {
    const found = characterStore.findById(request.user.directories, request.params.char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });
    return response.json({ character: found.character });
});

router.put('/sheets/:char_id/stats/:key', (request, response) => {
    const value = request.body?.value;
    if (value === undefined) return response.status(400).json({ error: 'value is required' });
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.setStat(dirs, cid, chid, request.params.key, value));
});

router.patch('/sheets/:char_id/stats/:key', (request, response) => {
    const delta = Number(request.body?.delta);
    if (!Number.isFinite(delta)) return response.status(400).json({ error: 'delta must be a number' });
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.adjustStat(dirs, cid, chid, request.params.key, delta));
});

router.delete('/sheets/:char_id/stats/:key', (request, response) => {
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.clearStat(dirs, cid, chid, request.params.key));
});

router.put('/sheets/:char_id/statuses/:key', (request, response) => {
    const value = request.body?.value;
    if (typeof value !== 'string') return response.status(400).json({ error: 'value must be a string' });
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.setStatus(dirs, cid, chid, request.params.key, value));
});

router.delete('/sheets/:char_id/statuses/:key', (request, response) => {
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.clearStatus(dirs, cid, chid, request.params.key));
});

router.post('/sheets/:char_id/items', (request, response) => {
    const body = request.body ?? {};
    if (!body.name) return response.status(400).json({ error: 'name is required' });
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.addItem(dirs, cid, chid, body));
});

router.put('/sheets/:char_id/items/:item_id', (request, response) => {
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.updateItem(dirs, cid, chid, request.params.item_id, request.body ?? {}));
});

router.delete('/sheets/:char_id/items/:item_id', (request, response) => {
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.deleteItem(dirs, cid, chid, request.params.item_id));
});

router.put('/sheets/:char_id/skills', (request, response) => {
    const skills = request.body?.skills;
    if (!Array.isArray(skills)) return response.status(400).json({ error: 'skills must be an array' });
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.setSkills(dirs, cid, chid, skills));
});

router.put('/sheets/:char_id/notes', (request, response) => {
    const notes = request.body?.notes;
    if (typeof notes !== 'string') return response.status(400).json({ error: 'notes must be a string' });
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.setNotes(dirs, cid, chid, notes));
});

/* -------- Relationships (M2) --------
 *
 * `sheet.relationships` is a per-other-character KV grid. The endpoints
 * mirror the stat/status surface but are routed through five explicit
 * verbs so the frontend can be granular without juggling JSON-patch:
 *
 *   GET    /sheets/:char_id/relationships              → just the keys
 *   GET    /sheets/:char_id/relationships/:other_id    → one entry
 *   PUT    /sheets/:char_id/relationships/:other_id/:field
 *   DELETE /sheets/:char_id/relationships/:other_id/:field
 *   DELETE /sheets/:char_id/relationships/:other_id
 *
 * The two GETs exist so the panel UI can render relationships lazily —
 * the design rule is "the bundled character GET is not the one big
 * blob to dump": the panel asks for the list of `other_ids` and only
 * fetches a card's full field set when the user expands it. That keeps
 * NPC-to-NPC entries (which the player isn't normally looking at)
 * cheap, and matches the one-card-at-a-time render policy.
 *
 * The `:other_id` route param must reference another character that
 * exists in the same campaign — a leak from another campaign would
 * never resolve in the panel anyway, but we reject it explicitly here
 * so a Director-tool dispatch in M8 cannot accidentally write a
 * dangling relationship.
 */

function ensureOtherCharacterInSameCampaign(directories, campaignId, otherCharacterId) {
    if (!otherCharacterId || typeof otherCharacterId !== 'string') return false;
    const other = characterStore.findById(directories, otherCharacterId);
    if (!other) return false;
    return other.campaign_id === campaignId;
}

router.get('/sheets/:char_id/relationships', (request, response) => {
    const found = characterStore.findById(request.user.directories, request.params.char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });
    const rels = (found.character?.sheet?.relationships && typeof found.character.sheet.relationships === 'object')
        ? found.character.sheet.relationships
        : {};
    return response.json({
        character_id: found.character.id,
        other_ids: Object.keys(rels).sort(),
    });
});

router.get('/sheets/:char_id/relationships/:other_id', (request, response) => {
    const found = characterStore.findById(request.user.directories, request.params.char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });
    const otherId = request.params.other_id;
    const rels = (found.character?.sheet?.relationships && typeof found.character.sheet.relationships === 'object')
        ? found.character.sheet.relationships
        : {};
    const entry = rels[otherId];
    return response.json({
        character_id: found.character.id,
        other_id: otherId,
        fields: (entry && typeof entry === 'object') ? entry : null,
    });
});

router.put('/sheets/:char_id/relationships/:other_id/:field', (request, response) => {
    const value = request.body?.value;
    if (value === undefined) return response.status(400).json({ error: 'value is required' });
    if (typeof value !== 'string' && typeof value !== 'number') {
        return response.status(400).json({ error: 'value must be a string or number' });
    }
    const otherId = request.params.other_id;
    const field = request.params.field;
    if (!field) return response.status(400).json({ error: 'field is required' });

    const directories = request.user.directories;
    const found = characterStore.findById(directories, request.params.char_id);
    if (!found) return response.status(404).json({ error: 'character not found' });
    if (found.character.id === otherId) {
        return response.status(400).json({ error: 'cannot set a relationship to self' });
    }
    if (!ensureOtherCharacterInSameCampaign(directories, found.campaign_id, otherId)) {
        return response.status(400).json({ error: 'other character is not in this campaign' });
    }
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.setRelationshipField(dirs, cid, chid, otherId, field, value));
});

router.delete('/sheets/:char_id/relationships/:other_id/:field', (request, response) => {
    const otherId = request.params.other_id;
    const field = request.params.field;
    if (!field) return response.status(400).json({ error: 'field is required' });
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.clearRelationshipField(dirs, cid, chid, otherId, field));
});

router.delete('/sheets/:char_id/relationships/:other_id', (request, response) => {
    const otherId = request.params.other_id;
    return withCharacter(request, response, (dirs, cid, chid) =>
        sheetOps.removeRelationship(dirs, cid, chid, otherId));
});

/* -------- Scenes (Phase 3) -------- */

/**
 * POST /api/gm/campaigns/:cid/scenes
 *
 * Create a new scene under the given campaign and set it as the campaign's
 * current scene.
 */
router.post('/campaigns/:cid/scenes', (request, response) => {
    const campaign = campaignStore.get(request.user.directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const body = request.body ?? {};
    const validationError = validateSceneInput(body);
    if (validationError) return response.status(400).json({ error: validationError });

    try {
        const player = characterStore.listAll(request.user.directories, campaign.id).find(c => c.is_player);
        const participants = Array.isArray(body.participants) && body.participants.length > 0
            ? body.participants
            : (player ? [player.id] : []);
        const scene = sceneStore.create(request.user.directories, campaign.id, {
            name: body.name,
            location: body.location,
            participants,
        });
        campaignStore.touch(request.user.directories, campaign.id);
        return response.status(201).json({ scene });
    } catch (error) {
        console.error('[gm] create scene failed', error);
        return response.status(500).json({ error: 'failed to create scene' });
    }
});

/**
 * GET /api/gm/campaigns/:cid/scenes
 *
 * List all scenes (active + closed) for the given campaign.
 */
router.get('/campaigns/:cid/scenes', (request, response) => {
    const campaign = campaignStore.get(request.user.directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });
    try {
        const scenes = sceneStore.listAll(request.user.directories, campaign.id);
        scenes.sort((a, b) => Date.parse(b.started_at || '0') - Date.parse(a.started_at || '0'));
        return response.json({ scenes });
    } catch (error) {
        console.error('[gm] list scenes failed', error);
        return response.status(500).json({ error: 'failed to list scenes' });
    }
});

/**
 * GET /api/gm/scenes/:id
 */
router.get('/scenes/:id', (request, response) => {
    const found = sceneStore.findById(request.user.directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });
    return response.json({ scene: found.scene });
});

/**
 * GET /api/gm/campaigns/:cid/scenes/:sid/summary
 *
 * Returns the full `SceneSummary` JSON written by the scene-end pipeline.
 * Used by Campaign Main to expand a closed scene's recap inline. Returns
 * 404 when the scene is missing or has no summary file yet (active
 * scenes / scenes that closed before Phase 8 shipped).
 */
router.get('/campaigns/:cid/scenes/:sid/summary', (request, response) => {
    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, request.params.cid);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });
    const scene = sceneStore.get(directories, campaign.id, request.params.sid);
    if (!scene) return response.status(404).json({ error: 'scene not found' });
    const summary = summaryStore.read(directories, campaign.id, scene.id);
    if (!summary) return response.status(404).json({ error: 'no summary on file' });
    return response.json({ summary, scene });
});

/**
 * GET /api/gm/scenes/:id/transcript?after=N
 *
 * Returns transcript lines, optionally skipping the first `after` entries.
 */
router.get('/scenes/:id/transcript', (request, response) => {
    const found = sceneStore.findById(request.user.directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });

    const after = Math.max(0, Number(request.query.after) || 0);
    try {
        const lines = transcript.readLines(request.user.directories, found.campaign_id, found.scene.id, after);
        return response.json({ lines, scene: found.scene });
    } catch (error) {
        console.error('[gm] read transcript failed', error);
        return response.status(500).json({ error: 'failed to read transcript' });
    }
});

/**
 * PUT /api/gm/scenes/:id/messages/:line_index
 *
 * Patch the text of a single transcript line. Body: `{ mes: string }`.
 *
 * The line index is the 0-based index into the scene's JSONL — exactly
 * the value the frontend uses for `mesid` (because `enterSceneMode`
 * replays lines 1:1). Roll cards are intentionally not editable; the
 * pencil icon is hidden in scene mode.
 *
 * For roll cards we still mirror `mes` into `extra.narration` so the
 * frontend's roll-card renderer (which reads from `extra`) stays in
 * sync.
 */
router.put('/scenes/:id/messages/:line_index', async (request, response) => {
    const found = sceneStore.findById(request.user.directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });
    if (found.scene.status === 'closed') return response.status(409).json({ error: 'scene is closed' });

    const idx = Number(request.params.line_index);
    if (!Number.isInteger(idx) || idx < 0) {
        return response.status(400).json({ error: 'line_index must be a non-negative integer' });
    }

    const { mes } = request.body ?? {};
    if (typeof mes !== 'string') {
        return response.status(400).json({ error: 'mes must be a string' });
    }

    try {
        const lines = transcript.readLines(request.user.directories, found.campaign_id, found.scene.id, 0);
        if (idx >= lines.length) {
            return response.status(404).json({ error: 'line not found' });
        }
        const target = lines[idx];
        if (target?.extra?.kind === 'roll') {
            // Roll cards: edit the narration body, not the `mes` body
            // alone — the renderer prefers `extra.narration` and the
            // raw `mes` is what surfaces if metadata is stripped.
            const updated = await transcript.updateLine(
                request.user.directories,
                found.campaign_id,
                found.scene.id,
                idx,
                { mes, extra: { narration: mes } },
            );
            const scene = sceneStore.refreshMessageCount(request.user.directories, found.campaign_id, found.scene.id);
            return response.json({ line: updated, scene });
        }
        const updated = await transcript.updateLine(
            request.user.directories,
            found.campaign_id,
            found.scene.id,
            idx,
            { mes },
        );
        const scene = sceneStore.refreshMessageCount(request.user.directories, found.campaign_id, found.scene.id);
        return response.json({ line: updated, scene });
    } catch (err) {
        if (err && /** @type {any} */(err).code === 'out_of_range') {
            return response.status(404).json({ error: err.message });
        }
        console.error('[gm] edit transcript line failed', err);
        return response.status(500).json({ error: 'failed to edit message' });
    }
});

/**
 * DELETE /api/gm/scenes/:id/messages/:line_index
 *
 * Drop a single transcript line and best-effort cascade-delete any RAG
 * records that were derived from it (opinion-extractor character
 * memories stamped with `opinion-extractor:{sceneId}:msg-{messageIndex}`,
 * and narrator-continuity memories stamped with
 * `narrator-continuity:{sceneId}`).
 *
 * The cascade is opportunistic: failures don't abort the transcript
 * delete. Sheet-mutation audits and add_lore writes are intentionally
 * left in place — those record state changes that may still be
 * meaningful even if the originating message goes away.
 */
router.delete('/scenes/:id/messages/:line_index', async (request, response) => {
    const directories = request.user.directories;
    const found = sceneStore.findById(directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });
    if (found.scene.status === 'closed') return response.status(409).json({ error: 'scene is closed' });

    const idx = Number(request.params.line_index);
    if (!Number.isInteger(idx) || idx < 0) {
        return response.status(400).json({ error: 'line_index must be a non-negative integer' });
    }

    try {
        const removed = await transcript.deleteLine(directories, found.campaign_id, found.scene.id, idx);
        const scene = sceneStore.refreshMessageCount(directories, found.campaign_id, found.scene.id);

        // Best-effort RAG cascade. Only worth running when the deleted
        // line was an in-fiction beat (actor / narrator / roll); player
        // lines and system markers don't carry derived memory records.
        const cascade = { attempted: false, removed: 0, errors: /** @type {string[]} */ ([]) };
        const role = removed?.extra?.role;
        const isBeat = role === 'actor' || role === 'narrator' || role === 'roll' || removed?.extra?.kind === 'roll';
        if (isBeat) {
            cascade.attempted = true;
            try {
                const svc = await getMemoryService(directories);
                if (svc && typeof svc.deleteRecordsBySource === 'function') {
                    // 1. opinion-extractor records (stamped per message index).
                    const opinionPrefix = `opinion-extractor:${found.scene.id}:msg-${idx}`;
                    const opinionResult = await svc.deleteRecordsBySource({
                        campaignId: found.campaign_id,
                        sourcePrefix: opinionPrefix,
                    });
                    cascade.removed += opinionResult.removed;
                    cascade.errors.push(...opinionResult.errors);

                    // 2. narrator-continuity (scene-scoped — only purge if
                    //    we deleted a narrator beat, since those memories
                    //    summarise the whole scene's narration).
                    if (role === 'narrator' || removed?.extra?.kind === 'roll') {
                        const narratorPrefix = `narrator-continuity:${found.scene.id}`;
                        const narratorResult = await svc.deleteRecordsBySource({
                            campaignId: found.campaign_id,
                            sourcePrefix: narratorPrefix,
                        });
                        cascade.removed += narratorResult.removed;
                        cascade.errors.push(...narratorResult.errors);
                    }
                }
            } catch (cascadeErr) {
                cascade.errors.push(`cascade: ${cascadeErr?.message || String(cascadeErr)}`);
                console.warn('[gm] delete-line cascade failed', cascadeErr?.message || cascadeErr);
            }
        }

        return response.json({ removed, scene, cascade });
    } catch (err) {
        if (err && /** @type {any} */(err).code === 'out_of_range') {
            return response.status(404).json({ error: err.message });
        }
        console.error('[gm] delete transcript line failed', err);
        return response.status(500).json({ error: 'failed to delete message' });
    }
});

/**
 * POST /api/gm/scenes/:id/messages/:line_index/regenerate
 *
 * Truncate the transcript so that everything strictly AFTER the most
 * recent player input at-or-before `line_index` is dropped, then run a
 * fresh Director turn with that player input as `user_input`. The
 * stream shape is identical to `POST /api/gm/turn` (NDJSON of
 * TurnEvents), so the frontend's `consumeTurnStream` handler doesn't
 * need a new branch.
 *
 * Body must include `director_profile` and `actor_profile` (and may
 * include `summarizer_profile`) so we can build LLM clients identically
 * to /turn — we don't carry these in scene state.
 */
router.post('/scenes/:id/messages/:line_index/regenerate', async (request, response) => {
    const directories = request.user.directories;
    const found = sceneStore.findById(directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });
    if (found.scene.status === 'closed') return response.status(409).json({ error: 'scene is closed' });

    const idx = Number(request.params.line_index);
    if (!Number.isInteger(idx) || idx < 0) {
        return response.status(400).json({ error: 'line_index must be a non-negative integer' });
    }

    const body = request.body ?? {};
    const { director_profile, actor_profile, summarizer_profile } = body;
    if (!director_profile || !actor_profile) {
        return response.status(400).json({ error: 'director_profile and actor_profile are required' });
    }

    const campaign = campaignStore.get(directories, found.campaign_id);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    // Find the most-recent player input at or before idx. The regenerate
    // semantics are: "redo the AI side of the most recent player turn".
    // We truncate everything strictly after that player line so the
    // freshly-run loop sees the same context as the original turn.
    const allLines = transcript.readLines(directories, campaign.id, found.scene.id, 0);
    if (idx >= allLines.length) {
        return response.status(404).json({ error: 'line not found' });
    }
    let playerIdx = -1;
    for (let i = Math.min(idx, allLines.length - 1); i >= 0; i--) {
        if (allLines[i]?.is_user) { playerIdx = i; break; }
    }
    if (playerIdx === -1) {
        return response.status(409).json({
            error: 'no preceding player input found — nothing to regenerate from',
        });
    }
    const userInput = String(allLines[playerIdx].mes || '').trim();

    // Truncate inclusive: keep [0..playerIdx], drop everything after.
    try {
        await transcript.truncateAfter(directories, campaign.id, found.scene.id, playerIdx);
        sceneStore.refreshMessageCount(directories, campaign.id, found.scene.id);
    } catch (err) {
        console.error('[gm] regenerate truncate failed', err);
        return response.status(500).json({ error: 'failed to truncate transcript' });
    }

    return runStreamingTurn({
        request,
        response,
        directories,
        campaign,
        scene: found.scene,
        userInput,
        director_profile,
        actor_profile,
        summarizer_profile,
        // Player line is already on disk from the original turn — don't
        // re-append it in `runStreamingTurn`.
        skipPlayerLinePersist: true,
    });
});

/**
 * POST /api/gm/scenes/:id/messages
 *
 * Append a transcript line. Phase 3 the frontend uses this for player input;
 * Phase 4 the Director / Narrator persistence path also goes through here.
 */
router.post('/scenes/:id/messages', async (request, response) => {
    const found = sceneStore.findById(request.user.directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });
    if (found.scene.status === 'closed') return response.status(409).json({ error: 'scene is closed' });

    const body = request.body ?? {};
    if (typeof body.name !== 'string' || body.name.length === 0) {
        return response.status(400).json({ error: 'name is required' });
    }
    if (typeof body.mes !== 'string') {
        return response.status(400).json({ error: 'mes must be a string' });
    }

    /** @type {import('../gm-core/scenes/schemas.js').TranscriptLine} */
    const line = {
        name: body.name,
        force_avatar: typeof body.force_avatar === 'string' ? body.force_avatar : undefined,
        mes: body.mes,
        is_user: body.is_user === true,
        is_system: body.is_system === true,
        send_date: typeof body.send_date === 'string' ? body.send_date : new Date().toISOString(),
        extra: body.extra && typeof body.extra === 'object' ? body.extra : undefined,
    };

    try {
        await transcript.appendLine(request.user.directories, found.campaign_id, found.scene.id, line);
        const updated = sceneStore.refreshMessageCount(request.user.directories, found.campaign_id, found.scene.id);
        return response.status(201).json({ line, scene: updated });
    } catch (error) {
        console.error('[gm] append transcript failed', error);
        return response.status(500).json({ error: 'failed to append message' });
    }
});

/**
 * POST /api/gm/scenes/:id/participants
 *
 * Add a character to the scene's participant list. Body: `{ character_id }`.
 * Idempotent: adding a participant who is already present returns 200 with
 * the existing scene record. The PC is allowed (the right sidebar pre-fills
 * with the PC anyway, but explicit add is a no-op).
 */
router.post('/scenes/:id/participants', (request, response) => {
    const found = sceneStore.findById(request.user.directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });
    if (found.scene.status === 'closed') return response.status(409).json({ error: 'scene is closed' });
    const characterId = request.body?.character_id;
    if (typeof characterId !== 'string' || characterId.length === 0) {
        return response.status(400).json({ error: 'character_id is required' });
    }
    const character = characterStore.get(request.user.directories, found.campaign_id, characterId);
    if (!character) return response.status(404).json({ error: 'character not found in this campaign' });
    try {
        const updated = participants.addParticipant(request.user.directories, found.campaign_id, found.scene.id, character.id);
        return response.json({ scene: updated, character });
    } catch (error) {
        console.error('[gm] add participant failed', error);
        return response.status(500).json({ error: 'failed to add participant' });
    }
});

/**
 * DELETE /api/gm/scenes/:id/participants/:char_id
 *
 * Remove a character from the scene's participant list. The PC cannot be
 * removed (returns 409); other characters are removed idempotently.
 */
router.delete('/scenes/:id/participants/:char_id', (request, response) => {
    const found = sceneStore.findById(request.user.directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });
    if (found.scene.status === 'closed') return response.status(409).json({ error: 'scene is closed' });
    const character = characterStore.get(request.user.directories, found.campaign_id, request.params.char_id);
    if (character?.is_player) {
        return response.status(409).json({ error: 'cannot remove the player character' });
    }
    try {
        const updated = participants.removeParticipant(request.user.directories, found.campaign_id, found.scene.id, request.params.char_id);
        return response.json({ scene: updated });
    } catch (error) {
        console.error('[gm] remove participant failed', error);
        return response.status(500).json({ error: 'failed to remove participant' });
    }
});

/**
 * POST /api/gm/scenes/:id/end
 *
 * Phase 8: drives the scene-end pipeline. Produces a `SceneSummary`,
 * runs per-participant `MemoryExtraction`, persists the summary doc,
 * writes key events as `world_lore` and per-character memories as
 * `character_memory`, then flips the scene to `closed`.
 *
 * Body:
 *   { director_profile: LlmProfile, actor_profile: LlmProfile }
 *
 * Query:
 *   ?dry_run=1   run the LLM calls but skip every persistent write.
 *                Returns the structured outputs in the response body
 *                so callers (eval scripts, tests) can inspect them.
 *   ?force=1    debug-only: re-run the pipeline against a closed scene.
 *                Records are written through `mirror.upsertRecordInJsonl`
 *                so deterministic ids make this idempotent. NOT exposed
 *                to the UI.
 */
router.post('/scenes/:id/end', async (request, response) => {
    const directories = request.user.directories;
    const found = sceneStore.findById(directories, request.params.id);
    if (!found) return response.status(404).json({ error: 'scene not found' });

    const dryRun = request.query.dry_run === '1' || request.query.dry_run === 'true';
    const force = request.query.force === '1' || request.query.force === 'true';
    if (found.scene.status === 'closed' && !force) {
        return response.status(409).json({ error: 'scene is already closed' });
    }

    const body = request.body ?? {};
    const { director_profile, actor_profile } = body;
    if (!director_profile || !actor_profile) {
        return response.status(400).json({ error: 'director_profile and actor_profile are required' });
    }

    const campaign = campaignStore.get(directories, found.campaign_id);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });

    const characters = characterStore.listAll(directories, campaign.id);
    const player = characters.find(c => c.is_player) || null;
    const participantIds = new Set(found.scene.participants || []);
    if (player) participantIds.add(player.id);
    const participants = characters
        .filter(c => participantIds.has(c.id))
        .sort((a, b) => Number(b.is_player) - Number(a.is_player));

    let memoryService;
    let sceneIndex = 0;
    try {
        memoryService = await getMemoryService(directories);
        sceneIndex = computeSceneIndex(found.scene);
    } catch (err) {
        console.error('[gm] scene-end: memory service unavailable', err);
        return response.status(503).json({ error: 'memory service unavailable', details: err?.message || String(err) });
    }

    let summaryClient;
    let extractionClient;
    try {
        summaryClient = createLlmClient({ userDirectories: directories, profile: director_profile });
        extractionClient = createLlmClient({ userDirectories: directories, profile: actor_profile });
    } catch (err) {
        console.error('[gm] scene-end: failed to build LLM client', err);
        return response.status(400).json({ error: 'invalid llm profile', details: err?.message || String(err) });
    }

    const abortController = new AbortController();
    request.on('close', () => {
        if (!response.writableEnded) abortController.abort();
    });

    try {
        const result = await runSceneEndPipeline({
            directories,
            campaignId: campaign.id,
            campaign: { name: campaign.name, brief: campaign.brief },
            scene: found.scene,
            participants,
            memoryService,
            summaryClient,
            extractionClient,
            sceneIndex,
            dryRun,
            signal: abortController.signal,
        });
        return response.json({
            scene: result.scene ?? found.scene,
            summary: result.summary,
            memories_extracted: result.memories_extracted,
            key_events_written: result.key_events_written,
            warnings: result.warnings,
            dry_run: result.dry_run,
        });
    } catch (error) {
        const stage = /** @type {any} */(error)?.stage;
        console.error('[gm] scene-end failed', { stage, error });
        const status = stage === 'summary' ? 502 : 500;
        return response.status(status).json({
            error: 'scene-end pipeline failed',
            stage,
            details: error?.message || String(error),
        });
    }
});

/* -------- Turn (Phase 4) -------- */

const TRANSCRIPT_TAIL_CHARS = 4000;

/**
 * POST /api/gm/turn
 *
 * Run a single player turn: persist the player input first (so the JSONL is
 * never inconsistent if the loop fails), build a TurnContext from disk, and
 * stream `TurnEvent`s as NDJSON. Each `message` event is also persisted to
 * the transcript with `extra.role = 'narrator'`.
 *
 * Body shape:
 *   {
 *     campaign_id, scene_id, user_input,
 *     director_profile:    LlmProfile,
 *     actor_profile:       LlmProfile,
 *     summarizer_profile?: LlmProfile,   // collapses long agent-loop history
 *   }
 */
router.post('/turn', async (request, response) => {
    const body = request.body ?? {};
    const { campaign_id, scene_id, user_input, director_profile, actor_profile, summarizer_profile } = body;
    const userInput = typeof user_input === 'string' ? user_input.trim() : '';

    if (!campaign_id || !scene_id) {
        return response.status(400).json({ error: 'campaign_id and scene_id are required' });
    }
    if (!director_profile || !actor_profile) {
        return response.status(400).json({ error: 'director_profile and actor_profile are required' });
    }

    const directories = request.user.directories;
    const campaign = campaignStore.get(directories, campaign_id);
    if (!campaign) return response.status(404).json({ error: 'campaign not found' });
    const found = sceneStore.findById(directories, scene_id);
    if (!found || found.campaign_id !== campaign.id) {
        return response.status(404).json({ error: 'scene not found' });
    }
    if (found.scene.status === 'closed') {
        return response.status(409).json({ error: 'scene is closed' });
    }

    return runStreamingTurn({
        request,
        response,
        directories,
        campaign,
        scene: found.scene,
        userInput,
        director_profile,
        actor_profile,
        summarizer_profile,
    });
});

/**
 * Shared body for /turn and /scenes/:id/messages/:line_index/regenerate.
 *
 * Persists the player input (unless `skipPlayerLinePersist` is true, used
 * by the regenerate flow where the player line is already on disk),
 * builds a TurnContext from the on-disk state, streams TurnEvents as
 * NDJSON, and persists `message` / `roll` events back into the
 * transcript as they arrive.
 *
 * @param {{
 *   request: import('express').Request,
 *   response: import('express').Response,
 *   directories: import('../users.js').UserDirectoryList,
 *   campaign: any,
 *   scene: any,
 *   userInput: string,
 *   director_profile: any,
 *   actor_profile: any,
 *   summarizer_profile?: any,
 *   skipPlayerLinePersist?: boolean,
 * }} args
 */
async function runStreamingTurn(args) {
    const { request, response, directories, campaign, scene, userInput,
        director_profile, actor_profile, summarizer_profile,
        skipPlayerLinePersist = false } = args;
    const found = { scene, campaign_id: campaign.id };

    const characters = characterStore.listAll(directories, campaign.id);
    const player = characters.find(c => c.is_player) || null;
    const charactersById = new Map(characters.map(c => [c.id, c]));

    // Persist the player line FIRST so the transcript is never desynced.
    // The regenerate flow passes `skipPlayerLinePersist: true` because
    // the player line is already on disk from the original turn.
    if (userInput && !skipPlayerLinePersist) {
        try {
            const playerLine = {
                name: player ? player.name : 'Player',
                force_avatar: player?.st_card_avatar ? `/characters/${encodeURIComponent(player.st_card_avatar)}` : undefined,
                mes: userInput,
                is_user: true,
                is_system: false,
                send_date: new Date().toISOString(),
                extra: { role: 'player' },
            };
            await transcript.appendLine(directories, campaign.id, found.scene.id, playerLine);
            sceneStore.refreshMessageCount(directories, campaign.id, found.scene.id);
        } catch (error) {
            console.error('[gm] persist player line failed', error);
        }
    }

    // Build the TurnContext. Scene participants are the actors the Director
    // can call this turn; characters NOT in the scene are surfaced as a
    // "library" the Director can `spawn_character` from. The PC is always
    // first in the actor list.
    const recentLines = transcript.readLines(directories, campaign.id, found.scene.id, 0);
    const recentTranscript = formatTranscriptTail(recentLines, TRANSCRIPT_TAIL_CHARS);
    const participantIds = new Set(found.scene.participants || []);
    if (player) participantIds.add(player.id);
    const inSceneActors = characters
        .filter(c => participantIds.has(c.id))
        .sort((a, b) => Number(b.is_player) - Number(a.is_player));
    const offSceneCharacters = characters.filter(c => !participantIds.has(c.id) && !c.is_player);
    const ctx = {
        campaign: { id: campaign.id, name: campaign.name, brief: campaign.brief, ruleset_id: campaign.ruleset_id },
        scene: { id: found.scene.id, name: found.scene.name, location: found.scene.location, status: found.scene.status },
        actors: inSceneActors.map(c => ({
            id: c.id,
            name: c.name,
            is_player: c.is_player,
            appearance: c.appearance,
            personality: c.personality,
            voice: c.voice,
            background: c.background,
        })),
        library_characters: offSceneCharacters.map(c => ({
            id: c.id,
            name: c.name,
            appearance: c.appearance,
        })),
        recent_transcript: recentTranscript,
        user_input: userInput,
    };

    // NDJSON stream headers. Set `Cache-Control: no-transform` so the
    // `compression` middleware skips this route, and disable buffering.
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    if (typeof response.flushHeaders === 'function') response.flushHeaders();

    const abortController = new AbortController();
    request.on('close', () => {
        if (!response.writableEnded) abortController.abort();
    });

    /** @param {object} ev */
    const emit = async (ev) => {
        if (response.writableEnded) return;
        try {
            response.write(JSON.stringify(ev) + '\n');
            // Force flush through the compression middleware (if active).
            const flush = /** @type {any} */(response).flush;
            if (typeof flush === 'function') flush.call(response);
        } catch (writeErr) {
            console.warn('[gm] turn write failed', writeErr);
            return;
        }
        // Persist message events to the transcript.
        if (ev && ev.kind === 'message') {
            try {
                const speaker = ev.actor && ev.actor !== 'narrator' && charactersById.has(ev.actor)
                    ? charactersById.get(ev.actor)
                    : null;
                const line = {
                    name: ev.name || ev.actor || 'Narrator',
                    force_avatar: speaker?.st_card_avatar
                        ? `/characters/${encodeURIComponent(speaker.st_card_avatar)}`
                        : undefined,
                    mes: ev.text || '',
                    is_user: false,
                    is_system: false,
                    send_date: new Date().toISOString(),
                    extra: {
                        role: ev.role || 'narrator',
                        actor: ev.actor,
                        actor_id: ev.actor_id || (ev.role === 'actor' ? ev.actor : undefined),
                    },
                };
                await transcript.appendLine(directories, campaign.id, found.scene.id, line);
                sceneStore.refreshMessageCount(directories, campaign.id, found.scene.id);
            } catch (persistErr) {
                console.error('[gm] persist actor line failed', persistErr);
            }
        }
        // Persist roll events as a single transcript line carrying both the
        // card payload (in `extra.card`) and the post-roll narration (`mes`).
        // We mark them `is_system: true` so SillyTavern does not render them
        // through the default chat-bubble renderer; the frontend's roll-card
        // branch picks up the line via `extra.kind === 'roll'` and replaces
        // it with a styled card.
        if (ev && ev.kind === 'roll') {
            try {
                const speaker = ev.actor_id && charactersById.has(ev.actor_id)
                    ? charactersById.get(ev.actor_id)
                    : null;
                // The post-roll prose may be voiced by a *different* character
                // than the actor who rolled (Director picked `voice: <NPC id>`
                // for a social check). Surface that explicitly so the frontend
                // can credit the right speaker on top of the card body.
                const narrationSpeaker = ev.narration_speaker_id && charactersById.has(ev.narration_speaker_id)
                    ? charactersById.get(ev.narration_speaker_id)
                    : null;
                const line = {
                    name: ev.actor_name || speaker?.name || 'System',
                    force_avatar: speaker?.st_card_avatar
                        ? `/characters/${encodeURIComponent(speaker.st_card_avatar)}`
                        : undefined,
                    mes: ev.narration || '',
                    is_user: false,
                    is_system: true,
                    send_date: new Date().toISOString(),
                    extra: {
                        role: 'roll',
                        kind: 'roll',
                        card: ev.card,
                        narration: ev.narration,
                        actor_id: ev.actor_id,
                        actor_name: ev.actor_name,
                        intent: ev.intent,
                        narration_speaker_id: ev.narration_speaker_id || null,
                        narration_speaker_name: ev.narration_speaker_name || null,
                        narration_speaker_role: ev.narration_speaker_role || 'narrator',
                        narration_speaker_avatar: narrationSpeaker?.st_card_avatar
                            ? `/characters/${encodeURIComponent(narrationSpeaker.st_card_avatar)}`
                            : null,
                    },
                };
                await transcript.appendLine(directories, campaign.id, found.scene.id, line);
                sceneStore.refreshMessageCount(directories, campaign.id, found.scene.id);
            } catch (persistErr) {
                console.error('[gm] persist roll line failed', persistErr);
            }
        }
        // `state` (spawn / remove) and `tool_error` events are intentionally
        // NOT persisted to the transcript: they're loop bookkeeping and the
        // player's reading flow benefits from a clean chat. The roster
        // sidebar is restored from `scene.json` (which `addParticipant` /
        // `removeParticipant` already write to), and the actor's first
        // `speak` after a spawn is plenty of in-fiction signal that they
        // entered the scene. Tool-error recoveries are even more clearly
        // internal Director noise — we just log them server-side here.
        if (ev && ev.kind === 'tool_error') {
            console.warn('[gm] director tool_error (recovered):', ev.tool, ev.code, ev.message);
        }
    };

    let directorClient, actorClient, summarizerClient = null;
    try {
        directorClient = createLlmClient({ userDirectories: directories, profile: director_profile });
        actorClient = createLlmClient({ userDirectories: directories, profile: actor_profile });
        // The summariser role is optional. When the frontend ships a
        // `summarizer_profile` we build a dedicated client; otherwise the
        // loop transparently falls back to the Director's client. We don't
        // hard-fail here on a bad summariser profile — summarisation is a
        // quality optimisation, and we'd rather run the turn than block
        // the player on a misconfiguration in a non-critical role.
        if (summarizer_profile && typeof summarizer_profile === 'object') {
            try {
                summarizerClient = createLlmClient({ userDirectories: directories, profile: summarizer_profile });
            } catch (sumErr) {
                console.warn('[gm] summarizer_profile invalid; falling back to director client', sumErr?.message || sumErr);
                summarizerClient = null;
            }
        }
    } catch (err) {
        await emit({
            kind: 'error',
            code: err?.code || 'bad_profile',
            message: err?.message || 'failed to build LLM client',
            retryable: false,
        });
        await emit({ kind: 'end_of_turn', reason: 'error' });
        response.end();
        return;
    }

    // Resolve the ruleset once per turn. Phase 6 keeps the adjudicator on the
    // same client as the Director (both are structured-output-only); a
    // dedicated `gm-adjudicator-model` profile slot is a Phase 10 concern.
    const ruleset = getRulesetFor(directories, campaign.ruleset_id);

    // Phase 7: resolve a MemoryService and a monotonic scene_index. Failure
    // here is non-fatal — the loop will run with `memoryService = null` and
    // skip retrieval + writers, preserving Phase 4-6 behaviour.
    /** @type {import('../gm-core/rag/service.d.ts').MemoryService | null} */
    let memoryService = null;
    let sceneIndex = 0;
    try {
        memoryService = await getMemoryService(directories);
        sceneIndex = computeSceneIndex(found.scene);
    } catch (err) {
        console.warn('[gm] /turn: memory service unavailable; running RAG-free', err?.message || err);
        memoryService = null;
    }

    try {
        await runTurn({
            ctx,
            directorClient,
            actorClient,
            adjudicatorClient: directorClient,
            summarizerClient: summarizerClient || undefined,
            ruleset,
            emit,
            signal: abortController.signal,
            findCharacter: (id) => charactersById.get(id) || null,
            addParticipant: (id) => {
                const updated = participants.addParticipant(directories, campaign.id, found.scene.id, id);
                return updated ? charactersById.get(id) || null : null;
            },
            removeParticipant: (id) => {
                const updated = participants.removeParticipant(directories, campaign.id, found.scene.id, id);
                return updated ? charactersById.get(id) || null : null;
            },
            // Promote-on-speak: when the loop's transient character first
            // speaks, we persist them as a real campaign character via the
            // standard library store. After persistence, the loop calls
            // `addParticipant` with the new id so the right-sidebar roster
            // refreshes from disk on the next reload.
            createCharacter: (input) => {
                const persisted = characterStore.create(directories, campaign.id, input);
                if (persisted) charactersById.set(persisted.id, persisted);
                return persisted;
            },
            // M8: Director-driven sheet mutations. Each op is dispatched
            // through the per-mutator helpers in
            // `gm-core/sheets/operations.js` so the same audit trail
            // (atomic write + `updated_at` bump) applies whether the
            // edit came from the panel UI or the Director's
            // `mutate_sheet` action. Returning the updated character
            // also refreshes the per-turn `charactersById` cache so a
            // subsequent `speak` step in the same loop renders the new
            // sheet via the per-actor prompt builder.
            mutateSheet: (characterId, op) => {
                if (!op || typeof op !== 'object') return null;
                let updated = null;
                switch (op.op) {
                    case 'set_stat':
                        updated = sheetOps.setStat(directories, campaign.id, characterId, op.key, op.value);
                        break;
                    case 'adjust_stat':
                        updated = sheetOps.adjustStat(directories, campaign.id, characterId, op.key, op.delta);
                        break;
                    case 'clear_stat':
                        updated = sheetOps.clearStat(directories, campaign.id, characterId, op.key);
                        break;
                    case 'set_status':
                        updated = sheetOps.setStatus(directories, campaign.id, characterId, op.key, op.value);
                        break;
                    case 'clear_status':
                        updated = sheetOps.clearStatus(directories, campaign.id, characterId, op.key);
                        break;
                    case 'add_item':
                        updated = sheetOps.addItem(directories, campaign.id, characterId, {
                            name: op.name,
                            description: op.description,
                            influences: op.influences,
                        });
                        break;
                    case 'update_item': {
                        const patch = {};
                        if (op.name !== undefined) patch.name = op.name;
                        if (op.description !== undefined) patch.description = op.description;
                        if (op.influences !== undefined) patch.influences = op.influences;
                        updated = sheetOps.updateItem(directories, campaign.id, characterId, op.item_id, patch);
                        break;
                    }
                    case 'remove_item':
                        updated = sheetOps.deleteItem(directories, campaign.id, characterId, op.item_id);
                        break;
                    default:
                        return null;
                }
                if (updated) charactersById.set(updated.id, updated);
                return updated;
            },
            // Identity field updates (appearance, personality, voice,
            // background, name). For NPCs the Director applies these
            // directly; for the PC the loop emits an `identity_edit_request`
            // event and returns the update as pending, leaving the actual
            // write to the player's approve/deny action in the frontend.
            updateCharacter: (characterId, patch) => {
                const updated = characterStore.update(directories, campaign.id, characterId, patch);
                if (updated) {
                    charactersById.set(updated.id, updated);
                    writeStCardForCharacter(directories, updated);
                    if (updated.is_player) mirrorCharacterToPersona(directories, updated);
                }
                return updated;
            },
            memoryService,
            sceneIndex,
        });
    } catch (err) {
        console.error('[gm] turn loop crashed', err);
        try {
            await emit({
                kind: 'error',
                code: 'loop_crash',
                message: err?.message || String(err),
                retryable: false,
            });
            await emit({ kind: 'end_of_turn', reason: 'error' });
        } catch (_) { /* swallow */ }
    } finally {
        if (!response.writableEnded) response.end();
    }
}

/**
 * Compute a monotonically increasing scene_index used by the decay model
 * to estimate "scenes elapsed". For now we approximate with the scene's
 * `started_at` epoch shifted into days; the absolute number doesn't
 * matter — only the ordering does.
 *
 * @param {{ started_at?: string, message_count?: number }} scene
 */
function computeSceneIndex(scene) {
    if (!scene) return 0;
    const started = Date.parse(scene.started_at || '') || 0;
    if (!started) return Math.max(0, Number(scene.message_count) || 0);
    // Days since 2025-01-01 — keeps numbers small but monotonic across
    // calendar months. Fractional values are fine.
    const epoch = Date.parse('2025-01-01T00:00:00Z');
    const days = (started - epoch) / (1000 * 60 * 60 * 24);
    return Math.max(0, days + (Number(scene.message_count) || 0) * 0.01);
}

/**
 * Format the last N chars of a transcript for prompt context. Each line
 * becomes `<name>: <message>`.
 *
 * @param {Array<any>} lines
 * @param {number} maxChars
 */
function formatTranscriptTail(lines, maxChars) {
    if (!Array.isArray(lines) || lines.length === 0) return '';
    const parts = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln) continue;
        const who = ln.name || (ln.is_user ? 'Player' : (ln.extra?.role || 'Narrator'));
        const text = (ln.mes || '').trim();
        if (!text) continue;
        const piece = `${who}: ${text}`;
        if (total + piece.length + 1 > maxChars && parts.length > 0) break;
        parts.push(piece);
        total += piece.length + 1;
    }
    parts.reverse();
    return parts.join('\n');
}
