/**
 * Standalone error class for LLM client failures.
 *
 * Lives outside `client.js` so callers (the Director loop, the actor /
 * narrator dispatchers) can `instanceof`-check without dragging the
 * transport stack — and its config-bound dependencies — into their import
 * graph. The Phase 5 tests rely on this separation: `loop.js` only needs
 * `LlmError`, not `createLlmClient`.
 */

export class LlmError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {boolean} retryable
     */
    constructor(code, message, retryable = false) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }
}
