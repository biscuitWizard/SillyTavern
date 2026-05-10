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

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
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
