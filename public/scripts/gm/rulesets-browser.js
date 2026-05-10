/**
 * Rulesets Browser — list + read-only detail view.
 *
 * Renders into whichever mount container the Campaign Manager hands it.
 * Two modes: grid of cards (list), and a single-ruleset detail pane.
 */

import * as api from './api.js';

/* -------- Public entry point -------- */

/**
 * Render the rulesets browser into `mount`, replacing its children.
 *
 * @param {HTMLElement} mount
 */
export async function renderRulesetsBrowser(mount) {
    let rulesets = [];
    try {
        rulesets = await api.listRulesets();
    } catch (err) {
        console.error('[gm] listRulesets failed', err);
    }

    renderList(mount, rulesets);
}

/* -------- List view -------- */

/**
 * @param {HTMLElement} mount
 * @param {Array<{ id: string, name: string, source: string }>} rulesets
 */
function renderList(mount, rulesets) {
    const wrap = el('div', 'gm-ruleset-list');

    const header = el('div', 'gm-page-header');
    const left = document.createElement('div');
    left.append(
        elText('h1', 'gm-page-title', 'Rulesets'),
        elText('p', 'gm-page-subtitle', 'Browse available rulesets. Each defines abilities, skills, DC bands, and a severity ladder.'),
    );
    header.append(left);
    wrap.append(header);

    if (!rulesets.length) {
        wrap.append(elText('div', 'gm-empty-panel', 'No rulesets found.'));
        mount.replaceChildren(wrap);
        return;
    }

    const grid = el('div', 'gm-ruleset-grid');
    for (const rs of rulesets) {
        const card = el('button', 'gm-ruleset-card');
        card.type = 'button';
        card.append(
            elText('h3', 'gm-ruleset-card-name', rs.name),
            elText('div', 'gm-ruleset-card-id', rs.id),
            sourcePill(rs.source),
        );
        card.addEventListener('click', () => openDetail(mount, rulesets, rs.id));
        grid.append(card);
    }
    wrap.append(grid);
    mount.replaceChildren(wrap);
}

/* -------- Detail view -------- */

/**
 * @param {HTMLElement} mount
 * @param {Array<{ id: string, name: string, source: string }>} rulesets
 * @param {string} rulesetId
 */
async function openDetail(mount, rulesets, rulesetId) {
    mount.replaceChildren(elText('div', 'gm-empty-panel', 'Loading ruleset…'));

    let ruleset;
    try {
        ruleset = await api.getRuleset(rulesetId);
    } catch (err) {
        console.error('[gm] getRuleset failed', err);
        mount.replaceChildren(elText('div', 'gm-empty-panel', `Failed to load ruleset: ${err?.message || err}`));
        return;
    }
    if (!ruleset) {
        mount.replaceChildren(elText('div', 'gm-empty-panel', 'Ruleset not found.'));
        return;
    }

    const detail = el('div', 'gm-ruleset-detail');

    const back = el('button', 'gm-back-btn');
    back.type = 'button';
    back.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to rulesets';
    back.addEventListener('click', () => renderList(mount, rulesets));
    detail.append(back);

    const header = el('div', 'gm-ruleset-header');
    header.append(
        elText('h2', '', ruleset.name),
        sourcePill(rulesets.find(r => r.id === rulesetId)?.source ?? 'unknown'),
    );
    if (ruleset.dc_min != null && ruleset.dc_max != null) {
        header.append(elText('span', 'gm-text-muted', `DC range: ${ruleset.dc_min}–${ruleset.dc_max}`));
    }
    detail.append(header);

    if (ruleset.abilities?.length) {
        detail.append(renderAbilitiesSection(ruleset.abilities));
    }
    if (ruleset.skills?.length) {
        detail.append(renderSkillsSection(ruleset.skills, ruleset.abilities || []));
    }
    if (ruleset.dc_bands?.length) {
        detail.append(renderDcBandsSection(ruleset.dc_bands));
    }
    if (ruleset.severities?.length) {
        detail.append(renderSeveritySection(ruleset.severities));
    }
    detail.append(renderStarterPackSection(ruleset));
    if (ruleset.sheet_layout) {
        detail.append(renderSheetLayoutSection(ruleset.sheet_layout));
    }

    mount.replaceChildren(detail);
}

/* -------- Detail sections -------- */

function renderAbilitiesSection(abilities) {
    const section = el('div', 'gm-ruleset-section');
    section.append(elText('h3', 'gm-ruleset-section-title', 'Abilities'));

    const table = el('table', 'gm-ruleset-table');
    const thead = el('thead', '');
    const hr = el('tr', '');
    hr.append(elText('th', '', 'Name'), elText('th', '', 'ID'), elText('th', '', 'Stat Key'));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody', '');
    for (const ab of abilities) {
        const tr = el('tr', '');
        tr.append(elText('td', '', ab.name), elText('td', 'gm-mono', ab.id), elText('td', 'gm-mono', ab.stat_key));
        tbody.append(tr);
    }
    table.append(tbody);
    section.append(table);
    return section;
}

function renderSkillsSection(skills, abilities) {
    const section = el('div', 'gm-ruleset-section');
    section.append(elText('h3', 'gm-ruleset-section-title', 'Skills'));

    const byAbility = new Map();
    for (const ab of abilities) byAbility.set(ab.id, []);
    for (const sk of skills) {
        if (!byAbility.has(sk.ability_id)) byAbility.set(sk.ability_id, []);
        byAbility.get(sk.ability_id).push(sk);
    }

    for (const ab of abilities) {
        const group = byAbility.get(ab.id) || [];
        if (!group.length) continue;

        const disc = el('div', 'gm-disclosure');
        const toggle = el('button', 'gm-disclosure-toggle');
        toggle.type = 'button';
        toggle.textContent = `${ab.name} (${group.length})`;
        const body = el('div', 'gm-disclosure-body');

        for (const sk of group) {
            const row = el('div', 'gm-disclosure-row');
            row.append(elText('strong', '', sk.name));
            if (sk.description) row.append(elText('span', 'gm-text-muted', ` — ${sk.description}`));
            body.append(row);
        }

        toggle.addEventListener('click', () => {
            disc.classList.toggle('is-open');
        });

        disc.append(toggle, body);
        section.append(disc);
    }

    return section;
}

function renderDcBandsSection(bands) {
    const section = el('div', 'gm-ruleset-section');
    section.append(elText('h3', 'gm-ruleset-section-title', 'DC Bands'));

    const table = el('table', 'gm-ruleset-table');
    const thead = el('thead', '');
    const hr = el('tr', '');
    hr.append(elText('th', '', 'Label'), elText('th', '', 'DC'), elText('th', '', 'Description'));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody', '');
    for (const band of bands) {
        const tr = el('tr', '');
        tr.append(
            elText('td', '', band.label),
            elText('td', 'gm-mono', String(band.dc)),
            elText('td', '', band.description || ''),
        );
        tbody.append(tr);
    }
    table.append(tbody);
    section.append(table);
    return section;
}

function renderSeveritySection(severities) {
    const section = el('div', 'gm-ruleset-section');
    section.append(elText('h3', 'gm-ruleset-section-title', 'Severity Ladder'));

    const table = el('table', 'gm-ruleset-table');
    const thead = el('thead', '');
    const hr = el('tr', '');
    hr.append(elText('th', '', 'Level'), elText('th', '', 'Label'), elText('th', '', 'Description'));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody', '');
    for (const sev of severities) {
        const tr = el('tr', '');
        tr.append(
            elText('td', 'gm-mono', sev.id),
            elText('td', '', sev.label),
            elText('td', '', sev.description || ''),
        );
        tbody.append(tr);
    }
    table.append(tbody);
    section.append(table);
    return section;
}

function renderStarterPackSection(ruleset) {
    const section = el('div', 'gm-ruleset-section');
    section.append(elText('h3', 'gm-ruleset-section-title', 'Starter Pack'));

    const stats = ruleset.starter_stats;
    if (stats && Object.keys(stats).length) {
        section.append(elText('h4', 'gm-ruleset-sub-title', 'Stats'));
        const table = el('table', 'gm-ruleset-table');
        const tbody = el('tbody', '');
        for (const [key, val] of Object.entries(stats)) {
            const tr = el('tr', '');
            tr.append(elText('td', 'gm-mono', key), elText('td', '', String(val)));
            tbody.append(tr);
        }
        table.append(tbody);
        section.append(table);
    }

    const skills = ruleset.starter_skills;
    if (Array.isArray(skills) && skills.length) {
        section.append(elText('h4', 'gm-ruleset-sub-title', 'Skills'));
        const chips = el('div', 'gm-ruleset-chips');
        for (const sk of skills) {
            chips.append(elText('span', 'gm-pill', sk));
        }
        section.append(chips);
    }

    return section;
}

function renderSheetLayoutSection(layout) {
    const section = el('div', 'gm-ruleset-section');
    section.append(elText('h3', 'gm-ruleset-section-title', 'Sheet Layout'));

    const disc = el('div', 'gm-disclosure');
    const toggle = el('button', 'gm-disclosure-toggle');
    toggle.type = 'button';
    const catCount = layout.categories?.length ?? 0;
    toggle.textContent = `${catCount} ${catCount === 1 ? 'category' : 'categories'} (click to expand)`;
    const body = el('div', 'gm-disclosure-body');

    if (Array.isArray(layout.categories)) {
        for (const cat of layout.categories) {
            const row = el('div', 'gm-disclosure-row');
            row.append(elText('span', 'gm-pill', cat.kind));
            row.append(elText('strong', '', ` ${cat.label}`));
            const fieldCount = (cat.fields?.length ?? 0) + (cat.per_target_fields?.length ?? 0);
            if (fieldCount) row.append(elText('span', 'gm-text-muted', ` — ${fieldCount} fields`));
            body.append(row);
        }
    }

    toggle.addEventListener('click', () => disc.classList.toggle('is-open'));
    disc.append(toggle, body);
    section.append(disc);
    return section;
}

/* -------- Helpers -------- */

function sourcePill(source) {
    return elText('span', 'gm-pill', source || 'unknown');
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
