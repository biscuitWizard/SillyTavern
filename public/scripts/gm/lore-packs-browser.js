/**
 * Lore Packs browser — Library tab surface.
 *
 * List view shows cards for each bundled lore pack.
 * Detail view shows entries grouped by kind, characters section, and
 * "Apply to campaign" CTA.
 */

import * as api from './api.js';

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

/* -------- Kind label formatting -------- */

const KIND_LABELS = {
    location: 'Location',
    faction: 'Faction',
    culture: 'Culture',
    people: 'People',
    history: 'History',
    magic: 'Magic',
    artifact: 'Artifact',
    bestiary: 'Bestiary',
    cosmology: 'Cosmology',
    language: 'Language',
    pantheon: 'Pantheon',
    custom: 'Custom',
};

function kindLabel(kind) {
    return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/* ================================================================
 *  Public entry point
 * ================================================================ */

/**
 * Render the Lore Packs browser into the given mount element.
 * @param {HTMLElement} mount
 */
export async function renderLorePacksBrowser(mount) {
    mount.innerHTML = '';
    mount.append(elText('p', 'gm-text-muted', 'Loading lore packs…'));

    try {
        const packs = await api.listLorePacks();
        mount.innerHTML = '';

        if (!packs.length) {
            mount.append(elText('div', 'gm-empty-panel', 'No lore packs found.'));
            return;
        }

        renderListView(mount, packs);
    } catch (err) {
        mount.innerHTML = '';
        mount.append(elText('div', 'gm-empty-panel', `Failed to load lore packs: ${err.message}`));
    }
}

/* ================================================================
 *  List view
 * ================================================================ */

function renderListView(mount, packs) {
    const grid = el('div', 'gm-lore-grid');

    for (const pack of packs) {
        const card = el('div', 'gm-lore-card');
        card.append(elText('h3', 'gm-lore-card-name', pack.name));

        if (pack.description) {
            card.append(elText('p', 'gm-lore-card-desc', pack.description));
        }

        const meta = el('div', 'gm-lore-card-meta');
        const count = pack.entry_count ?? pack.count ?? 0;
        meta.append(elText('span', '', `${count} ${count === 1 ? 'entry' : 'entries'}`));
        card.append(meta);

        card.addEventListener('click', () => openDetailView(mount, pack.id));
        grid.append(card);
    }

    mount.append(grid);
}

/* ================================================================
 *  Detail view
 * ================================================================ */

async function openDetailView(mount, packId) {
    mount.innerHTML = '';
    mount.append(elText('p', 'gm-text-muted', 'Loading…'));

    try {
        const pack = await api.getLorePack(packId);
        if (!pack) {
            mount.innerHTML = '';
            mount.append(elText('div', 'gm-empty-panel', 'Lore pack not found.'));
            return;
        }
        mount.innerHTML = '';
        renderDetail(mount, pack);
    } catch (err) {
        mount.innerHTML = '';
        mount.append(elText('div', 'gm-empty-panel', `Failed to load lore pack: ${err.message}`));
    }
}

function renderDetail(mount, pack) {
    const container = el('div', 'gm-lore-detail');

    // Back button
    const back = elHTML('button', 'gm-lore-back-btn', '<i class="fa-solid fa-arrow-left"></i> Back to lore packs');
    back.type = 'button';
    back.addEventListener('click', () => renderLorePacksBrowser(mount));
    container.append(back);

    // Header
    const header = el('div', 'gm-lore-detail-header');
    header.append(elText('h2', '', pack.pack_name));

    const metaRow = el('div', 'gm-lore-card-meta');
    const entryCount = pack.entries?.length ?? 0;
    const charCount = pack.characters?.length ?? 0;
    metaRow.append(elText('span', '', `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`));
    if (charCount > 0) {
        metaRow.append(elText('span', 'gm-pill', `${charCount} ${charCount === 1 ? 'character' : 'characters'}`));
    }
    header.append(metaRow);
    container.append(header);

    // Description
    if (pack.description) {
        container.append(elText('p', 'gm-lore-detail-desc', pack.description));
    }

    // Entries grouped by kind
    if (entryCount > 0) {
        const grouped = groupByKind(pack.entries);
        for (const [kind, entries] of grouped) {
            const group = el('div', 'gm-lore-group');
            group.append(elText('h3', 'gm-lore-group-title', kindLabel(kind)));

            for (const entry of entries) {
                group.append(buildEntryDisclosure(entry));
            }
            container.append(group);
        }
    }

    // Characters section
    if (charCount > 0) {
        const charSection = el('div', 'gm-lore-group');
        charSection.append(elText('h3', 'gm-lore-group-title', `Characters (${charCount})`));

        const charGrid = el('div', 'gm-lore-chars-grid');
        for (const ch of pack.characters) {
            const tile = el('div', 'gm-lore-char-tile');
            tile.append(elText('h4', '', ch.name));
            if (ch.appearance) {
                const blurb = ch.appearance.length > 200 ? ch.appearance.slice(0, 200) + '…' : ch.appearance;
                tile.append(elText('p', 'gm-lore-card-desc', blurb));
            }
            charGrid.append(tile);
        }
        charSection.append(charGrid);
        container.append(charSection);
    }

    // Apply to campaign CTA
    const ctaSection = el('div', 'gm-lore-apply-section');
    const applyBtn = elText('button', 'gm-primary-btn', 'Apply to campaign');
    applyBtn.type = 'button';
    applyBtn.addEventListener('click', () => openApplyModal(pack.pack_id));
    ctaSection.append(applyBtn);
    container.append(ctaSection);

    mount.append(container);
}

/* -------- Entry disclosure -------- */

function buildEntryDisclosure(entry) {
    const wrapper = el('div', 'gm-lore-entry');

    const toggle = elText('div', 'gm-lore-entry-toggle', entry.title);
    const body = el('div', 'gm-lore-entry-body');
    body.hidden = true;

    if (entry.tags?.length) {
        const tagRow = el('div', 'gm-lore-entry-tags');
        for (const t of entry.tags) {
            tagRow.append(elText('span', 'gm-pill', t));
        }
        body.append(tagRow);
    }

    if (entry.body) {
        const text = el('div', '');
        text.style.whiteSpace = 'pre-wrap';
        text.textContent = entry.body;
        body.append(text);
    }

    toggle.addEventListener('click', () => {
        const open = !body.hidden;
        body.hidden = open;
        toggle.classList.toggle('gm-lore-entry-toggle--open', !open);
    });

    wrapper.append(toggle, body);
    return wrapper;
}

/* -------- Group entries by kind -------- */

function groupByKind(entries) {
    /** @type {Map<string, Array>} */
    const map = new Map();
    for (const e of entries) {
        const kind = e.entry_kind ?? 'custom';
        if (!map.has(kind)) map.set(kind, []);
        map.get(kind).push(e);
    }
    return map;
}

/* ================================================================
 *  Apply-to-campaign modal
 * ================================================================ */

async function openApplyModal(packId) {
    const overlay = el('div', 'gm-modal-overlay');
    const panel = el('div', 'gm-modal');

    // Header
    const head = el('div', 'gm-modal-header');
    head.append(elText('h2', 'gm-modal-title', 'Apply lore pack'));
    const closeBtn = el('button', 'gm-icon-btn');
    closeBtn.type = 'button';
    closeBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
    closeBtn.addEventListener('click', () => overlay.remove());
    head.append(closeBtn);

    // Body
    const body = el('div', 'gm-modal-body');
    body.append(elText('p', 'gm-text-muted', 'Loading campaigns…'));

    // Footer
    const foot = el('div', 'gm-modal-footer');

    const cancelBtn = elText('button', 'gm-secondary-btn', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = elText('button', 'gm-primary-btn', 'Apply');
    confirmBtn.type = 'button';
    confirmBtn.disabled = true;

    foot.append(cancelBtn, confirmBtn);

    panel.append(head, body, foot);
    overlay.append(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.append(overlay);

    // Load campaigns
    let selectedCid = null;
    try {
        const campaigns = await api.listCampaigns();
        body.innerHTML = '';

        if (!campaigns.length) {
            body.append(elText('p', 'gm-empty-panel', 'No campaigns yet. Create one first.'));
            return;
        }

        const list = el('div', 'gm-lore-campaign-list');
        for (const c of campaigns) {
            const row = el('div', 'gm-lore-campaign-row');
            row.append(elText('strong', '', c.name));
            if (c.brief) row.append(elText('span', 'gm-lore-card-desc', c.brief));

            row.addEventListener('click', () => {
                list.querySelectorAll('.gm-lore-campaign-row').forEach(r => r.classList.remove('gm-lore-campaign-row--selected'));
                row.classList.add('gm-lore-campaign-row--selected');
                selectedCid = c.id;
                confirmBtn.disabled = false;
            });
            list.append(row);
        }
        body.append(list);

        const note = elText('p', 'gm-lore-idempotency-note', 'Re-applying a pack is safe — existing characters and lore entries are skipped.');
        body.append(note);
    } catch (err) {
        body.innerHTML = '';
        body.append(elText('p', 'gm-empty-panel', `Failed to load campaigns: ${err.message}`));
        return;
    }

    // Confirm handler
    confirmBtn.addEventListener('click', async () => {
        if (!selectedCid) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Applying…';

        try {
            await api.applyLorePack({ cid: selectedCid, pack_id: packId });
            body.innerHTML = '';
            body.append(elText('p', '', 'Lore pack applied successfully!'));
            foot.innerHTML = '';
            const doneBtn = elText('button', 'gm-primary-btn', 'Done');
            doneBtn.type = 'button';
            doneBtn.addEventListener('click', () => overlay.remove());
            foot.append(doneBtn);
        } catch (err) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Apply';
            const errMsg = elText('p', 'gm-lore-error', `Error: ${err.message}`);
            const existing = body.querySelector('.gm-lore-error');
            if (existing) existing.replaceWith(errMsg);
            else body.append(errMsg);
        }
    });
}
