# Phase 8 — Scene-end pipeline

Status: Done.

## Goal

When the player ends a scene, summarize what happened, extract
per-character first-person memories, and write them into the
appropriate Qdrant collections. The next scene starts knowing what
the previous one taught the world and the characters.

## Relationship to Phase 7

Phase 7 already shipped *inline* memory accumulation: each actor
reply runs through `writers/opinion.js`, every Narrator beat through
`writers/narrator-continuity.js`, and `end_turn` writes a pacing note
via `writers/director-pacing.js`. Phase 8 layers a *batch* end-of-scene
pipeline on top of those writers — it does **not** replace them. The
two coexist and write to disjoint deterministic id namespaces:

- Phase 7 character memories: `sha256("{cid}|{character_id}|{scene_id}|{messageIndex}|{slot}|{content}")`.
- Phase 8 character memories: `sha256("{cid}|{character_id}|{scene_id}|scene-end|{slot}|{content}")`.

So a participant who already accumulated 3 inline memories during the
scene can pick up another 0–3 retrospective memories at scene-end
without collision or duplication.

## Scope

- [src/gm-core/scenes/end-pipeline.js](../../src/gm-core/scenes/end-pipeline.js)
  orchestrates:
  1. Build a transcript view (last 60 lines, tail-capped at 8000
     chars).
  2. Structured `SceneSummary` LLM call (uses
     `director_profile`).
  3. For each participant in `scene.participants` (plus the PC),
     parallel structured `MemoryExtraction` LLM call (uses
     `actor_profile`). Each call sees ONLY that character's name +
     personality + the transcript tail + the SceneSummary headline +
     prose; never another participant's sheet or memories.
  4. Write extracted memories to `character_memory__{cid}__{id}`
     via `MemoryService.write(...)` (disk JSONL mirror first, then
     Qdrant; queued for next-boot reconcile on Qdrant outage).
  5. Write `key_events` from the summary as `world_lore__{cid}`
     entries with `origin: 'generated'`,
     `source_type: 'scene_end'`, `scene_id: <scene>`,
     `entry_kind: 'history'`.
  6. Persist the `SceneSummary` JSON to
     `{handle}/campaigns/{cid}/scenes/{scene_id}.summary.json`.
  7. Patch `Scene` metadata: `status: 'closed'`, `ended_at`,
     `summary_id`, `summary_headline`, `summary_path`.
- Pure-functional in the LLM-call sense: re-running the pipeline on
  the same transcript with the same scene id produces the same
  memory writes (deterministic ids → JSONL upserts + Qdrant upserts
  are no-ops on the second pass).
- `POST /api/gm/scenes/{id}/end` body:
  `{ director_profile: LlmProfile, actor_profile: LlmProfile }`.
  Query: `?dry_run=1` runs the LLM calls but skips every persistent
  write (returns the structured outputs in the response body for
  evaluation). `?force=1` is debug-only and re-runs the pipeline
  against an already-closed scene; idempotent at the storage layer.
- Frontend: End Scene button now hands off to the pipeline. While
  the pipeline runs the topbar chip displays "Closing scene…" and
  the End Scene button is disabled. On success the page returns to
  Campaign Main and a toastr toast announces
  `Scene closed — "<headline>" · N memories extracted`. The closed
  scene's row in scene history shows its `summary_headline` under
  the scene name. A "Preview Summary" affordance is **deferred**
  to Phase 10.

## Out of scope

- Re-running scene-end on a previously closed scene from the UI
  (debug-only via `?force=1` against the API).
- Editing extracted memories (Phase 10 memory inspector).
- Scene branching / forking from a summary.
- Long-term automatic compression of older scene summaries.

## Files

Added:

- [src/gm-core/scenes/end-pipeline.js](../../src/gm-core/scenes/end-pipeline.js)
- [src/gm-core/scenes/summarize-prompts.js](../../src/gm-core/scenes/summarize-prompts.js)
- [src/gm-core/scenes/extract-prompts.js](../../src/gm-core/scenes/extract-prompts.js)
- [src/gm-core/scenes/summary-store.js](../../src/gm-core/scenes/summary-store.js)
- [tests/gm-core/scenes/end-pipeline.test.js](../../tests/gm-core/scenes/end-pipeline.test.js)
- [tests/frontend/scene-end/scene-end.e2e.js](../../tests/frontend/scene-end/scene-end.e2e.js)
  (gated on `TTRPG_E2E_SCENE_END=1`).

Modified:

- [src/gm-core/scenes/schemas.js](../../src/gm-core/scenes/schemas.js)
  and [`schemas.d.ts`](../../src/gm-core/scenes/schemas.d.ts) —
  `Scene` gains `summary_id`, `summary_headline`, `summary_path`;
  new `SceneSummary` typedef + `buildSceneSummary` builder.
- [src/gm-core/scenes/store.js](../../src/gm-core/scenes/store.js) —
  `endScene(directories, campaignId, sceneId, summaryPatch?)` now
  applies the summary metadata before flipping status.
- [src/gm-core/rag/writers/ids.js](../../src/gm-core/rag/writers/ids.js)
  — adds `deriveSceneEndCharacterMemoryId` and
  `deriveSceneEndKeyEventId` (disjoint namespaces from Phase 7).
- [src/endpoints/gm.js](../../src/endpoints/gm.js) — extends
  `POST /scenes/:id/end` with the pipeline driver,
  `director_profile`/`actor_profile` validation, `?dry_run=1` and
  `?force=1` query flags, and a 502 on summary-stage failure.
- [public/scripts/gm/api.js](../../public/scripts/gm/api.js) —
  `endScene(sceneId, { director_profile, actor_profile, dry_run })`
  returns the full pipeline payload.
- [public/scripts/gm/scene.js](../../public/scripts/gm/scene.js) —
  `onEndScene` shows the "Closing scene…" chip, disables the End
  Scene button, awaits the pipeline, fires a toastr toast with the
  headline + memory count, then routes back to Campaign Main.
- [public/scripts/gm/campaign-main.js](../../public/scripts/gm/campaign-main.js)
  — `renderSceneRow` renders `.gm-scene-row-headline` under the name
  when `scene.summary_headline` is non-empty.
- [public/css/gm.css](../../public/css/gm.css) — `.gm-scene-row-text`
  vertical wrap container + `.gm-scene-row-headline` italic muted
  ellipsis style.

## Schemas

`SceneSummary` (LLM-structured output, persisted as JSON beside the
scene transcript):

```ts
type SceneSummary = {
    scene_id: string;
    campaign_id: string;
    headline: string;                 // one-sentence headline
    summary: string;                  // 3–6 sentence prose summary
    key_events: KeyEvent[];           // each becomes a world_lore record
    location_changes: string[];
    participant_changes: string[];    // who joined / left mid-scene
    generated_at: string;
};

type KeyEvent = {
    text: string;                     // narrative description
    tags: string[];
    importance: number;               // 0..1
};
```

`MemoryExtraction` (per participant, batch retrospective):

```ts
type MemoryExtraction = {
    is_significant: boolean;          // false → no memorable beats; memories ignored
    memories: ExtractedMemory[];      // capped at 3 by schema
};

type ExtractedMemory = {
    content: string;                  // first-person from this character's POV
    tags: string[];                   // 2–4 lowercase keywords
    importance: number;               // 0..1
    valence: number;                  // -1..1
};
```

`Scene` extension (Phase 8):

```ts
type Scene = {
    /* …phase-3 fields… */
    summary_id?: string | null;       // 'summary:{cid}:{scene_id}'
    summary_headline?: string | null; // cached for the history row
    summary_path?: string | null;     // path to .summary.json relative to handle root
};
```

Deterministic vector ids:

- Per-character end-of-scene memory:
  `sha256("{cid}|{character_id}|{scene_id}|scene-end|{slot}|{content}").slice(0, 16)`.
- Key event world fact:
  `sha256("{cid}|{scene_id}|key-event|{idx}|{content}").slice(0, 16)`.

## HTTP route

`POST /api/gm/scenes/:id/end?dry_run=0|1&force=0|1`

Body:

```json
{ "director_profile": LlmProfile, "actor_profile": LlmProfile }
```

Response (200):

```json
{
  "scene": Scene,
  "summary": SceneSummary,
  "memories_extracted": { "<character_id>": <count>, "...": ... },
  "key_events_written": <count>,
  "warnings": [{ "stage": "extraction", "character_id": "...", "error": "..." }],
  "dry_run": false
}
```

Errors:

- `400` — missing `director_profile`/`actor_profile` or invalid LLM profile.
- `404` — scene or campaign not found.
- `409` — scene already closed and `?force=1` not provided.
- `502` — `SceneSummary` LLM call failed; scene stays `active`,
  no writes performed.
- `503` — Memory service unavailable (boot reconcile in progress
  or Qdrant unreachable + embedder unresolved). Pipeline did not run.

## Failure behaviour

- Summary call failure → 502 with `stage: 'summary'`. No
  `character_memory`, `world_lore`, summary file, or scene patch
  writes happen. Scene stays `active`.
- Per-participant extraction failure → that participant contributes
  zero memories; the failure is captured in `result.warnings`. The
  rest of the pipeline (other participants, key events, summary
  file, scene close) continues. Scene flips to `closed`.
- Individual `MemoryService.write(...)` failures → logged in
  `result.warnings`; the disk JSONL mirror still has the line, so
  next-boot reconcile retries the Qdrant upsert.

## Acceptance criteria

- Pressing End Scene in an active scene triggers the pipeline; the
  scene metadata flips to `closed` with the new summary fields
  populated; the transcript file is left intact (no pipeline writes
  touch `{scene_id}.jsonl`). ✅
- Memories appear in the right Qdrant collections with deterministic
  ids; a second invocation of `POST /scenes/{id}/end?force=1` is
  idempotent (sizes stable, contents identical). ✅ (covered in
  `tests/gm-core/scenes/end-pipeline.test.js`).
- Returning to a campaign after closing a scene shows the scene in
  the history with the headline visible (`.gm-scene-row-headline`
  rendered when `Scene.summary_headline` is non-empty). ✅
- Per-participant prompt isolation: character A's MemoryExtraction
  prompt does not contain character B's name or personality. ✅
  (asserted as a unit test).
- `?dry_run=1` returns the structured outputs without writing to
  disk or Qdrant or flipping status. ✅ (asserted as a unit test).
- Adjudicator prompts still don't import `MemoryService` (Phase 7
  invariant; Phase 8 does not touch `skillcheck/`). ✅

## Depends on

Phases 4 (Director + Narrator for the LLM calls), 5 (per-participant
extraction needs the participant list), 7 (Qdrant collections + RAG
service + disk-mirror writes + deterministic id helpers).
