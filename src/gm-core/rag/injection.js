/**
 * Format retrieval hits as MEMORIES blocks for prompt injection.
 *
 * The output has a fixed header/footer pattern so a downstream
 * "transcript-cleanliness" assertion can grep for `--- BEGIN MEMORIES`
 * in the JSONL transcript and fail the build if it ever lands there.
 * RAG snippets must NEVER appear in the JSONL — they live in the prompt
 * for one call and that's it.
 *
 * Dedupes by record id and tie-breaks by importance × score.
 */

/**
 * @typedef {import('./schemas.d.ts').RetrievalHit} RetrievalHit
 */

const HEADER_PREFIX = '--- BEGIN MEMORIES';
const FOOTER = '--- END MEMORIES ---';

/**
 * Render a list of hits as a single block. Returns '' when hits is empty
 * so the caller can splice unconditionally.
 *
 * @param {RetrievalHit[]} hits
 * @param {{ kind: string, label?: string, max?: number }} opts
 * @returns {string}
 */
export function formatBlock(hits, { kind, label, max = 6 }) {
    if (!Array.isArray(hits) || hits.length === 0) return '';
    const seen = new Set();
    const lines = [];
    let count = 0;
    for (const hit of hits) {
        if (!hit || !hit.record) continue;
        const id = hit.record.id;
        if (seen.has(id)) continue;
        seen.add(id);
        if (count >= max) break;
        count++;
        const tags = Array.isArray(hit.record.tags) && hit.record.tags.length
            ? ` [${hit.record.tags.join(', ')}]`
            : '';
        const importance = hit.record.importance != null
            ? ` (importance ${hit.record.importance.toFixed(2)})`
            : '';
        const title = hit.record.world_lore?.title;
        const head = title ? `**${title}** — ` : '';
        lines.push(`- ${head}${oneLine(hit.record.content)}${tags}${importance}`);
    }
    if (lines.length === 0) return '';
    const headLabel = label ? `${kind}: ${label}` : kind;
    return [`${HEADER_PREFIX} (${headLabel}) ---`, ...lines, FOOTER, ''].join('\n');
}

/**
 * Render multiple kinds of hits in a stable order.
 *
 * @param {Array<{ kind: string, label?: string, hits: RetrievalHit[], max?: number }>} sections
 * @returns {string}
 */
export function formatSections(sections) {
    const out = [];
    for (const s of sections || []) {
        const block = formatBlock(s.hits || [], { kind: s.kind, label: s.label, max: s.max });
        if (block) out.push(block);
    }
    return out.join('\n');
}

/** @param {string} text */
function oneLine(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

export const INJECTION_HEADER_PREFIX = HEADER_PREFIX;
export const INJECTION_FOOTER = FOOTER;
