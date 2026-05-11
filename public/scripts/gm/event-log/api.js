/**
 * Debug-events API client.
 */

const BASE = '/api/gm/debug-events';

/**
 * Fetch history from GET /api/gm/debug-events.
 * @param {{ sceneId: string, campaignId: string, since?: string, limit?: number }} opts
 * @returns {Promise<Array>}
 */
export async function fetchHistory({ sceneId, campaignId, since, limit }) {
    const params = new URLSearchParams({ campaign_id: campaignId });
    if (sceneId) params.set('scene_id', sceneId);
    if (since) params.set('since', since);
    if (limit) params.set('limit', String(limit));
    const res = await fetch(`${BASE}?${params}`);
    if (!res.ok) throw new Error(`debug-events fetch: ${res.status}`);
    return res.json();
}

/**
 * Open an SSE stream to GET /api/gm/debug-events/stream.
 * Returns { eventSource, close() }.
 * @param {{ sceneId: string, campaignId: string, onEvent: (ev: object) => void, onOpen?: () => void, onError?: (err: Event) => void }} opts
 */
export function openStream({ sceneId, campaignId, since, onEvent, onOpen, onError }) {
    const params = new URLSearchParams({ campaign_id: campaignId });
    if (sceneId) params.set('scene_id', sceneId);
    if (since) params.set('since', since);
    const es = new EventSource(`${BASE}/stream?${params}`);
    es.onmessage = (msg) => {
        try {
            const event = JSON.parse(msg.data);
            onEvent(event);
        } catch (_) { /* ignore malformed */ }
    };
    if (onOpen) es.onopen = onOpen;
    if (onError) es.onerror = onError;
    return { eventSource: es, close: () => es.close() };
}

/**
 * Clear events via DELETE /api/gm/debug-events.
 * @param {{ sceneId: string, campaignId: string }} opts
 */
export async function clearHistory({ sceneId, campaignId }) {
    const params = new URLSearchParams({ campaign_id: campaignId });
    if (sceneId) params.set('scene_id', sceneId);
    const res = await fetch(`${BASE}?${params}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`debug-events clear: ${res.status}`);
}

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;

/**
 * Open an auto-reconnecting SSE stream with exponential backoff.
 * @param {{ sceneId: string, campaignId: string, onEvent: (ev: object) => void, onStatusChange?: (connected: boolean) => void }} opts
 * @returns {{ close: () => void }}
 */
export function openAutoStream({ sceneId, campaignId, onEvent, onStatusChange }) {
    let lastEventId = null;
    let delay = BACKOFF_INITIAL;
    let reconnectTimer = null;
    let stream = null;
    let closed = false;

    function connect() {
        if (closed) return;

        stream = openStream({
            sceneId,
            campaignId,
            since: lastEventId || undefined,
            onEvent(event) {
                if (event.id) lastEventId = event.id;
                onEvent(event);
            },
            onOpen() {
                delay = BACKOFF_INITIAL;
                if (onStatusChange) onStatusChange(true);
            },
            onError() {
                if (closed) return;
                if (onStatusChange) onStatusChange(false);
                stream.close();
                stream = null;
                scheduleReconnect();
            },
        });
    }

    function scheduleReconnect() {
        if (closed) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!closed) connect();
        }, delay);
        delay = Math.min(delay * 2, BACKOFF_MAX);
    }

    connect();

    return {
        close() {
            closed = true;
            if (reconnectTimer != null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (stream) {
                stream.close();
                stream = null;
            }
            if (onStatusChange) onStatusChange(false);
        },
    };
}
