/**
 * Mountable character card view.
 *
 * Renders the same identity + layout-driven sheet editor as
 * `sheet-panel.js`, but into an arbitrary mount node instead of the
 * modal overlay. Used by the right-drawer character drawer for inline
 * editing and by the modal wrapper in `sheet-panel.js`.
 *
 * Internally this delegates to `sheet-panel.js`'s rendering helpers —
 * the rendering logic lives in one place, this module provides the
 * mount-to-node API.
 */

import * as api from './api.js';

/** @type {{ layout: any, ruleset: any, loading: boolean }} */
let cachedLayoutState = { layout: null, ruleset: null, loading: false };

/**
 * Fetch or return the cached layout + ruleset for a campaign.
 *
 * @param {{ ruleset_id?: string } | null} campaign
 */
async function ensureLayout(campaign) {
    const rulesetId = campaign && typeof campaign.ruleset_id === 'string' ? campaign.ruleset_id : null;
    if (!rulesetId) {
        cachedLayoutState = { layout: null, ruleset: null, loading: false };
        return cachedLayoutState;
    }
    if (cachedLayoutState.layout && !cachedLayoutState.loading) {
        return cachedLayoutState;
    }
    cachedLayoutState.loading = true;
    try {
        const [layout, ruleset] = await Promise.all([
            api.getSheetLayout(rulesetId).catch(() => null),
            api.getRuleset(rulesetId).catch(() => null),
        ]);
        cachedLayoutState = { layout: layout || null, ruleset: ruleset || null, loading: false };
    } catch (_) {
        cachedLayoutState = { layout: null, ruleset: null, loading: false };
    }
    return cachedLayoutState;
}

/**
 * Render a character card (identity + sheet) into a target element.
 * Wires save-on-blur for all editable fields. Broadcasts
 * `tt:character-changed` on every successful mutation.
 *
 * Returns an object with a `refresh(character)` method so the parent
 * can push updated character data in without a full teardown.
 *
 * @param {{
 *   mount: HTMLElement,
 *   character: any,
 *   campaign: any | null,
 *   showPortrait?: boolean,
 * }} opts
 * @returns {{ refresh: (character: any) => void, destroy: () => void }}
 */
export function mountCardView({ mount, character, campaign, showPortrait = true }) {
    let current = character;
    let destroyed = false;

    function render() {
        if (destroyed) return;
        mount.innerHTML = '';
        mount.append(buildCardContent(current, campaign, showPortrait));
    }

    const loadPromise = ensureLayout(campaign).then(() => {
        if (!destroyed) render();
    });

    // Initial render (loading state)
    render();

    return {
        refresh(updated) {
            current = updated;
            render();
        },
        destroy() {
            destroyed = true;
            mount.innerHTML = '';
        },
    };
}

/**
 * Build the full card DOM subtree. Pulled into its own function so
 * both `mountCardView` and the modal wrapper can use it.
 *
 * @param {any} character
 * @param {any | null} campaign
 * @param {boolean} showPortrait
 * @returns {HTMLElement}
 */
function buildCardContent(character, campaign, showPortrait) {
    const wrap = el('div', 'gm-card-view');

    if (showPortrait) {
        const portraitSection = el('div', 'gm-card-portrait-section');
        const img = document.createElement('img');
        img.className = 'gm-card-portrait-img';
        img.src = api.getPortraitUrl(character);
        img.alt = character.name;
        img.addEventListener('error', () => { img.style.display = 'none'; });
        portraitSection.append(img);
        wrap.append(portraitSection);
    }

    wrap.append(renderIdentitySection(character));
    wrap.append(renderSheetSection(character, campaign));

    return wrap;
}

/* -------- Identity -------- */

function renderIdentitySection(character) {
    const section = el('div', 'gm-sheet-section gm-identity-section');
    section.append(elText('div', 'gm-sheet-section-title', 'Identity'));

    const FIELDS = [
        { key: 'appearance', label: 'Appearance' },
        { key: 'personality', label: 'Personality' },
        { key: 'voice', label: 'Voice' },
        { key: 'background', label: 'Background' },
    ];

    for (const { key, label } of FIELDS) {
        const row = el('div', 'gm-modal-detail gm-identity-field');
        row.append(elText('div', 'gm-modal-detail-label', label));

        const textarea = /** @type {HTMLTextAreaElement} */ (el('textarea', 'gm-identity-field__textarea'));
        textarea.rows = 2;
        textarea.placeholder = `${label}…`;
        textarea.value = String(character[key] ?? '');

        let lastSaved = textarea.value;
        textarea.addEventListener('blur', async () => {
            const val = textarea.value.trim();
            if (val === lastSaved) return;
            try {
                const out = await api.setIdentityField(character.id, key, val);
                lastSaved = val;
                if (out) {
                    window.dispatchEvent(new CustomEvent('tt:character-changed', { detail: { character: out } }));
                }
            } catch (err) {
                console.warn('[gm.card-view] identity save failed', err);
            }
        });

        row.append(textarea);
        section.append(row);
    }

    return section;
}

/* -------- Sheet (delegates to layout or flat KV) -------- */

function renderSheetSection(character, campaign) {
    const section = el('div', 'gm-sheet-section gm-card-sheet-section');
    section.append(elText('div', 'gm-sheet-section-title', 'Sheet'));

    const { layout, loading } = cachedLayoutState;
    if (loading) {
        section.append(elText('p', 'gm-muted', 'Loading sheet…'));
        return section;
    }

    const sheet = character.sheet || {};

    if (layout && Array.isArray(layout.categories) && layout.categories.length) {
        for (const cat of layout.categories) {
            if (!cat) continue;
            const catSection = renderSimpleCategory(cat, character);
            if (catSection) section.append(catSection);
        }
    }

    // Always show unclaimed stats/statuses
    const statEntries = Object.entries(sheet.stats || {});
    if (statEntries.length) {
        const statsBlock = el('div', 'gm-card-kv-block');
        statsBlock.append(elText('div', 'gm-card-kv-title', 'Stats'));
        const grid = el('div', 'gm-card-kv-grid');
        for (const [key, value] of statEntries) {
            const cell = el('div', 'gm-card-kv-cell');
            cell.append(elText('span', 'gm-card-kv-label', key));
            cell.append(elText('span', 'gm-card-kv-value', String(value)));
            grid.append(cell);
        }
        statsBlock.append(grid);
        section.append(statsBlock);
    }

    const statusEntries = Object.entries(sheet.statuses || {});
    if (statusEntries.length) {
        const block = el('div', 'gm-card-kv-block');
        block.append(elText('div', 'gm-card-kv-title', 'Statuses'));
        for (const [key, value] of statusEntries) {
            block.append(elText('div', 'gm-card-kv-entry', `${key}: ${value}`));
        }
        section.append(block);
    }

    if (Array.isArray(sheet.skills) && sheet.skills.length) {
        const block = el('div', 'gm-card-kv-block');
        block.append(elText('div', 'gm-card-kv-title', 'Skills'));
        block.append(elText('div', 'gm-card-kv-entry', sheet.skills.join(', ')));
        section.append(block);
    }

    if (Array.isArray(sheet.items) && sheet.items.length) {
        const block = el('div', 'gm-card-kv-block');
        block.append(elText('div', 'gm-card-kv-title', 'Items'));
        for (const item of sheet.items) {
            const row = el('div', 'gm-card-kv-entry');
            row.textContent = item.name + (item.description ? ` — ${item.description}` : '');
            block.append(row);
        }
        section.append(block);
    }

    if (sheet.notes) {
        const block = el('div', 'gm-card-kv-block');
        block.append(elText('div', 'gm-card-kv-title', 'Notes'));
        block.append(elText('div', 'gm-card-kv-entry', sheet.notes));
        section.append(block);
    }

    return section;
}

function renderSimpleCategory(cat, character) {
    if (cat.kind === 'relationships' && character.is_player) return null;
    const section = el('div', 'gm-card-category');
    section.append(elText('div', 'gm-card-category-title', cat.label || cat.kind));
    return section;
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
