/**
 * Left sidebar — pinned player character + live sheet preview.
 *
 * Shown in Campaign Main and Scene views once a PC exists. Reads from the
 * server (`GET /api/gm/sheets/:char_id`) and renders a portrait + identity
 * blurb + a compact "key stats" grid pulled from the KV stats bag (a small
 * curated subset of conventional keys). Click "Open sheet" to launch the
 * full KV editor in `sheet-panel.js`.
 *
 * The sidebar listens to `tt:character-changed` window events so it stays
 * fresh when the sheet panel saves an edit. Re-mounting the sidebar
 * naturally re-fetches the latest sheet.
 */

import * as api from './api.js';
import { openSheetPanel } from './sheet-panel.js';

const KEY_STAT_ORDER = [
    'level',
    'hp',
    'max_hp',
    'ac',
    'proficiency_bonus',
    'strength',
    'dexterity',
    'constitution',
    'intelligence',
    'wisdom',
    'charisma',
];
const KEY_STAT_LABELS = {
    level: 'Level',
    hp: 'HP',
    max_hp: 'Max HP',
    ac: 'AC',
    proficiency_bonus: 'Prof.',
    strength: 'STR',
    dexterity: 'DEX',
    constitution: 'CON',
    intelligence: 'INT',
    wisdom: 'WIS',
    charisma: 'CHA',
};

let activeRoot = null;
let activeUnsub = null;

/**
 * Render the left sidebar into a fresh container and return it.
 *
 * @param {{ campaign: any, player: any | null }} params
 * @returns {HTMLElement}
 */
export function renderLeftSidebar({ campaign, player }) {
    teardownLeftSidebar();

    const root = el('aside', 'gm-sidebar gm-sidebar-left');
    root.dataset.campaignId = campaign?.id || '';

    if (!player) {
        root.append(emptyState());
        activeRoot = root;
        return root;
    }

    root.append(buildCard(player));
    activeRoot = root;

    const onChanged = (ev) => {
        const updated = ev?.detail?.character;
        if (!updated || updated.id !== player.id) return;
        // Replace the card in place. We hold a reference to the root, not
        // the card, so we rebuild from scratch.
        const fresh = buildCard(updated);
        const existingCard = root.querySelector('.gm-sidebar-card');
        if (existingCard) {
            root.replaceChild(fresh, existingCard);
        } else {
            root.append(fresh);
        }
    };
    window.addEventListener('tt:character-changed', onChanged);
    activeUnsub = () => window.removeEventListener('tt:character-changed', onChanged);

    // Fire-and-forget refresh so any edits made while offscreen show up.
    api.getSheet(player.id)
        .then(updated => {
            if (!updated || updated.id !== player.id) return;
            const fresh = buildCard(updated);
            const existingCard = root.querySelector('.gm-sidebar-card');
            if (existingCard) root.replaceChild(fresh, existingCard);
        })
        .catch(() => { /* best-effort */ });

    return root;
}

/**
 * Tear down listeners attached to the previous mount. The router's
 * `replaceChildren` removes the DOM but our window-level listener does
 * not unbind itself.
 */
export function teardownLeftSidebar() {
    if (activeUnsub) {
        try { activeUnsub(); } catch (_) { /* ignore */ }
        activeUnsub = null;
    }
    activeRoot = null;
}

/* -------- Renderers -------- */

function emptyState() {
    const wrap = el('div', 'gm-sidebar-empty');
    wrap.append(elText('div', 'gm-sidebar-empty-title', 'No character yet'));
    const note = el('p', 'gm-sidebar-empty-body');
    note.textContent = 'Create your character to start playing.';
    wrap.append(note);
    return wrap;
}

function buildCard(character) {
    const card = el('div', 'gm-sidebar-card');

    const portrait = el('div', 'gm-sidebar-portrait');
    if (character.st_card_avatar) {
        const img = document.createElement('img');
        img.src = `/characters/${encodeURIComponent(character.st_card_avatar)}`;
        img.alt = character.name;
        img.addEventListener('error', () => {
            portrait.innerHTML = '<i class="fa-solid fa-user-circle"></i>';
        });
        portrait.append(img);
    } else {
        portrait.innerHTML = '<i class="fa-solid fa-user-circle"></i>';
    }
    card.append(portrait);

    const ident = el('div', 'gm-sidebar-ident');
    ident.append(elText('div', 'gm-sidebar-name', character.name));
    ident.append(elText('div', 'gm-sidebar-tag', character.is_player ? 'Player character' : 'NPC'));
    if (character.appearance) {
        ident.append(elText('p', 'gm-sidebar-blurb', character.appearance));
    }
    card.append(ident);

    const stats = renderKeyStats(character.sheet?.stats || {});
    if (stats) card.append(stats);

    const actions = el('div', 'gm-sidebar-actions');
    const openBtn = el('button', 'gm-secondary-btn');
    openBtn.type = 'button';
    openBtn.innerHTML = '<i class="fa-solid fa-scroll"></i> Open sheet';
    openBtn.addEventListener('click', () => openSheetPanel(character));
    actions.append(openBtn);
    card.append(actions);

    return card;
}

/**
 * Compact KV grid showing the most relevant stats first; everything else is
 * hidden in the modal sheet editor.
 *
 * @param {Record<string, number | string>} stats
 */
function renderKeyStats(stats) {
    const entries = Object.entries(stats);
    if (entries.length === 0) return null;

    const ordered = [];
    const seen = new Set();
    for (const key of KEY_STAT_ORDER) {
        if (Object.prototype.hasOwnProperty.call(stats, key)) {
            ordered.push([key, stats[key]]);
            seen.add(key);
        }
    }
    // Append any remaining stats up to a small cap so the sidebar stays compact.
    for (const [key, value] of entries) {
        if (seen.has(key)) continue;
        ordered.push([key, value]);
        if (ordered.length >= 12) break;
    }

    const grid = el('div', 'gm-sidebar-stats');
    for (const [key, value] of ordered) {
        const cell = el('div', 'gm-sidebar-stat');
        cell.append(elText('div', 'gm-sidebar-stat-label', KEY_STAT_LABELS[key] || key));
        cell.append(elText('div', 'gm-sidebar-stat-value', String(value)));
        grid.append(cell);
    }
    return grid;
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
