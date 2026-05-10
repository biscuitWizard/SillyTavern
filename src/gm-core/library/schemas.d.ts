/**
 * Character + CharacterSheet types (Phase 2; KV-stat refactor in Phase 5).
 */

export interface Item {
    id: string;
    name: string;
    description: string;
    influences: string[];
}

export interface CharacterSheet {
    stats: Record<string, number | string>;
    statuses: Record<string, string>;
    items: Item[];
    skills: string[];
    notes: string;
    /**
     * Per-other-character record of how *this* character feels about
     * them. Keys are the other character's id; values are a small KV
     * grid whose schema is driven by the layout's `relationships`
     * category `per_target_fields[]` (M1).
     *
     * Other characters' opinions about this one live on THEIR sheet,
     * not here. The actor-prompt renderer reads only `character.sheet`
     * — never a campaign-side mirror — to preserve the per-actor
     * isolation invariant pinned in `tests/gm-core/actor-prompts.test.js`.
     */
    relationships: Record<string, Record<string, number | string>>;
}

export interface Character {
    id: string;
    campaign_id: string;
    name: string;
    is_player: boolean;
    appearance: string;
    personality: string;
    voice: string;
    background: string;
    sheet: CharacterSheet;
    /** Derived: true when a portrait PNG exists on disk beside the JSON. */
    has_portrait: boolean;
    created_at: string;
    updated_at: string;
}

export function defaultSheet(overrides?: Partial<CharacterSheet>): CharacterSheet;
export function buildCharacter(input: Partial<Character> & { id: string; campaign_id: string; name: string }): Character;
export function validateCharacterInput(body: Partial<Character>): string | null;
