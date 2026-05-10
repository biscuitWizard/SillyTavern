export interface Scene {
    id: string;
    campaign_id: string;
    name: string;
    status: 'active' | 'closed';
    participants: string[];
    location: string;
    started_at: string;
    ended_at: string | null;
    message_count: number;
    summary_id?: string | null;
    summary_headline?: string | null;
    summary_path?: string | null;
}

export interface TranscriptLine {
    name: string;
    force_avatar?: string;
    mes: string;
    is_user: boolean;
    is_system: boolean;
    send_date: string;
    extra?: Record<string, unknown>;
}

export interface SceneSummaryKeyEvent {
    text: string;
    tags: string[];
    importance: number;
}

export interface SceneSummary {
    scene_id: string;
    campaign_id: string;
    headline: string;
    summary: string;
    key_events: SceneSummaryKeyEvent[];
    location_changes: string[];
    participant_changes: string[];
    generated_at: string;
}

export const SCENE_NAME_MAX: number;
export const SCENE_LOCATION_MAX: number;
export const SCENE_HEADLINE_MAX: number;

export function buildScene(input: Partial<Scene> & { id: string; campaign_id: string }): Scene;
export function validateSceneInput(body: Partial<Scene>): string | null;
export function buildSceneSummary(input: Partial<SceneSummary> & { scene_id: string; campaign_id: string }): SceneSummary;
