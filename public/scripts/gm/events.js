/**
 * Tiny synchronous event bus for the GM shell.
 *
 * Lets one module (e.g. `turn-events.js`) broadcast a payload that any
 * other module (e.g. the Memory Explorer's live feed) can subscribe to
 * without either needing to know about the other. Subscriber callbacks
 * are invoked synchronously in registration order; a throwing handler
 * is logged but does not abort the rest.
 *
 * Usage:
 *
 *   import { on, emit } from './events.js';
 *   const off = on('memory_write', payload => console.log(payload));
 *   emit('memory_write', { ... });
 *   off();
 */

/** @type {Map<string, Set<(payload: any) => void>>} */
const listeners = new Map();

/**
 * Subscribe to an event. Returns an unsubscribe function — callers should
 * invoke it from their teardown path.
 *
 * @param {string} event
 * @param {(payload: any) => void} cb
 * @returns {() => void}
 */
export function on(event, cb) {
    if (typeof event !== 'string' || !event) throw new Error('events.on: event name required');
    if (typeof cb !== 'function') throw new Error('events.on: callback required');
    let set = listeners.get(event);
    if (!set) {
        set = new Set();
        listeners.set(event, set);
    }
    set.add(cb);
    return () => {
        const s = listeners.get(event);
        if (!s) return;
        s.delete(cb);
        if (!s.size) listeners.delete(event);
    };
}

/**
 * Broadcast an event payload to every subscriber. Each handler runs
 * inside its own try/catch so one bad listener can't break the rest.
 *
 * @param {string} event
 * @param {any} payload
 */
export function emit(event, payload) {
    const set = listeners.get(event);
    if (!set || !set.size) return;
    // Snapshot the set so a handler that unsubscribes itself doesn't
    // mutate the iteration.
    for (const cb of [...set]) {
        try {
            cb(payload);
        } catch (err) {
            console.error(`[gm] events.emit handler for "${event}" threw`, err);
        }
    }
}

/**
 * Test-only: clear every subscription. Production code should not call
 * this; it exists so unit tests can reset state between runs.
 */
export function _resetForTests() {
    listeners.clear();
}
