/**
 * Campaign character drawer — replaces ST's right-panel character list
 * with a campaign-scoped roster and inline character card view.
 *
 * States:
 *   - No campaign loaded → empty message
 *   - Campaign loaded, no characters → "Create your first character" CTA
 *   - Campaign loaded, characters → roster list + selected card body
 *
 * The drawer subscribes to `tt:campaign-changed` and `tt:character-changed`
 * so it stays in sync with the rest of the shell without polling.
 */

import * as api from './api.js';
import { mountCardView } from './character-card-view.js';
import { openCharacterWizard } from './character-wizard.js';
import { openSheetPanel } from './sheet-panel.js';

let mountEl = null;

/** @type {{ campaign: any | null, characters: any[], player: any | null }} */
let state = { campaign: null, characters: [], player: null };

let selectedCharacterId = null;

/** @type {{ refresh: (c: any) => void, destroy: () => void } | null} */
let activeCardView = null;

/**
 * One-time mount into `#gm-character-drawer`. Called from `bootstrap.js`.
 */
export function init() {
    mountEl = document.getElementById('gm-character-drawer');
    if (!mountEl) {
        console.warn('[gm.drawer] #gm-character-drawer not found');
        return;
    }

    window.addEventListener('tt:campaign-changed', (/** @type {CustomEvent} */ e) => {
        const detail = e.detail || {};
        update({ campaign: detail.campaign || null, characters: detail.characters || [], player: detail.player || null });
    });

    window.addEventListener('tt:character-changed', async (/** @type {CustomEvent} */ e) => {
        if (!state.campaign) return;
        try {
            const chars = await api.listCharacters(state.campaign.id);
            state.characters = chars;
            state.player = chars.find(c => c.is_player) || null;
            render();
        } catch (err) {
            console.warn('[gm.drawer] refresh after character-changed failed', err);
        }
    });

    render();
}

/**
 * Push new campaign + characters state into the drawer.
 *
 * @param {{ campaign: any | null, characters: any[], player: any | null }} next
 */
export function update(next) {
    state = { ...next };
    if (state.campaign && selectedCharacterId) {
        const still = state.characters.find(c => c.id === selectedCharacterId);
        if (!still) selectedCharacterId = null;
    }
    render();
}

function render() {
    if (!mountEl) return;
    destroyCardView();
    mountEl.innerHTML = '';

    if (!state.campaign) {
        mountEl.append(renderEmptyState());
        return;
    }

    if (state.characters.length === 0) {
        mountEl.append(renderNoCampaignCharacters());
        return;
    }

    mountEl.append(renderRoster());

    if (!selectedCharacterId && state.player) {
        selectedCharacterId = state.player.id;
    }

    const selected = state.characters.find(c => c.id === selectedCharacterId);
    if (selected) {
        const cardMount = el('div', 'gm-drawer-card');
        mountEl.append(cardMount);
        activeCardView = mountCardView({
            mount: cardMount,
            character: selected,
            campaign: state.campaign,
            showPortrait: false,
        });
    }
}

function destroyCardView() {
    if (activeCardView) {
        activeCardView.destroy();
        activeCardView = null;
    }
}

/* -------- Roster -------- */

function renderRoster() {
    const wrap = el('div', 'gm-drawer-roster');

    const header = el('div', 'gm-drawer-roster-header');
    header.append(elText('span', 'gm-drawer-roster-title', 'Characters'));

    const actions = el('div', 'gm-drawer-roster-actions');

    if (!state.player) {
        const addPc = el('button', 'gm-drawer-btn gm-drawer-btn--pc');
        addPc.type = 'button';
        addPc.textContent = '+ Player';
        addPc.addEventListener('click', () => {
            openCharacterWizard(state.campaign.id, onCharacterCreated, { mode: 'pc' });
        });
        actions.append(addPc);
    }

    const addNpc = el('button', 'gm-drawer-btn gm-drawer-btn--npc');
    addNpc.type = 'button';
    addNpc.textContent = '+ NPC';
    addNpc.addEventListener('click', () => {
        openCharacterWizard(state.campaign.id, onCharacterCreated, { mode: 'npc' });
    });
    actions.append(addNpc);
    header.append(actions);
    wrap.append(header);

    const list = el('div', 'gm-drawer-roster-list');
    for (const char of state.characters) {
        list.append(renderRosterRow(char));
    }
    wrap.append(list);

    return wrap;
}

function renderRosterRow(character) {
    const row = el('div', 'gm-drawer-roster-row');
    if (character.id === selectedCharacterId) {
        row.classList.add('gm-drawer-roster-row--selected');
    }

    const portrait = el('div', 'gm-drawer-roster-portrait');
    const img = document.createElement('img');
    img.src = api.getPortraitUrl(character);
    img.alt = character.name;
    img.addEventListener('error', () => {
        portrait.innerHTML = '<i class="fa-solid fa-user-circle"></i>';
    });
    portrait.append(img);
    row.append(portrait);

    const info = el('div', 'gm-drawer-roster-info');
    info.append(elText('div', 'gm-drawer-roster-name', character.name));
    const badge = elText('span',
        `gm-drawer-roster-badge ${character.is_player ? 'gm-drawer-roster-badge--pc' : 'gm-drawer-roster-badge--npc'}`,
        character.is_player ? 'PC' : 'NPC',
    );
    info.append(badge);
    row.append(info);

    const expandBtn = el('button', 'gm-drawer-roster-expand');
    expandBtn.type = 'button';
    expandBtn.title = 'Full sheet editor';
    expandBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square"></i>';
    expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSheetPanel(character, { campaign: state.campaign });
    });
    row.append(expandBtn);

    row.addEventListener('click', () => {
        selectedCharacterId = character.id;
        render();
    });

    return row;
}

/* -------- Empty states -------- */

function renderEmptyState() {
    const wrap = el('div', 'gm-drawer-empty');
    wrap.append(elText('p', 'gm-drawer-empty-text', 'Open a campaign to see characters.'));
    return wrap;
}

function renderNoCampaignCharacters() {
    const wrap = el('div', 'gm-drawer-empty');
    wrap.append(elText('p', 'gm-drawer-empty-text', 'No characters yet.'));
    const btn = el('button', 'gm-drawer-btn gm-drawer-btn--pc');
    btn.type = 'button';
    btn.textContent = 'Create Player Character';
    btn.addEventListener('click', () => {
        openCharacterWizard(state.campaign.id, onCharacterCreated, { mode: 'pc' });
    });
    wrap.append(btn);
    return wrap;
}

/* -------- Callbacks -------- */

async function onCharacterCreated(character) {
    if (!state.campaign) return;
    try {
        const chars = await api.listCharacters(state.campaign.id);
        state.characters = chars;
        state.player = chars.find(c => c.is_player) || null;
        selectedCharacterId = character?.id || null;
    } catch (_) { /* swallow — render will show stale */ }
    window.dispatchEvent(new CustomEvent('tt:character-changed', { detail: { character } }));
    render();
}

/* -------- DOM helpers -------- */

function el(tag, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function elText(tag, className, text) {
    const e = el(tag, className);
    e.textContent = text ?? '';
    return e;
}
