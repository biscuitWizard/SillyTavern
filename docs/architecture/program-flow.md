# Program flow: a player turn

This is the canonical event sequence for a single player turn inside an
active scene. Phase numbers refer to the roadmap in
[README.md](README.md#phasing); the full flow is realized incrementally.

## Entry point

The frontend Scene view owns the input bar. When the player submits text:

1. Append the player's message to the local transcript and to the on-disk
   JSONL via `addOneMessage()` and the GM core's transcript writer.
2. Pre-empt SillyTavern's `Generate()` so it does not run the standard
   chat-completion pipeline. The exact mechanism is the GM-mode-aware
   short-circuit at the start of `Generate()` (see
   [ADR 0004](../adr/0004-cannibalize-st-chat-substrate.md)).
3. POST to `/api/gm/turn` with `{ campaign_id, scene_id, user_input }`.
   The response is `application/x-ndjson`: one `TurnEvent` per line.
4. Stream-parse each line and render it.

## Server-side: the Director loop

`src/gm-core/director/loop.js` runs a bounded loop (default cap: 8 steps).
Each iteration:

```mermaid
flowchart TD
  Start([Step start]) --> StatusEvt[emit status: directing]
  StatusEvt --> Decide[Director: structured(DirectorDecision)]
  Decide -->|action: speak narrator| CallNarrator
  Decide -->|action: speak character X| CallActor
  Decide -->|action: skill_check| Adjudicate
  Decide -->|action: spawn_character| StateMutation
  Decide -->|action: remove_character| StateMutation
  Decide -->|action: add_lore| StateMutation
  Decide -->|action: propose_scene| StateMutation
  Decide -->|action: end_turn| Done([loop end])

  CallNarrator --> EmitMessage[emit message: narrator] --> NextStep([next step])
  CallActor --> EmitMessage2[emit message: actor X] --> NextStep
  Adjudicate --> SkillDecide[skillcheck.decide structured] --> Roll[skillcheck.roll]
  Roll --> EmitRoll[emit roll: card] --> ForceNarrator[Narrator: post_roll prose]
  ForceNarrator --> EmitMessage3[emit message: narrator] --> NextStep
  StateMutation --> EmitState[emit state-change event] --> NextStep
  NextStep --> Start
```

## TurnEvent kinds

The NDJSON stream emits one `TurnEvent` per line. Kinds (subject to
schema in `src/gm-core/director/schemas.d.ts` once implemented):

- `status` — Director phase change (`directing`, `awaiting_actor`,
  `rolling`, `narrating_consequence`, `closing`).
- `message` — a finished message from Narrator or an actor. Carries
  `{ actor, text, post_roll? }`.
- `roll` — a transparent skill-check card with `{ actor, skill, dc,
  ability, modifier, d20, total, outcome, severity }`.
- `state` — game-state mutation (`spawn_character`, `remove_character`,
  `add_lore`, `propose_scene`).
- `error` — recoverable error (e.g. provider failure, retry exhausted).
- `end_of_turn` — sentinel; loop is done. Frontend stops reading.

The frontend renders each kind via a dedicated path that reuses
`addOneMessage()` for prose and a custom template for `roll` and `state`.

## Per-actor prompts

Every Narrator and actor call is built from authoritative state. The
Director prompt and prior actor outputs are not chained; each call gets a
fresh user prompt. This is enforced in the prompt builders:

- `src/gm-core/director/prompts.js` (system + user for the Director)
- `src/gm-core/narrator/prompts.js` (system + user for the World Narrator)
- `src/gm-core/actors/prompts.js` (system + user for any character actor)

Inputs each prompt is allowed to see, and not see, are listed in
[../adr/0004-cannibalize-st-chat-substrate.md](../adr/0004-cannibalize-st-chat-substrate.md)
and the to-be-ported `context-and-prompts.md`.

## Skill check resolution

Two LLM calls plus a deterministic roll, when the Director picks
`skill_check`:

1. **Adjudicator** — `skillcheck.decide()` with a structured
   `SkillCheckDecision` schema. Output: `{ required, skill, dc, ability,
   failure_severity, justification }`. We clamp DC against the active
   ruleset and override `ability` from the ruleset when the LLM disagrees.
2. **Roll** — `skillcheck.roll()` is pure. d20 + ability modifier from
   the actor's sheet + proficiency bonus when the actor is proficient.
   Returns `RollOutcome { d20, modifier, total, success, margin }`.
3. **Narration** — the Narrator is invoked with `post_roll` metadata so
   the prompt builder can frame the prose as a consequence of the roll.

A real roll always forces the Narrator next. A "no check needed" decision
emits a status event and lets the Director pick again.

## Scene end

The player triggers scene end from the Scene view (button, not a slash
command). The frontend POSTs the trimmed transcript to
`/api/gm/scenes/{id}/end`. Server-side `src/gm-core/scenes/end-pipeline.js`
runs:

1. Structured `SceneSummary` LLM call.
2. Per-participant `MemoryExtraction` LLM call.
3. Write extracted memories to `character_memory__{id}` collections.
4. Write key events to `world_fact__{campaign_id}`.
5. Mark scene `closed` in JSON state. Frontend returns to Campaign Main.

The pipeline is pure-functional in the LLM-call sense: idempotent if you
run it again on the same transcript with the same scene ID.

## What does not happen

- The Director never gets RAG snippets.
- The Narrator never sees character memories.
- Actor X never sees actor Y's sheet or memories.
- RAG snippets are never persisted to the transcript.
- ST's group-chat scheduler is never used; there are no groups for
  scenes.
- ST's character-list welcome flow does not run when GM mode is active.

These are properties of the system, not coincidences of any one
implementation file.
