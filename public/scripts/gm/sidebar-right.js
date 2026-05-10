/**
 * Right sidebar — in-scene roster (Scene view only).
 *
 * Lists every character in `scene.participants` with portrait + name. Click
 * a card to view their sheet (NPC sheets render through the same modal but
 * editing is unrestricted — the player decides what their NPCs look like).
 *
 * "Add NPC" opens a small picker:
 *   - Existing campaign characters not already in the scene → click to add.
 *   - "Create NPC" → opens the character wizard in `is_player: false` mode.
 *
 * Subscribes to `turn-events.onStateEvent` so spawn/remove decisions made by
 * the Director update the roster live without polling.
 */

import * as api from './api.js';
import { openSheetPanel } from './sheet-panel.js';
import { openCharacterWizard } from './character-wizard.js';
import { onStateEvent } from './turn-events.js';

let activeRoot = null;
let activeUnsubState = null;
let activeRefresh = null;

/**
 * @param {{ campaign: any, scene: any, characters: any[] }} params
 * @returns {HTMLElement}
 */
export function renderRightSidebar({ campaign, scene, characters }) {
    teardownRightSidebar();

    const root = document.createElement('aside');
    root.className = 'gm-sidebar gm-sidebar-right';

    const state = {
        campaign,
        scene: { ...scene, participants: Array.isArray(scene.participants) ? [...scene.participants] : [] },
        charactersById: new Map((characters || []).map(c => [c.id, c])),
        charactersList: Array.isArray(characters) ? characters.slice() : [],
    };

    const header = document.createElement('div');
    header.className = 'gm-sidebar-header';
    const title = document.createElement('div');
    title.className = 'gm-sidebar-title';
    title.textContent = 'In scene';
    header.append(title);
    root.append(header);

    const list = document.createElement('div');
    list.className = 'gm-sidebar-roster';
    root.append(list);

    const actions = document.createElement('div');
    actions.className = 'gm-sidebar-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'gm-secondary-btn';
    addBtn.type = 'button';
    addBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Add to scene';
    addBtn.addEventListener('click', () => openPicker(state, root, addBtn));
    actions.append(addBtn);
    root.append(actions);

    const refreshList = () => {
        list.innerHTML = '';
        const idsInScene = state.scene.participants;
        if (idsInScene.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'gm-sidebar-empty-body';
            empty.textContent = 'No actors in scene yet.';
            list.append(empty);
            return;
        }
        for (const id of idsInScene) {
            const character = state.charactersById.get(id);
            if (!character) continue;
            list.append(buildRow(character, state, refreshList));
        }
    };

    refreshList();

    activeRoot = root;
    activeRefresh = async () => {
        try {
            const fresh = await api.getScene(state.scene.id);
            if (fresh) state.scene = { ...state.scene, ...fresh, participants: fresh.participants || [] };
            const chars = await api.listCharacters(campaign.id).catch(() => null);
            if (Array.isArray(chars)) {
                state.charactersList = chars;
                state.charactersById = new Map(chars.map(c => [c.id, c]));
            }
        } catch (err) {
            console.warn('[gm] sidebar-right refresh failed', err);
        }
        refreshList();
    };

    activeUnsubState = onStateEvent((ev) => {
        if (!ev) return;
        if (ev.change === 'spawn' && ev.character_id) {
            const set = new Set(state.scene.participants);
            set.add(ev.character_id);
            state.scene.participants = Array.from(set);
        } else if (ev.change === 'remove' && ev.character_id) {
            state.scene.participants = state.scene.participants.filter(id => id !== ev.character_id);
        }
        // Pull a fresh roster so any Director-spawned NPC we don't yet
        // know about (impossible today; defensive) shows up correctly.
        if (activeRefresh) activeRefresh();
        else refreshList();
    });

    return root;
}

export function teardownRightSidebar() {
    if (activeUnsubState) {
        try { activeUnsubState(); } catch (_) { /* ignore */ }
        activeUnsubState = null;
    }
    activeRefresh = null;
    activeRoot = null;
}

/* -------- Roster row -------- */

function buildRow(character, state, refreshList) {
    const row = document.createElement('div');
    row.className = 'gm-sidebar-roster-row';
    if (character.is_player) row.classList.add('is-player');

    const portrait = document.createElement('div');
    portrait.className = 'gm-sidebar-roster-portrait';
    if (character.has_portrait !== false) {
        const img = document.createElement('img');
        img.src = api.getPortraitUrl(character);
        img.alt = character.name;
        img.addEventListener('error', () => {
            portrait.innerHTML = '<i class="fa-solid fa-user-circle"></i>';
        });
        portrait.append(img);
    } else {
        portrait.innerHTML = '<i class="fa-solid fa-user-circle"></i>';
    }

    const body = document.createElement('div');
    body.className = 'gm-sidebar-roster-body';
    const name = document.createElement('div');
    name.className = 'gm-sidebar-roster-name';
    name.textContent = character.name;
    const role = document.createElement('div');
    role.className = 'gm-sidebar-roster-role';
    role.textContent = character.is_player ? 'You' : 'NPC';
    body.append(name, role);

    const sheetBtn = document.createElement('button');
    sheetBtn.className = 'gm-icon-btn';
    sheetBtn.type = 'button';
    sheetBtn.title = 'View sheet';
    sheetBtn.innerHTML = '<i class="fa-solid fa-scroll"></i>';
    sheetBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openSheetPanel(character);
    });

    row.append(portrait, body, sheetBtn);

    if (!character.is_player) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'gm-icon-btn gm-sidebar-remove';
        removeBtn.type = 'button';
        removeBtn.title = 'Remove from scene';
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        removeBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (!confirm(`Remove ${character.name} from this scene?`)) return;
            try {
                await api.removeSceneParticipant(state.scene.id, character.id);
                state.scene.participants = state.scene.participants.filter(id => id !== character.id);
                refreshList();
            } catch (err) {
                console.error('[gm] remove participant failed', err);
                alert(`Could not remove: ${err?.message || err}`);
            }
        });
        row.append(removeBtn);
    }

    row.addEventListener('click', () => openSheetPanel(character));
    return row;
}

/* -------- Add picker -------- */

function openPicker(state, sidebarRoot, anchorBtn) {
    closePicker();

    const overlay = document.createElement('div');
    overlay.className = 'gm-modal-overlay';
    overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) closePicker();
    });

    const panel = document.createElement('div');
    panel.className = 'gm-modal gm-picker-modal';

    const head = document.createElement('div');
    head.className = 'gm-modal-header';
    const title = document.createElement('h2');
    title.className = 'gm-modal-title';
    title.textContent = 'Add to scene';
    head.append(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gm-icon-btn';
    closeBtn.type = 'button';
    closeBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
    closeBtn.addEventListener('click', closePicker);
    head.append(closeBtn);
    panel.append(head);

    const body = document.createElement('div');
    body.className = 'gm-modal-body';

    const idsInScene = new Set(state.scene.participants);
    const candidates = state.charactersList.filter(c => !idsInScene.has(c.id) && !c.is_player);
    if (candidates.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'gm-modal-detail-body';
        empty.textContent = 'No off-stage NPCs in this campaign yet.';
        body.append(empty);
    } else {
        const list = document.createElement('div');
        list.className = 'gm-picker-list';
        for (const c of candidates) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'gm-picker-row';
            const dot = document.createElement('span');
            dot.className = 'gm-picker-dot';
            const label = document.createElement('span');
            label.className = 'gm-picker-label';
            label.textContent = c.name;
            const blurb = document.createElement('span');
            blurb.className = 'gm-picker-blurb';
            blurb.textContent = c.appearance ? c.appearance.slice(0, 60) : '';
            row.append(dot, label, blurb);
            row.addEventListener('click', async () => {
                try {
                    await api.addSceneParticipant(state.scene.id, c.id);
                    state.scene.participants = [...state.scene.participants, c.id];
                    closePicker();
                    if (activeRefresh) await activeRefresh();
                } catch (err) {
                    console.error('[gm] add participant failed', err);
                    alert(`Could not add: ${err?.message || err}`);
                }
            });
            list.append(row);
        }
        body.append(list);
    }

    const sep = document.createElement('div');
    sep.className = 'gm-picker-sep';
    sep.textContent = 'or';
    body.append(sep);

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'gm-secondary-btn';
    createBtn.innerHTML = '<i class="fa-solid fa-user-pen"></i> Create new NPC';
    createBtn.addEventListener('click', () => {
        closePicker();
        openCharacterWizard(state.campaign.id, async (created) => {
            if (created && created.id) {
                try {
                    await api.addSceneParticipant(state.scene.id, created.id);
                } catch (err) {
                    console.warn('[gm] auto-add NPC after create failed', err);
                }
            }
            if (activeRefresh) await activeRefresh();
        }, { mode: 'npc' });
    });
    body.append(createBtn);
    panel.append(body);

    overlay.append(panel);
    document.body.append(overlay);
    activePicker = overlay;
    document.addEventListener('keydown', onPickerEsc);
}

let activePicker = null;
function closePicker() {
    if (activePicker && activePicker.parentNode) {
        activePicker.parentNode.removeChild(activePicker);
    }
    activePicker = null;
    document.removeEventListener('keydown', onPickerEsc);
}
function onPickerEsc(e) {
    if (e.key === 'Escape') closePicker();
}
