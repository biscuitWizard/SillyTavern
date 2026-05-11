export type SheetMutationOp =
    | { op: 'set_stat'; key: string; value: number | string }
    | { op: 'adjust_stat'; key: string; delta: number }
    | { op: 'clear_stat'; key: string }
    | { op: 'set_status'; key: string; value: string }
    | { op: 'clear_status'; key: string }
    | { op: 'add_item'; name: string; description?: string; influences?: string[] }
    | { op: 'update_item'; item_id: string; name?: string; description?: string; influences?: string[] }
    | { op: 'remove_item'; item_id: string };

export type DirectorDecision =
    | { action: 'speak'; actor: 'narrator' | string; intent: string; rationale: string }
    | { action: 'skill_check'; actor: string; intent: string; rationale: string }
    | { action: 'search_library'; query: string; rationale: string }
    | {
          action: 'spawn_character';
          from_source: 'library' | 'new';
          ref?: string;
          name?: string;
          brief?: string;
          on_join_message?: string;
          rationale: string;
      }
    | {
          action: 'remove_character';
          character_id: string;
          on_leave_message?: string;
          rationale: string;
      }
    | {
          action: 'add_lore';
          title: string;
          body: string;
          tags: string[];
          rationale: string;
      }
    | {
          action: 'mutate_sheet';
          character_id: string;
          ops: SheetMutationOp[];
          rationale: string;
      }
    | {
          action: 'mutate_identity';
          character_id: string;
          field: 'appearance' | 'personality' | 'voice' | 'background';
          value: string;
          rationale: string;
      }
    | {
          action: 'propose_scene';
          name: string;
          setting: string;
          suggested_participants: string[];
          hooks: string[];
          rationale: string;
      }
    | { action: 'end_turn'; rationale: string; pacing_note?: string };

export const SUPPORTED_ACTIONS: ReadonlySet<DirectorDecision['action']>;
export const IDENTITY_FIELDS: ReadonlySet<string>;
export const SUPPORTED_SHEET_MUTATION_OPS: ReadonlySet<string>;
export const directorTools: import('../llm/client.js').ToolDefinition[];
export function validateDirectorDecision(value: unknown): string | null;
