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

export interface LlmClient {
    profile: LlmProfile;
    chat(args: { system: string; user: string; signal?: AbortSignal }): Promise<string>;
    structured(args: {
        system: string;
        user: string;
        schema: object;
        schemaName: string;
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
