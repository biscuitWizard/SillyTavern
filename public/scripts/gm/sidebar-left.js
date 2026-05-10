/**
 * Left sidebar — pinned player character + live sheet preview.
 *
 * Shown in Campaign Main and Scene views once a PC exists. Reads the
 * server's character record (`GET /api/gm/sheets/:char_id`) plus the
 * campaign's merged sheet layout (`GET /api/gm/rulesets/:id/sheet-layout`)
 * and renders a portrait + identity blurb + a compact "highlight" grid
 * driven by the layout: every category whose YAML carries
 * `sidebar_highlight: true` contributes its fields to the sidebar
 * preview. Fields render as label+value cells, or as miniature bars
 * when their layout type is `bar`.
 *
 * Backwards-compat: when the campaign's ruleset has no layout (older
 * rulesets, or `ruleset_id` is missing), the sidebar falls back to the
 * legacy curated KEY_STAT_ORDER. Click "Open sheet" to launch the
 * full editor in `sheet-panel.js`.
 *
 * The sidebar listens to `tt:character-changed` window events so it
 * stays fresh when the sheet panel saves an edit. Re-mounting the
 * sidebar naturally re-fetches the latest sheet.
 */

import * as api from './api.js';
import { openSheetPanel } from './sheet-panel.js';

/** Legacy fallback used when no SheetLayout is available. */
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

/**
 * Lightweight per-ruleset layout cache so we don't re-fetch on every
 * `tt:character-changed` event. Keyed by `ruleset_id`. Stores either a
 * resolved `SheetLayout` (or null when the ruleset has none) or a
 * Promise to one in flight — `getLayoutFor` always returns a Promise.
 *
 * @type {Map<string, Promise<any> | null>}
 */
const layoutCache = new Map();

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
    root.dataset.rulesetId = campaign?.ruleset_id || '';

    if (!player) {
        root.append(emptyState());
        activeRoot = root;
        return root;
    }

    // Render the card synchronously with the legacy fallback so the
    // sidebar appears immediately, then upgrade in place when the
    // layout arrives (or when the server returns null and we keep the
    // fallback).
    root.append(buildCard(player, null));
    activeRoot = root;

    /** @param {any} character @param {any} layout */
    const replaceCard = (character, layout) => {
        const fresh = buildCard(character, layout);
        const existingCard = root.querySelector('.gm-sidebar-card');
        if (existingCard) {
            root.replaceChild(fresh, existingCard);
        } else {
            root.append(fresh);
        }
    };

    let currentCharacter = player;
    let currentLayout = null;

    getLayoutFor(campaign?.ruleset_id).then((layout) => {
        currentLayout = layout || null;
        // Only replace if the sidebar wasn't torn down in the meantime.
        if (activeRoot !== root) return;
        replaceCard(currentCharacter, currentLayout);
    }).catch(() => { /* keep the fallback card */ });

    const onChanged = (ev) => {
        const updated = ev?.detail?.character;
        if (!updated || updated.id !== player.id) return;
        currentCharacter = updated;
        replaceCard(currentCharacter, currentLayout);
    };
    window.addEventListener('tt:character-changed', onChanged);
    activeUnsub = () => window.removeEventListener('tt:character-changed', onChanged);

    // Fire-and-forget refresh so any edits made while offscreen show up.
    api.getSheet(player.id)
        .then((updated) => {
            if (!updated || updated.id !== player.id) return;
            currentCharacter = updated;
            replaceCard(currentCharacter, currentLayout);
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

/**
 * Resolve the merged sheet layout for a ruleset, caching the response
 * (and any in-flight promise) so repeated re-renders are cheap.
 *
 * @param {string | undefined | null} rulesetId
 * @returns {Promise<any>}
 */
function getLayoutFor(rulesetId) {
    if (!rulesetId) return Promise.resolve(null);
    if (layoutCache.has(rulesetId)) {
        const cached = layoutCache.get(rulesetId);
        return Promise.resolve(cached);
    }
    const inflight = api.getSheetLayout(rulesetId)
        .then((layout) => {
            layoutCache.set(rulesetId, layout || null);
            return layout || null;
        })
        .catch((err) => {
            console.warn('[sidebar-left] sheet layout fetch failed', err);
            layoutCache.set(rulesetId, null);
            return null;
        });
    layoutCache.set(rulesetId, inflight);
    return inflight;
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

/**
 * @param {any} character
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout | null} layout
 */
function buildCard(character, layout) {
    const card = el('div', 'gm-sidebar-card');

    const portrait = el('div', 'gm-sidebar-portrait');
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
    card.append(portrait);

    const ident = el('div', 'gm-sidebar-ident');
    ident.append(elText('div', 'gm-sidebar-name', character.name));
    ident.append(elText('div', 'gm-sidebar-tag', character.is_player ? 'Player character' : 'NPC'));
    if (character.appearance) {
        ident.append(elText('p', 'gm-sidebar-blurb', character.appearance));
    }
    card.append(ident);

    const stats = renderHighlights(character.sheet?.stats || {}, layout);
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
 * Pick which stats to surface in the sidebar:
 *   - layout-driven path: every category with `sidebar_highlight: true`
 *     contributes its `fields[]` (paired-trait fields contribute both
 *     legs). Bar fields render as labelled mini-bars; everything else
 *     renders as a label+value cell.
 *   - fallback path: legacy curated KEY_STAT_ORDER, then any remaining
 *     stats up to a soft cap of 12 cells.
 *
 * @param {Record<string, number | string>} stats
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout | null} layout
 */
function renderHighlights(stats, layout) {
    const highlightFields = collectHighlightFields(layout);
    if (highlightFields.length) {
        return renderLayoutHighlights(stats, highlightFields);
    }
    return renderLegacyHighlights(stats);
}

/**
 * Walk the layout and return every field belonging to a category that
 * opts into `sidebar_highlight: true`. Only `kind: stats` fields are
 * surfaced — statuses/skills/items/relationships have their own UI
 * affordances and would clutter the compact sidebar.
 *
 * @param {import('../../../src/gm-core/rulesets/schemas.d.ts').SheetLayout | null} layout
 * @returns {Array<{ field: any, category: any }>}
 */
function collectHighlightFields(layout) {
    if (!layout || !Array.isArray(layout.categories)) return [];
    /** @type {Array<{ field: any, category: any }>} */
    const out = [];
    for (const category of layout.categories) {
        if (!category || !category.sidebar_highlight) continue;
        if (category.kind !== 'stats') continue;
        const fields = Array.isArray(category.fields) ? category.fields : [];
        for (const field of fields) {
            if (!field || !field.key) continue;
            out.push({ field, category });
        }
    }
    return out;
}

/**
 * Render the layout-driven highlight strip.
 *
 * @param {Record<string, number | string>} stats
 * @param {Array<{ field: any, category: any }>} highlights
 */
function renderLayoutHighlights(stats, highlights) {
    const grid = el('div', 'gm-sidebar-stats');
    let anyEmitted = false;

    for (const { field } of highlights) {
        const node = renderHighlightCell(field, stats);
        if (node) {
            grid.append(node);
            anyEmitted = true;
        }
    }

    return anyEmitted ? grid : null;
}

/**
 * Render one highlight cell. Returns null when the field has no value
 * AND is not flagged `required` — keeps the sidebar tight.
 *
 * @param {any} field
 * @param {Record<string, number | string>} stats
 */
function renderHighlightCell(field, stats) {
    const has = Object.prototype.hasOwnProperty.call(stats, field.key);
    if (!has && !field.required) return null;
    const raw = has ? stats[field.key] : (field.default ?? '');

    if (field.type === 'bar') {
        const max = resolveBarMax(field, stats);
        const current = Number(raw);
        const safeCurrent = Number.isFinite(current) ? current : 0;
        const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
        const ratio = Math.max(0, Math.min(1, safeCurrent / safeMax));
        const cell = el('div', 'gm-sidebar-stat gm-sidebar-stat-bar');
        cell.append(elText('div', 'gm-sidebar-stat-label', field.label || field.key));
        const bar = el('div', 'gm-sidebar-bar');
        const fill = el('div', 'gm-sidebar-bar-fill');
        fill.style.width = `${(ratio * 100).toFixed(1)}%`;
        bar.append(fill);
        cell.append(bar);
        cell.append(elText('div', 'gm-sidebar-bar-value', `${formatScalar(safeCurrent)} / ${formatScalar(safeMax)}`));
        return cell;
    }

    if (field.type === 'paired') {
        const leftKey = field.key;
        const rightKey = field.paired_with?.key;
        const leftVal = Object.prototype.hasOwnProperty.call(stats, leftKey) ? stats[leftKey] : (field.default ?? 0);
        const rightVal = rightKey && Object.prototype.hasOwnProperty.call(stats, rightKey)
            ? stats[rightKey]
            : (field.paired_with?.default ?? 0);
        const cell = el('div', 'gm-sidebar-stat gm-sidebar-stat-paired');
        const labelLine = el('div', 'gm-sidebar-stat-paired-labels');
        labelLine.append(elText('span', 'gm-sidebar-stat-label', field.label || leftKey));
        labelLine.append(elText('span', 'gm-sidebar-stat-paired-vs', '/'));
        if (rightKey) labelLine.append(elText('span', 'gm-sidebar-stat-label', field.paired_with?.label || rightKey));
        cell.append(labelLine);
        const valueLine = el('div', 'gm-sidebar-stat-paired-values');
        valueLine.append(elText('span', 'gm-sidebar-stat-value', formatScalar(leftVal)));
        valueLine.append(elText('span', 'gm-sidebar-stat-paired-vs', '/'));
        if (rightKey) valueLine.append(elText('span', 'gm-sidebar-stat-value', formatScalar(rightVal)));
        cell.append(valueLine);
        return cell;
    }

    // number / text / unknown -> label + value cell
    const cell = el('div', 'gm-sidebar-stat');
    cell.append(elText('div', 'gm-sidebar-stat-label', field.label || field.key));
    cell.append(elText('div', 'gm-sidebar-stat-value', formatScalar(raw)));
    return cell;
}

/**
 * Resolve a bar field's effective maximum: explicit `field.max`, or
 * (when the field carries `max_from_key`) the value of that other stat
 * on the sheet, or 100 as a final fallback.
 *
 * @param {any} field
 * @param {Record<string, number | string>} stats
 */
function resolveBarMax(field, stats) {
    if (field.max_from_key && Object.prototype.hasOwnProperty.call(stats, field.max_from_key)) {
        const fromKey = Number(stats[field.max_from_key]);
        if (Number.isFinite(fromKey) && fromKey > 0) return fromKey;
    }
    if (Number.isFinite(field.max)) return Number(field.max);
    return 100;
}

/**
 * Legacy hardcoded highlight grid used when no SheetLayout is on file.
 *
 * @param {Record<string, number | string>} stats
 */
function renderLegacyHighlights(stats) {
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
    for (const [key, value] of entries) {
        if (seen.has(key)) continue;
        ordered.push([key, value]);
        if (ordered.length >= 12) break;
    }

    const grid = el('div', 'gm-sidebar-stats');
    for (const [key, value] of ordered) {
        const cell = el('div', 'gm-sidebar-stat');
        cell.append(elText('div', 'gm-sidebar-stat-label', KEY_STAT_LABELS[key] || key));
        cell.append(elText('div', 'gm-sidebar-stat-value', formatScalar(value)));
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

function formatScalar(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1);
    return String(value);
}
