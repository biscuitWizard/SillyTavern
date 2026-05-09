# Phase 8 — Scene-end pipeline

Status: Pending.

## Goal

When the player ends a scene, summarize what happened, extract
per-character first-person memories, and write them into the
appropriate Qdrant collections. The next scene starts knowing what
the previous one taught the world and the characters.

## Scope

- `src/gm-core/scenes/end-pipeline.js` — orchestrates:
  1. Build a transcript view (last N messages, default 60 lines —
     not the entire scene window).
  2. Structured `SceneSummary` LLM call.
  3. For each participant, structured `MemoryExtraction` LLM call
     using only the participant's view of the scene.
  4. Write extracted memories to `character_memory__{id}`.
  5. Write `key_events` from the summary as `world_fact__{cid}`
     entries.
  6. Update `Scene` metadata: `status: 'closed'`, `ended_at`, link to
     the resulting `SceneSummary`.
- Pure-functional in the LLM-call sense: re-running the pipeline on
  the same transcript with the same scene id produces the same
  memory writes (deterministic ids).
- `POST /api/gm/scenes/{id}/end` triggers the pipeline; supports
  `?dry_run=1` that runs the LLM calls but skips writes (for
  evaluation).
- Frontend: End Scene button now hands off to the pipeline with a
  spinner; on completion, returns to Campaign Main with a "Scene
  closed — N memories extracted" toast. A "Preview Summary" affordance
  is **deferred** to Phase 10.

## Out of scope

- Re-running scene-end on a previously closed scene from the UI
  (debug-only via API for now).
- Editing extracted memories (Phase 10 memory inspector).
- Scene branching / forking from a summary.
- Long-term automatic compression of older scene summaries.

## Files

Planned:

- `src/gm-core/scenes/end-pipeline.js`
- `src/gm-core/scenes/summarize-prompts.js`
- `src/gm-core/scenes/extract-prompts.js`
- `src/gm-core/scenes/schemas.js`, `schemas.d.ts`
- `src/endpoints/gm.js` — `POST /scenes/{id}/end` extended to run the
  pipeline (or take a `?dry_run=1` flag).
- `public/scripts/gm/scene.js` — wire End Scene button to the new
  flow; return to Campaign Main on completion.

## Schemas

`SceneSummary` (LLM-structured output):

```ts
type SceneSummary = {
    headline: string;                 // one-sentence headline
    summary: string;                  // 3–6 sentence prose summary
    key_events: KeyEvent[];           // each becomes a world_fact
    location_changes: string[];
    participant_changes: string[];    // who joined / left
};

type KeyEvent = {
    text: string;                     // narrative description
    tags: string[];
    importance: number;               // 0..1
};
```

`MemoryExtraction` (per participant):

```ts
type MemoryExtraction = {
    character_id: string;
    memories: ExtractedMemory[];      // each becomes a character_memory
};

type ExtractedMemory = {
    text: string;                     // first-person from this character's POV
    tags: string[];
    importance: number;               // 0..1
    valence: number;                  // -1..1
};
```

Deterministic vector ids:

- Per-character memory: `scene-{scene_id}-{character_id}-{idx}`
- Key event: `scene-event-{scene_id}-{idx}`

## Acceptance criteria

- Pressing End Scene in an active scene triggers the pipeline; the
  scene metadata flips to `closed`; the transcript file is left
  intact.
- Memories appear in the right Qdrant collections with deterministic
  ids; a second invocation of the same `POST /scenes/{id}/end` is
  idempotent.
- Returning to a campaign after closing a scene shows the scene in
  the history with the headline visible.
- Starting a *new* scene in the same campaign and prompting an actor
  who participated in the closed scene retrieves the relevant memory
  in the actor's prompt (verified by an integration test using the
  deterministic embedder).

## Depends on

Phases 4 (Director + Narrator for the LLM calls), 5 (per-participant
extraction needs the participant list), 7 (Qdrant collections + RAG
service).
