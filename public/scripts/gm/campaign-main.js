/**
 * Campaign Main — the per-campaign hub.
 *
 * Phase 1 ships the shell: banner header, party panel slot (filled in
 * Phase 2), scene history slot (filled in Phase 3), Start Scene CTA, gear
 * Settings popup, Delete campaign menu.
 */

import { route } from './router.js';
import * as api from './api.js';
import { openStApiPanel } from './llm-profile.js';
import { mountConnectionGate, getConnectionStatus } from './connection-gate.js';
import { openCharacterWizard } from './character-wizard.js';
import { renderLeftSidebar, teardownLeftSidebar } from './sidebar-left.js';

/**
 * Per-tab set of campaign ids whose PC wizard we have already auto-opened in
 * this session. Used to avoid re-popping the wizard every time the player
 * navigates back to the Campaign Main while they're still iterating on the
 * "do I want a character now" decision. Closing and re-opening the tab will
 * re-arm the auto-open.
 *
 * @type {Set<string>}
 */
const autoWizardOpened = new Set();

/**
 * Teardown for the connection gate mounted by the most recent render. See
 * the matching field in `campaign-manager.js` for rationale.
 *
 * @type {(() => void) | null}
 */
let activeGateTeardown = null;

/**
 * Top-level renderer. Replaces children of `mount` with the Campaign Main
 * surface for the given campaign.
 *
 * @param {HTMLElement} mount
 * @param {{ campaignId: string }} params
 */
export async function renderCampaignMain(mount, { campaignId }) {
    const campaign = await api.getCampaign(campaignId);
    if (!campaign) {
        mount.replaceChildren(notFoundNode());
        return;
    }

    const characters = await api.listCharacters(campaignId).catch(() => []);
    const player = characters.find(c => c.is_player) || null;
    const scenes = await api.listScenes(campaignId).catch(() => []);

    const topbar = renderTopbar(campaign);
    // The campaign hub uses a 3-column grid: left sidebar (PC + sheet) |
    // main content (hero / scenes / footer) | (no right sidebar in
    // Campaign Main; the right sidebar is scene-only). The grid lives
    // inside `.gm-campaign-main-gated` so the connection gate can dim
    // everything but the topbar in one go.
    teardownLeftSidebar();
    const gateGroup = el('div', 'gm-campaign-main-gated');
    const grid = el('div', 'gm-three-col');
    grid.append(renderLeftSidebar({ campaign, player }));
    const main = el('div', 'gm-three-col-main');
    main.append(
        renderHeroBanner(campaign, scenes),
        renderBody(campaign, { player, scenes }),
        renderFooter(),
    );
    grid.append(main);
    gateGroup.append(grid);
    mount.replaceChildren(topbar, gateGroup);

    if (activeGateTeardown) { activeGateTeardown(); activeGateTeardown = null; }
    activeGateTeardown = mountConnectionGate({ container: mount, target: gateGroup });

    // The character wizard opens automatically the first time you land on a
    // campaign without a PC, but we don't want it firing on top of a
    // "configure a connection profile" banner — surface the connection
    // requirement first.
    if (!player && !autoWizardOpened.has(campaign.id) && getConnectionStatus().ok) {
        autoWizardOpened.add(campaign.id);
        openCharacterWizard(campaign.id, () => {
            route({ view: 'campaign', campaignId: campaign.id });
        });
    }
}

/* -------- Topbar -------- */

function renderTopbar(campaign) {
    const topbar = el('div', 'gm-topbar');

    const left = el('div', 'gm-topbar-left');
    const back = iconButton('fa-arrow-left', 'Back to campaigns', () => {
        route({ view: 'manager' });
    });
    const brand = el('div', 'gm-brand');
    brand.append(
        elHTML('div', 'gm-brand-mark', '<i class="fa-solid fa-dice-d20"></i>'),
        elText('div', 'gm-brand-title', 'TTRPG Tavern'),
        elText('div', 'gm-brand-subtitle', campaign.name),
    );
    left.append(back, brand);

    const right = el('div', 'gm-topbar-actions');
    right.append(
        renderTabSwitcher('hub', campaign),
        iconButton('fa-plug', 'API & connection settings', () => openStApiPanel()),
        iconButton('fa-trash', 'Delete campaign', () => onDelete(campaign)),
    );

    topbar.append(left, right);
    return topbar;
}

/**
 * Render the Hub / Memory tab switcher used in the campaign topbar. The
 * Memory Explorer view re-uses the same helper so the two surfaces stay
 * visually aligned.
 *
 * @param {'hub' | 'memory'} active
 * @param {{ id: string }} campaign
 * @returns {HTMLElement}
 */
export function renderTabSwitcher(active, campaign) {
    const wrap = el('div', 'gm-topbar-tabs');
    const hub = el('button', `gm-topbar-tab${active === 'hub' ? ' is-active' : ''}`);
    hub.type = 'button';
    hub.textContent = 'Hub';
    hub.addEventListener('click', () => {
        if (active === 'hub') return;
        route({ view: 'campaign', campaignId: campaign.id });
    });
    const mem = el('button', `gm-topbar-tab${active === 'memory' ? ' is-active' : ''}`);
    mem.type = 'button';
    mem.textContent = 'Memory';
    mem.addEventListener('click', () => {
        if (active === 'memory') return;
        route({ view: 'memory', campaignId: campaign.id });
    });
    wrap.append(hub, mem);
    return wrap;
}

/* -------- Hero banner -------- */

function renderHeroBanner(campaign, scenes) {
    const banner = el('div', `gm-hero-banner theme-${campaign.banner_theme || 'default'}`);
    const inner = el('div', 'gm-hero-inner');

    const chip = elText('span', 'gm-ruleset-chip', campaign.ruleset_id);
    const title = elText('h1', 'gm-hero-title', campaign.name);
    const brief = elText('p', 'gm-hero-brief', campaign.brief || 'No campaign brief yet.');

    const meta = el('div', 'gm-hero-meta');
    const sceneLabel = scenes.length === 1 ? 'scene' : 'scenes';
    meta.append(
        metaItem('fa-masks-theater', `${scenes.length} ${sceneLabel}`),
        metaItem('fa-clock', campaign.last_played_at
            ? `Last played ${formatRelative(campaign.last_played_at)}`
            : 'Never played'),
    );

    inner.append(chip, title, brief, meta);
    banner.append(inner);
    return banner;
}

/* -------- Body -------- */

function renderBody(campaign, { player, scenes }) {
    const page = el('div', 'gm-page gm-campaign-page');

    const top = el('div', 'gm-campaign-actions');
    const startBtn = el('button', 'gm-primary-btn');
    startBtn.type = 'button';
    startBtn.disabled = !player;
    startBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Scene';
    if (player) {
        startBtn.addEventListener('click', () => onStartScene(campaign, player));
    } else {
        startBtn.title = 'Create your character first';
    }
    top.append(startBtn);

    if (!player) {
        const cta = el('button', 'gm-secondary-btn');
        cta.type = 'button';
        cta.innerHTML = '<i class="fa-solid fa-user-pen"></i> Create your character';
        cta.addEventListener('click', () => openCharacterWizard(campaign.id, () => {
            route({ view: 'campaign', campaignId: campaign.id });
        }));
        top.append(cta);
    }

    page.append(top);

    // The party panel lives in the left sidebar in Phase 5+; the body now
    // focuses on scene history.
    page.append(renderSection('Scene history', renderSceneHistoryPanel(campaign, scenes)));

    return page;
}

function renderSection(title, body) {
    const section = el('div', 'gm-section');
    section.append(elText('h2', 'gm-section-title', title));
    section.append(body);
    return section;
}

function renderSceneHistoryPanel(campaign, scenes) {
    if (!scenes.length) {
        return elText('div', 'gm-empty-panel', 'No scenes yet. Start one to begin the story.');
    }
    const list = el('div', 'gm-scene-list');
    const sorted = [...scenes].sort((a, b) => Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0));
    for (const scene of sorted) {
        list.append(renderSceneRow(campaign, scene));
    }
    return list;
}

function renderSceneRow(campaign, scene) {
    const row = el('button', 'gm-scene-row');
    row.type = 'button';

    const status = scene.status === 'closed' ? 'Closed' : 'Active';
    const date = scene.started_at ? formatRelative(scene.started_at) : '—';
    const messages = `${scene.message_count ?? 0} msg`;

    row.innerHTML = `
        <span class="gm-scene-row-name"></span>
        <span class="gm-scene-row-meta">
            <span class="gm-scene-row-status status-${scene.status}"></span>
            <span class="gm-scene-row-date"></span>
            <span class="gm-scene-row-messages"></span>
        </span>
    `;
    row.querySelector('.gm-scene-row-name').textContent = scene.name || scene.id;
    row.querySelector('.gm-scene-row-status').textContent = status;
    row.querySelector('.gm-scene-row-date').textContent = date;
    row.querySelector('.gm-scene-row-messages').textContent = messages;

    row.addEventListener('click', () => {
        route({
            view: 'scene',
            campaignId: campaign.id,
            sceneId: scene.id,
            readOnly: scene.status === 'closed',
        });
    });

    return row;
}

function renderFooter() {
    const footer = el('div', 'gm-footer');
    footer.append(
        elText('span', '', 'TTRPG Tavern — Phase 4'),
        elText('span', 'gm-pill', 'pre-alpha'),
    );
    return footer;
}

/* -------- Click handlers -------- */

async function onStartScene(campaign, player) {
    try {
        const scene = await api.createScene(campaign.id, {
            name: `Scene ${new Date().toLocaleString()}`,
            location: '',
        });
        route({ view: 'scene', campaignId: campaign.id, sceneId: scene.id });
    } catch (err) {
        console.error('[gm] failed to start scene', err);
        alert(`Could not start scene: ${err?.message || err}`);
    }
}

async function onDelete(campaign) {
    if (!confirm(`Delete campaign "${campaign.name}"? This cannot be undone.`)) return;
    try {
        await api.deleteCampaign(campaign.id);
        route({ view: 'manager' });
    } catch (err) {
        console.error('[gm] failed to delete campaign', err);
        alert(`Could not delete campaign: ${err?.message || err}`);
    }
}

function notFoundNode() {
    const div = el('div', 'gm-error-banner');
    div.textContent = 'Campaign not found.';
    const back = el('button', 'gm-secondary-btn');
    back.type = 'button';
    back.textContent = 'Back to campaigns';
    back.addEventListener('click', () => route({ view: 'manager' }));
    div.append(back);
    return div;
}

/* -------- DOM helpers (small, repeated across views) -------- */

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

function metaItem(icon, text) {
    const item = el('span', 'gm-campaign-meta-item');
    item.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    item.querySelector('span').textContent = text;
    return item;
}

function formatRelative(iso) {
    const then = Date.parse(iso);
    if (!then) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w ago`;
    return new Date(then).toLocaleDateString();
}
