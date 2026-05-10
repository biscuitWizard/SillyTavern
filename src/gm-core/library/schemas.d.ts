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
    st_card_avatar: string | null;
    created_at: string;
    updated_at: string;
}

export function defaultSheet(overrides?: Partial<CharacterSheet>): CharacterSheet;
export function buildCharacter(input: Partial<Character> & { id: string; campaign_id: string; name: string }): Character;
export function validateCharacterInput(body: Partial<Character>): string | null;
