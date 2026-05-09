# Phase 7 — RAG (Qdrant)

Status: Pending.

## Goal

Wire long-term memory. Every actor call gets the right slice of memory
spliced into its prompt; nothing else. Memories live in Qdrant, never
in the transcript. Per-call scoping is strict and enforced by the
service layer, not by polite convention.

## Scope

- `src/gm-core/rag/qdrant.js` — thin wrapper around
  `@qdrant/js-client-rest`. Collection naming preserved from legacy:
  `character_memory__{character_id}` and `world_fact__{campaign_id}`.
  Auto-create collections on first write.
- `src/gm-core/rag/embedders.js` — pluggable embedder. Default reuses
  ST's existing vector backends (`src/vectors/*`) so we get OpenAI,
  llama.cpp, Ollama, and friends for free. A `DeterministicEmbedder`
  ships for tests.
- `src/gm-core/rag/service.js` — `MemoryService` with
  `for_character(character_id, query, top_k=4)` and
  `for_world(campaign_id, query, top_k=3)`. Both take a query string
  and return ranked snippets. **No method allows cross-scope
  search.**
- `src/gm-core/rag/injection.js` — formats a list of snippets into a
  prompt block (`--- BEGIN MEMORIES ---` / `--- END MEMORIES ---`).
  Actor and Narrator prompt builders call this before final assembly.
- Director prompt builder explicitly does not call the RAG service.
  That is asserted in tests.
- Ingestion paths (campaign load):
  - World facts: each lore record is embedded into
    `world_fact__{campaign_id}`.
  - Character memories: any `starting_memories` on a character at load
    time are embedded into `character_memory__{character_id}`.
- HTTP routes for inspection / admin:
  - `POST /api/gm/rag/memories` — write a character memory.
  - `POST /api/gm/rag/world-facts` — write a world fact.
  - `POST /api/gm/rag/search` — debug-only search with explicit
    scope; the `/turn` path never uses this — it calls
    `MemoryService` directly in-process.
  - `DELETE /api/gm/rag/memories/{id}`.

## Out of scope

- Scene-end summarization → memory extraction (Phase 8).
- Memory inspector UI (Phase 10).
- Tag-based recency / decay tweaks (the legacy project supported
  exponential decay; same here, default off).
- Multi-tenant Qdrant (we assume one Qdrant instance per fork
  install).

## Files

Planned:

- `src/gm-core/rag/qdrant.js`
- `src/gm-core/rag/embedders.js`
- `src/gm-core/rag/service.js`, `service.d.ts`
- `src/gm-core/rag/injection.js`
- `src/gm-core/rag/schemas.d.ts`
- `src/gm-core/rag/routes.js`
- `src/gm-core/campaigns/ingest.js` — extended to write lore + starting
  memories into Qdrant on campaign load.
- `src/gm-core/narrator/prompts.js` — pull `for_world(...)` snippets.
- `src/gm-core/actors/prompts.js` — pull `for_character(...) +
  for_world(...)` snippets.

## Schemas

`MemoryRecord`:

```ts
type MemoryRecord = {
    id: string;                       // deterministic ULID/hash
    kind: 'character_memory' | 'world_fact';
    scope_id: string;                 // character_id or campaign_id
    content: string;                  // the embedded text
    tags: string[];
    importance: number | null;        // 0..1 optional weight
    valence: number | null;           // -1..1 optional
    source: string | null;            // e.g. 'scene-end:{scene_id}', 'campaign-seed', 'manual'
    created_at: string;
    metadata: Record<string, unknown>;
};
```

Per-call scoping rules (enforced in `service.js`, not convention):

| Caller       | `for_character`           | `for_world`              | RAG?     |
|--------------|---------------------------|--------------------------|----------|
| Director     | n/a                       | n/a                      | **never** |
| Narrator     | n/a                       | yes (top 3)              | yes      |
| Actor X      | yes for X (top 4)         | yes (top 3)              | yes      |
| Post-roll Narrator | n/a                 | yes (top 3)              | yes      |
| Skill-check adjudicator (Phase 6) | n/a       | n/a                      | **never** |

## Acceptance criteria

- `docker compose up qdrant` is enough to run the system; if Qdrant is
  unreachable, the GM core logs a warning and continues with empty
  retrieval (no scenes break).
- Loading a campaign with `lore` and per-character `starting_memories`
  writes the corresponding collections in Qdrant.
- An actor X in a scene receives only X's memories + world facts in
  its prompt (verified by string assertions in unit tests against
  built prompt strings).
- The Director prompt contains no memory snippets.
- RAG snippets never appear in the transcript JSONL.
- Search snippets respect the configured top-k; tagging works on
  writes; recency decay is optional and off by default.

## Depends on

Phases 4, 5, 6 (so we have actors, narrator, and adjudicator ready to
consume). Operational dependency: Qdrant container running.
