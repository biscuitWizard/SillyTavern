/**
 * Bounded Director loop for a single player turn.
 *
 * Dispatcher table:
 *   - `speak: narrator`       → Narrator client; emit a `message` (role:narrator).
 *   - `speak: <character_id>` → Actor client; emit a `message` (role:actor).
 *                               Per-actor scoped prompt — never sees other
 *                               actors' sheets. If the id is not in the
 *                               scene roster, the loop emits a recoverable
 *                               `tool_error` with closest matches and a
 *                               `LAST BEAT` summary so the Director can
 *                               recover (`search_library`,
 *                               `spawn_character`, or end the turn) on the
 *                               next step.
 *   - `skill_check`           → adjudicator decides skill/DC/severity, engine
 *                               rolls the d20, narrator writes the post-roll
 *                               beat. Emits ONE `roll` event combining the
 *                               card + narration so the frontend renders a
 *                               single styled bubble. `required:false` returns
 *                               to the loop without forcing the narrator.
 *   - `search_library`        → in-memory fuzzy search over off-stage
 *                               characters. No state mutation. Returns the
 *                               match list as a `LAST BEAT` tool result.
 *   - `spawn_character` (`from_source: 'library'`, `ref: <id>`) →
 *         add to `scene.participants`, emit a `state` (`change: 'spawn'`).
 *   - `spawn_character` (`from_source: 'new'`, `name`, `brief`) →
 *         create a transient (in-memory only) character; mirror into
 *         `ctx.actors`; emit a `state` (`change: 'spawn'`, `ephemeral: true`).
 *         Persistence is deferred until the character first speaks
 *         (promote-on-speak). If they never speak in this turn, they vanish.
 *   - `remove_character`      → remove from `scene.participants`, emit a
 *                               `state` (`change: 'remove'`).
 *   - `add_lore`              → write a generated world-lore entry.
 *   - `end_turn`              → emit `end_of_turn`.
 *   - everything else         → `error: unsupported_action`, force end.
 *
 * # Between-step communication
 *
 * The loop talks to itself across iterations through `ctx.last_beat`. After
 * every non-terminal dispatch the loop sets `ctx.last_beat` to a short
 * summary of what happened (or, for tool actions, a structured tool result).
 * The Director's user prompt renders this in a `# LAST BEAT` block. This
 * replaces the older pattern of mutating `ctx.user_input` (which leaked
 * loop-internal hacks into the narrator/actor prompts and, more
 * importantly, kept making the Director think the player was still waiting
 * on a fresh response).
 *
 * The loop emits TurnEvent objects via the supplied `emit(ev)` callback;
 * the HTTP handler is responsible for serialising those to NDJSON. This
 * separation keeps the loop testable from Node without spinning up Express.
 */

import { directorSystemPrompt, directorUserPrompt } from './prompts.js';
import { narratorSystemPrompt, narratorUserPrompt } from '../narrator/prompts.js';
import { actorSystemPrompt, actorUserPrompt } from '../actors/prompts.js';
import { directorDecisionJsonSchema, validateDirectorDecision, SUPPORTED_ACTIONS } from './schemas.js';
import { LlmError } from '../llm/errors.js';
import * as skillEngine from '../skillcheck/engine.js';
import { narratorPostRollUserPrompt } from '../skillcheck/prompts.js';
import { formatSections } from '../rag/injection.js';
import { writeAddLore } from '../rag/writers/lore-add.js';
import { writeDirectorPacing } from '../rag/writers/director-pacing.js';
import { extractAndWriteOpinion } from '../rag/writers/opinion.js';
import { extractAndWriteNarratorContinuity } from '../rag/writers/narrator-continuity.js';

// A well-behaved turn looks like: speak(narrator) -> end_turn. We give the
// loop a small amount of slack so a Director that mis-classifies a beat can
// still recover, but we never want to run away into a 5+ beat monologue.
// Phase 5 raised the cap to absorb `spawn_character` + `speak: <actor>` in
// one turn; Phase 6 raises it again to absorb `skill_check` (one dispatch
// step that internally also consumes adjudicator + narrator calls) followed
// by an `end_turn`.
const DEFAULT_MAX_STEPS = 8;

// Per-speaker speak quotas inside a single turn. Small local models
// (qwen2.5:14b and friends) routinely ignore the system prompt's "default
// to end_turn after a speak" guidance and keep firing `speak: <same actor>`
// — and an actor LLM that reads its own prior message in the transcript
// tail will then regurgitate the same prose. The loop enforces these
// quotas hard: when the Director picks speak for a saturated actor, the
// loop converts the beat into an end_turn instead. This is a guardrail,
// not a budget — the prompt still asks the Director to stop earlier.
const MAX_SPEAKS_PER_ACTOR = 1;
const MAX_SPEAKS_NARRATOR  = 2;

/**
 * @typedef {object} TurnEvent
 * @property {('status'|'message'|'state'|'roll'|'error'|'tool_error'|'end_of_turn')} kind
 * @property {string} [phase]      for status: 'directing' | 'awaiting_actor' | 'rolling' | 'closing'
 * @property {string} [actor]      for message
 * @property {string} [name]       for message: display name
 * @property {string} [text]       for message
 * @property {string} [role]       for message: 'narrator' | 'actor' | 'system'
 * @property {string} [actor_id]   for message/roll: stable id of the speaking actor
 * @property {string} [actor_name] for roll
 * @property {string} [change]     for state: 'spawn' | 'remove'
 * @property {string} [character_id]    for state
 * @property {string} [character_name]  for state
 * @property {boolean} [ephemeral]      for state.spawn: character is held in-memory until first speak
 * @property {boolean} [promoted]       for state.spawn: a previously transient character was just persisted
 * @property {object} [card]       for roll: RollCard payload (skill, dc, breakdown, outcome, severity)
 * @property {string} [narration]  for roll: post-roll narrator prose
 * @property {string} [intent]     for roll: original director intent
 * @property {string} [code]       for error/tool_error
 * @property {string} [message]    for error/tool_error
 * @property {boolean} [retryable] for error
 * @property {string} [tool]       for tool_error: action name that errored (e.g. 'speak', 'spawn_character')
 * @property {string[]} [suggestions]   for tool_error: short human-readable recovery hints
 * @property {string} [reason]     for end_of_turn: 'director' | 'cap' | 'error' | 'aborted'
 */

/**
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   directorClient: import('../llm/client.d.ts').LlmClient,
 *   actorClient:    import('../llm/client.d.ts').LlmClient,
 *   adjudicatorClient?: import('../llm/client.d.ts').LlmClient,
 *   ruleset?: import('../rulesets/schemas.d.ts').Ruleset | null,
 *   rng?: () => number,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   addParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   removeParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   findCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 *   createCharacter?: (input: Partial<import('../library/schemas.js').Character> & { name: string }) => Promise<import('../library/schemas.js').Character> | import('../library/schemas.js').Character,
 *   signal?: AbortSignal,
 *   maxSteps?: number,
 *   memoryService?: import('../rag/service.d.ts').MemoryService | null,
 *   sceneIndex?: number,
 * }} args
 */
export async function runTurn({
    ctx,
    directorClient,
    actorClient,
    adjudicatorClient,
    ruleset,
    rng,
    emit,
    addParticipant,
    removeParticipant,
    findCharacter,
    createCharacter,
    signal,
    maxSteps = DEFAULT_MAX_STEPS,
    memoryService = null,
    sceneIndex = 0,
}) {
    // Adjudicator defaults to the Director's own client — both are
    // structured-output-only and operate without RAG, per DESIGN.md's memory
    // injection rules.
    const adjudicator = adjudicatorClient || directorClient;
    const cid = ctx.campaign?.id;
    let step = 0;
    let lastMemoryWriteId = 0;

    // Per-turn transient character store. The Director's `spawn_character`
    // with `from_source: 'new'` parks a new NPC here; we mirror them into
    // `ctx.actors` so subsequent steps can `speak` them. The character is
    // promoted to disk only when they actually speak (promote-on-speak), so
    // a typo'd spawn that's never followed up by a speak vanishes at end of
    // turn. Map<id, Character>.
    /** @type {Map<string, import('../library/schemas.js').Character>} */
    const transientCharacters = new Map();
    /** @type {Set<string>} */
    const promotedTransients = new Set();

    /** @param {string} id */
    const resolveCharacter = (id) => {
        if (!id) return null;
        if (transientCharacters.has(id)) return transientCharacters.get(id) || null;
        return findCharacter ? findCharacter(id) : null;
    };

    // Per-turn speak quotas keyed by actor id (or 'narrator'). See
    // MAX_SPEAKS_PER_ACTOR / MAX_SPEAKS_NARRATOR above.
    /** @type {Map<string, number>} */
    const speakCounts = new Map();

    while (step < maxSteps) {
        if (signal?.aborted) {
            await emit({ kind: 'end_of_turn', reason: 'aborted' });
            return;
        }
        step++;

        await emit({ kind: 'status', phase: 'directing' });

        // Build the Director MEMORIES block — top 6 from world_lore + top 2
        // from director_memory. Disk-canonical store; if Qdrant is down the
        // service returns empty hits and the loop continues.
        if (memoryService && cid) {
            try {
                const queryText = pickQueryText(ctx);
                const slice = await memoryService.for_director({ campaignId: cid, queryText });
                ctx.memories_block = formatSections([
                    { kind: 'world_lore', hits: slice.world },
                    { kind: 'director_memory', hits: slice.director, max: 4 },
                ]);
            } catch (err) {
                console.warn('[director-loop] memory injection failed', err?.message || err);
                ctx.memories_block = '';
            }
        }

        let decision;
        try {
            decision = await directorClient.structured({
                system: directorSystemPrompt(ctx),
                user: directorUserPrompt(ctx),
                schema: directorDecisionJsonSchema,
                schemaName: 'DirectorDecision',
                signal,
            });
        } catch (err) {
            await emitError(emit, err, 'director');
            await emit({ kind: 'end_of_turn', reason: 'error' });
            return;
        }

        const validationErr = validateDirectorDecision(decision);
        if (validationErr) {
            await emit({ kind: 'error', code: 'invalid_decision', message: validationErr, retryable: false });
            await emit({ kind: 'end_of_turn', reason: 'error' });
            return;
        }

        if (!SUPPORTED_ACTIONS.has(decision.action)) {
            await emit({
                kind: 'error',
                code: 'unsupported_action',
                message: `Action "${decision.action}" is not yet implemented in this phase.`,
                retryable: false,
            });
            await emit({ kind: 'end_of_turn', reason: 'error' });
            return;
        }

        if (decision.action === 'end_turn') {
            // Phase 7: persist a director pacing note to director_memory if
            // the Director provided one via the optional `pacing_note` field.
            if (memoryService && cid && typeof decision.pacing_note === 'string') {
                writeDirectorPacing({
                    memoryService,
                    campaignId: cid,
                    sceneId: ctx.scene?.id || '',
                    sceneIndex,
                    pacingNote: decision.pacing_note,
                }).catch(() => {});
            }
            await emit({ kind: 'end_of_turn', reason: 'director' });
            return;
        }

        if (decision.action === 'add_lore') {
            if (memoryService && cid) {
                const result = await writeAddLore({
                    memoryService,
                    campaignId: cid,
                    sceneId: ctx.scene?.id || '',
                    sceneIndex,
                    directorStepIndex: step,
                    decision,
                });
                if (result.wrote && result.id) {
                    await emit({
                        kind: 'memory_write',
                        memory_kind: 'world_lore',
                        record_id: result.id,
                        title: decision.title,
                    });
                    appendToTail(ctx, 'System', `[lore added: ${decision.title}]`);
                    ctx.last_beat = `add_lore committed: "${decision.title}". Decide the next beat (typically end_turn unless the player is still owed a response).`;
                } else {
                    await emit({
                        kind: 'status',
                        phase: 'directing',
                        message: 'add_lore: no memory service available; recording skipped.',
                    });
                    ctx.last_beat = 'add_lore: no memory service available; the lore was NOT recorded. Continue with the next beat.';
                }
            } else {
                await emit({
                    kind: 'status',
                    phase: 'directing',
                    message: 'add_lore: no memory service available; recording skipped.',
                });
                ctx.last_beat = 'add_lore: no memory service available; the lore was NOT recorded. Continue with the next beat.';
            }
            continue;
        }

        if (decision.action === 'speak') {
            // Quota check BEFORE dispatch: if this actor has already
            // saturated their per-turn budget, swallow the speak and end
            // the turn. Local LLMs routinely chain `speak: <same actor>`
            // even when the prompt says not to; this is the loop's hard
            // backstop against runaway monologues.
            const actorKey = decision.actor === 'narrator' ? 'narrator' : decision.actor;
            const cap = decision.actor === 'narrator' ? MAX_SPEAKS_NARRATOR : MAX_SPEAKS_PER_ACTOR;
            const used = speakCounts.get(actorKey) || 0;
            if (used >= cap) {
                await emit({
                    kind: 'status',
                    phase: 'closing',
                    message: `Speak quota for ${actorKey} reached (${used}/${cap}); ending the turn.`,
                });
                await emit({ kind: 'end_of_turn', reason: 'cap' });
                return;
            }
            const speakResult = await dispatchSpeak({
                ctx, decision, actorClient, emit, signal,
                resolveCharacter,
                transientCharacters,
                promotedTransients,
                createCharacter,
                addParticipant,
                memoryService, cid, sceneIndex,
            });
            if (speakResult === 'end') {
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
            }
            // Only count an actual emitted speak. dispatchSpeak returns
            // undefined on a tool_error (e.g. unknown actor) without
            // having called the LLM — those don't count against the quota.
            if (speakResult === 'spoke') {
                speakCounts.set(actorKey, used + 1);
            }
            continue;
        }

        if (decision.action === 'skill_check') {
            const result = await dispatchSkillCheck({
                ctx,
                decision,
                ruleset: ruleset || null,
                adjudicatorClient: adjudicator,
                actorClient,
                rng,
                emit,
                signal,
                findCharacter: resolveCharacter,
                memoryService,
                cid,
                sceneIndex,
            });
            if (result === 'end') {
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
            }
            continue;
        }

        if (decision.action === 'search_library') {
            await dispatchSearchLibrary({ ctx, decision });
            continue;
        }

        if (decision.action === 'spawn_character') {
            const result = await dispatchSpawn({
                ctx, decision, emit,
                addParticipant,
                resolveCharacter,
                transientCharacters,
            });
            if (result === 'end') {
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
            }
            continue;
        }

        if (decision.action === 'remove_character') {
            const result = await dispatchRemove({
                ctx, decision, emit, removeParticipant,
                findCharacter: resolveCharacter,
                transientCharacters,
                promotedTransients,
            });
            if (result === 'end') {
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
            }
            continue;
        }

        // Unreachable: any newly supported action should have a branch above.
        await emit({ kind: 'error', code: 'internal', message: `Unhandled supported action ${decision.action}` });
        await emit({ kind: 'end_of_turn', reason: 'error' });
        return;
    }

    void lastMemoryWriteId; // reserved for future debug hooks
    await emit({ kind: 'end_of_turn', reason: 'cap' });
}

/**
 * Pick a query string for retrieval. Prefer the player's latest input;
 * fall back to the recent transcript tail's last line if input is
 * silent.
 *
 * @param {import('./prompts.js').TurnContext} ctx
 */
function pickQueryText(ctx) {
    const ui = String(ctx.user_input || '').trim();
    if (ui) return ui;
    const tail = String(ctx.recent_transcript || '').trim();
    if (!tail) return '';
    const lines = tail.split('\n').filter(Boolean);
    return lines[lines.length - 1] || '';
}

/**
 * Dispatch a `speak` decision. Return values:
 *   - 'spoke' — the actor LLM was called and a `message` event was
 *     emitted. The caller increments the per-turn speak quota.
 *   - 'end'   — an unrecoverable error was emitted; the loop should
 *     terminate.
 *   - undefined — a recoverable tool_error was emitted (e.g. unknown
 *     actor id). The Director gets a `LAST BEAT` summary and the loop
 *     continues so it can recover.
 *
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   actorClient: import('../llm/client.d.ts').LlmClient,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   signal?: AbortSignal,
 *   resolveCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 *   transientCharacters?: Map<string, import('../library/schemas.js').Character>,
 *   promotedTransients?: Set<string>,
 *   createCharacter?: (input: Partial<import('../library/schemas.js').Character> & { name: string }) => Promise<import('../library/schemas.js').Character> | import('../library/schemas.js').Character,
 *   addParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 * }} args
 */
async function dispatchSpeak({
    ctx, decision, actorClient, emit, signal,
    resolveCharacter, transientCharacters, promotedTransients,
    createCharacter, addParticipant,
    memoryService, cid, sceneIndex,
}) {
    await emit({ kind: 'status', phase: 'awaiting_actor' });

    const isNarrator = decision.actor === 'narrator';
    if (isNarrator) {
        // Narrator MEMORIES block: world_lore + own narrator_memory.
        const previousMemoriesBlock = ctx.memories_block;
        if (memoryService && cid) {
            try {
                const slice = await memoryService.for_narrator({
                    campaignId: cid,
                    queryText: decision.intent || pickQueryText(ctx),
                });
                ctx.memories_block = formatSections([
                    { kind: 'world_lore', hits: slice.world },
                    { kind: 'narrator_memory', hits: slice.narrator, max: 4 },
                ]);
            } catch (err) {
                console.warn('[loop.narrator] memory injection failed', err?.message || err);
                ctx.memories_block = '';
            }
        }
        let prose;
        try {
            prose = await actorClient.chat({
                system: narratorSystemPrompt(),
                user: narratorUserPrompt(ctx, decision.intent || ''),
                signal,
            });
        } catch (err) {
            ctx.memories_block = previousMemoriesBlock;
            await emitError(emit, err, 'narrator');
            return 'end';
        }
        // Restore the Director-side memories block for subsequent steps.
        ctx.memories_block = previousMemoriesBlock;
        const text = (prose || '').trim();
        await emit({
            kind: 'message',
            actor: 'narrator',
            name: 'Narrator',
            role: 'narrator',
            text,
        });
        appendToTail(ctx, 'Narrator', text);
        ctx.last_beat = `Narrator just delivered the beat (intent: "${truncateForBeat(decision.intent)}"). The player has been responded to. Default to end_turn unless the player\'s input clearly demanded another beat.`;
        // Return value below is assigned after the memory hooks fire.

        if (memoryService && cid) {
            // Fire-and-forget continuity extractor. Its writes emit their own
            // memory_write events through the service path.
            extractAndWriteNarratorContinuity({
                memoryService,
                client: actorClient,
                campaignId: cid,
                sceneId: ctx.scene?.id || '',
                sceneName: ctx.scene?.name,
                location: ctx.scene?.location,
                sceneIndex,
                prose: text,
            }).then(result => {
                for (const rec of result.hits || []) {
                    emit({ kind: 'memory_write', memory_kind: 'narrator_memory', record_id: rec.id, title: rec.content }).catch(() => {});
                }
            }).catch(() => {});
        }
        return 'spoke';
    }

    // Per-actor scoped speak. The Director picked an actor id; resolve the
    // character record via the loop's character lookup (which transparently
    // checks transient characters first). If the id is not in the scene
    // roster, surface a helpful tool_error and continue the loop so the
    // Director can recover via search_library / spawn_character / end_turn.
    const inScene = (ctx.actors || []).some(a => a.id === decision.actor);
    if (!inScene) {
        const suggestions = buildUnknownActorSuggestions(ctx, decision.actor);
        await emit({
            kind: 'tool_error',
            tool: 'speak',
            code: 'unknown_actor',
            message: `Actor "${decision.actor}" is not in the current scene roster.`,
            suggestions,
        });
        ctx.last_beat = formatToolError({
            tool: 'speak',
            code: 'unknown_actor',
            message: `Actor "${decision.actor}" is not in the current scene roster.`,
            suggestions,
        });
        return;
    }
    const character = resolveCharacter ? resolveCharacter(decision.actor) : null;
    if (!character) {
        const suggestions = buildUnknownActorSuggestions(ctx, decision.actor);
        await emit({
            kind: 'tool_error',
            tool: 'speak',
            code: 'character_not_found',
            message: `Could not load character "${decision.actor}".`,
            suggestions,
        });
        ctx.last_beat = formatToolError({
            tool: 'speak',
            code: 'character_not_found',
            message: `Could not load character "${decision.actor}".`,
            suggestions,
        });
        return;
    }
    if (character.is_player) {
        await emit({
            kind: 'tool_error',
            tool: 'speak',
            code: 'cannot_speak_for_player',
            message: 'The Director cannot speak for the player character. Pick the narrator or an NPC.',
        });
        ctx.last_beat = formatToolError({
            tool: 'speak',
            code: 'cannot_speak_for_player',
            message: `Tried to speak as the player character "${character.name}". The player drives the player. Pick narrator or an NPC; if no NPC fits, end_turn.`,
        });
        return;
    }

    // Per-actor MEMORIES block. Built per-call so the prior Director-side
    // block doesn't leak into the actor prompt.
    const previousMemoriesBlock = ctx.memories_block;
    if (memoryService && cid) {
        try {
            const slice = await memoryService.for_character({
                campaignId: cid,
                characterId: character.id,
                queryText: decision.intent || pickQueryText(ctx),
            });
            ctx.memories_block = formatSections([
                { kind: 'character_memory', label: character.id, hits: slice.character, max: 4 },
                { kind: 'world_lore', hits: slice.world, max: 5 },
                { kind: 'player_journal', hits: slice.player_journal, max: 1 },
            ]);
        } catch (err) {
            console.warn('[loop.actor] memory injection failed', err?.message || err);
            ctx.memories_block = '';
        }
    }

    let prose;
    try {
        prose = await actorClient.chat({
            system: actorSystemPrompt(ctx, character),
            user: actorUserPrompt(ctx, character, decision.intent || ''),
            signal,
        });
    } catch (err) {
        ctx.memories_block = previousMemoriesBlock;
        await emitError(emit, err, `actor:${character.id}`);
        return 'end';
    }
    ctx.memories_block = previousMemoriesBlock;
    const text = (prose || '').trim();

    // Promote-on-speak: if the speaking character is a transient (created
    // via spawn_character: from_source: 'new'), persist them now and add to
    // scene.participants. This way a typo'd / abandoned spawn vanishes at
    // end of turn — only characters who actually said something become
    // permanent campaign records.
    let promotedNow = false;
    if (transientCharacters && transientCharacters.has(character.id) && !promotedTransients?.has(character.id)) {
        const promoted = await promoteTransient({
            transient: character,
            createCharacter,
            addParticipant,
        });
        if (promoted) {
            // Replace the transient with the persisted record across ctx.
            transientCharacters.set(promoted.id, promoted);
            promotedTransients?.add(promoted.id);
            const idx = (ctx.actors || []).findIndex(a => a.id === character.id);
            if (idx >= 0) {
                ctx.actors[idx] = {
                    id: promoted.id,
                    name: promoted.name,
                    is_player: promoted.is_player,
                    appearance: promoted.appearance,
                    personality: promoted.personality,
                    voice: promoted.voice,
                    background: promoted.background,
                };
            }
            promotedNow = true;
            await emit({
                kind: 'state',
                change: 'spawn',
                character_id: promoted.id,
                character_name: promoted.name,
                promoted: true,
            });
        }
    }

    await emit({
        kind: 'message',
        actor: character.id,
        actor_id: character.id,
        name: character.name,
        role: 'actor',
        text,
    });
    appendToTail(ctx, character.name, text);
    ctx.last_beat = `${character.name} (id: \`${character.id}\`) just spoke in response to the player's input${promotedNow ? ' (and was promoted from transient to a persistent campaign character)' : ''}. Default to end_turn unless the player's input clearly addressed multiple characters.`;

    if (memoryService && cid && !promotedNow) {
        // Fire-and-forget opinion extractor. Bounded by the schema (max 2
        // memories) and the false-positive guard `is_significant`.
        // Skip on the first speak of a freshly promoted character: there's
        // no character_memory collection for them yet to populate, and the
        // RAG service may be initialising the new collection.
        extractAndWriteOpinion({
            memoryService,
            client: actorClient,
            campaignId: cid,
            character,
            sceneId: ctx.scene?.id || '',
            sceneIndex,
            messageIndex: Date.now(),
            lastMessage: text,
            transcriptTail: ctx.recent_transcript || '',
        }).then(result => {
            for (const rec of result.hits || []) {
                emit({ kind: 'memory_write', memory_kind: 'character_memory', record_id: rec.id, title: rec.content, character_id: character.id }).catch(() => {});
            }
        }).catch(() => {});
    }
    return 'spoke';
}

/**
 * Promote a transient character to disk + scene participants. Returns the
 * persisted record on success, or null if persistence isn't wired (in
 * which case the transient stays transient and the speak still went out
 * with the in-memory identity — better than failing the beat).
 *
 * @param {{
 *   transient: import('../library/schemas.js').Character,
 *   createCharacter?: (input: Partial<import('../library/schemas.js').Character> & { name: string }) => Promise<import('../library/schemas.js').Character> | import('../library/schemas.js').Character,
 *   addParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 * }} args
 */
async function promoteTransient({ transient, createCharacter, addParticipant }) {
    if (!createCharacter) return null;
    try {
        const persisted = await createCharacter({
            name: transient.name,
            is_player: false,
            appearance: transient.appearance || '',
            personality: transient.personality || '',
            voice: transient.voice || '',
            background: transient.background || '',
            sheet: transient.sheet,
        });
        if (!persisted) return null;
        if (addParticipant) {
            try {
                await addParticipant(persisted.id);
            } catch (err) {
                console.warn('[loop.promote] addParticipant failed', err?.message || err);
            }
        }
        return persisted;
    } catch (err) {
        console.warn('[loop.promote] createCharacter failed', err?.message || err);
        return null;
    }
}

/** @param {string} s */
function truncateForBeat(s) {
    if (typeof s !== 'string') return '';
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/**
 * Fuzzy match an unknown actor id/name against the current scene roster
 * and the off-stage library. Returns short hint strings the Director can
 * use to recover.
 *
 * @param {import('./prompts.js').TurnContext} ctx
 * @param {string} unknownId
 * @returns {string[]}
 */
function buildUnknownActorSuggestions(ctx, unknownId) {
    const needle = String(unknownId || '').toLowerCase();
    /** @type {string[]} */
    const out = [];
    const inSceneNonPc = (ctx.actors || []).filter(a => !a.is_player);
    const inSceneMatches = inSceneNonPc
        .filter(a => fuzzyMatch(a.id, needle) || fuzzyMatch(a.name, needle))
        .slice(0, 3);
    if (inSceneMatches.length) {
        out.push(`Closest in-scene actors: ${inSceneMatches.map(a => `\`${a.id}\` (${a.name})`).join(', ')}`);
    } else if (inSceneNonPc.length) {
        out.push(`In-scene NPCs you can speak as: ${inSceneNonPc.slice(0, 5).map(a => `\`${a.id}\` (${a.name})`).join(', ')}`);
    }
    const lib = ctx.library_characters || [];
    const libMatches = lib
        .filter(a => fuzzyMatch(a.id, needle) || fuzzyMatch(a.name, needle))
        .slice(0, 3);
    if (libMatches.length) {
        out.push(`Possible library matches (use \`spawn_character\` from_source: "library", ref: <id> first): ${libMatches.map(a => `\`${a.id}\` (${a.name})`).join(', ')}`);
    } else if (lib.length) {
        out.push('No close library matches. Try `search_library` with a query string, or `spawn_character` with from_source: "new", name, brief.');
    } else {
        out.push('No off-stage library characters. Use `spawn_character` with from_source: "new", name, brief — or end the turn.');
    }
    return out;
}

/**
 * Crude case-insensitive substring + token-overlap match. Good enough for
 * "bartender" matching "the_bartender" / "Old Bartender" / etc.
 *
 * @param {string} candidate
 * @param {string} needle    already lower-cased
 */
function fuzzyMatch(candidate, needle) {
    if (!candidate || !needle) return false;
    const c = String(candidate).toLowerCase();
    if (c.includes(needle) || needle.includes(c)) return true;
    const cTokens = c.split(/[\s_\-]+/).filter(Boolean);
    const nTokens = needle.split(/[\s_\-]+/).filter(Boolean);
    return cTokens.some(t => nTokens.some(n => t === n || t.includes(n) || n.includes(t)));
}

/**
 * Render a tool error for the Director's `# LAST BEAT` block.
 *
 * @param {{ tool: string, code: string, message: string, suggestions?: string[] }} err
 */
function formatToolError({ tool, code, message, suggestions }) {
    const lines = [
        `Tool error from \`${tool}\` (code: ${code}): ${message}`,
    ];
    if (suggestions && suggestions.length) {
        lines.push('Suggestions:');
        for (const s of suggestions) lines.push(`- ${s}`);
    }
    lines.push('Pick a different action — DO NOT repeat the same call. End the turn if no recovery makes sense.');
    return lines.join('\n');
}

/**
 * Dispatch a `skill_check` decision.
 *
 * 1. Resolve the actor (PC or in-scene NPC); reject anyone outside the roster.
 * 2. Emit a `rolling` status pill so the UI can show feedback.
 * 3. Call `engine.decide(...)` — strict, structured, no RAG.
 * 4. If the decision says no roll is needed, emit a status note and return
 *    control to the loop (Director gets to pick the next beat).
 * 5. Otherwise: roll the dice (pure), call the post-roll Narrator with the
 *    outcome, emit ONE combined `kind: 'roll'` event with both the card and
 *    the narration. Append a synthetic transcript-tail entry so subsequent
 *    Director steps in the same turn can reason about the result.
 *
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   ruleset: import('../rulesets/schemas.d.ts').Ruleset | null,
 *   adjudicatorClient: import('../llm/client.d.ts').LlmClient,
 *   actorClient: import('../llm/client.d.ts').LlmClient,
 *   rng?: () => number,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   signal?: AbortSignal,
 *   findCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 * }} args
 */
async function dispatchSkillCheck({ ctx, decision, ruleset, adjudicatorClient, actorClient, rng, emit, signal, findCharacter, memoryService, cid, sceneIndex }) {
    if (!ruleset) {
        await emit({
            kind: 'error',
            code: 'no_ruleset',
            message: 'skill_check: no ruleset is loaded for this campaign.',
            retryable: false,
        });
        return 'end';
    }

    const actorId = decision.actor;
    const inScene = (ctx.actors || []).some(a => a.id === actorId);
    if (!actorId || !inScene) {
        await emit({
            kind: 'error',
            code: 'unknown_actor',
            message: `skill_check: actor "${actorId}" is not in the current scene roster.`,
            retryable: false,
        });
        return 'end';
    }
    const character = findCharacter ? findCharacter(actorId) : null;
    if (!character) {
        await emit({
            kind: 'error',
            code: 'character_not_found',
            message: `skill_check: could not load character "${actorId}".`,
            retryable: false,
        });
        return 'end';
    }

    await emit({ kind: 'status', phase: 'rolling' });

    let skillDecision;
    try {
        skillDecision = await skillEngine.decide({
            ruleset,
            intent: String(decision.intent || ''),
            actorName: character.name,
            client: adjudicatorClient,
            signal,
        });
    } catch (err) {
        await emitError(emit, err, 'adjudicator');
        return 'end';
    }

    if (!skillDecision.required) {
        // The adjudicator declined the roll. Surface a soft status so the
        // player can see something happened, then return to the loop without
        // forcing a narrator beat — the Director gets to pick the next move.
        await emit({
            kind: 'status',
            phase: 'directing',
            message: `No check needed: ${skillDecision.justification}`,
        });
        appendToTail(ctx, 'System', `[skill_check refused for ${character.name}: ${skillDecision.justification}]`);
        return;
    }

    /** @type {import('../skillcheck/schemas.d.ts').RollOutcome} */
    let outcome;
    try {
        outcome = skillEngine.roll({ ruleset, character, decision: skillDecision, rng });
    } catch (err) {
        await emit({
            kind: 'error',
            code: 'roll_failed',
            message: `skill_check roll: ${err?.message || err}`,
            retryable: false,
        });
        return 'end';
    }

    // Build the chat-side card before we kick off the narrator so we can
    // pass the rendered details into the prose prompt.
    const card = skillEngine.renderRollCard({
        ruleset,
        character,
        decision: skillDecision,
        outcome,
        intent: String(decision.intent || ''),
    });

    // Narrator MEMORIES block for the post-roll beat. Same shape as the
    // `speak: narrator` branch above.
    const previousMemoriesBlock = ctx.memories_block;
    if (memoryService && cid) {
        try {
            const slice = await memoryService.for_narrator({
                campaignId: cid,
                queryText: String(decision.intent || character.name),
            });
            ctx.memories_block = formatSections([
                { kind: 'world_lore', hits: slice.world },
                { kind: 'narrator_memory', hits: slice.narrator, max: 4 },
            ]);
        } catch (err) {
            console.warn('[loop.skillcheck.narrator] memory injection failed', err?.message || err);
            ctx.memories_block = '';
        }
    }

    let narration = '';
    try {
        const prose = await actorClient.chat({
            system: narratorSystemPrompt(),
            user: narratorPostRollUserPrompt(ctx, {
                actor_name: character.name,
                skill_name: card.skill_name,
                ability_name: card.ability_name,
                dc: card.dc,
                total: outcome.total,
                d20: outcome.d20,
                success: outcome.success,
                severity: skillDecision.failure_severity,
                crit: outcome.crit,
                intent: String(decision.intent || ''),
            }),
            signal,
        });
        narration = String(prose || '').trim();
    } catch (err) {
        ctx.memories_block = previousMemoriesBlock;
        await emitError(emit, err, 'narrator:post_roll');
        return 'end';
    }
    ctx.memories_block = previousMemoriesBlock;

    await emit({
        kind: 'roll',
        actor_id: character.id,
        actor_name: character.name,
        intent: String(decision.intent || ''),
        card,
        narration,
    });

    if (memoryService && cid) {
        // Narrator continuity from the post-roll beat as well as a hook so
        // the actor's character memory captures their own roll outcome.
        extractAndWriteNarratorContinuity({
            memoryService,
            client: actorClient,
            campaignId: cid,
            sceneId: ctx.scene?.id || '',
            sceneName: ctx.scene?.name,
            location: ctx.scene?.location,
            sceneIndex,
            prose: narration,
        }).catch(() => {});
    }

    // Synthesise a single recent-transcript line so subsequent Director steps
    // in the same turn can reason about what happened. We do NOT echo the
    // dice math — just the outcome and the prose, since that's what an
    // observer at the table would carry forward.
    const verdict = outcome.success ? 'succeeded' : 'failed';
    appendToTail(ctx, 'System', `[${character.name} ${verdict} their ${card.skill_name} check vs DC ${card.dc}]`);
    appendToTail(ctx, 'Narrator', narration);
    ctx.last_beat = `${character.name} ${verdict} a ${card.skill_name} check vs DC ${card.dc} (d20=${outcome.d20}, total=${outcome.total}). The Narrator already described the consequence. Default to end_turn — the player\'s next turn drives what happens next.`;
    return;
}

/**
 * Dispatch a `search_library` decision. No state mutation. Filters
 * `ctx.library_characters` (off-stage) by a free-text query against id,
 * name, and the short appearance/role blurb the HTTP wrapper attaches.
 * Result goes back via `ctx.last_beat` so the Director can decide what to
 * do with the matches on its next step.
 *
 * @param {{ ctx: import('./prompts.js').TurnContext, decision: any }} args
 */
async function dispatchSearchLibrary({ ctx, decision }) {
    const query = String(decision.query || '').trim();
    if (!query) {
        ctx.last_beat = formatToolError({
            tool: 'search_library',
            code: 'empty_query',
            message: 'search_library was called with an empty query.',
            suggestions: ['Try `search_library` again with a non-empty query, or `spawn_character` with from_source: "new", name, brief.'],
        });
        return;
    }
    const lib = ctx.library_characters || [];
    if (!lib.length) {
        ctx.last_beat = `Tool result from \`search_library\` (query: "${query}"): the campaign library has no off-stage characters. Use \`spawn_character\` with from_source: "new", name: "...", brief: "..." to invent one — or end the turn.`;
        return;
    }
    const needle = query.toLowerCase();
    const tokens = needle.split(/[\s_\-]+/).filter(Boolean);
    const scored = lib
        .map(c => {
            const hay = `${c.id || ''} ${c.name || ''} ${c.appearance || ''}`.toLowerCase();
            let score = 0;
            if (hay.includes(needle)) score += 5;
            for (const t of tokens) if (t && hay.includes(t)) score += 1;
            return { c, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(x => x.c);
    if (!scored.length) {
        ctx.last_beat = `Tool result from \`search_library\` (query: "${query}"): no off-stage characters matched. Either invent one with \`spawn_character\` (from_source: "new", name, brief) or end the turn.`;
        return;
    }
    const lines = [`Tool result from \`search_library\` (query: "${query}"): ${scored.length} match${scored.length === 1 ? '' : 'es'}:`];
    for (const c of scored) {
        const blurb = c.appearance ? ` — ${truncateForBeat(c.appearance)}` : '';
        lines.push(`- \`${c.id}\` — **${c.name}**${blurb}`);
    }
    lines.push('Use `spawn_character` with from_source: "library", ref: "<id>" to bring one of these characters on-stage, then `speak` them.');
    ctx.last_beat = lines.join('\n');
}

/**
 * Dispatch `spawn_character`. Two paths:
 *
 *   - `from_source: 'library'` — bring an existing campaign character into
 *     the scene; persisted immediately via `addParticipant`.
 *   - `from_source: 'new'` — invent a transient character (in-memory only).
 *     They appear in `ctx.actors` so the Director can `speak` them next,
 *     but persistence is deferred to first speak (promote-on-speak in
 *     `dispatchSpeak`). If they never speak this turn, they vanish.
 *
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   addParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   resolveCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 *   transientCharacters?: Map<string, import('../library/schemas.js').Character>,
 * }} args
 */
async function dispatchSpawn({ ctx, decision, emit, addParticipant, resolveCharacter, transientCharacters }) {
    if (decision.from_source === 'new') {
        return dispatchSpawnNew({ ctx, decision, emit, transientCharacters });
    }
    if (decision.from_source !== 'library') {
        const message = `spawn_character.from_source must be "library" or "new"; got "${decision.from_source}".`;
        await emit({
            kind: 'tool_error',
            tool: 'spawn_character',
            code: 'invalid_source',
            message,
        });
        ctx.last_beat = formatToolError({
            tool: 'spawn_character',
            code: 'invalid_source',
            message,
            suggestions: ['Use from_source: "library" with a `ref` from the library list, or from_source: "new" with `name` and `brief`.'],
        });
        return;
    }
    const ref = decision.ref;
    if (!ref || typeof ref !== 'string') {
        const message = 'spawn_character from_source: "library" requires a `ref` (character id).';
        await emit({
            kind: 'tool_error',
            tool: 'spawn_character',
            code: 'missing_ref',
            message,
        });
        ctx.last_beat = formatToolError({
            tool: 'spawn_character',
            code: 'missing_ref',
            message,
            suggestions: ['Use `search_library` first if you need to discover the right id.'],
        });
        return;
    }
    const character = resolveCharacter ? resolveCharacter(ref) : null;
    if (!character) {
        const message = `Character "${ref}" is not in this campaign.`;
        const suggestions = ['Try `search_library` with a query string, or `spawn_character` from_source: "new" with name and brief.'];
        await emit({
            kind: 'tool_error',
            tool: 'spawn_character',
            code: 'character_not_found',
            message,
            suggestions,
        });
        ctx.last_beat = formatToolError({
            tool: 'spawn_character',
            code: 'character_not_found',
            message,
            suggestions,
        });
        return;
    }
    const already = (ctx.actors || []).some(a => a.id === ref);
    if (already) {
        // Idempotent: re-spawning a present participant is a no-op + status.
        await emit({
            kind: 'status',
            phase: 'directing',
            message: `${character.name} is already in the scene.`,
        });
        ctx.last_beat = `${character.name} (id: \`${character.id}\`) was already in the scene; no roster change. Continue.`;
        return;
    }
    if (!addParticipant) {
        await emit({
            kind: 'error',
            code: 'no_participant_writer',
            message: 'spawn_character: scene participant writer not configured.',
            retryable: false,
        });
        return 'end';
    }
    try {
        await addParticipant(character.id);
    } catch (err) {
        await emit({
            kind: 'error',
            code: 'spawn_failed',
            message: `Failed to add ${character.name} to the scene: ${err?.message || err}`,
            retryable: false,
        });
        return 'end';
    }

    // Mirror the new participant into the working ctx so subsequent steps in
    // the same turn can reference them.
    ctx.actors = [...(ctx.actors || []), {
        id: character.id,
        name: character.name,
        is_player: character.is_player,
        appearance: character.appearance,
        personality: character.personality,
        voice: character.voice,
        background: character.background,
    }];

    await emit({
        kind: 'state',
        change: 'spawn',
        character_id: character.id,
        character_name: character.name,
    });
    ctx.last_beat = `${character.name} (id: \`${character.id}\`) entered the scene. Decide whether to \`speak\` as them next or hand the floor back via \`end_turn\`.`;
    return;
}

/**
 * Spawn a brand new character into the scene as a TRANSIENT — held only in
 * the loop's `transientCharacters` map and mirrored into `ctx.actors`.
 * Never written to disk here; persistence is deferred until the character
 * first speaks (see `promoteTransient` in `dispatchSpeak`).
 *
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   transientCharacters?: Map<string, import('../library/schemas.js').Character>,
 * }} args
 */
async function dispatchSpawnNew({ ctx, decision, emit, transientCharacters }) {
    const name = String(decision.name || '').trim();
    const brief = String(decision.brief || '').trim();
    if (!name || !brief) {
        const message = 'spawn_character from_source: "new" requires both `name` and `brief`.';
        await emit({
            kind: 'tool_error',
            tool: 'spawn_character',
            code: 'missing_fields',
            message,
        });
        ctx.last_beat = formatToolError({
            tool: 'spawn_character',
            code: 'missing_fields',
            message,
            suggestions: ['Retry with `name`: short display name, and `brief`: a one-sentence description (appearance, role, voice).'],
        });
        return;
    }
    if (!transientCharacters) {
        await emit({
            kind: 'error',
            code: 'no_transient_store',
            message: 'spawn_character (new): transient character store not configured.',
            retryable: false,
        });
        return 'end';
    }
    const usedIds = new Set([
        ...(ctx.actors || []).map(a => a.id),
        ...(ctx.library_characters || []).map(c => c.id),
        ...transientCharacters.keys(),
    ]);
    const id = generateTransientId(name, usedIds);
    const now = new Date().toISOString();
    /** @type {import('../library/schemas.js').Character} */
    const transient = {
        id,
        campaign_id: ctx.campaign?.id || '',
        name,
        is_player: false,
        appearance: brief,
        personality: '',
        voice: '',
        background: '',
        sheet: { stats: {}, statuses: {}, items: [], skills: [], notes: '' },
        st_card_avatar: null,
        created_at: now,
        updated_at: now,
    };
    transientCharacters.set(id, transient);
    ctx.actors = [...(ctx.actors || []), {
        id,
        name,
        is_player: false,
        appearance: brief,
    }];
    await emit({
        kind: 'state',
        change: 'spawn',
        character_id: id,
        character_name: name,
        ephemeral: true,
    });
    ctx.last_beat = `Transient character "${name}" (id: \`${id}\`) spawned into the scene with brief: "${brief}". They will become a permanent campaign character only if you \`speak\` as them this turn. Decide whether to \`speak\` them next.`;
    return;
}

/**
 * Generate a slug-style id from a name, suffixed if it collides.
 *
 * @param {string} name
 * @param {Set<string>} usedIds
 */
function generateTransientId(name, usedIds) {
    const base = String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'npc';
    if (!usedIds.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base}_${i}`;
        if (!usedIds.has(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
}

/**
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   removeParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   findCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 *   transientCharacters?: Map<string, import('../library/schemas.js').Character>,
 *   promotedTransients?: Set<string>,
 * }} args
 */
async function dispatchRemove({ ctx, decision, emit, removeParticipant, findCharacter, transientCharacters, promotedTransients }) {
    const id = decision.character_id;
    if (!id || typeof id !== 'string') {
        const message = 'remove_character requires a `character_id`.';
        await emit({
            kind: 'tool_error',
            tool: 'remove_character',
            code: 'missing_character_id',
            message,
        });
        ctx.last_beat = formatToolError({ tool: 'remove_character', code: 'missing_character_id', message });
        return;
    }
    const character = findCharacter ? findCharacter(id) : null;
    if (!character) {
        const message = `Character "${id}" is not in this campaign.`;
        await emit({
            kind: 'tool_error',
            tool: 'remove_character',
            code: 'character_not_found',
            message,
        });
        ctx.last_beat = formatToolError({ tool: 'remove_character', code: 'character_not_found', message });
        return;
    }
    if (character.is_player) {
        const message = 'The player character cannot be removed from a scene.';
        await emit({
            kind: 'tool_error',
            tool: 'remove_character',
            code: 'cannot_remove_player',
            message,
        });
        ctx.last_beat = formatToolError({ tool: 'remove_character', code: 'cannot_remove_player', message });
        return;
    }
    const present = (ctx.actors || []).some(a => a.id === id);
    if (!present) {
        await emit({
            kind: 'status',
            phase: 'directing',
            message: `${character.name} is not in the scene.`,
        });
        ctx.last_beat = `${character.name} (id: \`${character.id}\`) was not in the scene; nothing changed. Continue.`;
        return;
    }

    // Transient (un-promoted) characters live only in the loop's transient
    // map. Removing them is a memory-only op — no participant writer call.
    const isTransient = transientCharacters && transientCharacters.has(character.id) && !promotedTransients?.has(character.id);
    if (isTransient) {
        transientCharacters.delete(character.id);
        ctx.actors = (ctx.actors || []).filter(a => a.id !== id);
        await emit({
            kind: 'state',
            change: 'remove',
            character_id: character.id,
            character_name: character.name,
        });
        ctx.last_beat = `${character.name} (transient) removed before they ever spoke; they're gone with no campaign record. Continue.`;
        return;
    }

    if (!removeParticipant) {
        await emit({
            kind: 'error',
            code: 'no_participant_writer',
            message: 'remove_character: scene participant writer not configured.',
            retryable: false,
        });
        return 'end';
    }
    try {
        await removeParticipant(character.id);
    } catch (err) {
        await emit({
            kind: 'error',
            code: 'remove_failed',
            message: `Failed to remove ${character.name} from the scene: ${err?.message || err}`,
            retryable: false,
        });
        return 'end';
    }

    ctx.actors = (ctx.actors || []).filter(a => a.id !== id);

    await emit({
        kind: 'state',
        change: 'remove',
        character_id: character.id,
        character_name: character.name,
    });
    ctx.last_beat = `${character.name} (id: \`${character.id}\`) left the scene. Continue or end_turn.`;
    return;
}

/**
 * @param {(ev: TurnEvent) => Promise<void> | void} emit
 * @param {unknown} err
 * @param {string} stage
 */
async function emitError(emit, err, stage) {
    if (err instanceof LlmError) {
        await emit({ kind: 'error', code: err.code, message: `${stage}: ${err.message}`, retryable: err.retryable });
        return;
    }
    const message = (err && /** @type {Error} */(err).message) || String(err);
    await emit({ kind: 'error', code: 'unknown', message: `${stage}: ${message}`, retryable: false });
}

/**
 * @param {import('./prompts.js').TurnContext} ctx
 * @param {string} who
 * @param {string} text
 */
function appendToTail(ctx, who, text) {
    const tail = ctx.recent_transcript || '';
    const next = `${tail}${tail ? '\n' : ''}${who}: ${text}`;
    // Cap tail length to ~8000 chars (loose bound; the HTTP wrapper trims more
    // aggressively before passing the next director step).
    ctx.recent_transcript = next.length > 8000 ? next.slice(-8000) : next;
}
