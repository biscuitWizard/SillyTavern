/**
 * Detail modal for a single debug event.
 */

/**
 * @param {{ id, ts, scope, kind, headline, detail, parent_id? }} event
 */
export function openDetailModal(event) {
    closeActiveModal();

    const overlay = document.createElement('div');
    overlay.className = 'gm-modal-overlay';
    overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) close();
    });

    const modal = document.createElement('div');
    modal.className = 'gm-modal gm-evlog-detail-modal';

    /* ---- Header ---- */
    const header = document.createElement('div');
    header.className = 'gm-modal-header';
    const title = document.createElement('h2');
    title.className = 'gm-modal-title';
    title.textContent = event.headline || `${event.kind} event`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'gm-icon-btn';
    closeBtn.type = 'button';
    closeBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
    closeBtn.addEventListener('click', close);
    header.append(title, closeBtn);
    modal.append(header);

    /* ---- Tabs ---- */
    const tabs = document.createElement('div');
    tabs.className = 'gm-evlog-detail-tabs';

    const tabNames = ['request', 'response', 'meta'];
    const tabBtns = {};
    for (const name of tabNames) {
        const btn = document.createElement('button');
        btn.className = 'gm-evlog-detail-tab';
        btn.type = 'button';
        btn.dataset.tab = name;
        btn.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        if (name === 'request') btn.classList.add('active');
        btn.addEventListener('click', () => activateTab(name));
        tabs.append(btn);
        tabBtns[name] = btn;
    }
    modal.append(tabs);

    /* ---- Body ---- */
    const body = document.createElement('div');
    body.className = 'gm-modal-body gm-evlog-detail-body';
    modal.append(body);

    function activateTab(tab) {
        for (const [name, btn] of Object.entries(tabBtns)) {
            btn.classList.toggle('active', name === tab);
        }
        body.innerHTML = '';
        if (tab === 'request') body.append(buildRequestTab(event));
        else if (tab === 'response') body.append(buildResponseTab(event));
        else body.append(buildMetaTab(event));
    }

    activateTab('request');

    overlay.append(modal);
    document.body.append(overlay);
    activeModal = overlay;
    document.addEventListener('keydown', onEsc);

    function close() {
        closeActiveModal();
    }
}

/* -------- Active modal tracking -------- */

let activeModal = null;

function closeActiveModal() {
    if (activeModal && activeModal.parentNode) {
        activeModal.parentNode.removeChild(activeModal);
    }
    activeModal = null;
    document.removeEventListener('keydown', onEsc);
}

function onEsc(e) {
    if (e.key === 'Escape') closeActiveModal();
}

/* -------- Request tab -------- */

function buildRequestTab(event) {
    const frag = document.createDocumentFragment();

    if (event.kind === 'llm_call' && Array.isArray(event.detail?.messages)) {
        const copyAllBtn = document.createElement('button');
        copyAllBtn.className = 'gm-evlog-copy-all-btn';
        copyAllBtn.type = 'button';
        copyAllBtn.textContent = 'Copy All';
        copyAllBtn.addEventListener('click', () => {
            const text = event.detail.messages
                .map(m => `[${m.role || 'unknown'}]\n${m.content || ''}`)
                .join('\n\n');
            copyToClipboard(text, copyAllBtn);
        });
        frag.append(copyAllBtn);

        for (const msg of event.detail.messages) {
            frag.append(buildMessageBlock(msg));
        }
    } else {
        frag.append(buildJsonBlock(event.detail));
    }

    return frag;
}

function buildMessageBlock(msg) {
    const block = document.createElement('div');
    block.className = 'gm-evlog-msg-block';

    const header = document.createElement('div');
    header.className = 'gm-evlog-msg-header';

    const roleEl = document.createElement('span');
    roleEl.className = 'gm-evlog-msg-role';
    roleEl.textContent = msg.role || 'unknown';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'gm-evlog-copy-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyToClipboard(msg.content || '', copyBtn);
    });

    header.append(roleEl, copyBtn);
    block.append(header);

    const content = document.createElement('pre');
    content.className = 'gm-evlog-msg-content';
    content.textContent = msg.content || '';
    block.append(content);

    return block;
}

/* -------- Response tab -------- */

function buildResponseTab(event) {
    const frag = document.createDocumentFragment();

    if (event.kind !== 'llm_call') {
        if (event.detail?.summary) {
            const pre = document.createElement('pre');
            pre.className = 'gm-evlog-json-block';
            pre.textContent = event.detail.summary;
            frag.append(pre);
        } else {
            frag.append(buildJsonBlock(event.detail));
        }
        return frag;
    }

    const detail = event.detail || {};

    if (detail.error) {
        const err = document.createElement('div');
        err.className = 'gm-evlog-error-block';
        err.textContent = `${detail.error.code || 'ERROR'}: ${detail.error.message || JSON.stringify(detail.error)}`;
        frag.append(err);
        return frag;
    }

    if (detail.mode === 'structured') {
        frag.append(buildJsonBlock(detail.parsed, 'Parsed (structured)'));

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'gm-evlog-copy-btn';
        toggleBtn.type = 'button';
        toggleBtn.textContent = 'Show raw';
        toggleBtn.style.margin = '8px 0';

        const rawBlock = document.createElement('pre');
        rawBlock.className = 'gm-evlog-json-block';
        rawBlock.textContent = detail.raw_response || '(no raw response)';
        rawBlock.style.display = 'none';

        toggleBtn.addEventListener('click', () => {
            const showing = rawBlock.style.display !== 'none';
            rawBlock.style.display = showing ? 'none' : '';
            toggleBtn.textContent = showing ? 'Show raw' : 'Hide raw';
        });

        frag.append(toggleBtn, rawBlock);
    } else {
        const pre = document.createElement('pre');
        pre.className = 'gm-evlog-json-block';
        pre.textContent = detail.raw_response || detail.response || '(no response)';
        frag.append(pre);
    }

    return frag;
}

/* -------- Meta tab -------- */

function buildMetaTab(event) {
    const dl = document.createElement('dl');
    dl.className = 'gm-evlog-meta-dl';
    const detail = event.detail || {};

    const add = (label, value) => {
        if (value == null || value === '') return;
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = String(value);
        dl.append(dt, dd);
    };

    add('Provider', detail.provider);
    add('Model', detail.model);
    add('Base URL', detail.base_url);
    add('Schema', detail.schema_name);
    add('Mode', detail.mode);
    add('Role', detail.role);
    add('Duration', detail.duration_ms != null ? `${detail.duration_ms}ms` : null);

    if (detail.usage) {
        const u = detail.usage;
        add('Tokens', `Prompt: ${u.prompt_tokens ?? '?'}, Completion: ${u.completion_tokens ?? '?'}, Total: ${u.total_tokens ?? '?'}`);
    }

    add('Scope', event.scope);
    add('Parent ID', event.parent_id);
    add('Event ID', event.id);
    add('Timestamp', event.ts);

    return dl;
}

/* -------- Helpers -------- */

function buildJsonBlock(obj, label) {
    const frag = document.createDocumentFragment();
    if (label) {
        const heading = document.createElement('div');
        heading.className = 'gm-evlog-msg-role';
        heading.style.marginBottom = '4px';
        heading.textContent = label;
        frag.append(heading);
    }
    const pre = document.createElement('pre');
    pre.className = 'gm-evlog-json-block';
    try {
        pre.textContent = JSON.stringify(obj, null, 2);
    } catch (_) {
        pre.textContent = String(obj);
    }
    frag.append(pre);
    return frag;
}

function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    }).catch(() => {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
}
