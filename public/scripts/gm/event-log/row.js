/**
 * Event Log — single event row renderer.
 *
 * Each row has a collapsed state (chip + headline + relative time) and an
 * expanded state (detail summary + "View full" button).  Click to toggle.
 */

/* -------- Relative-time formatter -------- */

function relativeTime(isoString) {
    const delta = Math.max(0, Date.now() - new Date(isoString).getTime());
    const secs = Math.floor(delta / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

/* -------- Chip role resolver -------- */

function chipLabel(event) {
    if (event.kind === 'llm_call' && event.detail?.role) return event.detail.role;
    return event.kind;
}

/* -------- Expanded detail builder -------- */

function buildDetail(event) {
    const wrap = document.createElement('div');
    wrap.className = 'gm-evlog-expanded';

    const dl = document.createElement('dl');
    dl.className = 'gm-evlog-detail-dl';

    const add = (key, val) => {
        if (val == null) return;
        const dt = document.createElement('dt');
        dt.textContent = key;
        const dd = document.createElement('dd');
        dd.textContent = String(val);
        dl.append(dt, dd);
    };

    if (event.kind === 'llm_call') {
        add('Mode', event.detail?.mode);
        add('Provider', event.detail?.provider);
        add('Model', event.detail?.model);
        add('Duration', event.detail?.duration_ms != null ? `${event.detail.duration_ms}ms` : null);
        add('Messages', event.detail?.message_count);
    } else if (event.kind === 'tool_decision') {
        add('Step', event.detail?.step);
        add('Action', event.detail?.decision?.action);
    } else if (event.kind === 'tool_result') {
        add('Summary', event.detail?.summary);
    }

    wrap.append(dl);

    const btn = document.createElement('button');
    btn.className = 'gm-evlog-view-full-btn';
    btn.type = 'button';
    btn.textContent = 'View full';
    wrap.append(btn);

    return wrap;
}

/* -------- Public API -------- */

/**
 * @param {{ id: string, ts: string, scope: string, kind: string, headline: string, detail: object }} event
 * @returns {HTMLElement}
 */
export function renderEventRow(event) {
    const row = document.createElement('div');
    row.className = 'gm-evlog-row';
    row.dataset.eventId = event.id;

    const head = document.createElement('div');
    head.className = 'gm-evlog-row-head';

    const chip = document.createElement('span');
    const label = chipLabel(event);
    chip.className = `gm-evlog-chip gm-evlog-chip--${label}`;
    chip.textContent = label;

    const headline = document.createElement('span');
    headline.className = 'gm-evlog-headline';
    headline.textContent = event.headline;

    const time = document.createElement('span');
    time.className = 'gm-evlog-time';
    time.textContent = relativeTime(event.ts);

    head.append(chip, headline, time);
    row.append(head);

    let detailEl = null;

    row.addEventListener('click', () => {
        const expanding = !row.classList.contains('is-expanded');
        row.classList.toggle('is-expanded', expanding);
        if (expanding && !detailEl) {
            detailEl = buildDetail(event);
            row.append(detailEl);
        }
        if (detailEl) {
            detailEl.style.display = expanding ? '' : 'none';
        }
    });

    return row;
}
