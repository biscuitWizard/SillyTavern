/**
 * `search_memory` tool — wraps `MemoryService.search` with role-based gating.
 *
 * The tool definition is the same JSON schema everywhere (so the model
 * sees one consistent surface), but the dispatcher uses the caller's
 * role to enforce that:
 *   - Director / Narrator can only target `world_lore` and their own role
 *     memory.
 *   - Actor X can only target `world_lore`, its own `character_memory`,
 *     and `player_journal`.
 *   - Adjudicator never sees this tool at all.
 *
 * Returns up to 8 hits with content + tags + importance + score so the
 * model can decide whether to use them.
 */

/**
 * @typedef {import('./service.d.ts').MemoryService} MemoryService
 * @typedef {('director' | 'narrator' | 'actor')} ToolRole
 */

export const SEARCH_MEMORY_TOOL_NAME = 'search_memory';

/**
 * JSON schema for the tool argument shape, suitable for OpenAI / Ollama
 * function-calling, SillyTavern's ToolManager, and the in-process
 * structured-output strict-mode shim.
 */
export const searchMemoryToolSchema = {
    name: SEARCH_MEMORY_TOOL_NAME,
    description: 'Look up additional memories beyond what was pre-injected into your prompt. Use this when the player references something specific you do not already have context for.',
    parameters: {
        type: 'object',
        properties: {
            scope: {
                type: 'string',
                enum: ['world_lore', 'character_memory', 'director_memory', 'narrator_memory', 'player_journal'],
                description: 'Which memory store to query. Your role determines which scopes you may access.',
            },
            query: {
                type: 'string',
                description: 'Free-text query — names, places, themes, etc.',
            },
            top_k: {
                type: 'integer',
                description: 'Maximum number of hits to return (1..8). Defaults to 4.',
                minimum: 1,
                maximum: 8,
            },
            filters: {
                type: 'object',
                description: 'Optional payload filters. Only meaningful for world_lore.',
                properties: {
                    origin: { type: 'string', enum: ['core', 'generated'] },
                    entry_kind: {
                        type: 'string',
                        enum: ['location', 'faction', 'culture', 'people', 'history', 'magic', 'artifact', 'bestiary', 'cosmology', 'language', 'pantheon', 'custom'],
                    },
                    scene_id: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
        },
        required: ['scope', 'query'],
        additionalProperties: false,
    },
};

/**
 * Decide whether a role+scope+characterId combination is allowed. Returns
 * null on success or an error string explaining the reason.
 *
 * @param {ToolRole} role
 * @param {string} scope
 * @param {{ requestingCharacterId?: string, scopeCharacterId?: string }} [opts]
 */
export function gateAccess(role, scope, opts = {}) {
    if (role === 'director') {
        if (scope === 'world_lore' || scope === 'director_memory') return null;
        return `Director may not access scope "${scope}".`;
    }
    if (role === 'narrator') {
        if (scope === 'world_lore' || scope === 'narrator_memory') return null;
        return `Narrator may not access scope "${scope}".`;
    }
    if (role === 'actor') {
        if (scope === 'world_lore' || scope === 'player_journal') return null;
        if (scope === 'character_memory') {
            const requester = opts.requestingCharacterId;
            const target = opts.scopeCharacterId || requester;
            if (!requester || !target || requester !== target) {
                return 'Actor may only access its own character_memory.';
            }
            return null;
        }
        return `Actor may not access scope "${scope}".`;
    }
    return `Unknown role "${role}".`;
}

/**
 * Build the dispatcher closure for one role/campaign context.
 *
 * @param {{
 *   memoryService: MemoryService,
 *   campaignId: string,
 *   role: ToolRole,
 *   characterId?: string,
 * }} ctx
 * @returns {(args: { scope: string, query: string, top_k?: number, filters?: object, characterId?: string }) => Promise<{ ok: boolean, hits?: any[], error?: string }>}
 */
export function buildSearchMemoryHandler(ctx) {
    const { memoryService, campaignId, role, characterId } = ctx;
    return async (args) => {
        if (!args || typeof args !== 'object') return { ok: false, error: 'invalid args' };
        const scope = String(args.scope || '');
        const query = String(args.query || '').trim();
        if (!query) return { ok: false, error: 'query is required' };
        const targetCharacterId = args.characterId || characterId;
        const gateErr = gateAccess(role, scope, {
            requestingCharacterId: characterId,
            scopeCharacterId: targetCharacterId,
        });
        if (gateErr) return { ok: false, error: gateErr };
        const limit = Math.max(1, Math.min(8, Number(args.top_k) || 4));
        try {
            const hits = await memoryService.search({
                campaignId,
                kind: /** @type {any} */(scope),
                characterId: scope === 'character_memory' ? targetCharacterId : undefined,
                queryText: query,
                limit,
                filters: args.filters || undefined,
            });
            return {
                ok: true,
                hits: hits.map(h => ({
                    id: h.record.id,
                    content: h.record.content,
                    tags: h.record.tags,
                    importance: h.record.importance,
                    score: h.score,
                    title: h.record.world_lore?.title,
                    origin: h.record.world_lore?.origin,
                })),
            };
        } catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
    };
}
