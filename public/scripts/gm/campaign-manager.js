/**
 * Campaign Manager — the home screen.
 *
 * Fetches campaigns from `/api/gm/campaigns` and lets the player create a
 * new one (one-step modal). Click on a campaign card opens Campaign Main.
 */

import * as api from './api.js';
import { route } from './router.js';
import { openStApiPanel } from './llm-profile.js';
import { mountConnectionGate } from './connection-gate.js';
import { BANNER_THEMES } from './constants.js';

/**
 * Per-mount teardown for the previously-rendered connection gate. The
 * router re-runs `renderCampaignManager` on each navigation; we keep
 * this at module scope so we can dispose the prior subscription before
 * mounting a new one.
 *
 * @type {(() => void) | null}
 */
let activeGateTeardown = null;

/**
 * Render the Campaign Manager into `mount`.
 *
 * @param {HTMLElement} mount
 */
export async function renderCampaignManager(mount) {
    /** @type {import('./api.js').CampaignSummary[]} */
    let campaigns = [];
    try {
        campaigns = await api.listCampaigns();
    } catch (err) {
        console.error('[gm] listCampaigns failed', err);
    }
    const topbar = renderTopbar();
    const page = renderPage(campaigns);
    mount.replaceChildren(topbar, page);

    if (activeGateTeardown) { activeGateTeardown(); activeGateTeardown = null; }
    activeGateTeardown = mountConnectionGate({ container: mount, target: page });
}

/* -------- Topbar -------- */

function renderTopbar() {
    const topbar = el('div', 'gm-topbar');

    const brand = el('div', 'gm-brand');
    brand.append(
        elHTML('div', 'gm-brand-mark', '<i class="fa-solid fa-dice-d20"></i>'),
        elText('div', 'gm-brand-title', 'TTRPG Tavern'),
        elText('div', 'gm-brand-subtitle', 'fork of SillyTavern'),
    );

    const actions = el('div', 'gm-topbar-actions');
    actions.append(
        iconButton('fa-plug', 'API & connection settings', () => openStApiPanel()),
        iconButton('fa-circle-question', 'Help', () => {
            console.debug('[gm] help click (not implemented)');
        }),
    );

    topbar.append(brand, actions);
    return topbar;
}

/* -------- Page -------- */

function renderPage(campaigns) {
    const page = el('div', 'gm-page');
    page.append(
        renderPageHeader(),
        renderCampaignGrid(campaigns),
        renderResourcesSection(),
        renderFooter(),
    );
    return page;
}

function renderPageHeader() {
    const header = el('div', 'gm-page-header');

    const left = document.createElement('div');
    left.append(
        elText('h1', 'gm-page-title', 'Campaigns'),
        elText('p', 'gm-page-subtitle', 'Pick up where you left off, or start a new world. Each campaign is its own setting, party, ruleset, and history.'),
    );

    const right = document.createElement('div');
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'gm-primary-btn';
    newBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New campaign';
    newBtn.addEventListener('click', onNewCampaign);
    right.append(newBtn);

    header.append(left, right);
    return header;
}

function renderCampaignGrid(campaigns) {
    const grid = el('div', 'gm-campaign-grid');
    for (const campaign of campaigns) {
        grid.append(renderCampaignCard(campaign));
    }
    grid.append(renderNewCampaignCard());
    return grid;
}

function renderCampaignCard(campaign) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gm-campaign-card';
    card.setAttribute('data-campaign-id', campaign.id);
    card.addEventListener('click', () => onOpenCampaign(campaign));

    const banner = el('div', `gm-campaign-banner theme-${campaign.banner_theme || 'default'}`);
    const chip = elText('span', 'gm-ruleset-chip', campaign.ruleset_id);
    banner.append(chip);

    const body = el('div', 'gm-campaign-body');
    body.append(
        elText('h3', 'gm-campaign-name', campaign.name),
        elText('p', 'gm-campaign-brief', campaign.brief || ''),
        renderCampaignMeta(campaign),
    );

    card.append(banner, body);
    return card;
}

function renderCampaignMeta(campaign) {
    const meta = el('div', 'gm-campaign-meta');
    const sceneLabel = campaign.scene_count === 1 ? 'scene' : 'scenes';
    meta.append(
        metaItem('fa-clock', campaign.last_played_at ? `Played ${formatRelative(campaign.last_played_at)}` : 'Never played'),
        metaItem('fa-masks-theater', `${campaign.scene_count} ${sceneLabel}`),
    );
    return meta;
}

function metaItem(icon, text) {
    const item = el('span', 'gm-campaign-meta-item');
    item.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    item.querySelector('span').textContent = text;
    return item;
}

function renderNewCampaignCard() {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gm-new-campaign-card';
    card.addEventListener('click', onNewCampaign);

    card.append(
        elHTML('div', 'gm-new-campaign-icon', '<i class="fa-solid fa-plus"></i>'),
        elText('div', 'gm-new-campaign-title', 'New Campaign'),
        elText('div', 'gm-new-campaign-hint', 'Choose a name and a ruleset, generate your character, and begin.'),
    );

    return card;
}

function renderResourcesSection() {
    const section = el('div', 'gm-section');
    section.append(elText('h2', 'gm-section-title', 'Resources'));

    const row = el('div', 'gm-resource-row');
    row.append(
        resourceTile('fa-book', 'Browse rulesets', 'Phase 6+'),
        resourceTile('fa-flask', 'Lore library', 'Phase 6+'),
        resourceTile('fa-brain', 'Memory inspector', 'Phase 7+'),
        resourceTile('fa-cogs', 'Model assignments', 'Phase 10'),
    );
    section.append(row);
    return section;
}

function resourceTile(icon, label, status) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'gm-resource-tile';
    tile.innerHTML = `<i class="fa-solid ${icon}"></i><span></span><span class="gm-pill" style="margin-left: auto;"></span>`;
    tile.querySelectorAll('span')[0].textContent = label;
    tile.querySelectorAll('span')[1].textContent = status;
    tile.addEventListener('click', () => {
        console.debug('[gm] resource click (not implemented):', label);
    });
    return tile;
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

async function onOpenCampaign(campaign) {
    await route({ view: 'campaign', campaignId: campaign.id });
}

async function onNewCampaign() {
    const result = await openNewCampaignModal();
    if (!result) return;
    try {
        const campaign = await api.createCampaign(result);
        await route({ view: 'campaign', campaignId: campaign.id });
    } catch (err) {
        console.error('[gm] createCampaign failed', err);
        alert(`Could not create campaign: ${err?.message || err}`);
    }
}

/**
 * Open a single-step new-campaign modal. Resolves with the user's input or
 * `null` if cancelled.
 *
 * @returns {Promise<{ name: string, brief: string, ruleset_id: string, banner_theme: string } | null>}
 */
function openNewCampaignModal() {
    return new Promise((resolve) => {
        const overlay = el('div', 'gm-modal-overlay');
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                cleanup();
                resolve(null);
            }
        });
        const panel = el('div', 'gm-modal');

        const head = el('div', 'gm-modal-header');
        head.append(elText('h2', 'gm-modal-title', 'New campaign'));
        const close = el('button', 'gm-icon-btn');
        close.type = 'button';
        close.innerHTML = '<i class="fa-solid fa-times"></i>';
        close.addEventListener('click', () => { cleanup(); resolve(null); });
        head.append(close);

        const body = el('div', 'gm-modal-body');

        const nameInput = inputField('Name', { placeholder: 'Shadows of Ironhold' });
        const briefInput = textareaField('Brief', { placeholder: 'A short pitch — what kind of campaign is this?', rows: 3 });
        const rulesetInput = inputField('Ruleset', { value: 'dnd5e', placeholder: 'dnd5e' });
        const themeInput = selectField('Banner theme', BANNER_THEMES, 'default');

        body.append(nameInput.wrap, briefInput.wrap, rulesetInput.wrap, themeInput.wrap);

        const foot = el('div', 'gm-modal-footer');
        const cancel = el('button', 'gm-secondary-btn');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => { cleanup(); resolve(null); });
        const create = el('button', 'gm-primary-btn');
        create.type = 'button';
        create.innerHTML = '<i class="fa-solid fa-plus"></i> Create';
        create.disabled = true;
        nameInput.input.addEventListener('input', () => {
            create.disabled = nameInput.input.value.trim().length === 0;
        });
        create.addEventListener('click', () => {
            const name = nameInput.input.value.trim();
            if (!name) return;
            cleanup();
            resolve({
                name,
                brief: briefInput.input.value.trim(),
                ruleset_id: rulesetInput.input.value.trim() || 'dnd5e',
                banner_theme: themeInput.select.value,
            });
        });
        foot.append(cancel, create);

        panel.append(head, body, foot);
        overlay.append(panel);
        document.body.append(overlay);
        nameInput.input.focus();

        function cleanup() {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
    });
}

function inputField(label, { value = '', placeholder = '' } = {}) {
    const wrap = el('label', 'gm-modal-field');
    wrap.append(elText('span', 'gm-modal-field-label', label));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gm-modal-input';
    input.value = value;
    input.placeholder = placeholder;
    wrap.append(input);
    return { wrap, input };
}

function textareaField(label, { rows = 3, placeholder = '' } = {}) {
    const wrap = el('label', 'gm-modal-field');
    wrap.append(elText('span', 'gm-modal-field-label', label));
    const input = document.createElement('textarea');
    input.className = 'gm-modal-textarea';
    input.rows = rows;
    input.placeholder = placeholder;
    wrap.append(input);
    return { wrap, input };
}

function selectField(label, options, defaultValue) {
    const wrap = el('label', 'gm-modal-field');
    wrap.append(elText('span', 'gm-modal-field-label', label));
    const select = document.createElement('select');
    select.className = 'gm-modal-select';
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        select.append(o);
    }
    if (defaultValue && options.includes(defaultValue)) select.value = defaultValue;
    wrap.append(select);
    return { wrap, select };
}

/* -------- DOM helpers -------- */

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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gm-icon-btn';
    btn.title = title;
    btn.innerHTML = `<i class="fa-solid ${faIcon}"></i>`;
    btn.addEventListener('click', onClick);
    return btn;
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
