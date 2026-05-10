/**
 * Memory Explorer — collapsible live feed of `memory_write` events.
 *
 * Subscribes to the global event bus on mount; every payload matching the
 * shape that `turn-events.js` emits gets prepended to the rolling list.
 * Older entries are trimmed once the buffer exceeds `MAX_ENTRIES` so the
 * panel stays bounded during long turns.
 *
 * The panel is collapsible; the header always shows the running count
 * since mount. A short "is-fresh" CSS class triggers a flash animation
 * on each new row.
 */

import { on } from '../events.js';

const MAX_ENTRIES = 50;
const FRESH_DURATION_MS = 1200;

/**
 * @returns {{ node: HTMLElement, teardown: () => void }}
 */
export function renderLiveFeed() {
    const root = el('div', 'gm-memex-feed');
    let collapsed = true;
    let received = 0;

    const header = el('button', 'gm-memex-feed-header');
    header.type = 'button';
    const title = elText('span', 'gm-memex-feed-title', 'Live writes');
    const count = elText('span', 'gm-memex-feed-count', '0');
    const chevron = el('span', 'gm-memex-feed-chevron');
    chevron.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
    header.append(title, count, chevron);

    const body = el('div', 'gm-memex-feed-body');
    body.style.display = 'none';

    const list = el('div', 'gm-memex-feed-list');
    const empty = el('div', 'gm-memex-feed-empty');
    empty.textContent = 'Waiting for the next turn…';
    body.append(empty, list);

    function applyCollapsed() {
        body.style.display = collapsed ? 'none' : '';
        root.classList.toggle('is-collapsed', collapsed);
        chevron.innerHTML = collapsed
            ? '<i class="fa-solid fa-chevron-down"></i>'
            : '<i class="fa-solid fa-chevron-up"></i>';
    }
    header.addEventListener('click', () => {
        collapsed = !collapsed;
        applyCollapsed();
    });

    function pushEvent(payload) {
        received += 1;
        count.textContent = String(received);
        if (empty.parentNode) empty.parentNode.removeChild(empty);

        const row = el('div', 'gm-memex-feed-row is-fresh');
        const head = el('div', 'gm-memex-feed-row-head');
        head.append(elText('span', 'gm-memex-feed-row-kind', payload?.memory?.kind || payload?.kind_target || 'memory'));
        head.append(elText('span', 'gm-memex-feed-row-when', new Date().toLocaleTimeString()));
        row.append(head);

        const summary = previewText(payload);
        if (summary) {
            row.append(elText('div', 'gm-memex-feed-row-body', summary));
        }
        list.prepend(row);

        while (list.childElementCount > MAX_ENTRIES) {
            const last = list.lastElementChild;
            if (last) list.removeChild(last);
        }

        setTimeout(() => row.classList.remove('is-fresh'), FRESH_DURATION_MS);
    }

    const unsubscribe = on('memory_write', (payload) => {
        try {
            pushEvent(payload);
        } catch (err) {
            console.error('[gm] live-feed handler threw', err);
        }
    });

    root.append(header, body);
    applyCollapsed();

    return {
        node: root,
        teardown() {
            unsubscribe();
        },
    };
}

function previewText(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const m = payload.memory || payload.record || {};
    const text = m.content || payload.summary || payload.text || '';
    if (!text) return '';
    const first = String(text).split('\n')[0].trim();
    return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function elText(tag, className, text) {
    const node = el(tag, className);
    node.textContent = text;
    return node;
}
