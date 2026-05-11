export interface LlmProfile {
    source: string;
    model: string;
    secret_id?: string;
    reverse_proxy?: string;
    proxy_password?: string;
    custom_url?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    extra?: Record<string, unknown>;
}

/**
 * Internal canonical chat-message shape. We follow the OpenAI
 * `/v1/chat/completions` schema as the lingua franca and translate to
 * Claude's `tool_use`/`tool_result` blocks at the provider boundary.
 *
 * - `role: 'tool'` messages are tool/function-call results, paired with
 *   the preceding assistant message's `tool_calls[i].id` via
 *   `tool_call_id`. Per OpenAI's spec they MUST follow an assistant
 *   message that carried the matching `tool_calls` array.
 * - An assistant message that invoked one or more tools usually sets
 *   `content: null` and carries the call(s) in `tool_calls`. We allow
 *   both `null` and `''` for portability.
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        /** Arguments serialized as a JSON string, per OpenAI's spec. */
        arguments: string;
    };
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters: object;
        strict?: boolean;
    };
}

/**
 * Result of a successful `LlmClient.tool()` call. Always normalised to
 * this shape regardless of whether the upstream produced a real
 * `tool_calls` array or we synthesised one from text-mode JSON fallback.
 */
export interface ToolCallResponse {
    /** Stable id used as `tool_call_id` on the matching tool result message. */
    id: string;
    /** Tool/function name. Validated against the caller's `tools` list. */
    name: string;
    /** Parsed arguments object. */
    arguments: Record<string, unknown>;
    /** Raw arguments JSON string as the model emitted it. */
    raw_arguments: string;
}

export interface ChatUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface LlmClient {
    profile: LlmProfile;
    /**
     * Free-form chat. Pass either `{system, user}` (single-turn) or
     * `messages` (full history). When `messages` is set, `system`/`user`
     * are ignored. The optional `onUsage` callback fires once per call
     * with normalised token usage from the upstream response (or `null`
     * if the provider omitted `usage`).
     */
    chat(args: {
        system?: string;
        user?: string;
        messages?: ChatMessage[];
        onUsage?: (usage: ChatUsage | null) => void;
        signal?: AbortSignal;
    }): Promise<string>;
    /**
     * Schema-constrained call. Same `messages`/`onUsage` semantics as
     * `chat`. Returns the parsed JSON object (provider-native structured
     * mode where supported, text-mode JSON fallback otherwise).
     */
    structured(args: {
        system?: string;
        user?: string;
        messages?: ChatMessage[];
        schema: object;
        schemaName: string;
        onUsage?: (usage: ChatUsage | null) => void;
        signal?: AbortSignal;
    }): Promise<any>;
    /**
     * Tool/function-calling call. The model is constrained to pick
     * exactly one tool from `tools`; we return its name + parsed
     * arguments + a stable `id` the caller should reflect back on the
     * matching `{role:'tool', tool_call_id: id}` result message in the
     * next call's history.
     *
     * When the upstream provider doesn't speak tools (or fails the
     * tools-mode request), we fall back to text-mode JSON, prompt the
     * model to return `{name, arguments}` in plain text, and synthesise
     * the `id`. The returned shape is identical so callers don't need
     * to branch.
     */
    tool(args: {
        system?: string;
        user?: string;
        messages?: ChatMessage[];
        tools: ToolDefinition[];
        tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
        onUsage?: (usage: ChatUsage | null) => void;
        signal?: AbortSignal;
    }): Promise<ToolCallResponse>;
}

export class LlmError extends Error {
    code: string;
    retryable: boolean;
    constructor(code: string, message: string, retryable?: boolean);
}

export function createLlmClient(args: {
    userDirectories: import('../../users.js').UserDirectoryList;
    profile: LlmProfile;
}): LlmClient;
