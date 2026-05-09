/**
 * Campaign Manager screen — the first thing the player sees when opening
 * TTRPG Tavern. Replaces SillyTavern's chat-first welcome flow.
 *
 * Phase 1 status: visual proof-of-concept. All data is mocked from
 * `mock-data.js`; clicks log to the console. Wiring to the future
 * `/api/gm/campaigns` endpoint and to a Campaign Main view lands in
 * later phases.
 */

import { mockCampaigns } from './mock-data.js';

/**
 * Renders the Campaign Manager into the given root element. Replaces any
 * existing children.
 *
 * @param {HTMLElement} root
 */
export function renderCampaignManager(root) {
    root.replaceChildren(
        renderTopbar(),
        renderPage(),
    );
}

/* ---------- Topbar ---------- */

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
        iconButton('fa-cog', 'Settings', () => {
            console.debug('[gm] settings click (not implemented)');
        }),
        iconButton('fa-circle-question', 'Help', () => {
            console.debug('[gm] help click (not implemented)');
        }),
    );

    topbar.append(brand, actions);
    return topbar;
}

/* ---------- Page ---------- */

function renderPage() {
    const page = el('div', 'gm-page');
    page.append(
        renderPageHeader(),
        renderCampaignGrid(),
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

function renderCampaignGrid() {
    const grid = el('div', 'gm-campaign-grid');
    for (const campaign of mockCampaigns) {
        grid.append(renderCampaignCard(campaign));
    }
    grid.append(renderNewCampaignCard());
    return grid;
}

/**
 * @param {import('./mock-data.js').MockCampaign} campaign
 */
function renderCampaignCard(campaign) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gm-campaign-card';
    card.setAttribute('data-campaign-id', campaign.id);
    card.addEventListener('click', () => onOpenCampaign(campaign));

    const banner = el('div', `gm-campaign-banner theme-${campaign.bannerTheme || 'default'}`);
    const chip = elText('span', 'gm-ruleset-chip', campaign.ruleset);
    banner.append(chip);

    const body = el('div', 'gm-campaign-body');
    body.append(
        elText('h3', 'gm-campaign-name', campaign.name),
        elText('p', 'gm-campaign-brief', campaign.brief),
        renderCampaignMeta(campaign),
    );

    card.append(banner, body);
    return card;
}

/**
 * @param {import('./mock-data.js').MockCampaign} campaign
 */
function renderCampaignMeta(campaign) {
    const meta = el('div', 'gm-campaign-meta');
    const sceneLabel = campaign.sceneCount === 1 ? 'scene' : 'scenes';
    meta.append(
        metaItem('fa-clock', `Played ${campaign.lastPlayed}`),
        metaItem('fa-masks-theater', `${campaign.sceneCount} ${sceneLabel}`),
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

    const icon = elHTML('div', 'gm-new-campaign-icon', '<i class="fa-solid fa-plus"></i>');
    const title = elText('div', 'gm-new-campaign-title', 'New Campaign');
    const hint = elText('div', 'gm-new-campaign-hint', 'Choose a ruleset, generate your character, and begin.');

    card.append(icon, title, hint);
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
        elText('span', '', 'TTRPG Tavern — Phase 1 visual proof-of-concept. Mock data only.'),
        elText('span', 'gm-pill', 'pre-alpha'),
    );
    return footer;
}

/* ---------- Click handlers (placeholders) ---------- */

/**
 * @param {import('./mock-data.js').MockCampaign} campaign
 */
function onOpenCampaign(campaign) {
    console.info('[gm] open campaign (not implemented):', campaign.id);
    // In Phase 2+ this becomes a route to Campaign Main.
}

function onNewCampaign() {
    console.info('[gm] new campaign (not implemented)');
    // In Phase 2+ this becomes a wizard: ruleset → character → first scene.
}

/* ---------- Tiny DOM helpers (no jQuery; this module is self-contained) ---------- */

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
