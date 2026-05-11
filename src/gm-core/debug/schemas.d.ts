/**
 * Debug event log types for the TTRPG Tavern GM core.
 *
 * Every instrumented LLM call, Director tool decision, and turn-level span
 * emits a `DebugEvent` that is persisted to a per-scene JSONL file and
 * streamed live to the frontend Event Log panel via SSE.
 */

export type DebugEventScope =
    | 'turn'
    | 'scene_end'
    | 'opening'
    | 'ask'
    | 'plot'
    | 'lore'
    | 'rag_writer'
    | 'character_create'
    | 'other';

export type DebugEventKind =
    | 'llm_call'
    | 'tool_decision'
    | 'tool_result'
    | 'turn_event'
    | 'span_start'
    | 'span_end';

export type LlmRole =
    | 'director'
    | 'narrator'
    | 'actor'
    | 'adjudicator'
    | 'summarizer'
    | 'opening'
    | 'ask'
    | 'plot'
    | 'lore'
    | 'opinion_writer'
    | 'narrator_continuity_writer'
    | 'scene_summary'
    | 'memory_extraction'
    | 'other';

export interface DebugEvent {
    id: string;
    ts: string;
    scene_id?: string;
    campaign_id?: string;
    scope: DebugEventScope;
    kind: DebugEventKind;
    parent_id?: string;
    headline: string;
    detail: Record<string, unknown>;
}

export interface LlmCallDetail {
    role: LlmRole;
    mode: 'chat' | 'structured';
    provider: string;
    model: string;
    base_url: string;
    schema_name?: string;
    messages: Array<{ role: string; content: string }>;
    raw_response?: string;
    parsed?: unknown;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    duration_ms: number;
    error?: { code: string; message: string };
    actor_id?: string;
    scene_id?: string;
    campaign_id?: string;
}

export interface ToolDecisionDetail {
    step: number;
    decision: Record<string, unknown>;
}

export interface ToolResultDetail {
    step: number;
    summary: string;
    tool_error_key?: string;
    turn_events?: Array<Record<string, unknown>>;
}

export interface SpanDetail {
    label: string;
    user_input?: string;
    scene_id?: string;
    campaign_id?: string;
    end_reason?: string;
}

export interface DebugContext {
    directories: import('../../users.js').UserDirectoryList;
    scene_id?: string;
    campaign_id?: string;
    scope: DebugEventScope;
    parent_id?: string;
}
