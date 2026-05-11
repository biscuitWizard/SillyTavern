/**
 * Direct LLM client for the GM core. Calls upstream providers from Node
 * without round-tripping through SillyTavern's `/api/backends/...` surface.
 *
 * The factory `createLlmClient` returns `{ chat, structured }`. Callers pass:
 *
 *   - `userDirectories`: from `request.user.directories`, used to read API
 *     keys from the per-handle `secrets.json`.
 *   - `profile`: a snapshot the frontend ships on every `/api/gm/turn` call,
 *     telling us which provider, which model, which custom URL / proxy,
 *     and which named secret to use.
 *
 * Two methods:
 *
 *   - `chat({ system, user, messages?, onUsage?, signal })`: returns the
 *     assistant text. Either pass `{system, user}` for a single-turn call
 *     or `messages` for a multi-turn agent loop. When `messages` is set,
 *     `system`/`user` are ignored.
 *   - `structured({ system, user, messages?, schema, schemaName, onUsage?, signal })`:
 *     returns a parsed JSON object that conforms to `schema`. Uses the
 *     provider's native structured-output mode where available
 *     (`response_format` for OpenAI-family, forced tool-use for Claude);
 *     falls back to text-mode JSON with a single retry on parse failure.
 *
 * Both methods accept an optional `onUsage(usage)` callback that fires once
 * per call with `{prompt_tokens, completion_tokens, total_tokens}` parsed
 * from the upstream response (or `null` when the provider doesn't surface
 * a usage object — some Ollama versions omit it). The Director loop uses
 * this to drive history summarisation without a client-side token estimator.
 *
 * On any non-2xx upstream response or parse failure the client throws a
 * `LlmError { code, message, retryable }` so the Director loop can decide
 * whether to retry the step or surface an error event.
 */

import { readSecret, SECRET_KEYS } from '../../endpoints/secrets.js';
import { LlmError } from './errors.js';
import { makeDebugEvent, emitDebugEvent } from '../debug/bus.js';
export { LlmError };

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Default base URLs for OpenAI-compatible endpoints. `custom` resolves from
 * the profile's own `custom_url`. Local providers (ollama, llamacpp,
 * koboldcpp) keep these defaults but accept a `custom_url` override for
 * non-default ports / remote LAN servers.
 */
const PROVIDER_BASE = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    deepseek: 'https://api.deepseek.com/beta',
    xai: 'https://api.x.ai/v1',
    nanogpt: 'https://nano-gpt.com/api/v1',
    mistralai: 'https://api.mistral.ai/v1',
    perplexity: 'https://api.perplexity.ai',
    aimlapi: 'https://api.aimlapi.com/v1',
    moonshot: 'https://api.moonshot.ai/v1',
    fireworks: 'https://api.fireworks.ai/inference/v1',
    cometapi: 'https://api.cometapi.com/v1',
    electronhub: 'https://api.electronhub.ai/v1',
    // Local providers — expose OpenAI-compatible `/v1/chat/completions`.
    ollama: 'http://127.0.0.1:11434/v1',
    llamacpp: 'http://127.0.0.1:8080/v1',
    koboldcpp: 'http://127.0.0.1:5001/v1',
};

/**
 * Provider keys → SECRET_KEYS entry. Anything missing here resolves to no
 * key (local providers like Ollama and llama.cpp don't need one). The
 * Authorization header is only set when a key is present.
 */
const PROVIDER_SECRET = {
    openai: SECRET_KEYS.OPENAI,
    claude: SECRET_KEYS.CLAUDE,
    openrouter: SECRET_KEYS.OPENROUTER,
    groq: SECRET_KEYS.GROQ,
    deepseek: SECRET_KEYS.DEEPSEEK,
    xai: SECRET_KEYS.XAI,
    nanogpt: SECRET_KEYS.NANOGPT,
    custom: SECRET_KEYS.CUSTOM,
    mistralai: SECRET_KEYS.MISTRALAI,
    perplexity: SECRET_KEYS.PERPLEXITY,
    aimlapi: SECRET_KEYS.AIMLAPI,
    moonshot: SECRET_KEYS.MOONSHOT,
    fireworks: SECRET_KEYS.FIREWORKS,
    cometapi: SECRET_KEYS.COMETAPI,
    electronhub: SECRET_KEYS.ELECTRONHUB,
    // Local: optional bearer key (e.g. an ollama proxy in front of the API).
    ollama: SECRET_KEYS.CUSTOM,
    llamacpp: SECRET_KEYS.CUSTOM,
    koboldcpp: SECRET_KEYS.CUSTOM,
};

/**
 * Sources that speak the OpenAI `/v1/chat/completions` shape natively (or
 * close enough). Claude uses `/v1/messages` and is handled separately.
 *
 * Local providers (ollama, llamacpp, koboldcpp) all expose OpenAI-compatible
 * chat-completion endpoints and slot in here. The `structured()` path drops
 * back to text-mode JSON if the local server doesn't accept
 * `response_format: { type: 'json_schema', strict: true }`.
 */
const OPENAI_FAMILY = new Set([
    'openai',
    'openrouter',
    'groq',
    'deepseek',
    'xai',
    'nanogpt',
    'custom',
    'mistralai',
    'perplexity',
    'aimlapi',
    'moonshot',
    'fireworks',
    'cometapi',
    'electronhub',
    'ollama',
    'llamacpp',
    'koboldcpp',
]);

/**
 * Sources where we should NOT send `response_format` at all — the upstream
 * server either ignores it loudly or rejects it. We go straight to the
 * text-mode JSON path. (Ollama in particular has shipped versions where
 * `response_format` triggers a hard error rather than being ignored.)
 */
const FORCE_TEXT_JSON = new Set([
    'ollama',
    'llamacpp',
    'koboldcpp',
]);

// LlmError lives in `./errors.js` so callers (loop, prompts) can
// `instanceof`-check without transitively importing the secrets stack.
// Re-exported above for backward compatibility.

/**
 * @typedef {object} LlmProfile
 * @property {string} source                  e.g. 'openai' | 'claude' | 'openrouter' | 'custom'
 * @property {string} model                   model name passed to the provider
 * @property {string} [secret_id]             specific secret ID; default = active secret
 * @property {string} [reverse_proxy]         optional custom base URL for OpenAI/Claude proxies
 * @property {string} [proxy_password]        when reverse_proxy is set, this is the API key
 * @property {string} [custom_url]            base URL for `source === 'custom'`
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {number} [max_tokens]
 * @property {Record<string, unknown>} [extra]   provider-specific extras merged into the body
 */

/**
 * @typedef {object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {object} ChatUsage
 * @property {number} prompt_tokens
 * @property {number} completion_tokens
 * @property {number} total_tokens
 */

/**
 * @typedef {object} LlmClient
 * @property {(args: { system?: string, user?: string, messages?: ChatMessage[], onUsage?: (usage: ChatUsage | null) => void, signal?: AbortSignal }) => Promise<string>} chat
 * @property {(args: { system?: string, user?: string, messages?: ChatMessage[], schema: object, schemaName: string, onUsage?: (usage: ChatUsage | null) => void, signal?: AbortSignal }) => Promise<any>} structured
 * @property {LlmProfile} profile
 */

/**
 * Build a normalised messages[] array from caller args. Either `messages`
 * (preferred for agent loops) or `{system, user}` (legacy single-turn path).
 *
 * @param {{ system?: string, user?: string, messages?: ChatMessage[] }} args
 * @returns {ChatMessage[]}
 */
function resolveMessages({ system, user, messages }) {
    if (Array.isArray(messages) && messages.length) {
        return messages;
    }
    /** @type {ChatMessage[]} */
    const out = [];
    if (typeof system === 'string' && system.length) {
        out.push({ role: 'system', content: system });
    }
    if (typeof user === 'string') {
        out.push({ role: 'user', content: user });
    }
    if (!out.length) {
        throw new LlmError('bad_request', 'no messages, system, or user provided', false);
    }
    return out;
}

/**
 * @param {{ userDirectories: import('../../users.js').UserDirectoryList, profile: LlmProfile }} args
 * @returns {LlmClient}
 */
export function createLlmClient({ userDirectories, profile }) {
    if (!profile || typeof profile !== 'object') {
        throw new LlmError('bad_profile', 'profile is required', false);
    }
    if (!profile.source) throw new LlmError('bad_profile', 'profile.source is required', false);
    if (!profile.model) throw new LlmError('bad_profile', 'profile.model is required', false);

    const apiKey = resolveApiKey(userDirectories, profile);
    const baseUrl = resolveBaseUrl(profile);

    /** @param {AbortSignal | undefined} caller */
    function withTimeout(caller) {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(new LlmError('timeout', `llm timeout after ${DEFAULT_TIMEOUT_MS}ms`, true)), DEFAULT_TIMEOUT_MS);
        if (caller) {
            if (caller.aborted) ctrl.abort();
            else caller.addEventListener('abort', () => ctrl.abort(caller.reason), { once: true });
        }
        return { signal: ctrl.signal, cancel: () => clearTimeout(timeout) };
    }

    return {
        profile,

        async chat({ system, user, messages, onUsage, signal, role } = /** @type {any} */({})) {
            const { signal: s, cancel } = withTimeout(signal);
            const msgs = resolveMessages({ system, user, messages });
            const t0 = Date.now();
            /** @type {import('../debug/schemas.js').LlmCallDetail['usage']} */
            let capturedUsage;
            const wrappedOnUsage = (u) => {
                capturedUsage = u ?? undefined;
                if (onUsage) onUsage(u);
            };
            try {
                let result;
                if (profile.source === 'claude') {
                    result = await claudeChat({ baseUrl, apiKey, profile, messages: msgs, onUsage: wrappedOnUsage, signal: s });
                } else if (OPENAI_FAMILY.has(profile.source)) {
                    result = await openaiChat({ baseUrl, apiKey, profile, messages: msgs, onUsage: wrappedOnUsage, signal: s });
                } else {
                    throw new LlmError('unsupported_source', `source not supported: ${profile.source}`, false);
                }
                const ev = makeDebugEvent({
                    kind: 'llm_call',
                    headline: `${role || 'other'}: chat call`,
                    detail: {
                        role: role || 'other',
                        mode: 'chat',
                        provider: profile.source,
                        model: profile.model,
                        base_url: baseUrl,
                        messages: msgs,
                        raw_response: result,
                        usage: capturedUsage,
                        duration_ms: Date.now() - t0,
                        message_count: msgs.length,
                    },
                });
                if (ev) emitDebugEvent(ev);
                return result;
            } catch (err) {
                const ev = makeDebugEvent({
                    kind: 'llm_call',
                    headline: `${role || 'other'}: chat call (error)`,
                    detail: {
                        role: role || 'other',
                        mode: 'chat',
                        provider: profile.source,
                        model: profile.model,
                        base_url: baseUrl,
                        messages: msgs,
                        usage: capturedUsage,
                        duration_ms: Date.now() - t0,
                        error: { code: err?.code || 'unknown', message: err?.message || String(err) },
                        message_count: msgs.length,
                    },
                });
                if (ev) emitDebugEvent(ev);
                throw err;
            } finally {
                cancel();
            }
        },

        async structured({ system, user, messages, schema, schemaName, onUsage, signal, role } = /** @type {any} */({})) {
            const { signal: s, cancel } = withTimeout(signal);
            const msgs = resolveMessages({ system, user, messages });
            const t0 = Date.now();
            /** @type {import('../debug/schemas.js').LlmCallDetail['usage']} */
            let capturedUsage;
            const wrappedOnUsage = (u) => {
                capturedUsage = u ?? undefined;
                if (onUsage) onUsage(u);
            };
            try {
                let result;
                if (profile.source === 'claude') {
                    result = await claudeStructured({ baseUrl, apiKey, profile, messages: msgs, schema, schemaName, onUsage: wrappedOnUsage, signal: s });
                } else if (OPENAI_FAMILY.has(profile.source)) {
                    result = await openaiStructured({ baseUrl, apiKey, profile, messages: msgs, schema, schemaName, onUsage: wrappedOnUsage, signal: s });
                } else {
                    throw new LlmError('unsupported_source', `source not supported: ${profile.source}`, false);
                }
                const ev = makeDebugEvent({
                    kind: 'llm_call',
                    headline: `${role || 'other'}: structured call`,
                    detail: {
                        role: role || 'other',
                        mode: 'structured',
                        provider: profile.source,
                        model: profile.model,
                        base_url: baseUrl,
                        schema_name: schemaName,
                        messages: msgs,
                        parsed: result,
                        usage: capturedUsage,
                        duration_ms: Date.now() - t0,
                        message_count: msgs.length,
                    },
                });
                if (ev) emitDebugEvent(ev);
                return result;
            } catch (err) {
                const ev = makeDebugEvent({
                    kind: 'llm_call',
                    headline: `${role || 'other'}: structured call (error)`,
                    detail: {
                        role: role || 'other',
                        mode: 'structured',
                        provider: profile.source,
                        model: profile.model,
                        base_url: baseUrl,
                        schema_name: schemaName,
                        messages: msgs,
                        usage: capturedUsage,
                        duration_ms: Date.now() - t0,
                        error: { code: err?.code || 'unknown', message: err?.message || String(err) },
                        message_count: msgs.length,
                    },
                });
                if (ev) emitDebugEvent(ev);
                throw err;
            } finally {
                cancel();
            }
        },
    };
}

/**
 * Resolve the API key. Preference order:
 *   1. `profile.proxy_password` if `reverse_proxy` is set.
 *   2. The named secret for the source, looked up by `profile.secret_id`
 *      (falls back to the active secret when no id given).
 *
 * @param {import('../../users.js').UserDirectoryList} userDirectories
 * @param {LlmProfile} profile
 */
function resolveApiKey(userDirectories, profile) {
    if (profile.reverse_proxy) {
        return profile.proxy_password || '';
    }
    const secretKey = PROVIDER_SECRET[profile.source];
    if (!secretKey) return '';
    try {
        return readSecret(userDirectories, secretKey, profile.secret_id) || '';
    } catch (_err) {
        return '';
    }
}

/**
 * Resolve the base URL. Preference order:
 *   1. `profile.reverse_proxy` (used by OpenAI/Claude users behind proxies).
 *   2. `profile.custom_url` for `source === 'custom'` (required) or any
 *      local provider (optional override of the default port).
 *   3. The default `PROVIDER_BASE` URL for the source.
 *
 * @param {LlmProfile} profile
 */
function resolveBaseUrl(profile) {
    if (profile.reverse_proxy) {
        return normalizeBaseUrl(profile.reverse_proxy, profile.source);
    }
    if (profile.source === 'custom') {
        if (!profile.custom_url) throw new LlmError('bad_profile', 'custom source requires custom_url', false);
        return normalizeBaseUrl(profile.custom_url, profile.source);
    }
    if (profile.custom_url && (profile.source === 'ollama' || profile.source === 'llamacpp' || profile.source === 'koboldcpp')) {
        return normalizeBaseUrl(profile.custom_url, profile.source);
    }
    if (profile.source === 'claude') return 'https://api.anthropic.com/v1';
    const url = PROVIDER_BASE[profile.source];
    if (url) return url;
    throw new LlmError('unknown_source', `no base URL for source: ${profile.source}`, false);
}

/**
 * Normalize a base URL: strip trailing slashes and, for OpenAI-family local
 * providers, append `/v1` if the user gave us the bare server root (e.g.
 * `http://localhost:11434` for Ollama).
 *
 * @param {string} input
 * @param {string} source
 */
function normalizeBaseUrl(input, source) {
    let s = stripTrailingSlash(input);
    if (!s) return s;
    if (OPENAI_FAMILY.has(source) && source !== 'custom' && !/\/v\d+(?:\/[^/]+)?$/.test(s) && !s.endsWith('/api')) {
        s = `${s}/v1`;
    }
    return s;
}

function stripTrailingSlash(s) {
    return String(s).replace(/\/+$/, '');
}

/* -------- OpenAI-family transport -------- */

/**
 * @param {{ baseUrl: string, apiKey: string, profile: LlmProfile, messages: ChatMessage[], onUsage?: (usage: ChatUsage | null) => void, signal: AbortSignal }} args
 */
async function openaiChat({ baseUrl, apiKey, profile, messages, onUsage, signal }) {
    const body = openaiBaseBody({ profile, messages });
    const json = await openaiRequest({ baseUrl, apiKey, profile, body, signal });
    if (onUsage) onUsage(normaliseUsage(json, 'openai'));
    return extractOpenaiText(json);
}

/**
 * @param {{ baseUrl: string, apiKey: string, profile: LlmProfile, messages: ChatMessage[], schema: object, schemaName: string, onUsage?: (usage: ChatUsage | null) => void, signal: AbortSignal }} args
 */
async function openaiStructured({ baseUrl, apiKey, profile, messages, schema, schemaName, onUsage, signal }) {
    // Local providers (Ollama, llama.cpp, koboldcpp) don't reliably support
    // `response_format` on their OpenAI compatibility endpoints — go straight
    // to the text-mode JSON path which embeds the schema in the system prompt.
    if (FORCE_TEXT_JSON.has(profile.source)) {
        return await openaiStructuredFallback({ baseUrl, apiKey, profile, messages, schema, schemaName, onUsage, signal });
    }

    const body = openaiBaseBody({ profile, messages });
    body.response_format = {
        type: 'json_schema',
        json_schema: {
            name: schemaName || 'output',
            strict: true,
            schema,
        },
    };

    let raw, json;
    try {
        json = await openaiRequest({ baseUrl, apiKey, profile, body, signal });
        raw = extractOpenaiText(json);
    } catch (err) {
        // Some providers (e.g. plain OpenRouter routes) reject `response_format`.
        // Drop the schema and try once more in plain text mode, asking for JSON.
        if (err instanceof LlmError && err.code === 'http_400') {
            return await openaiStructuredFallback({ baseUrl, apiKey, profile, messages, schema, schemaName, onUsage, signal });
        }
        throw err;
    }
    try {
        const parsed = parseJsonOrThrow(raw, schemaName);
        if (onUsage) onUsage(normaliseUsage(json, 'openai'));
        return parsed;
    } catch (parseErr) {
        if (extractOpenaiFinishReason(json) === 'length') {
            const repaired = repairTruncatedJson(raw);
            if (repaired) {
                console.warn(`[llm] repaired truncated ${schemaName} JSON (finish_reason=length)`);
                if (onUsage) onUsage(normaliseUsage(json, 'openai'));
                return repaired;
            }
        }
        // Provider accepted `response_format` but produced unparseable output —
        // re-ask once in text-mode JSON before surfacing the error.
        try {
            return await openaiStructuredFallback({ baseUrl, apiKey, profile, messages, schema, schemaName, onUsage, signal });
        } catch (_) {
            throw parseErr;
        }
    }
}

/**
 * Fallback for sources that reject `response_format`: we ask for a JSON object
 * matching the schema and parse the text. One retry on malformed output.
 *
 * The schema reminder is appended to the FIRST system message so the model
 * still sees it when the caller passed a multi-turn `messages` array. If
 * there's no system message we synthesise one.
 *
 * @param {{ baseUrl: string, apiKey: string, profile: LlmProfile, messages: ChatMessage[], schema: object, schemaName: string, onUsage?: (usage: ChatUsage | null) => void, signal: AbortSignal }} args
 */
async function openaiStructuredFallback({ baseUrl, apiKey, profile, messages, schema, schemaName, onUsage, signal }) {
    const reminder = `\n\nReply with a single JSON object that matches this schema:\n${JSON.stringify(schema)}\nNo prose, no markdown fences.`;
    const augmented = augmentSystemMessage(messages, reminder);
    const body = openaiBaseBody({ profile, messages: augmented });
    let lastErr;
    let lastJson;
    for (let attempt = 0; attempt < 2; attempt++) {
        lastJson = await openaiRequest({ baseUrl, apiKey, profile, body, signal });
        const raw = extractOpenaiText(lastJson);
        try {
            const parsed = parseJsonOrThrow(raw, schemaName);
            if (onUsage) onUsage(normaliseUsage(lastJson, 'openai'));
            return parsed;
        } catch (err) {
            if (extractOpenaiFinishReason(lastJson) === 'length') {
                const repaired = repairTruncatedJson(raw);
                if (repaired) {
                    console.warn(`[llm] repaired truncated ${schemaName} JSON (finish_reason=length)`);
                    if (onUsage) onUsage(normaliseUsage(lastJson, 'openai'));
                    return repaired;
                }
            }
            lastErr = err;
        }
    }
    throw lastErr || new LlmError('parse_failed', 'unable to parse JSON from fallback', true);
}

/**
 * Splice a reminder into the first system message of a messages[] array,
 * or prepend a new system message if none exists. Returns a NEW array;
 * does not mutate the caller's input.
 *
 * @param {ChatMessage[]} messages
 * @param {string} reminder
 * @returns {ChatMessage[]}
 */
function augmentSystemMessage(messages, reminder) {
    const out = messages.map(m => ({ ...m }));
    const idx = out.findIndex(m => m.role === 'system');
    if (idx === -1) {
        out.unshift({ role: 'system', content: reminder.trimStart() });
    } else {
        out[idx] = { ...out[idx], content: `${out[idx].content}${reminder}` };
    }
    return out;
}

/**
 * @param {{ profile: LlmProfile, messages: ChatMessage[] }} args
 */
function openaiBaseBody({ profile, messages }) {
    /** @type {Record<string, unknown>} */
    const body = {
        model: profile.model,
        messages,
        stream: false,
    };
    if (typeof profile.temperature === 'number') body.temperature = profile.temperature;
    if (typeof profile.top_p === 'number') body.top_p = profile.top_p;
    if (typeof profile.max_tokens === 'number') body.max_tokens = profile.max_tokens;
    if (profile.extra && typeof profile.extra === 'object') Object.assign(body, profile.extra);
    return body;
}

/**
 * @param {{ baseUrl: string, apiKey: string, profile: LlmProfile, body: object, signal: AbortSignal }} args
 */
async function openaiRequest({ baseUrl, apiKey, profile, body, signal }) {
    const url = `${baseUrl}/chat/completions`;
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (profile.source === 'openrouter') {
        headers['HTTP-Referer'] = 'http://localhost';
        headers['X-Title'] = 'TTRPG Tavern';
    }

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });
    } catch (err) {
        if (signal.aborted) throw new LlmError('aborted', 'request aborted', false);
        throw new LlmError('network', `network error: ${err?.message || err}`, true);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = res.status >= 500 ? `http_${res.status}` : `http_${res.status}`;
        throw new LlmError(code, `${res.status} ${res.statusText}: ${text.slice(0, 500)}`, res.status >= 500);
    }
    let json;
    try {
        json = await res.json();
    } catch (err) {
        throw new LlmError('bad_response', `non-JSON response: ${err?.message || err}`, true);
    }
    return json;
}

function extractOpenaiText(json) {
    const choice = json?.choices?.[0];
    const message = choice?.message;
    if (!message) {
        throw new LlmError('bad_response', 'no choices[0].message in response', true);
    }
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
    }
    return '';
}

/** @param {any} json @returns {string | undefined} */
function extractOpenaiFinishReason(json) {
    return json?.choices?.[0]?.finish_reason;
}

/* -------- Claude transport -------- */

/**
 * @param {{ baseUrl: string, apiKey: string, profile: LlmProfile, messages: ChatMessage[], onUsage?: (usage: ChatUsage | null) => void, signal: AbortSignal }} args
 */
async function claudeChat({ baseUrl, apiKey, profile, messages, onUsage, signal }) {
    const body = claudeBaseBody({ profile, messages });
    const json = await claudeRequest({ baseUrl, apiKey, body, signal });
    if (onUsage) onUsage(normaliseUsage(json, 'claude'));
    return extractClaudeText(json);
}

/**
 * @param {{ baseUrl: string, apiKey: string, profile: LlmProfile, messages: ChatMessage[], schema: object, schemaName: string, onUsage?: (usage: ChatUsage | null) => void, signal: AbortSignal }} args
 */
async function claudeStructured({ baseUrl, apiKey, profile, messages, schema, schemaName, onUsage, signal }) {
    const body = claudeBaseBody({ profile, messages });
    const tool = {
        name: schemaName || 'output',
        description: 'Well-formed JSON object',
        input_schema: schema,
    };
    body.tools = [tool];
    body.tool_choice = { type: 'tool', name: tool.name };

    const json = await claudeRequest({ baseUrl, apiKey, body, signal });
    if (onUsage) onUsage(normaliseUsage(json, 'claude'));
    const block = (json?.content || []).find(b => b?.type === 'tool_use' && b?.name === tool.name);
    if (!block) {
        // Fallback: try to find any tool_use, otherwise extract text and parse.
        const anyTool = (json?.content || []).find(b => b?.type === 'tool_use');
        if (anyTool && anyTool.input && typeof anyTool.input === 'object') {
            return anyTool.input;
        }
        const text = extractClaudeText(json);
        try {
            return parseJsonOrThrow(text, schemaName);
        } catch (parseErr) {
            if (json?.stop_reason === 'max_tokens') {
                const repaired = repairTruncatedJson(text);
                if (repaired) {
                    console.warn(`[llm] repaired truncated claude ${schemaName} JSON (stop_reason=max_tokens)`);
                    return repaired;
                }
            }
            throw parseErr;
        }
    }
    if (block.input && typeof block.input === 'object') return block.input;
    throw new LlmError('bad_response', 'claude tool_use block missing input object', true);
}

/**
 * Claude's `/v1/messages` endpoint takes `system` separate from the
 * conversational `messages[]`. We hoist all `role: 'system'` messages out
 * (concatenating with double newlines if the caller built up multiple) and
 * leave the user/assistant turns intact.
 *
 * @param {{ profile: LlmProfile, messages: ChatMessage[] }} args
 */
function claudeBaseBody({ profile, messages }) {
    const systemParts = [];
    const convo = [];
    for (const m of messages) {
        if (m.role === 'system') {
            if (typeof m.content === 'string' && m.content.length) systemParts.push(m.content);
        } else {
            convo.push({ role: m.role, content: m.content });
        }
    }
    /** @type {Record<string, unknown>} */
    const body = {
        model: profile.model,
        max_tokens: typeof profile.max_tokens === 'number' ? profile.max_tokens : 1024,
        messages: convo,
    };
    if (systemParts.length) body.system = systemParts.join('\n\n');
    if (typeof profile.temperature === 'number') body.temperature = profile.temperature;
    if (typeof profile.top_p === 'number') body.top_p = profile.top_p;
    if (profile.extra && typeof profile.extra === 'object') Object.assign(body, profile.extra);
    return body;
}

/**
 * @param {{ baseUrl: string, apiKey: string, body: object, signal: AbortSignal }} args
 */
async function claudeRequest({ baseUrl, apiKey, body, signal }) {
    const url = `${baseUrl}/messages`;
    /** @type {Record<string, string>} */
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });
    } catch (err) {
        if (signal.aborted) throw new LlmError('aborted', 'request aborted', false);
        throw new LlmError('network', `network error: ${err?.message || err}`, true);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmError(`http_${res.status}`, `${res.status} ${res.statusText}: ${text.slice(0, 500)}`, res.status >= 500);
    }
    try {
        return await res.json();
    } catch (err) {
        throw new LlmError('bad_response', `non-JSON response: ${err?.message || err}`, true);
    }
}

function extractClaudeText(json) {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    return blocks
        .filter(b => b?.type === 'text')
        .map(b => b.text || '')
        .join('');
}

/**
 * Normalise the `usage` field from an upstream chat-completion response into
 * `{prompt_tokens, completion_tokens, total_tokens}`.
 *
 * - OpenAI-family servers (OpenAI, OpenRouter, Groq, …) return the names
 *   we use directly, but some omit `total_tokens` and a few local servers
 *   (older Ollama, llama.cpp builds without metrics) omit `usage` entirely.
 * - Claude returns `usage.{input_tokens, output_tokens}` and never a total.
 *
 * Returns `null` when the upstream omitted usage. The Director loop treats
 * `null` as "skip the budget check this step".
 *
 * @param {any} json
 * @param {'openai' | 'claude'} source
 * @returns {ChatUsage | null}
 */
function normaliseUsage(json, source) {
    const u = json?.usage;
    if (!u || typeof u !== 'object') return null;
    if (source === 'claude') {
        const prompt = numOr0(u.input_tokens);
        const completion = numOr0(u.output_tokens);
        if (!prompt && !completion) return null;
        return {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
        };
    }
    const prompt = numOr0(u.prompt_tokens);
    const completion = numOr0(u.completion_tokens);
    const total = numOr0(u.total_tokens) || (prompt + completion);
    if (!prompt && !completion && !total) return null;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
    };
}

function numOr0(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/* -------- Helpers -------- */

/**
 * Parse a string as JSON, tolerating common LLM mistakes (markdown fences,
 * leading/trailing prose). Throws an `LlmError` with `code: 'parse_failed'`
 * on failure.
 *
 * @param {string} raw
 * @param {string} schemaName
 */
function parseJsonOrThrow(raw, schemaName) {
    if (typeof raw !== 'string') {
        throw new LlmError('parse_failed', `expected string for ${schemaName}, got ${typeof raw}`, true);
    }
    let s = raw.trim();
    if (s.startsWith('```')) {
        // strip ```json … ``` fence
        s = s.replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/```$/, '').trim();
    }
    try {
        return JSON.parse(s);
    } catch (_) {
        // Try to extract the FIRST balanced {...} block. Some local models
        // (e.g. qwen2.5 via Ollama) occasionally emit two decisions back to
        // back; we want the first one and the agent loop will re-invoke the
        // Director for the next beat with full history.
        const first = extractFirstJsonObject(s);
        if (first !== null) {
            try {
                return JSON.parse(first);
            } catch (_) {
                // fall through
            }
        }
        // Fallback: greedy first..last (handles a single object with extra prose at both ends).
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start !== -1 && end > start) {
            const slice = s.slice(start, end + 1);
            try {
                return JSON.parse(slice);
            } catch (_) {
                // fall through
            }
        }
        throw new LlmError('parse_failed', `could not parse ${schemaName} JSON: ${s.slice(0, 200)}`, true);
    }
}

/**
 * Walks `s` and returns the substring of the first balanced JSON object,
 * respecting string literals (including escaped quotes). Returns null if no
 * balanced object is found.
 *
 * @param {string} s
 * @returns {string | null}
 */
function extractFirstJsonObject(s) {
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (escape) { escape = false; continue; }
        if (inString) {
            if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * Best-effort repair of truncated JSON produced when a model hits its
 * generation limit mid-object. Walks the string tracking JSON state, then
 * closes any dangling string literals, arrays, and objects.
 *
 * Only attempts repair when the string starts with `{` (i.e. it looks like
 * it was meant to be a JSON object). Returns `null` if the input doesn't
 * look repairable or repair produces invalid JSON.
 *
 * @param {string} raw
 * @returns {object | null}
 */
function repairTruncatedJson(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    if (s.startsWith('```')) {
        s = s.replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/```$/, '').trim();
    }
    const start = s.indexOf('{');
    if (start === -1) return null;
    s = s.slice(start);

    let inString = false;
    let escape = false;
    const stack = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escape) { escape = false; continue; }
        if (inString) {
            if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
    }

    if (stack.length === 0 && !inString) return null;

    let suffix = '';
    if (inString) suffix += '"';
    while (stack.length) suffix += stack.pop();

    try {
        return JSON.parse(s + suffix);
    } catch (_) {
        // The closed-off string value might contain trailing junk (e.g. a
        // half-written escape). Try trimming the last few chars before the
        // closing quote.
        for (let trim = 1; trim <= 5; trim++) {
            try {
                return JSON.parse(s.slice(0, -trim) + suffix);
            } catch (_) { /* keep trying */ }
        }
        return null;
    }
}
