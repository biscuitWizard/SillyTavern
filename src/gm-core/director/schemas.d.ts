export type DirectorDecision =
    | { action: 'speak'; actor: 'narrator' | string; intent: string; rationale: string }
    | { action: 'skill_check'; actor: string; intent: string; voice?: 'narrator' | string; rationale: string }
    | {
          action: 'spawn_character';
          from_source: 'library' | 'new';
          ref?: string;
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
          action: 'propose_scene';
          name: string;
          setting: string;
          suggested_participants: string[];
          hooks: string[];
          rationale: string;
      }
    | { action: 'end_turn'; rationale: string };

export const SUPPORTED_ACTIONS: ReadonlySet<DirectorDecision['action']>;
export const directorDecisionJsonSchema: object;
export function validateDirectorDecision(value: unknown): string | null;
