# Phase 5 — Multi-actor (with sidebars + KV-driven stats)

Status: Done.

## Goal

Scenes can contain AI-controlled characters in addition to the PC and
the Narrator. The Director can call `speak: <character_id>`; the actor
LLM responds in character; per-actor prompts are built from each
character's authoritative state with strict context isolation. This is
where the project becomes a tabletop in earnest.

Phase 5 also lands two scoped UI / data-model upgrades that the
multi-actor experience needs to feel right:

- A persistent **left sidebar** in Campaign Main and Scene views shows
  the player character + their live sheet whenever a campaign is
  loaded.
- A **right sidebar** in Scene view shows the in-scene roster
  (`scene.participants`) with click-to-view-sheet and an "Add to
  scene" affordance.
- **Stats become key-value pairs** seeded from the campaign's active
  ruleset (today only `dnd5e`). The wizard and sheet panel both expose
  generic KV CRUD, matching `srstavern`'s model.

## Scope

- `src/gm-core/actors/prompts.js` — per-actor prompt builder. Inputs:
  the character's full sheet rendered as YAML, intent from the
  Director, transcript tail. Excluded: other characters' sheets, other
  characters' memories, Director rationale.
- `DirectorDecision` extended dispatch in `director/loop.js`:
  - `speak: <character_id>` — call the actor LLM with the per-actor
    scoped prompt; emit a `message` tagged with `role: 'actor'`,
    `actor_id`, persisted to the transcript.
  - `spawn_character` with `from_source: 'library'` and a `ref` —
    add to `scene.participants`, emit `state: { change: 'spawn' }`.
  - `spawn_character` with `from_source: 'new'` — emit a structured
    `error` (`code: 'unsupported_source'`); AI character generation is
    Phase 6/10.
  - `remove_character` — remove from `scene.participants`, emit
    `state: { change: 'remove' }`.
- Scene participant management on the backend (`scenes/participants.js`
  helpers + `POST /api/gm/scenes/:id/participants` and
  `DELETE /api/gm/scenes/:id/participants/:char_id`).
- Sheet → YAML rendering helper (`library/yaml.js` from Phase 2 is
  used here).
- Actor invocation reuses the same `llm.chat()` wrapper from Phase 4.
- `src/gm-core/rulesets/index.js` — in-memory registry exposing
  `starter_stats` / `starter_skills` per `ruleset_id`. The character
  create endpoint seeds `sheet.stats` from this when no stats are
  shipped by the caller. Phase 6 swaps the registry for a YAML loader.
- `src/gm-core/library/schemas.js` — `defaultSheet()` is purely
  additive (no implicit 5e seed); `buildCharacter()` no longer auto-
  seeds stats.
- `src/gm-core/sheets/operations.js` — adds `clearStat()` parallel to
  the existing `clearStatus()`. Backed by a new
  `DELETE /api/gm/sheets/:char_id/stats/:key` route.
- Frontend: `public/scripts/gm/sidebar-left.js` (PC card + compact KV
  stats grid), `public/scripts/gm/sidebar-right.js` (in-scene roster +
  Add NPC picker), `public/scripts/gm/turn-events.js` (handles
  `state` events and forwards them to the right sidebar via an event
  bus).
- Wizard `public/scripts/gm/character-wizard.js` gains a Stats step
  with an editable KV grid pre-populated from the ruleset, and a
  `is_player: false` "Create NPC" mode invoked from the right sidebar.
- Sheet panel `public/scripts/gm/sheet-panel.js` becomes a real KV
  editor for `stats` and `statuses` (set / delete / add).

## Out of scope

- Skill checks (Phase 6).
- RAG (Phase 7) — actors do not yet receive memory snippets; only
  their sheet + intent + transcript tail.
- AI-driven new character generation (Phase 6 / 10). `spawn_character`
  with `from_source: 'new'` returns a structured error in this phase;
  only `from_source: 'library'` works.
- Per-actor mute / chip UI for the player to silence specific actors
  (Phase 10).
- YAML-backed rulesets (Phase 6). Today the registry is a static
  in-memory object with one entry (`dnd5e`).

## Files

Shipped:

- `src/gm-core/actors/prompts.js`
- `src/gm-core/director/loop.js` — extended with new dispatchers.
- `src/gm-core/director/schemas.js`, `schemas.d.ts` — `SUPPORTED_ACTIONS`
  extended.
- `src/gm-core/director/prompts.js` — Director system prompt rewritten
  to describe Phase 5's action surface; user prompt now lists actors
  with stable ids and a separate "library" section the Director can
  spawn from.
- `src/gm-core/scenes/participants.js` — `addParticipant`,
  `removeParticipant`. Idempotent.
- `src/gm-core/rulesets/index.js` — in-memory registry +
  `getRuleset(id)`.
- `src/gm-core/library/schemas.js`, `schemas.d.ts` — KV-driven
  sheet, no implicit 5e defaults.
- `src/gm-core/sheets/operations.js` — `clearStat()` added.
- `src/gm-core/llm/errors.js` — `LlmError` extracted so test code can
  consume `loop.js` without dragging the secrets stack.
- `src/endpoints/gm.js` — `/rulesets/:id`, `/scenes/:id/participants`,
  `/sheets/:char_id/stats/:key` (DELETE), and `/turn` updated to build
  `ctx.actors` from `scene.participants` only and to dispatch
  participant writes.
- `public/scripts/gm/sidebar-left.js`, `public/scripts/gm/sidebar-right.js`.
- `public/scripts/gm/turn-events.js` — central NDJSON dispatcher,
  including `state` events, plus a small event bus for the right
  sidebar.
- `public/scripts/gm/sheet-panel.js` — KV editor.
- `public/scripts/gm/character-wizard.js` — Stats step + NPC mode.
- `public/scripts/gm/api.js` — new helpers: `addSceneParticipant`,
  `removeSceneParticipant`, `setStat`, `clearStat`, `setStatus`,
  `clearStatus`, `getSheet`, `getRuleset`.
- `public/scripts/gm/scene.js`, `public/scripts/gm/campaign-main.js`
  — mount the sidebars; campaign-main switches to a 3-column grid.
- `public/css/gm.css` — sidebar / KV editor / picker styling and the
  3-column grid.

## Schemas

`DirectorDecision` (Phase 5 dispatched subset):

```ts
type DirectorDecision =
    | { action: 'speak'; actor: 'narrator' | string; intent: string; rationale: string }
    | { action: 'spawn_character'; from_source: 'library'; ref: string; rationale: string }
    | { action: 'spawn_character'; from_source: 'new'; rationale: string }   // returns error
    | { action: 'remove_character'; character_id: string; rationale: string }
    | { action: 'end_turn'; rationale: string };
```

`TurnEvent` (Phase 5 superset):

```ts
type TurnEvent =
    | ...   // Phase 4 kinds
    | { kind: 'message'; actor: string; actor_id?: string; name: string; text: string; role: 'narrator' | 'actor' | 'system' }
    | { kind: 'state'; change: 'spawn' | 'remove'; character_id: string; character_name: string };
```

`Ruleset`:

```ts
type Ruleset = {
    id: string;
    name: string;
    starter_stats: Record<string, number | string>;
    starter_skills: string[];
};
```

## Context isolation invariants

These are properties of the system, enforced by the prompt builders:

1. Actor X's prompt sees only X's sheet. No other character's sheet.
2. Actor X's prompt does not contain RAG memories of any kind in this
   phase (RAG starts in Phase 7).
3. Director rationale is never echoed into actor prompts.
4. Narrator does not see character sheets.

`tests/gm-core/actor-prompts.test.js` asserts these explicitly: it
builds Amelia's and Jack's prompts in the same scene and checks each
prompt does not contain unique markers from the other character's
sheet.

## Acceptance criteria

- Adding an NPC to a scene from the right sidebar's picker shows them
  in the in-scene roster and they may be picked by the Director's
  `speak`.
- An actor's reply renders with the right name and (when set) avatar,
  persists to the transcript with `extra.role = 'actor'` and
  `extra.actor_id = <id>`.
- `spawn_character: library` invoked by the Director adds the chosen
  character to `scene.participants`, emits a `state: { change: 'spawn' }`
  event, and appends a system line to the transcript;
  `remove_character` does the inverse.
- `spawn_character: new` returns a structured `error` event with
  `code: 'unsupported_source'` and ends the turn.
- The Director can take multiple beats within one player turn (cap
  enforced; raised slightly to absorb `spawn_character` + `speak`
  combos).
- The isolation tests pass.
- The left sidebar always shows the PC's portrait, identity, and a
  compact stats grid whenever a campaign is loaded; "Open sheet"
  launches the KV editor.
- The wizard's Stats step pre-fills with the campaign ruleset's
  starter pack and supports add / edit / delete on arbitrary keys.

## Depends on

Phase 4.
