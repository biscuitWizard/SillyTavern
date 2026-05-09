# Phase 5 — Multi-actor

Status: Pending.

## Goal

Scenes can contain AI-controlled characters in addition to the PC and
the Narrator. The Director can call `speak: <character_id>`; the actor
LLM responds in character; per-actor prompts are built from each
character's authoritative state with strict context isolation. This is
where the project becomes a tabletop in earnest.

## Scope

- `src/gm-core/actors/prompts.js` — per-actor prompt builder. Inputs:
  the character's full sheet rendered as YAML, intent from the
  Director, transcript tail. Excluded: other characters' sheets, other
  characters' memories, Director rationale.
- `DirectorDecision` extended with `speak: { actor: <character_id> }`,
  `spawn_character: { source: 'library' | 'new'; ... }`,
  `remove_character: { character_id }`. Dispatchers wired in
  `director/loop.js`.
- Scene participant management on the backend (`SceneStore`
  add/remove participant) and in the UI (Party panel reflects
  in-scene roster, persistence via `scene.json`).
- Sheet → YAML rendering helper (`library/yaml.js` from Phase 2 is
  used here).
- Actor invocation reuses the same `llm.chat()` wrapper from Phase 4.

## Out of scope

- Skill checks (Phase 6).
- RAG (Phase 7) — actors do not yet receive memory snippets; only
  their sheet + intent + transcript tail.
- AI-driven new character generation (Phase 6 / 10). `spawn_character`
  with `source: 'new'` returns a stub error in this phase; only
  `source: 'library'` works.
- Per-actor mute / chip UI for the player to silence specific actors
  (Phase 10).

## Files

Planned:

- `src/gm-core/actors/prompts.js`
- `src/gm-core/director/loop.js` — extended with new dispatchers.
- `src/gm-core/director/schemas.js`, `schemas.d.ts` — extended union.
- `src/gm-core/scenes/participants.js` — add / remove participant
  helpers; updates `Scene.participants`.
- `src/endpoints/gm.js` — `/scenes/{id}/participants` routes.
- `public/scripts/gm/party-panel.js` — extended to manage in-scene
  roster (add NPC from library, remove).
- `public/scripts/gm/turn-events.js` — handle `state` events for
  spawn / remove and surface them as small system-style messages in
  the transcript.

## Schemas

`DirectorDecision` (Phase 5 superset):

```ts
type DirectorDecision =
    | { action: 'speak'; actor: 'narrator' | string; intent: string; rationale: string }
    | { action: 'spawn_character'; source: 'library'; character_id: string; rationale: string }
    | { action: 'spawn_character'; source: 'new'; rationale: string }   // returns error in Phase 5
    | { action: 'remove_character'; character_id: string; rationale: string }
    | { action: 'end_turn'; rationale: string };
```

`TurnEvent` (Phase 5 superset):

```ts
type TurnEvent =
    | ...   // Phase 4 kinds
    | { kind: 'state'; change: 'spawn' | 'remove'; character_id: string; character_name: string };
```

`ActorPromptInputs` (server-side):

```ts
type ActorPromptInputs = {
    actor: Character;                  // sheet rendered as YAML for the prompt
    intent: string;                    // from Director
    transcript_tail_text: string;
    campaign_addendum: string;
};
```

## Context isolation invariants

These are properties of the system, enforced by the prompt builders:

1. Actor X's prompt sees only X's sheet. No other character's sheet.
2. Actor X's prompt does not contain RAG memories of any kind in this
   phase (RAG starts in Phase 7).
3. Director rationale is never echoed into actor prompts.
4. Narrator does not see character sheets.

Unit tests in `tests/gm-core/prompts.test.js` (planned) assert these
explicitly: build a prompt for X with Y also in the scene, then check
the prompt string does not contain Y's sheet markers.

## Acceptance criteria

- Adding an NPC from the library to a scene shows them in the Party
  panel and they may be picked by the Director's `speak`.
- An actor's reply renders with the right name and avatar, persists
  to the transcript with `extra.role = 'actor'` and
  `extra.actor_id = <id>`.
- `spawn_character: library` invoked by the Director adds the chosen
  character to `scene.participants` and emits a `state` event;
  `remove_character` does the inverse.
- The Director can take multiple turns within one player turn (cap
  enforced).
- The isolation tests pass.

## Depends on

Phase 4.
