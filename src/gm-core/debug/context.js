/**
 * Async-propagated debug context.
 *
 * Uses Node's `AsyncLocalStorage` so any code running inside a
 * `withDebugContext()` call can retrieve the active `DebugContext`
 * without requiring it to be threaded through every function signature.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * @typedef {import('./schemas.js').DebugContext} DebugContext
 */

/** @type {AsyncLocalStorage<DebugContext>} */
const als = new AsyncLocalStorage();

/**
 * Run `fn` inside an AsyncLocalStorage context carrying `ctx`.
 *
 * @template T
 * @param {DebugContext} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function withDebugContext(ctx, fn) {
    return als.run(ctx, fn);
}

/**
 * Return the active `DebugContext`, or `null` if called outside of a
 * `withDebugContext` scope.
 *
 * @returns {DebugContext | null}
 */
export function currentContext() {
    return als.getStore() ?? null;
}
