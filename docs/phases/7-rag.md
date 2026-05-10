# Phase 7 — RAG (Qdrant) + Memory Explorer

Status: In progress.

## Goal

Wire long-term memory across five Qdrant collections, with strict per-call
scoping enforced in code (not by convention), a Memory Explorer tab in
the GM shell, and disk-canonical persistence so the Qdrant volume can be
wiped without losing data. Every actor / narrator / director call gets
the right slice spliced into its prompt; nothing else. Snippets never
land in the transcript JSONL.

This phase expands the original short doc with a unified world-lore
collection, payload-facet search, a relaxed Director/Narrator RAG policy
(see DESIGN.md memory matrix update), in-scene memory writers, lore
ingestion paths, and a disaster-recovery story. The expanded design
lives in [.cursor/plans/phase-7-rag\*.plan.md](../../.cursor/plans/).

## Scope

### Five collections, one base record

All memory records share the `MemoryRecord` shape (id, kind, scope_id,
content, tags, importance, valence, temporally_blind, decay_override,
source, created_at, updated_at, metadata). The `kind` enum drives
collection naming:

- `world_lore__{cid}` — unified world facts. Both seed lore and
  runtime-generated facts live here, with `origin: 'core' | 'generated'`
  in the payload plus `source_type`, `scene_id`, `entry_kind`, `tags`.
- `character_memory__{cid}__{character_id}` — per-character first-person
  memories. Physical-collection-per-character makes the leak invariant
  ("Actor X never sees Y's memories") a storage-layer guarantee. The
  `{cid}` prefix prevents cross-campaign collision: character ids are
  only unique within a campaign.
- `director_memory__{cid}` — Director's pacing log (one entry per
  `end_turn`). Aggressive decay default.
- `narrator_memory__{cid}` — Narrator continuity notes (locations
  named, recurring imagery, NPCs described). Mild decay.
- `player_journal__{cid}` — out-of-fiction player notes. No decay.
  Read-only for actors; the player writes through the explorer.

### Retrieval policy (revises DESIGN.md memory matrix)

| Caller | character_memory | world_lore | director_memory | narrator_memory | player_journal |
|---|---|---|---|---|---|
| Director | never | top-6 | own, top-2 | never | top-1 |
| Narrator | never | top-6 | never | own, top-2 | top-1 |
| Actor X | own, top-4 | top-5 | never | never | top-1 (read) |
| Skill-check adjudicator | **never** | **never** | **never** | **never** | **never** |
| Post-roll Narrator | never | top-6 | never | own, top-2 | top-1 |

Every retrieval is scope-explicit. The adjudicator is the lone hold-out:
its prompt builder will not even import `MemoryService`, asserted in a
unit test.

### `search_memory` tool

A bounded tool that the Director, Narrator, and actors can call mid-step
to widen retrieval. Exposed through SillyTavern's `ToolManager` and
through the in-process structured-output strict-mode shim. Each role's
tool gate is enforced server-side:

- Director / Narrator can target `world_lore` (with payload filters) and
  their own role memory; never `character_memory`.
- Actor X can target `world_lore`, `character_memory__{cid}__{X}` (own),
  and `player_journal`; never another character's memory.
- The adjudicator does not see the tool definition.

Bounded to 3 tool hops per Director step.

### Decay model

Ported from [VectHare's `core/temporal-decay.js`](https://github.com/Coneja-Chibi/VectHare/blob/main/core/temporal-decay.js).
Per-collection defaults plus per-record overrides:

- Decay (older = lower) and Nostalgia (older = higher), exponential or
  linear modes, configurable half-life and floor.
- `temporally_blind: true` opts a record out entirely.
- For `world_lore`, decay is driven by the `origin` tag: `origin: 'core'`
  records default to `temporally_blind: true`; `origin: 'generated'`
  records default to long half-life decay. Promotion is a `PATCH` of
  both fields in one call.
- Age unit is `scenes_elapsed` (campaign-relative), not wall-clock.
  Wall-clock is also stored for the explorer.
- Implemented entirely in `MemoryService.search()` after Qdrant returns
  raw cosine — Qdrant payload filters do the cheap work, JS does the
  multiplier.

### Persistence model — disk canonical, Qdrant derived

Qdrant volumes are easy to lose. Disk JSON/JSONL/YAML is canonical;
Qdrant is a derived index that we rebuild from disk on boot.

Disk layout:

```
{handle}/campaigns/{cid}/
  campaign.json
  characters/{char_id}.json
  characters/{char_id}.memories.jsonl     # NEW: append-only character memory mirror
  scenes/{scene_id}.json
  scenes/{scene_id}.jsonl
  lore/core/*.yaml                        # NEW: authored seed lore (canonical for origin:'core')
  lore/generated.jsonl                    # NEW: append-only mirror of origin:'generated' writes
  director/memory.jsonl                   # NEW: append-only mirror of director_memory writes
  narrator/memory.jsonl                   # NEW: append-only mirror of narrator_memory writes
  player/journal.jsonl                    # NEW: append-only mirror of player_journal writes
  rag/.ingest-state.json                  # NEW: { file_path → content_hash } for idempotent re-ingest
  rag/.pending-deletes.json               # NEW: queued Qdrant collection drops (replayed on boot)
  rag/.pending-upserts.json               # NEW: queued Qdrant upserts (replayed on boot)
```

Write path (every memory):
1. Validate; assign deterministic id.
2. Append to disk JSONL with `write-file-atomic`.
3. Upsert to Qdrant. On failure, queue id in `rag/.pending-upserts.json`.
4. Emit a `kind: 'memory_write'` `TurnEvent` for the explorer's live-feed.

Boot reconcile (on every campaign load):
1. Walk `lore/core/*.yaml`; hash each. Upsert changed/new; delete
   records whose source file vanished.
2. Walk all `*.jsonl` mirrors; for each line, upsert if Qdrant lacks
   the id (this is the WAL replay).
3. Drain `rag/.pending-deletes.json` and `rag/.pending-upserts.json`.
4. If Qdrant is unreachable, log a warning and continue with empty
   retrieval. Reconcile retries on next load or via
   `POST /api/gm/rag/reconcile`.

Cascade deletes:
- Campaign delete: enumerate `*__{cid}` and `*__{cid}__*` collections,
  drop each, then `removeDir(campaignDir)`. On any Qdrant failure,
  queue remaining drops to a parent-dir-level pending-deletes file
  before removing the campaign dir.
- Character delete: drop `character_memory__{cid}__{char_id}`, remove
  disk JSON + mirror JSONL.

### Lore ingestion

- Bundled seed packs at `data/lore-packs/{slug}/setting.yaml`. One
  ships with Phase 7 (`eldoria`, ported from
  `data/default-user/worlds/Eldoria.json`).
- Wizard "Seed lore" step: pick a bundled pack, paste YAML, or
  "auto-extract from brief".
- Auto-extractor: ported concept from
  [`../srstavern/sidecar/srstavern/lore_extractor/`](../../../srstavern/sidecar/srstavern/lore_extractor/).
  One structured LLM call against `Campaign.brief + addendum` produces
  a starter `lore/core/` set. Subagent-runnable for prompt tuning.

### In-scene memory writers (NEW in Phase 7)

All four route through `mirror.js` so a Qdrant outage cannot lose a write.

- `writers/opinion.js` — after each actor reply, a small structured
  call asks "did this actor commit anything to memory?" and writes
  0–2 first-person memories with importance/valence to
  `character_memory__{cid}__{actor_id}`.
- `writers/narrator-continuity.js` — after each Narrator beat,
  extracts {locations_named, characters_described, imagery_motifs}
  and writes to `narrator_memory__{cid}`.
- `writers/director-pacing.js` — at `end_turn`, writes a one-line
  directorial recap to `director_memory__{cid}`. Reuses the
  `end_turn` step's structured output by extending the schema with an
  optional `pacing_note: string`.
- `writers/lore-add.js` — Director's `add_lore` action writes to
  `world_lore__{cid}` with `origin: 'generated'`,
  `source_type: 'add_lore'`, scene-attributed.

### Memory Explorer UI

New `memory` view in the GM router; new "Memory" tab in the campaign
and scene topbars (hidden in Campaign Manager).

Five tabs: World Lore | Player Journal | Characters | Director Log |
Narrator Log. World Lore has a chip row (Origin: All/Core/Generated,
Kind, Scene source, Tags) that maps to Qdrant payload filters.
Characters tab takes a character-id sub-selector (one collection per
character, the dropdown makes the leak invariant visible).

Live-feed pane listens to `/api/gm/turn` for `kind: 'memory_write'`
events. Prompt-debug pane shows the last MEMORIES block built for
each character (in-memory ring buffer).

## Out of scope

- Phase 8 scene-end pipeline (formal `SceneSummary` +
  `MemoryExtraction`) — Phase 7 adds *inline* memory accumulation;
  Phase 8 adds the *batch* end-of-scene pipeline.
- Multi-tenant Qdrant.
- Hybrid BM25 + vector retrieval (Phase 10 if quality demands it).
- Conditional activation rules (emotion / keyword) — Phase 10.
- AI character generation, lore editor, ruleset picker — Phase 10.

## Files

### New backend modules — `src/gm-core/rag/`

- `qdrant.js` — `@qdrant/js-client-rest` wrapper; lazy-init;
  auto-create on first write; payload-filter helpers; `health()`.
- `embedders.js` — `Embedder` interface; `StVectorEmbedder` (reuses
  `src/vectors/*.js`); `DeterministicEmbedder` for tests;
  `OllamaEmbedder` direct path.
- `service.js`, `service.d.ts` — `MemoryService` with explicit-scope
  methods; enforces leak invariant in code.
- `mirror.js` — disk-first write wrapper.
- `reconcile.js` — boot/admin reconcile.
- `decay.js` — VectHare-ported decay + nostalgia.
- `injection.js` — formats snippets between
  `--- BEGIN MEMORIES ({kind}) ---` / `--- END MEMORIES ---` blocks.
- `tool.js` — `search_memory` tool definition + handler.
- `schemas.d.ts`, `schemas.js` — `MemoryRecord`, `MemoryKind`,
  `WorldLorePayload`, `RetrievalQuery`, `RetrievalHit`, `DecayConfig`.
- `routes.js` — `/api/gm/rag/*` routes.
- `writers/{opinion,narrator-continuity,director-pacing,lore-add}.js`.

### New backend modules — `src/gm-core/lore/`

- `schemas.d.ts` — `LoreEntry`.
- `store.js` — disk layer.
- `ingest.js` — campaign-load hash-and-upsert.
- `seed-packs.js` — bundled pack loader.
- `extractor.js` — LLM-driven brief-to-lore.

### Modified

- [src/gm-core/director/prompts.js](../../src/gm-core/director/prompts.js)
  — MEMORIES block; tool schema declaration.
- [src/gm-core/director/loop.js](../../src/gm-core/director/loop.js) —
  tool-using loop wrapping `directorClient.structured(...)`; pacing
  note on `end_turn`.
- [src/gm-core/narrator/prompts.js](../../src/gm-core/narrator/prompts.js)
  — MEMORIES block; tool wiring.
- [src/gm-core/actors/prompts.js](../../src/gm-core/actors/prompts.js)
  — MEMORIES block (own + world + journal slice); tool wiring.
- [src/gm-core/skillcheck/prompts.js](../../src/gm-core/skillcheck/prompts.js)
  — explicitly does NOT import `MemoryService`; asserted in test.
- [src/gm-core/library/store.js](../../src/gm-core/library/store.js) —
  cache key widened to `(handle, cid, char_id)`.
- [src/endpoints/gm.js](../../src/endpoints/gm.js) — mounts
  `/api/gm/rag/*`; `DELETE /campaigns/:id` and
  `DELETE /characters/:char_id` cascade Qdrant drops; turn loop
  invokes the writers.
- [public/scripts/gm/router.js](../../public/scripts/gm/router.js) —
  `'memory'` view.
- [public/scripts/gm/campaign-main.js](../../public/scripts/gm/campaign-main.js)
  and [public/scripts/gm/scene.js](../../public/scripts/gm/scene.js) —
  Memory topbar tab.
- [docker-compose.yml](../../docker-compose.yml) — `qdrant-snapshots`
  named volume; document `TTRPG_QDRANT_URL`.
- [config.yaml](../../config.yaml) — `rag:` block.

### New frontend modules — `public/scripts/gm/memory-explorer/`

`index.js`, `tabs.js`, `record-list.js`, `record-editor.js`,
`live-feed.js`, `prompt-debug.js`.

## Schemas

### `MemoryRecord` (base)

```ts
type MemoryKind =
  | 'world_lore'
  | 'character_memory'
  | 'director_memory'
  | 'narrator_memory'
  | 'player_journal';

type MemoryRecord = {
  id: string;                       // deterministic sha256 slice
  kind: MemoryKind;
  scope_id: string;                 // campaign_id (or "{cid}/{character_id}" for character_memory)
  content: string;
  tags: string[];
  importance: number;               // 0..1
  valence: number;                  // -1..1
  temporally_blind: boolean;
  decay_override: { mode: 'exponential' | 'linear', half_life: number, floor: number } | null;
  source: string;                   // e.g. 'seed_pack:eldoria', 'add_lore:scene-3:step-2', 'opinion-extractor:scene-3:msg-7'
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};
```

### `WorldLorePayload` (additional fields on world_lore records)

```ts
type WorldLoreOrigin = 'core' | 'generated';
type WorldLoreSourceType = 'seed_pack' | 'auto_extracted' | 'wizard_paste'
                          | 'add_lore' | 'scene_end' | 'manual';
type WorldLoreEntryKind = 'location' | 'faction' | 'culture' | 'people'
                        | 'history' | 'magic' | 'artifact' | 'bestiary'
                        | 'cosmology' | 'language' | 'pantheon' | 'custom';

type WorldLorePayload = {
  origin: WorldLoreOrigin;
  source_type: WorldLoreSourceType;
  scene_id: string | null;
  entry_kind: WorldLoreEntryKind;
  title: string;                    // short label for the explorer
};
```

### Deterministic ids

- Core lore: `sha256("{cid}|{file_relpath}|{content_hash}").slice(0, 16)`.
- Generated lore (`add_lore`): `sha256("{cid}|{scene_id}|{director_step_index}|{content_hash}").slice(0, 16)`.
- Character memory (opinion extractor): `sha256("{cid}|{character_id}|{scene_id}|{message_index}|{content_hash}").slice(0, 16)`.
- Director / narrator / player journal:
  `sha256("{cid}|{role}|{nanos}|{content_hash}").slice(0, 16)` — the
  `nanos` makes them unique-by-write but the disk JSONL line is the
  source of truth on replay so it stays deterministic.

## HTTP routes

Mounted at `/api/gm/rag/*` from [src/endpoints/gm.js](../../src/endpoints/gm.js):

- `GET /health` — Qdrant connectivity, version, collection list.
- `GET /collections` — lists all `*__{cid}` collections for the active campaign.
- `GET /collections/:kind/:scope_id?origin=core&entry_kind=faction&scene_id=...`
  — list records with payload filters (world_lore facets, etc.).
- `POST /memories` — write one memory (debug / explorer).
- `PATCH /memories/:id` — update tags / importance / temporally_blind / origin (promotion).
- `DELETE /memories/:id`.
- `POST /search` — debug-only ad-hoc search with explicit scope.
  The turn path never uses this; it calls `MemoryService` directly in-process.
- `POST /reconcile?cid=...` — admin: re-run boot reconcile.

## Acceptance criteria

- `docker compose up qdrant` is sufficient to run the system; if
  Qdrant is unreachable, the GM core logs a warning and continues with
  empty retrieval (no scenes break).
- Loading the seeded campaign writes `world_lore__shadows-of-ironhold`
  (with `origin: 'core'` payloads) and
  `character_memory__shadows-of-ironhold__{pc_id}` deterministically
  (same files → same record ids).
- Two campaigns can each have a character named `Jack` without
  collision: `character_memory__campaign_a__jack` vs
  `character_memory__campaign_b__jack`.
- Wiping `qdrant-data` and restarting fully restores the campaign from
  disk on next boot via the boot-reconcile WAL replay.
- Deleting a campaign drops all five of its collections (and its
  per-character memory collections) from Qdrant; the campaign dir on
  disk is removed only after Qdrant cascade succeeds (or queued for
  next-boot retry if Qdrant was down).
- Deleting a character drops `character_memory__{cid}__{char_id}` and
  removes the disk mirror.
- A single `for_world` retrieval returns a mixed list of core +
  generated facts ranked by score-after-decay, demonstrably preferring
  a relevant generated fact over an irrelevant core fact
  (fixture-asserted).
- Per-role retrieval matches the table above. Cross-actor leak test
  fails the build if violated.
- Adjudicator prompt has no MEMORIES block (string-asserted in test).
- Memory Explorer tab loads under 200 ms on a campaign with 1000
  records; search returns under 500 ms.
- Browser script (§4 of the plan) passes end-to-end with screenshots
  committed to `tests/frontend/memory-explorer/`.

## Depends on

Phases 4, 5, 6 (so we have actors, narrator, and adjudicator ready to
consume). Operational dependency: Qdrant container running. Frontend
depends on the Phase 1 GM shell.
