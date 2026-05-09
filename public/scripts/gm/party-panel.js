/**
 * Party panel shown on Campaign Main.
 *
 * Phase 1: empty state. Phase 2: shows the player character once the wizard
 * has run. Phase 5: NPCs added by the Director will surface here too.
 */

import { openCharacterWizard } from './character-wizard.js';
import { openSheetPanel } from './sheet-panel.js';
import { route } from './router.js';

/**
 * @param {{ campaign: any, player: any | null }} params
 * @returns {HTMLElement}
 */
export function renderPartyPanel({ campaign, player }) {
    if (!player) {
        const empty = el('div', 'gm-empty-panel');
        empty.append(elText('p', '', 'No characters yet.'));
        const btn = el('button', 'gm-secondary-btn');
        btn.type = 'button';
        btn.innerHTML = '<i class="fa-solid fa-user-pen"></i> Create your character';
        btn.addEventListener('click', () => openCharacterWizard(campaign.id, () => {
            route({ view: 'campaign', campaignId: campaign.id });
        }));
        empty.append(btn);
        return empty;
    }

    const grid = el('div', 'gm-party-grid');
    grid.append(renderCharacterCard(player));
    return grid;
}

/** @param {any} character */
function renderCharacterCard(character) {
    const card = el('button', 'gm-party-card');
    card.type = 'button';

    const portrait = el('div', 'gm-party-portrait');
    portrait.innerHTML = '<i class="fa-solid fa-user-circle"></i>';
    if (character.st_card_avatar) {
        portrait.innerHTML = '';
        const img = document.createElement('img');
        img.src = `/characters/${encodeURIComponent(character.st_card_avatar)}`;
        img.alt = character.name;
        img.addEventListener('error', () => {
            portrait.innerHTML = '<i class="fa-solid fa-user-circle"></i>';
        });
        portrait.append(img);
    }

    const body = el('div', 'gm-party-body');
    body.append(
        elText('div', 'gm-party-name', character.name),
        elText('div', 'gm-party-tag', character.is_player ? 'Player character' : 'NPC'),
    );
    if (character.appearance) {
        body.append(elText('p', 'gm-party-blurb', character.appearance));
    }

    card.append(portrait, body);
    card.addEventListener('click', () => openSheetPanel(character));
    return card;
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
