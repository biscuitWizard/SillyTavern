/**
 * Bounded Director loop for a single player turn.
 *
 * Phase 5 dispatcher table:
 *   - `speak: narrator`       → Narrator client; emit a `message` (role:narrator).
 *   - `speak: <character_id>` → Actor client; emit a `message` (role:actor).
 *                               Per-actor scoped prompt — never sees other
 *                               actors' sheets.
 *   - `spawn_character` (`from_source: 'library'`, `ref: <id>`) →
 *         add to `scene.participants`, emit a `state` (`change: 'spawn'`).
 *   - `spawn_character` (`from_source: 'new'`) →
 *         emit a structured `error` (`code: 'unsupported_source'`); the
 *         loop ends the turn. AI character generation is Phase 6/10.
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

// A well-behaved turn looks like: speak(narrator) -> end_turn. We give the
// loop a small amount of slack so a Director that mis-classifies a beat can
// still recover, but we never want to run away into a 5+ beat monologue. In
// Phase 5 the Director can stack `spawn_character` + `speak: <actor>` in one
// turn, so the cap rises slightly to absorb that path.
const DEFAULT_MAX_STEPS = 6;

/**
 * @typedef {object} TurnEvent
 * @property {('status'|'message'|'state'|'error'|'end_of_turn')} kind
 * @property {string} [phase]      for status: 'directing' | 'awaiting_actor' | 'closing'
 * @property {string} [actor]      for message
 * @property {string} [name]       for message: display name
 * @property {string} [text]       for message
 * @property {string} [role]       for message: 'narrator' | 'actor' | 'system'
 * @property {string} [actor_id]   for message: stable id of the speaking actor (when role='actor')
 * @property {string} [change]     for state: 'spawn' | 'remove'
 * @property {string} [character_id]    for state
 * @property {string} [character_name]  for state
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
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   addParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   removeParticipant?: (characterId: string) => Promise<import('../library/schemas.js').Character | null> | import('../library/schemas.js').Character | null,
 *   findCharacter?: (characterId: string) => import('../library/schemas.js').Character | null,
 *   signal?: AbortSignal,
 *   maxSteps?: number,
 * }} args
 */
export async function runTurn({
    ctx,
    directorClient,
    actorClient,
    emit,
    addParticipant,
    removeParticipant,
    findCharacter,
    signal,
    maxSteps = DEFAULT_MAX_STEPS,
}) {
    let step = 0;
    while (step < maxSteps) {
        if (signal?.aborted) {
            await emit({ kind: 'end_of_turn', reason: 'aborted' });
            return;
        }
        step++;

        await emit({ kind: 'status', phase: 'directing' });

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
            await emit({ kind: 'end_of_turn', reason: 'director' });
            return;
        }

        if (decision.action === 'speak') {
            const speakResult = await dispatchSpeak({
                ctx, decision, actorClient, emit, signal, findCharacter,
            });
            if (speakResult === 'end') {
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

    await emit({ kind: 'end_of_turn', reason: 'cap' });
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
async function dispatchSpeak({ ctx, decision, actorClient, emit, signal, findCharacter }) {
    await emit({ kind: 'status', phase: 'awaiting_actor' });

    const isNarrator = decision.actor === 'narrator';
    if (isNarrator) {
        let prose;
        try {
            prose = await actorClient.chat({
                system: narratorSystemPrompt(),
                user: narratorUserPrompt(ctx, decision.intent || ''),
                signal,
            });
        } catch (err) {
            await emitError(emit, err, 'narrator');
            return 'end';
        }
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

    let prose;
    try {
        prose = await actorClient.chat({
            system: actorSystemPrompt(ctx, character),
            user: actorUserPrompt(ctx, character, decision.intent || ''),
            signal,
        });
    } catch (err) {
        await emitError(emit, err, `actor:${character.id}`);
        return 'end';
    }
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
