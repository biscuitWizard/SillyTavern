/**
 * Bounded Director loop for a single player turn.
 *
 * Phase 4 dispatcher table:
 *   - `speak: narrator` → call the narrator client, emit a `message` event,
 *     persist into transcript, continue.
 *   - `end_turn`        → emit `end_of_turn` and return.
 *   - everything else   → emit `error` (`unsupported_action`), force end.
 *
 * The loop emits TurnEvent objects via the supplied `emit(ev)` callback;
 * the HTTP handler is responsible for serialising those to NDJSON. This
 * separation keeps the loop testable from Node without spinning up Express.
 */

import { directorSystemPrompt, directorUserPrompt } from './prompts.js';
import { narratorSystemPrompt, narratorUserPrompt } from '../narrator/prompts.js';
import { directorDecisionJsonSchema, validateDirectorDecision, SUPPORTED_ACTIONS } from './schemas.js';
import { LlmError } from '../llm/client.js';

// A well-behaved turn looks like: speak(narrator) -> end_turn. We give the
// loop a small amount of slack (3) so a Director that mis-classifies a beat
// can still recover, but we never want to run away into a 5+ beat monologue.
const DEFAULT_MAX_STEPS = 3;

/**
 * @typedef {object} TurnEvent
 * @property {('status'|'message'|'error'|'end_of_turn')} kind
 * @property {string} [phase]      for status: 'directing' | 'awaiting_actor' | 'closing'
 * @property {string} [actor]      for message
 * @property {string} [name]       for message: display name
 * @property {string} [text]       for message
 * @property {string} [role]       for message: 'narrator' | 'actor' | 'system'
 * @property {string} [code]       for error
 * @property {string} [message]    for error
 * @property {boolean} [retryable] for error
 * @property {string} [reason]     for end_of_turn: 'director' | 'cap' | 'error' | 'aborted'
 * @property {object} [decision]   for status: include the raw decision when phase === 'after_director'
 */

/**
 * @param {{
 *   ctx: import('./prompts.js').TurnContext,
 *   directorClient: import('../llm/client.d.ts').LlmClient,
 *   actorClient:    import('../llm/client.d.ts').LlmClient,
 *   emit: (ev: TurnEvent) => Promise<void> | void,
 *   signal?: AbortSignal,
 *   maxSteps?: number,
 * }} args
 */
export async function runTurn({ ctx, directorClient, actorClient, emit, signal, maxSteps = DEFAULT_MAX_STEPS }) {
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
                message: `Action "${decision.action}" is not yet implemented (Phase 4 only ships speak + end_turn).`,
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
            await emit({ kind: 'status', phase: 'awaiting_actor' });

            // Phase 4 wires only the Narrator. Other actors fall through to
            // an explicit error rather than silently routing to the narrator.
            if (decision.actor !== 'narrator') {
                await emit({
                    kind: 'error',
                    code: 'unsupported_actor',
                    message: `Actor "${decision.actor}" is not yet wired (Phase 4 only ships narrator).`,
                    retryable: false,
                });
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
            }

            let prose;
            try {
                prose = await actorClient.chat({
                    system: narratorSystemPrompt(),
                    user: narratorUserPrompt(ctx, decision.intent || ''),
                    signal,
                });
            } catch (err) {
                await emitError(emit, err, 'narrator');
                await emit({ kind: 'end_of_turn', reason: 'error' });
                return;
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

            // After a narrator beat the next call should almost always be
            // `end_turn` — replace user_input with an explicit instruction so
            // even a weaker Director can't accidentally chain another beat.
            ctx.user_input = '[The narrator has just spoken. The player has not had a chance to react yet. Emit `end_turn` now to hand control back to them.]';
            continue;
        }

        // Should not reach here.
        await emit({ kind: 'error', code: 'internal', message: `Unhandled supported action ${decision.action}` });
        await emit({ kind: 'end_of_turn', reason: 'error' });
        return;
    }

    await emit({ kind: 'end_of_turn', reason: 'cap' });
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
