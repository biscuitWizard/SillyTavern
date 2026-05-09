/**
 * Read-only character sheet preview.
 *
 * Shown when a party-panel card is clicked. A full sheet editor lands in
 * Phase 5/10; for now this is just a viewer.
 */

let activeOverlay = null;

/** @param {any} character */
export function openSheetPanel(character) {
    closeSheetPanel();

    const overlay = el('div', 'gm-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSheetPanel();
    });

    const panel = el('div', 'gm-modal gm-sheet-modal');
    panel.append(
        renderHeader(character),
        renderBody(character),
    );
    overlay.append(panel);
    document.body.append(overlay);
    activeOverlay = overlay;

    document.addEventListener('keydown', onEsc);
}

export function closeSheetPanel() {
    if (activeOverlay && activeOverlay.parentNode) {
        activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
    document.removeEventListener('keydown', onEsc);
}

function onEsc(e) {
    if (e.key === 'Escape') closeSheetPanel();
}

function renderHeader(character) {
    const head = el('div', 'gm-modal-header');
    head.append(elText('h2', 'gm-modal-title', character.name));
    const close = el('button', 'gm-icon-btn');
    close.type = 'button';
    close.innerHTML = '<i class="fa-solid fa-times"></i>';
    close.addEventListener('click', closeSheetPanel);
    head.append(close);
    return head;
}

function renderBody(character) {
    const body = el('div', 'gm-modal-body');

    body.append(detail('Appearance', character.appearance));
    body.append(detail('Personality', character.personality));
    body.append(detail('Voice', character.voice));
    body.append(detail('Background', character.background));

    body.append(elText('h3', 'gm-modal-section-title', 'Sheet'));
    body.append(renderStats(character.sheet?.stats || {}));

    if (character.sheet?.skills?.length) {
        body.append(elText('h4', 'gm-modal-subsection', 'Proficient skills'));
        body.append(elText('p', 'gm-modal-detail-body', character.sheet.skills.join(', ')));
    }

    return body;
}

function renderStats(stats) {
    const grid = el('div', 'gm-stats-grid');
    const entries = Object.entries(stats);
    if (!entries.length) {
        return elText('p', 'gm-modal-detail-body', '(no stats yet)');
    }
    for (const [key, value] of entries) {
        const cell = el('div', 'gm-stats-cell');
        cell.append(elText('div', 'gm-stats-key', key));
        cell.append(elText('div', 'gm-stats-value', String(value)));
        grid.append(cell);
    }
    return grid;
}

function detail(label, value) {
    const wrap = el('div', 'gm-modal-detail');
    wrap.append(elText('div', 'gm-modal-detail-label', label));
    const body = el('div', 'gm-modal-detail-body');
    body.textContent = value || '(empty)';
    wrap.append(body);
    return wrap;
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
