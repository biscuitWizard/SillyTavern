import type {
    MemoryKind,
    MemoryRecord,
    RetrievalHit,
    WorldLorePayload,
} from './schemas';
import type { QdrantWrapper } from './qdrant';
import type { Embedder } from './embedders';

export interface MemoryServiceDeps {
    directories: { root: string; campaigns: string };
    qdrant: QdrantWrapper;
    embedder: Embedder;
    topK?: {
        world?: number;
        character?: number;
        director?: number;
        narrator?: number;
        player_journal?: number;
    };
    getCurrentSceneIndex?: (campaignId: string) => number;
}

export interface MemoryService {
    embedder: Embedder;
    qdrant: QdrantWrapper;
    directories: MemoryServiceDeps['directories'];
    for_character(args: { campaignId: string; characterId: string; queryText: string; topK?: any }): Promise<{
        character: RetrievalHit[];
        world: RetrievalHit[];
        player_journal: RetrievalHit[];
    }>;
    for_director(args: { campaignId: string; queryText: string; topK?: any }): Promise<{
        world: RetrievalHit[];
        director: RetrievalHit[];
    }>;
    for_narrator(args: { campaignId: string; queryText: string; topK?: any }): Promise<{
        world: RetrievalHit[];
        narrator: RetrievalHit[];
    }>;
    for_world(args: {
        campaignId: string;
        queryText: string;
        limit?: number;
        filters?: Partial<WorldLorePayload> & { tags?: string[] };
    }): Promise<RetrievalHit[]>;
    for_player_journal(args: { campaignId: string; queryText: string; limit?: number }): Promise<RetrievalHit[]>;
    search(args: {
        campaignId: string;
        kind: MemoryKind;
        characterId?: string;
        queryText: string;
        limit?: number;
        filters?: Partial<WorldLorePayload> & { tags?: string[] };
    }): Promise<RetrievalHit[]>;
    write(args: {
        campaignId: string;
        record: Partial<MemoryRecord> & {
            id: string;
            kind: MemoryKind;
            scope_id: string;
            content: string;
        };
        characterId?: string;
    }): Promise<{
        id: string;
        collection: string;
        persisted_disk: boolean;
        persisted_qdrant: boolean;
        error?: string;
    }>;
    remove(args: {
        campaignId: string;
        id: string;
        kind: MemoryKind;
        characterId?: string;
    }): Promise<{ id: string; collection: string; removed_disk: boolean; removed_qdrant: boolean; error?: string }>;
    list(args: {
        campaignId: string;
        kind: MemoryKind;
        characterId?: string;
        filters?: Partial<WorldLorePayload> & { tags?: string[] };
        limit?: number;
        offset?: string | number | null;
    }): Promise<{ records: MemoryRecord[]; next_offset: string | number | null }>;
    patch(args: {
        campaignId: string;
        id: string;
        kind: MemoryKind;
        characterId?: string;
        patch: Partial<MemoryRecord>;
    }): Promise<MemoryRecord | null>;
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService;
