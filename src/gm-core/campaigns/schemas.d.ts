/**
 * Campaign schemas (Phase 1).
 *
 * The runtime constants/builders live in `schemas.js`. This file mirrors the
 * shape so other modules can `import type { Campaign } from './schemas'`.
 */

export type BannerTheme = 'shadows' | 'frontier' | 'hollow' | 'default';

export interface Campaign {
    id: string;
    name: string;
    brief: string;
    ruleset_id: string;
    addendum: string;
    banner_theme: BannerTheme;
    current_scene_id: string | null;
    last_played_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface CampaignSummary {
    id: string;
    name: string;
    brief: string;
    ruleset_id: string;
    banner_theme: BannerTheme;
    last_played_at: string | null;
    scene_count: number;
}

export const BANNER_THEMES: BannerTheme[];
export const CAMPAIGN_BRIEF_MAX: number;
export const CAMPAIGN_NAME_MAX: number;

export function buildCampaign(input: Partial<Campaign> & { id: string; name: string }): Campaign;
export function validateCampaignInput(body: Partial<Campaign>): string | null;
