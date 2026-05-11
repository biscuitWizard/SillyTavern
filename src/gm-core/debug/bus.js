/**
 * In-memory event bus for live debug event streaming.
 *
 * Events are fanned out synchronously to all matching subscribers, then
 * persisted to the JSONL store in a fire-and-forget async append that
 * never blocks the hot path.
 */

import crypto from 'node:crypto';
import { currentContext } from './context.js';
import { appendEvent } from './store.js';

/**
 * @typedef {import('./schemas.js').DebugEvent}      DebugEvent
 * @typedef {import('./schemas.js').DebugEventKind}   DebugEventKind
 * @typedef {import('./schemas.js').DebugEventScope}  DebugEventScope
 * @typedef {import('./schemas.js').DebugContext}      DebugContext
 */

/**
 * @typedef {object} SubscriptionFilter
 * @property {string} [scene_id]
 * @property {string} [campaign_id]
 */

/**
 * @typedef {object} Subscriber
 * @property {SubscriptionFilter} filter
 * @property {(event: DebugEvent) => void} fn
 */

/** @type {Set<Subscriber>} */
const subscribers = new Set();

/**
 * Does `event` match the subscriber's filter?
 *
 * A subscriber with both `scene_id` AND `campaign_id` receives events
 * matching EITHER field, so campaign-scoped events (openings, ask, plot)
 * still show up alongside scene events.
 *
 * @param {DebugEvent} event
 * @param {SubscriptionFilter} filter
 * @returns {boolean}
 */
function matches(event, filter) {
    const byScene = filter.scene_id ? event.scene_id === filter.scene_id : false;
    const byCampaign = filter.campaign_id ? event.campaign_id === filter.campaign_id : false;

    if (filter.scene_id && filter.campaign_id) return byScene || byCampaign;
    if (filter.scene_id) return byScene;
    if (filter.campaign_id) return byCampaign;
    return true;
}

/**
 * Synchronously fan out `event` to every matching subscriber, then
 * fire-and-forget persist it to the JSONL store.
 *
 * @param {DebugEvent} event
 */
export function emitDebugEvent(event) {
    for (const sub of subscribers) {
        if (!matches(event, sub.filter)) continue;
        try {
            sub.fn(event);
        } catch (err) {
            console.warn('[debug-bus] subscriber threw', err);
        }
    }

    const ctx = currentContext();
    if (ctx) {
        appendEvent(
            ctx.directories,
            event.campaign_id ?? '',
            event.scene_id,
            event,
        ).catch(() => {});
    }
}

/**
 * Register `fn` to receive debug events matching the given filter.
 *
 * @param {SubscriptionFilter} filter
 * @param {(event: DebugEvent) => void} fn
 * @returns {() => void} unsubscribe function
 */
export function subscribe(filter, fn) {
    /** @type {Subscriber} */
    const sub = { filter, fn };
    subscribers.add(sub);
    return () => { subscribers.delete(sub); };
}

/**
 * Build a full `DebugEvent` from the active debug context.
 *
 * Returns `null` when no debug context is active — callers should check
 * and skip emission in that case.
 *
 * @param {object} opts
 * @param {DebugEventKind} opts.kind
 * @param {string} opts.headline
 * @param {Record<string, unknown>} [opts.detail]
 * @param {string} [opts.parent_id]
 * @returns {DebugEvent | null}
 */
export function makeDebugEvent({ kind, headline, detail = {}, parent_id }) {
    const ctx = currentContext();
    if (!ctx) return null;

    return {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        scene_id: ctx.scene_id,
        campaign_id: ctx.campaign_id,
        scope: ctx.scope,
        kind,
        parent_id: parent_id ?? ctx.parent_id,
        headline,
        detail,
    };
}
