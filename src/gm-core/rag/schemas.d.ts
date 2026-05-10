/**
 * Type declarations for src/gm-core/rag/schemas.js. Mirrors JSDoc typedefs
 * for cross-module IDE support.
 */

export type MemoryKind =
    | 'world_lore'
    | 'character_memory'
    | 'director_memory'
    | 'narrator_memory'
    | 'player_journal';

export type WorldLoreOrigin = 'core' | 'generated';

export type WorldLoreSourceType =
    | 'seed_pack'
    | 'auto_extracted'
    | 'wizard_paste'
    | 'add_lore'
    | 'scene_end'
    | 'manual';

export type WorldLoreEntryKind =
    | 'location'
    | 'faction'
    | 'culture'
    | 'people'
    | 'history'
    | 'magic'
    | 'artifact'
    | 'bestiary'
    | 'cosmology'
    | 'language'
    | 'pantheon'
    | 'custom';

export interface WorldLorePayload {
    origin: WorldLoreOrigin;
    source_type: WorldLoreSourceType;
    scene_id: string | null;
    entry_kind: WorldLoreEntryKind;
    title: string;
}

export interface DecayConfig {
    mode: 'exponential' | 'linear';
    half_life: number;
    floor: number;
    nostalgia?: boolean;
}

export interface MemoryRecord {
    id: string;
    kind: MemoryKind;
    scope_id: string;
    content: string;
    tags: string[];
    importance: number;
    valence: number;
    temporally_blind: boolean;
    decay_override: DecayConfig | null;
    source: string;
    created_at: string;
    updated_at: string;
    metadata: Record<string, unknown>;
    world_lore?: WorldLorePayload;
    scene_index?: number;
}

export interface RetrievalQuery {
    text: string;
    top_k?: number;
    world_filters?: Partial<WorldLorePayload>;
    tags?: string[];
    include_blind?: boolean;
}

export interface RetrievalHit {
    record: MemoryRecord;
    raw_score: number;
    score: number;
    decay_multiplier: number;
}

export const MEMORY_KINDS: readonly MemoryKind[];
export const WORLD_LORE_ORIGINS: readonly WorldLoreOrigin[];
export const WORLD_LORE_ENTRY_KINDS: readonly WorldLoreEntryKind[];
export const WORLD_LORE_SOURCE_TYPES: readonly WorldLoreSourceType[];
export const DEFAULT_DECAY: Record<MemoryKind, DecayConfig>;

export function collectionNameFor(kind: MemoryKind, campaignId: string, characterId?: string): string;
export function parseCollectionName(name: string): { kind: MemoryKind; campaign_id: string; character_id?: string } | null;
export function validateMemoryRecord(input: Partial<MemoryRecord>): string | null;
export function buildMemoryRecord(input: Partial<MemoryRecord> & {
    id: string;
    kind: MemoryKind;
    scope_id: string;
    content: string;
}): MemoryRecord;
