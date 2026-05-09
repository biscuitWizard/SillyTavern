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

export const SCENE_NAME_MAX: number;
export const SCENE_LOCATION_MAX: number;

export function buildScene(input: Partial<Scene> & { id: string; campaign_id: string }): Scene;
export function validateSceneInput(body: Partial<Scene>): string | null;
