/**
 * Memory Explorer — top-level surface (Phase 7 frontend).
 *
 * Three-column layout:
 *   - left rail   → list of campaign collections (world lore, per-character
 *                   memory, director, narrator, player journal)
 *   - centre pane → paginated record list + filter row
 *   - right pane  → editor for the selected record
 *
 * A collapsible live feed (top-right) tails `memory_write` events from
 * the global event bus so the user can watch new memories scroll in
 * during a turn.
 *
 * The Explorer never throws past its render boundary — every API call is
 * wrapped, and failures surface as inline banners or status pills. The
 * topbar reuses the same Hub/Memory tab switcher as the campaign hub so
 * navigation stays consistent.
 */

import * as api from '../api.js';
import { route } from '../router.js';
import { openStApiPanel } from '../llm-profile.js';
import { renderTabSwitcher } from '../campaign-main.js';
import { teardownLeftSidebar } from '../sidebar-left.js';
import { buildCollectionRefs, renderLeftRail } from './left-rail.js';
import { renderRecordList } from './record-list.js';
import { renderRecordEditor } from './record-editor.js';
import { renderLiveFeed } from './live-feed.js';

/** @type {(() => void) | null} */
let activeFeedTeardown = null;
/** @type {(() => void) | null} */
let activeListTeardown = null;

/**
 * Mount the Memory Explorer for a campaign.
 *
 * @param {HTMLElement} mount
 * @param {{ campaignId: string }} params
 */
export async function renderMemoryExplorer(mount, { campaignId }) {
    teardownLeftSidebar();
    teardownPrevious();

    const campaign = await api.getCampaign(campaignId);
    if (!campaign) {
        mount.replaceChildren(notFound());
        return;
    }

    const characters = await api.listCharacters(campaignId).catch(() => []);
    const refs = buildCollectionRefs(campaign, characters);
    /** @type {import('./left-rail.js').CollectionRef} */
    let activeRef = refs[0];
    /** @type {any} */
    let selectedRecord = null;

    const topbar = buildTopbar(campaign);
    const banner = buildHealthBanner();
    const grid = el('div', 'gm-memex');

    const railHost = el('div', 'gm-memex-rail-host');
    const centerHost = el('div', 'gm-memex-center-host');
    const editorHost = el('div', 'gm-memex-editor-host');

    const feed = renderLiveFeed();
    activeFeedTeardown = feed.teardown;

    grid.append(railHost, centerHost, editorHost);

    mount.replaceChildren(topbar, banner, grid, feed.node);

    function renderRail() {
        railHost.replaceChildren(renderLeftRail({
            refs,
            activeId: activeRef?.id || null,
            onSelect: (ref) => {
                if (ref.id === activeRef?.id) return;
                activeRef = ref;
                selectedRecord = null;
                renderRail();
                mountList();
                mountEditor();
            },
        }));
    }

    /** @type {ReturnType<typeof renderRecordList> | null} */
    let listHandle = null;
    function mountList() {
        if (activeListTeardown) { activeListTeardown(); activeListTeardown = null; }
        listHandle = renderRecordList({
            campaignId,
            collection: activeRef,
            selectedRecordId: selectedRecord?.id || null,
            onSelectRecord: (record) => {
                selectedRecord = record;
                if (listHandle) listHandle.setSelected(record.id);
                mountEditor();
            },
        });
        activeListTeardown = listHandle.teardown;
        centerHost.replaceChildren(listHandle.node);
    }

    function mountEditor() {
        const handle = renderRecordEditor({
            campaignId,
            collection: activeRef,
            record: selectedRecord,
            onSaved: (updated) => {
                selectedRecord = updated;
                if (listHandle) listHandle.patchCachedRecord(updated.id, updated);
                mountEditor();
            },
            onDeleted: (id) => {
                if (listHandle) listHandle.patchCachedRecord(id, null);
                selectedRecord = null;
                mountEditor();
            },
        });
        editorHost.replaceChildren(handle.node);
    }

    renderRail();
    mountList();
    mountEditor();

    refreshHealth(banner).catch(err => console.warn('[gm] memex health probe failed', err));
}

function buildTopbar(campaign) {
    const topbar = el('div', 'gm-topbar');

    const left = el('div', 'gm-topbar-left');
    const back = iconButton('fa-arrow-left', 'Back to campaigns', () => {
        route({ view: 'manager' });
    });
    const brand = el('div', 'gm-brand');
    brand.append(
        elHTML('div', 'gm-brand-mark', '<i class="fa-solid fa-brain"></i>'),
        elText('div', 'gm-brand-title', 'Memory Explorer'),
        elText('div', 'gm-brand-subtitle', campaign.name),
    );
    left.append(back, brand);

    const right = el('div', 'gm-topbar-actions');
    right.append(
        renderTabSwitcher('memory', campaign),
        renderSeedLoreMenu(campaign),
        renderReconcileButton(campaign),
        iconButton('fa-plug', 'API & connection settings', () => openStApiPanel()),
    );

    topbar.append(left, right);
    return topbar;
}

function renderReconcileButton(campaign) {
    const btn = el('button', 'gm-secondary-btn');
    btn.type = 'button';
    btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Reconcile';
    btn.title = 'Re-run RAG reconcile for this campaign';
    btn.addEventListener('click', async () => {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reconciling…';
        try {
            const report = await api.reconcileRag(campaign.id);
            const counts = summarizeReconcile(report);
            toast(`Reconcile complete · ${counts}`, 'ok');
        } catch (err) {
            console.error('[gm] reconcile failed', err);
            toast(`Reconcile failed: ${(err && err.message) || err}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    });
    return btn;
}

function renderSeedLoreMenu(campaign) {
    const wrap = el('div', 'gm-memex-seed-menu');
    const btn = el('button', 'gm-secondary-btn');
    btn.type = 'button';
    btn.innerHTML = '<i class="fa-solid fa-seedling"></i> Seed lore';

    const panel = el('div', 'gm-memex-seed-panel');
    panel.style.display = 'none';

    let loaded = false;
    let loading = false;

    async function ensureLoaded() {
        if (loaded || loading) return;
        loading = true;
        panel.replaceChildren(loadingPill('Loading packs…'));
        try {
            const packs = await api.listLorePacks();
            panel.replaceChildren();
            if (!packs.length) {
                panel.append(elText('div', 'gm-memex-seed-empty', 'No lore packs available.'));
            } else {
                for (const pack of packs) {
                    panel.append(buildPackRow(campaign, pack, panel));
                }
            }
            loaded = true;
        } catch (err) {
            console.error('[gm] listLorePacks failed', err);
            panel.replaceChildren(elText('div', 'gm-memex-seed-empty', `Could not load packs: ${(err && err.message) || err}`));
        } finally {
            loading = false;
        }
    }

    btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const open = panel.style.display !== 'none';
        panel.style.display = open ? 'none' : '';
        if (!open) await ensureLoaded();
    });

    document.addEventListener('click', (ev) => {
        if (!wrap.contains(/** @type {Node} */(ev.target))) {
            panel.style.display = 'none';
        }
    });

    wrap.append(btn, panel);
    return wrap;
}

function buildPackRow(campaign, pack, panel) {
    const row = el('button', 'gm-memex-seed-row');
    row.type = 'button';
    row.append(elText('div', 'gm-memex-seed-row-name', pack.name || pack.id));
    if (pack.summary) row.append(elText('div', 'gm-memex-seed-row-summary', pack.summary));
    row.addEventListener('click', async () => {
        row.disabled = true;
        const orig = row.innerHTML;
        row.innerHTML = `<div class="gm-memex-seed-row-name">Applying ${pack.name || pack.id}…</div>`;
        try {
            await api.applyLorePack({ cid: campaign.id, pack_id: pack.id });
            toast(`Seeded "${pack.name || pack.id}".`, 'ok');
            panel.style.display = 'none';
            // Re-route to the same view so the World Lore collection
            // refreshes from disk.
            route({ view: 'memory', campaignId: campaign.id });
        } catch (err) {
            console.error('[gm] applyLorePack failed', err);
            row.disabled = false;
            row.innerHTML = orig;
            toast(`Could not apply pack: ${(err && err.message) || err}`, 'error');
        }
    });
    return row;
}

function buildHealthBanner() {
    const banner = el('div', 'gm-memex-health');
    banner.style.display = 'none';
    return banner;
}

async function refreshHealth(banner) {
    try {
        const health = await api.getRagHealth();
        if (!health || health.ok === false) {
            banner.style.display = '';
            banner.className = 'gm-memex-health is-warn';
            const url = health?.url || '(unknown URL)';
            banner.textContent = `Qdrant unreachable at ${url}${health?.error ? ` · ${health.error}` : ''}. Records may be served from the disk mirror only.`;
        } else {
            banner.style.display = 'none';
        }
    } catch (err) {
        banner.style.display = '';
        banner.className = 'gm-memex-health is-warn';
        banner.textContent = `RAG health check failed: ${(err && err.message) || err}`;
    }
}

function summarizeReconcile(report) {
    if (!report || typeof report !== 'object') return 'no report returned';
    const parts = [];
    for (const key of ['ingested', 'reembedded', 'pruned', 'requeued', 'errors']) {
        if (typeof report[key] === 'number') parts.push(`${key} ${report[key]}`);
    }
    if (!parts.length) {
        const ingest = report.ingest;
        if (ingest && typeof ingest === 'object') {
            for (const key of ['ingested', 'updated', 'skipped']) {
                if (typeof ingest[key] === 'number') parts.push(`${key} ${ingest[key]}`);
            }
        }
    }
    return parts.length ? parts.join(' · ') : 'OK';
}

function loadingPill(text) {
    const node = el('div', 'gm-memex-seed-loading');
    node.textContent = text;
    return node;
}

function toast(message, kind) {
    if (typeof toastr !== 'undefined' && toastr) {
        const fn = kind === 'error' ? toastr.error : toastr.success;
        try { fn.call(toastr, message, 'Memory Explorer'); return; } catch (_) { /* fall through */ }
    }
    if (kind === 'error') console.error('[gm] memex toast', message);
    else console.info('[gm] memex toast', message);
}

function notFound() {
    const div = el('div', 'gm-error-banner');
    div.textContent = 'Campaign not found.';
    const back = el('button', 'gm-secondary-btn');
    back.type = 'button';
    back.textContent = 'Back to campaigns';
    back.addEventListener('click', () => route({ view: 'manager' }));
    div.append(back);
    return div;
}

function teardownPrevious() {
    if (activeFeedTeardown) { activeFeedTeardown(); activeFeedTeardown = null; }
    if (activeListTeardown) { activeListTeardown(); activeListTeardown = null; }
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

function elHTML(tag, className, html) {
    const node = el(tag, className);
    node.innerHTML = html;
    return node;
}

function iconButton(faIcon, title, onClick) {
    const btn = el('button', 'gm-icon-btn');
    btn.type = 'button';
    btn.title = title;
    btn.innerHTML = `<i class="fa-solid ${faIcon}"></i>`;
    btn.addEventListener('click', onClick);
    return btn;
}
