/**
 * Bounded Director loop for a single player turn.
 *
 * Phase 6 dispatcher table:
 *   - `speak: narrator`       → Narrator client; emit a `message` (role:narrator).
 *   - `speak: <character_id>` → Actor client; emit a `message` (role:actor).
 *                               Per-actor scoped prompt — never sees other
 *                               actors' sheets.
 *   - `skill_check`           → adjudicator decides skill/DC/severity, engine
 *                               rolls the d20, narrator writes the post-roll
 *                               beat. Emits ONE `roll` event combining the
 *                               card + narration so the frontend renders a
 *                               single styled bubble. `required:false` returns
 *                               to the loop without forcing the narrator.
 *   - `spawn_character` (`from_source: 'library'`, `ref: <id>`) →
 *         add to `scene.participants`, emit a `state` (`change: 'spawn'`).
 *   - `spawn_character` (`from_source: 'new'`) →
 *         emit a structured `error` (`code: 'unsupported_source'`); the
 *         loop ends the turn. AI character generation is Phase 10.
 *   - `remove_character`      → remove from `scene.participants`, emit a
 *                               `state` (`change: 'remove'`).
 *   - `end_turn`              → emit `end_of_turn`.
 *   - everything else         → `error: unsupported_action`, force end.
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

/**
 * @typedef {object} TurnEvent
 * @property {('status'|'message'|'state'|'roll'|'error'|'end_of_turn')} kind
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
 * @property {object} [card]       for roll: RollCard payload (skill, dc, breakdown, outcome, severity)
 * @property {string} [narration]  for roll: post-roll narrator prose
 * @property {string} [intent]     for roll: original director intent
 * @property {string} [code]       for error
 * @property {string} [message]    for error
 * @property {boolean} [retryable] for error
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
                } else {
                    await emit({
                        kind: 'status',
                        phase: 'directing',
                        message: 'add_lore: no memory service available; recording skipped.',
                    });
                }
            } else {
                await emit({
                    kind: 'status',
                    phase: 'directing',
                    message: 'add_lore: no memory service available; recording skipped.',
                });
            }
            continue;
        }

        if (decision.action === 'speak') {
            const speakResult = await dispatchSpeak({
                ctx, decision, actorClient, emit, signal, findCharacter,
                memoryService, cid, sceneIndex,
            });
            if (speakResult === 'end') {
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
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
                findCharacter,
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

        if (decision.action === 'spawn_character') {
            const result = await dispatchSpawn({
                ctx, decision, emit, addParticipant, findCharacter,
            });
            if (result === 'end') {
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
            }
            continue;
        }

        if (decision.action === 'remove_character') {
            const result = await dispatchRemove({
                ctx, decision, emit, removeParticipant, findCharacter,
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
 * Dispatch a `speak` decision. Returns 'end' if the loop should terminate
 * (an unrecoverable error was emitted) or undefined to continue.
 *
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   actorClient: import('../llm/client.d.ts').LlmClient,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   signal?: AbortSignal,
 *   findCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 * }} args
 */
async function dispatchSpeak({ ctx, decision, actorClient, emit, signal, findCharacter, memoryService, cid, sceneIndex }) {
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
        ctx.user_input = '[The narrator has just spoken. Decide whether another beat is needed; if not, emit `end_turn`.]';

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
        return;
    }

    // Per-actor scoped speak. The Director picked an actor id; resolve the
    // character record via the loop's character lookup. The loop validates
    // membership in `ctx.actors` (the scene roster) before calling out so a
    // hallucinated id can't sneak through.
    const inScene = (ctx.actors || []).some(a => a.id === decision.actor && !a.is_player_only_marker);
    if (!inScene) {
        await emit({
            kind: 'error',
            code: 'unknown_actor',
            message: `Actor "${decision.actor}" is not in the current scene roster.`,
            retryable: false,
        });
        return 'end';
    }
    const character = findCharacter ? findCharacter(decision.actor) : null;
    if (!character) {
        await emit({
            kind: 'error',
            code: 'character_not_found',
            message: `Could not load character "${decision.actor}".`,
            retryable: false,
        });
        return 'end';
    }
    if (character.is_player) {
        await emit({
            kind: 'error',
            code: 'cannot_speak_for_player',
            message: 'The Director cannot speak for the player character. Pick the narrator or an NPC.',
            retryable: false,
        });
        return 'end';
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
    await emit({
        kind: 'message',
        actor: character.id,
        actor_id: character.id,
        name: character.name,
        role: 'actor',
        text,
    });
    appendToTail(ctx, character.name, text);

    if (memoryService && cid) {
        // Fire-and-forget opinion extractor. Bounded by the schema (max 2
        // memories) and the false-positive guard `is_significant`.
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
    return;
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
    ctx.user_input = '[A roll just resolved. Decide whether the player needs another beat or end the turn.]';
    return;
}

/**
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   addParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   findCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 * }} args
 */
async function dispatchSpawn({ ctx, decision, emit, addParticipant, findCharacter }) {
    if (decision.from_source === 'new') {
        await emit({
            kind: 'error',
            code: 'unsupported_source',
            message: 'Generating a brand new character is not yet wired (Phase 6/10). Use a campaign character via from_source: "library".',
            retryable: false,
        });
        return 'end';
    }
    if (decision.from_source !== 'library') {
        await emit({
            kind: 'error',
            code: 'invalid_source',
            message: `spawn_character from_source must be "library" or "new"; got "${decision.from_source}".`,
            retryable: false,
        });
        return 'end';
    }
    const ref = decision.ref;
    if (!ref || typeof ref !== 'string') {
        await emit({
            kind: 'error',
            code: 'missing_ref',
            message: 'spawn_character from_source: "library" requires a `ref` (character id).',
            retryable: false,
        });
        return 'end';
    }
    const character = findCharacter ? findCharacter(ref) : null;
    if (!character) {
        await emit({
            kind: 'error',
            code: 'character_not_found',
            message: `Character "${ref}" is not in this campaign.`,
            retryable: false,
        });
        return 'end';
    }
    const already = (ctx.actors || []).some(a => a.id === ref);
    if (already) {
        // Idempotent: re-spawning a present participant is a no-op + status.
        await emit({
            kind: 'status',
            phase: 'directing',
            message: `${character.name} is already in the scene.`,
        });
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
    return;
}

/**
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   decision: any,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   removeParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   findCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 * }} args
 */
async function dispatchRemove({ ctx, decision, emit, removeParticipant, findCharacter }) {
    const id = decision.character_id;
    if (!id || typeof id !== 'string') {
        await emit({
            kind: 'error',
            code: 'missing_character_id',
            message: 'remove_character requires a `character_id`.',
            retryable: false,
        });
        return 'end';
    }
    const character = findCharacter ? findCharacter(id) : null;
    if (!character) {
        await emit({
            kind: 'error',
            code: 'character_not_found',
            message: `Character "${id}" is not in this campaign.`,
            retryable: false,
        });
        return 'end';
    }
    if (character.is_player) {
        await emit({
            kind: 'error',
            code: 'cannot_remove_player',
            message: 'The player character cannot be removed from a scene.',
            retryable: false,
        });
        return 'end';
    }
    const present = (ctx.actors || []).some(a => a.id === id);
    if (!present) {
        await emit({
            kind: 'status',
            phase: 'directing',
            message: `${character.name} is not in the scene.`,
        });
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
