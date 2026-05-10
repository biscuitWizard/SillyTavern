/**
 * Campaign Main — the per-campaign hub.
 *
 * Layout: topbar with brand + Hub/Memory tab switcher + connection +
 * delete; hero banner reading the campaign brief; left sidebar with the
 * pinned PC sheet preview; main body that swaps between three sub-views
 * WITHOUT navigating away from the hub:
 *
 *   - 'hub'  (default): "Where things stand" panel + Ask/Plot action
 *             cards + expandable scene history.
 *   - 'ask'  : Ask panel (out-of-fiction GM chat, persistent transcript,
 *             auto-records world lore).
 *   - 'plot' : Plot panel (declared-action gate; pushback or scene start).
 *
 * Sub-view swaps stay inside `.gm-three-col-main` and do NOT toggle
 * `body.tt-mode-scene` (which is reserved for actual scenes).
 */

import { route } from './router.js';
import * as api from './api.js';
import { openStApiPanel, currentLlmProfile } from './llm-profile.js';
import { mountConnectionGate, getConnectionStatus } from './connection-gate.js';
import { openCharacterWizard } from './character-wizard.js';
import { renderLeftSidebar, teardownLeftSidebar } from './sidebar-left.js';
import { renderAskPanel } from './ask-panel.js';
import { renderPlotPanel } from './plot-panel.js';
import { setActiveCampaign } from './sheet-panel.js';

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

    // Stash the active campaign so the sheet panel (opened by the left
    // sidebar / party panel / etc.) can fetch the matching layout
    // without every call site having to thread the campaign through.
    setActiveCampaign(campaign);

    const characters = await api.listCharacters(campaignId).catch(() => []);
    const player = characters.find(c => c.is_player) || null;
    const scenes = await api.listScenes(campaignId).catch(() => []);

    // Notify the right-drawer character drawer about the active campaign.
    window.dispatchEvent(new CustomEvent('tt:campaign-changed', {
        detail: { campaign, characters, player },
    }));

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

/**
 * Render the Campaign Main body. The body has three sub-views the player
 * swaps between WITHOUT navigating away from the hub: 'hub' (default,
 * shows situation panel + Ask/Plot cards + scene history), 'ask' (Ask
 * panel), and 'plot' (Plot panel). Switching never toggles
 * `body.tt-mode-scene` — that class is reserved for actual scenes.
 *
 * @param {any} campaign
 * @param {{ player: any, scenes: any[] }} args
 */
function renderBody(campaign, { player, scenes }) {
    const page = el('div', 'gm-page gm-campaign-page');
    /** @type {'hub' | 'ask' | 'plot'} */
    let view = 'hub';
    let liveCampaign = campaign;

    const swap = async (next) => {
        if (next === view) return;
        view = next;
        await paint();
    };

    const paint = async () => {
        if (view === 'ask') {
            renderAskPanel(page, {
                campaign: liveCampaign,
                onBack: () => swap('hub'),
            });
            return;
        }
        if (view === 'plot') {
            if (!player) { view = 'hub'; }
            else {
                renderPlotPanel(page, {
                    campaign: liveCampaign,
                    player,
                    onBack: () => swap('hub'),
                });
                return;
            }
        }
        page.replaceChildren();
        if (player) {
            page.append(renderSituationPanel(liveCampaign, {
                onChanged: (updated) => { if (updated) liveCampaign = updated; paint(); },
            }));
        } else {
            page.append(renderChargenCallout(liveCampaign));
        }
        page.append(renderActionCards({
            player,
            onAsk: () => swap('ask'),
            onPlot: () => swap('plot'),
        }));
        page.append(renderSection('Scene history', renderSceneHistoryPanel(liveCampaign, scenes)));
    };

    paint();
    return page;
}

function renderSection(title, body) {
    const section = el('div', 'gm-section');
    section.append(elText('h2', 'gm-section-title', title));
    section.append(body);
    return section;
}

function renderChargenCallout(campaign) {
    const wrap = el('div', 'gm-empty-panel');
    wrap.append(elText('div', '', 'Create your player character to start playing.'));
    const cta = el('button', 'gm-primary-btn');
    cta.type = 'button';
    cta.innerHTML = '<i class="fa-solid fa-address-card"></i> Open Characters';
    cta.addEventListener('click', () => {
        const toggle = document.getElementById('rightNavDrawerIcon');
        if (toggle) toggle.click();
    });
    wrap.append(cta);
    return wrap;
}

/* -------- Situation panel -------- */

/**
 * Render the "Where things stand" panel. When `current_situation` is null
 * the panel offers a "Generate opening" button that POSTs to the server's
 * opening synth. The pencil icon swaps the panel into an inline edit
 * form that PATCHes the snapshot.
 *
 * @param {any} campaign
 * @param {{ onChanged: (updated: any) => void }} args
 */
function renderSituationPanel(campaign, { onChanged }) {
    const panel = el('div', 'gm-situation-panel');

    const head = el('div', 'gm-situation-panel-head');
    head.append(elText('div', 'gm-situation-panel-eyebrow', 'Where things stand'));
    const headActions = el('div', 'gm-situation-panel-actions');
    head.append(headActions);
    panel.append(head);

    const body = el('div', 'gm-situation-panel-body');
    panel.append(body);

    const cs = campaign.current_situation;
    if (!cs) {
        const empty = el('p', 'gm-situation-panel-empty');
        empty.textContent = 'No situation snapshot on file yet. The GM can write one based on your character and the campaign brief.';
        body.append(empty);

        const actions = el('div', 'gm-situation-panel-empty-actions');
        const genBtn = el('button', 'gm-primary-btn');
        genBtn.type = 'button';
        genBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate opening';
        genBtn.addEventListener('click', async () => {
            const status = getConnectionStatus();
            if (!status.ok) {
                alert('No active LLM connection. Open the API panel to fix this first.');
                return;
            }
            const directorProfile = currentLlmProfile('director');
            if (!directorProfile) {
                alert('No active LLM profile. Open the API panel to select one.');
                return;
            }
            genBtn.disabled = true;
            genBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Generating…';
            try {
                const out = await api.generateOpening(campaign.id, { director_profile: directorProfile });
                onChanged(out.campaign);
            } catch (err) {
                console.error('[gm] generateOpening failed', err);
                alert(`Could not generate opening: ${err?.message || err}`);
                genBtn.disabled = false;
                genBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate opening';
            }
        });

        const writeBtn = el('button', 'gm-secondary-btn');
        writeBtn.type = 'button';
        writeBtn.innerHTML = '<i class="fa-solid fa-pen"></i> Write it yourself';
        writeBtn.addEventListener('click', () => swapToEdit(panel, campaign, null, onChanged));
        actions.append(genBtn, writeBtn);
        body.append(actions);
        return panel;
    }

    headActions.append(buildEditButton(() => swapToEdit(panel, campaign, cs, onChanged)));

    if (cs.recap) {
        const recap = el('p', 'gm-situation-panel-recap');
        recap.textContent = cs.recap;
        body.append(recap);
    }

    const meta = el('div', 'gm-situation-panel-meta');
    if (cs.location) meta.append(metaPill('fa-location-dot', cs.location));
    if (cs.time) meta.append(metaPill('fa-clock', cs.time));
    if (Array.isArray(cs.nearby_characters) && cs.nearby_characters.length) {
        meta.append(metaPill('fa-users', `Nearby: ${cs.nearby_characters.join(', ')}`));
    }
    if (meta.childElementCount > 0) body.append(meta);

    return panel;
}

function metaPill(icon, text) {
    const span = document.createElement('span');
    span.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    span.querySelector('span').textContent = text;
    return span;
}

function buildEditButton(onClick) {
    const btn = el('button', 'gm-icon-btn');
    btn.type = 'button';
    btn.title = 'Edit "where things stand"';
    btn.innerHTML = '<i class="fa-solid fa-pen"></i>';
    btn.addEventListener('click', onClick);
    return btn;
}

/**
 * Replace the situation panel's body with an inline edit form. On save
 * PATCHes the campaign and re-renders via `onChanged`.
 *
 * @param {HTMLElement} panel
 * @param {any} campaign
 * @param {any} situation
 * @param {(updated: any) => void} onChanged
 */
function swapToEdit(panel, campaign, situation, onChanged) {
    panel.replaceChildren();
    const head = el('div', 'gm-situation-panel-head');
    head.append(elText('div', 'gm-situation-panel-eyebrow', 'Editing where things stand'));
    panel.append(head);

    const form = el('form', 'gm-situation-edit');
    const recap = formField('Recap', 'textarea', situation?.recap || '');
    const location = formField('Location', 'input', situation?.location || '');
    const time = formField('Time', 'input', situation?.time || '');
    const nearby = formField('Nearby (comma-separated)', 'input',
        Array.isArray(situation?.nearby_characters) ? situation.nearby_characters.join(', ') : '');

    form.append(recap.label, location.label, time.label, nearby.label);

    const actions = el('div', 'gm-situation-edit-actions');
    const cancel = el('button', 'gm-secondary-btn');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => onChanged(campaign));
    const save = el('button', 'gm-primary-btn');
    save.type = 'submit';
    save.textContent = 'Save';
    actions.append(cancel, save);
    form.append(actions);

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        save.disabled = true;
        cancel.disabled = true;
        const payload = {
            recap: recap.input.value.trim(),
            location: location.input.value.trim(),
            time: time.input.value.trim(),
            nearby_characters: nearby.input.value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
        };
        try {
            const out = await api.patchCurrentSituation(campaign.id, payload);
            onChanged(out.campaign);
        } catch (err) {
            console.error('[gm] patchCurrentSituation failed', err);
            alert(`Could not save: ${err?.message || err}`);
            save.disabled = false;
            cancel.disabled = false;
        }
    });

    panel.append(form);
}

function formField(labelText, kind, value) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = labelText;
    label.append(span);
    /** @type {HTMLInputElement | HTMLTextAreaElement} */
    const input = kind === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (input instanceof HTMLInputElement) input.type = 'text';
    input.value = value || '';
    label.append(input);
    return { label, input };
}

/* -------- Action cards (Ask / Plot) -------- */

function renderActionCards({ player, onAsk, onPlot }) {
    const wrap = el('div', 'gm-action-cards');
    wrap.append(buildActionCard({
        icon: 'fa-comments',
        title: 'Ask the GM',
        blurb: 'Out-of-fiction questions about the world, the plot, or what your character knows. The GM will answer without advancing the scene.',
        onClick: onAsk,
    }));
    const plotCard = buildActionCard({
        icon: 'fa-bolt',
        title: 'Take action',
        blurb: player
            ? `Tell the GM what ${player.name} wants to do, say, or attempt next. They\'ll either push back or set the scene.`
            : 'Create your character first to start declaring actions.',
        onClick: onPlot,
        disabled: !player,
    });
    wrap.append(plotCard);
    return wrap;
}

function buildActionCard({ icon, title, blurb, onClick, disabled }) {
    const btn = el('button', 'gm-action-card');
    btn.type = 'button';
    btn.disabled = !!disabled;
    const titleRow = el('div', 'gm-action-card-title');
    const iconWrap = el('div', 'gm-action-card-icon');
    iconWrap.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    titleRow.append(iconWrap, document.createTextNode(title));
    btn.append(titleRow);
    btn.append(elText('p', 'gm-action-card-blurb', blurb));
    if (!disabled) btn.addEventListener('click', onClick);
    return btn;
}

/* -------- Scene history (now expandable) -------- */

function renderSceneHistoryPanel(campaign, scenes) {
    if (!scenes.length) {
        return elText('div', 'gm-empty-panel', 'No scenes yet. Use "Take action" to start one.');
    }
    const list = el('div', 'gm-scene-list');
    const sorted = [...scenes].sort((a, b) => Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0));
    for (const scene of sorted) {
        const { row, expand, toggle } = renderSceneRow(campaign, scene);
        list.append(row);
        if (expand) list.append(expand);
        // keep ESLint quiet about the unused `toggle` (the wiring lives
        // inside the row click handler).
        void toggle;
    }
    return list;
}

function renderSceneRow(campaign, scene) {
    const row = el('button', 'gm-scene-row');
    row.type = 'button';

    const status = scene.status === 'closed' ? 'Closed' : 'Active';
    const date = scene.started_at ? formatRelative(scene.started_at) : '—';
    const messages = `${scene.message_count ?? 0} msg`;
    const headline = typeof scene.summary_headline === 'string' ? scene.summary_headline.trim() : '';

    row.innerHTML = `
        <span class="gm-scene-row-text">
            <span class="gm-scene-row-name"></span>
            <span class="gm-scene-row-headline"></span>
        </span>
        <span class="gm-scene-row-meta">
            <span class="gm-scene-row-status status-${scene.status}"></span>
            <span class="gm-scene-row-date"></span>
            <span class="gm-scene-row-messages"></span>
            <span class="gm-scene-row-chevron"><i class="fa-solid fa-chevron-down"></i></span>
        </span>
    `;
    row.querySelector('.gm-scene-row-name').textContent = scene.name || scene.id;
    const headlineEl = row.querySelector('.gm-scene-row-headline');
    if (headline) {
        headlineEl.textContent = headline;
        headlineEl.title = headline;
    } else {
        headlineEl.remove();
    }
    row.querySelector('.gm-scene-row-status').textContent = status;
    row.querySelector('.gm-scene-row-date').textContent = date;
    row.querySelector('.gm-scene-row-messages').textContent = messages;
    const chevron = row.querySelector('.gm-scene-row-chevron i');

    // Closed scenes get an inline expansion that pulls the SceneSummary
    // prose. Active scenes go straight to the scene view (Phase 4
    // behaviour). The "expand" element is created lazily on first toggle.
    const isClosed = scene.status === 'closed';
    /** @type {HTMLElement | null} */
    let expand = null;
    let loaded = false;
    let openState = false;

    const toggle = async () => {
        if (!isClosed) {
            route({
                view: 'scene',
                campaignId: campaign.id,
                sceneId: scene.id,
                readOnly: false,
            });
            return;
        }
        if (!expand) return;
        openState = !openState;
        expand.style.display = openState ? '' : 'none';
        if (chevron) {
            chevron.className = openState ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
        }
        if (openState && !loaded) {
            loaded = true;
            await loadExpansion(expand, campaign, scene);
        }
    };

    if (isClosed) {
        expand = el('div', 'gm-scene-row-expand');
        expand.style.display = 'none';
        // Initial placeholder content; replaced on first open.
        expand.append(elText('div', 'gm-scene-row-expand-empty', 'Loading scene summary…'));
    }

    row.addEventListener('click', toggle);

    return { row, expand, toggle };
}

async function loadExpansion(host, campaign, scene) {
    host.replaceChildren(elText('div', 'gm-scene-row-expand-empty', 'Loading scene summary…'));
    try {
        const summary = await api.getSceneSummary(campaign.id, scene.id);
        if (!summary) {
            host.replaceChildren(buildExpansionFallback(campaign, scene));
            return;
        }
        host.replaceChildren(buildExpansion(campaign, scene, summary));
    } catch (err) {
        console.warn('[gm] failed to load scene summary', err);
        host.replaceChildren(buildExpansionFallback(campaign, scene, err?.message || ''));
    }
}

function buildExpansion(campaign, scene, summary) {
    const wrap = document.createDocumentFragment();
    if (summary.headline) {
        wrap.append(elText('div', 'gm-scene-row-expand-headline', summary.headline));
    }
    if (summary.summary) {
        wrap.append(elText('p', 'gm-scene-row-expand-summary', summary.summary));
    }
    const meta = el('div', 'gm-scene-row-expand-meta');
    if (Array.isArray(summary.location_changes) && summary.location_changes.length) {
        const node = document.createElement('span');
        node.innerHTML = '<i class="fa-solid fa-location-dot"></i> <span></span>';
        node.querySelector('span').textContent = summary.location_changes.join(', ');
        meta.append(node);
    }
    if (Array.isArray(summary.participant_changes) && summary.participant_changes.length) {
        const node = document.createElement('span');
        node.innerHTML = '<i class="fa-solid fa-users"></i> <span></span>';
        node.querySelector('span').textContent = summary.participant_changes.join(', ');
        meta.append(node);
    }
    if (meta.childElementCount > 0) wrap.append(meta);

    const actions = el('div', 'gm-scene-row-expand-actions');
    const open = el('button', 'gm-secondary-btn');
    open.type = 'button';
    open.innerHTML = '<i class="fa-solid fa-book-open"></i> Open scene (read-only)';
    open.addEventListener('click', (ev) => {
        ev.stopPropagation();
        route({
            view: 'scene',
            campaignId: campaign.id,
            sceneId: scene.id,
            readOnly: true,
        });
    });
    actions.append(open);
    wrap.append(actions);
    return wrap;
}

function buildExpansionFallback(campaign, scene, errMessage) {
    const wrap = document.createDocumentFragment();
    const note = el('div', 'gm-scene-row-expand-empty');
    note.textContent = errMessage
        ? `Couldn't load scene summary: ${errMessage}`
        : 'No scene summary on file yet (this scene closed before summaries were enabled).';
    wrap.append(note);
    const actions = el('div', 'gm-scene-row-expand-actions');
    const open = el('button', 'gm-secondary-btn');
    open.type = 'button';
    open.innerHTML = '<i class="fa-solid fa-book-open"></i> Open scene (read-only)';
    open.addEventListener('click', (ev) => {
        ev.stopPropagation();
        route({
            view: 'scene',
            campaignId: campaign.id,
            sceneId: scene.id,
            readOnly: true,
        });
    });
    actions.append(open);
    wrap.append(actions);
    return wrap;
}

function renderFooter() {
    const footer = el('div', 'gm-footer');
    footer.append(
        elText('span', '', 'TTRPG Tavern'),
        elText('span', 'gm-pill', 'pre-alpha'),
    );
    return footer;
}

/* -------- Click handlers -------- */

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
