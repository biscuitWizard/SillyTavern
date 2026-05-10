/**
 * Embedder interface + concrete implementations.
 *
 *   `Embedder.dim`               vector dimension; constant per-instance.
 *   `Embedder.embed(text)`       Promise<number[]>
 *   `Embedder.embedBatch(texts)` Promise<number[][]>
 *
 * `DeterministicEmbedder` is a hash-based fallback used by tests so the
 * RAG core can run end-to-end without any embedding provider configured;
 * it produces stable per-token vectors that capture lexical overlap well
 * enough to differentiate "Amelia" from "Jack" in the unit suite.
 *
 * `OllamaEmbedder` and `StVectorEmbedder` are thin wrappers that defer to
 * the existing `src/vectors/*` providers. Phase 7 ships
 * `DeterministicEmbedder` + `OllamaEmbedder` as the two production paths;
 * `StVectorEmbedder` is the bridge into the rest of ST's vector stack.
 */

import { createHash } from 'node:crypto';

const DEFAULT_DETERMINISTIC_DIM = 384;

/**
 * @typedef {Object} Embedder
 * @property {number} dim
 * @property {(text: string) => Promise<number[]>} embed
 * @property {(texts: string[]) => Promise<number[][]>} embedBatch
 * @property {string} provider
 */

/**
 * Hash-based embedder. Deterministic, no network. Each token contributes
 * a sign+slot derived from sha256(token); we average then L2-normalise so
 * cosine similarity behaves like a soft Jaccard. Good enough for tests
 * and for graceful degradation when no embedding provider is configured.
 *
 * @param {{ dim?: number }} [opts]
 * @returns {Embedder}
 */
export function createDeterministicEmbedder(opts = {}) {
    const dim = Math.max(16, Math.floor(opts.dim || DEFAULT_DETERMINISTIC_DIM));
    return {
        dim,
        provider: 'deterministic',
        embed: async (text) => embedDeterministic(text, dim),
        embedBatch: async (texts) => texts.map(t => embedDeterministic(t, dim)),
    };
}

/**
 * @param {string} text
 * @param {number} dim
 * @returns {number[]}
 */
function embedDeterministic(text, dim) {
    const tokens = String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter(Boolean);
    const v = new Array(dim).fill(0);
    if (tokens.length === 0) return v;
    for (const tok of tokens) {
        const h = createHash('sha256').update(tok).digest();
        // Map first 16 bytes to slots+signs, summing into the slot. Using
        // a few independent slot+sign pairs per token gives us a denser
        // signal than a single-slot one-hot.
        for (let i = 0; i < 16; i += 2) {
            const slot = ((h[i] << 8) | h[i + 1]) % dim;
            const sign = ((h[i + 1] & 1) === 0) ? 1 : -1;
            v[slot] += sign;
        }
    }
    // L2 normalise.
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
}

/**
 * Ollama embedding provider. Hits `${baseUrl}/api/embeddings` directly to
 * avoid pulling in ST's full vector stack just for RAG.
 *
 * @param {{ baseUrl?: string, model?: string, dim?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Embedder}
 */
export function createOllamaEmbedder(opts = {}) {
    const baseUrl = (opts.baseUrl || process.env.TTRPG_OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
    const model = opts.model || process.env.TTRPG_OLLAMA_EMBED_MODEL || 'nomic-embed-text';
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    let dim = Math.max(0, Math.floor(opts.dim || 0));

    /** @param {string} text */
    async function callEmbed(text) {
        const res = await fetchImpl(`${baseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: String(text ?? '') }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Ollama embed failed: ${res.status} ${res.statusText} ${body}`.trim());
        }
        const data = await res.json();
        const vec = Array.isArray(data?.embedding) ? data.embedding.map(Number) : null;
        if (!vec) throw new Error('Ollama embed: response had no `embedding` array');
        if (!dim) dim = vec.length;
        return vec;
    }

    return {
        get dim() { return dim || DEFAULT_DETERMINISTIC_DIM; },
        provider: `ollama:${model}`,
        embed: (text) => callEmbed(text),
        embedBatch: async (texts) => {
            const out = [];
            for (const t of texts) out.push(await callEmbed(t));
            return out;
        },
    };
}

/**
 * Bridge embedder over the existing transformers pipeline (`src/vectors/embedding.js`).
 * Useful when ST is already running with the local transformers stack;
 * we don't pay double for embedding deps.
 *
 * @returns {Promise<Embedder>}
 */
export async function createStTransformersEmbedder() {
    const mod = await import('../../vectors/embedding.js');
    const probe = await mod.getTransformersVector('probe');
    const dim = probe.length;
    return {
        dim,
        provider: 'st-transformers',
        embed: (text) => mod.getTransformersVector(String(text ?? '')),
        embedBatch: async (texts) => {
            const out = [];
            for (const t of texts) out.push(await mod.getTransformersVector(String(t ?? '')));
            return out;
        },
    };
}

/**
 * Pick an embedder from a config block:
 *   { embedder_provider: 'deterministic' | 'ollama' | 'st-transformers', embedder_model?, embedder_dim? }
 *
 * Falls back to deterministic on errors so the RAG core boots even when
 * Ollama is down.
 *
 * @param {{
 *   embedder_provider?: string,
 *   embedder_model?: string,
 *   embedder_dim?: number,
 *   ollama_url?: string,
 * }} [cfg]
 * @returns {Promise<Embedder>}
 */
export async function resolveEmbedder(cfg = {}) {
    const provider = String(cfg.embedder_provider || process.env.TTRPG_RAG_EMBEDDER || 'deterministic').toLowerCase();
    try {
        if (provider === 'ollama') {
            return createOllamaEmbedder({
                baseUrl: cfg.ollama_url,
                model: cfg.embedder_model,
                dim: cfg.embedder_dim,
            });
        }
        if (provider === 'st-transformers' || provider === 'transformers') {
            return await createStTransformersEmbedder();
        }
    } catch (err) {
        console.warn('[rag] embedder init failed; falling back to deterministic', err?.message || err);
    }
    return createDeterministicEmbedder({ dim: cfg.embedder_dim || DEFAULT_DETERMINISTIC_DIM });
}
