/**
 * Event Log panel — renders inside the container provided by
 * `sidebar-right.js` when the "Event Log" tab is active.
 *
 * Uses real SSE streaming + REST history from the debug-events API
 * and bridges the frontend event bus for memory_write events.
 */

import { renderEventRow } from './row.js';
import { fetchHistory, openAutoStream, clearHistory } from './api.js';
import { renderFilters } from './filters.js';
import { openDetailModal } from './detail-modal.js';
import { on as busOn } from '../events.js';

let activeContainer = null;
let activeStream = null;
let busUnsub = null;
let pollTimer = null;
let pollCtx = null;

let allEvents = [];
let filters = { roles: [], scopes: [], text: '' };

let listEl = null;
let countEl = null;

/**
 * Build the Event Log panel UI inside `container`.
 * @param {HTMLElement} container
 * @param {{ sceneId: string, campaignId: string }} ctx
 */
export function renderEventLog(container, ctx) {
    teardownEventLog();
    activeContainer = container;
    container.innerHTML = '';

    allEvents = [];
    filters = { roles: [], scopes: [], text: '' };

    const { sceneId, campaignId } = ctx;

    /* ---- Header row ---- */
    const header = document.createElement('div');
    header.className = 'gm-evlog-header';

    const titleWrap = document.createElement('div');
    titleWrap.style.display = 'flex';
    titleWrap.style.alignItems = 'center';
    titleWrap.style.gap = '8px';

    const title = document.createElement('div');
    title.className = 'gm-evlog-title';
    title.textContent = 'Event Log';

    countEl = document.createElement('span');
    countEl.className = 'gm-evlog-count';
    countEl.textContent = '0';

    titleWrap.append(title, countEl);

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.alignItems = 'center';
    controls.style.gap = '8px';

    const liveDot = document.createElement('span');
    liveDot.className = 'gm-evlog-live-dot is-hidden';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'gm-evlog-clear-btn gm-icon-btn';
    clearBtn.type = 'button';
    clearBtn.title = 'Clear';
    clearBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    clearBtn.addEventListener('click', async () => {
        try {
            await clearHistory({ sceneId, campaignId });
        } catch (err) {
            console.warn('[gm] event-log clear failed', err);
        }
        allEvents = [];
        rerenderList();
    });

    controls.append(liveDot, clearBtn);
    header.append(titleWrap, controls);
    container.append(header);

    /* ---- Filter bar ---- */
    const filterBar = renderFilters({
        onFilterChange(f) {
            filters = f;
            rerenderList();
        },
    });
    container.append(filterBar);

    /* ---- Scrollable list ---- */
    listEl = document.createElement('div');
    listEl.className = 'gm-evlog-list';
    showEmpty();
    container.append(listEl);

    /* ---- Fetch history ---- */
    fetchHistory({ sceneId, campaignId })
        .then((events) => {
            if (!Array.isArray(events)) return;
            allEvents = events;
            rerenderList();
        })
        .catch((err) => {
            console.warn('[gm] event-log fetchHistory failed', err);
        });

    /* ---- SSE stream ---- */
    let sseConnected = false;
    activeStream = openAutoStream({
        sceneId,
        campaignId,
        onEvent(event) {
            allEvents.unshift(event);
            rerenderList();
        },
        onStatusChange(connected) {
            sseConnected = connected;
            liveDot.classList.toggle('is-hidden', !connected);
        },
    });

    /* ---- Polling fallback (when SSE is disconnected) ---- */
    pollCtx = { sceneId, campaignId };
    pollTimer = setInterval(async () => {
        if (sseConnected) return;
        try {
            const events = await fetchHistory({ sceneId, campaignId });
            if (!Array.isArray(events)) return;
            if (events.length !== allEvents.length) {
                allEvents = events;
                rerenderList();
            }
        } catch (_) { /* ignore poll errors */ }
    }, 5000);

    /* ---- Frontend bus bridge ---- */
    busUnsub = busOn('memory_write', (payload) => {
        const synthetic = {
            id: `bus_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            ts: new Date().toISOString(),
            scope: 'turn',
            kind: 'turn_event',
            headline: `Memory write: ${payload?.key || payload?.type || 'update'}`,
            detail: payload || {},
        };
        allEvents.unshift(synthetic);
        rerenderList();
    });
}

/* -------- Filtering -------- */

function applyFilters() {
    return allEvents.filter((ev) => {
        if (filters.roles.length > 0) {
            const evRole = ev.detail?.role;
            const match = (evRole && filters.roles.includes(evRole)) ||
                          filters.roles.includes(ev.kind);
            if (!match) return false;
        }
        if (filters.scopes.length > 0) {
            if (!filters.scopes.includes(ev.scope)) return false;
        }
        if (filters.text) {
            if (!(ev.headline || '').toLowerCase().includes(filters.text.toLowerCase())) {
                return false;
            }
        }
        return true;
    });
}

/* -------- Rendering helpers -------- */

function rerenderList() {
    if (!listEl) return;
    const displayed = applyFilters();
    listEl.innerHTML = '';

    if (countEl) countEl.textContent = String(allEvents.length);

    if (displayed.length === 0) {
        showEmpty();
        return;
    }

    for (const ev of displayed) {
        const rowEl = renderEventRow(ev);
        wireViewFull(rowEl, ev);
        listEl.append(rowEl);
    }
}

function wireViewFull(rowEl, event) {
    const btn = rowEl.querySelector('.gm-evlog-view-full-btn');
    if (btn) {
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            openDetailModal(event);
        });
    } else {
        const observer = new MutationObserver(() => {
            const b = rowEl.querySelector('.gm-evlog-view-full-btn');
            if (b) {
                b.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    openDetailModal(event);
                });
                observer.disconnect();
            }
        });
        observer.observe(rowEl, { childList: true, subtree: true });
    }
}

function showEmpty() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'gm-evlog-empty';
    empty.textContent = 'No events yet.';
    listEl.append(empty);
}

/**
 * Cleanup — close SSE, unsubscribe bus, null out references.
 */
export function teardownEventLog() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    pollCtx = null;
    if (activeStream) {
        activeStream.close();
        activeStream = null;
    }
    if (busUnsub) {
        busUnsub();
        busUnsub = null;
    }
    if (activeContainer) {
        activeContainer.innerHTML = '';
    }
    activeContainer = null;
    listEl = null;
    countEl = null;
    allEvents = [];
}
