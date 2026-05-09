# ADR 0003: JSON files for game state, Qdrant for vector data only

Status: Accepted
Date: 2026-05-09

## Context

`srstavern` stored canonical game state (campaigns, characters, sheets, lore,
scene metadata) in Postgres and vector data in Qdrant. That gave us proper
relational integrity and SQL queries, at the cost of a Postgres dependency
and two storage systems to back up.

SillyTavern itself uses per-user file storage: JSON files for settings,
character cards, presets, world info, and JSONL for chat transcripts. This is
adequate for a single-user TTRPG app, fits the spirit of "directly modify
SillyTavern", and removes one running service.

Vector data is a different story. We need cosine search over thousands of
embeddings for character memories and world facts. JSON files cannot do that
efficiently. Qdrant is the lightest option that solves it well, and the
prior `srstavern` work already validated the schema, so we keep it.

## Decision

**Game state (canonical, structured)**: JSON files under the per-user data
directory, following SillyTavern's existing pattern. New top-level entries
in `src/constants.js` `USER_DIRECTORY_TEMPLATE`:

```
{handle}/
  campaigns/
    {campaign_id}/
      campaign.json              # name, ruleset_id, addendum, current_scene_id, ...
      characters/{char_id}.json  # full Character incl. nested sheet
      lore/{lore_id}.json
      scenes/{scene_id}.json     # metadata: name, status, participants, ...
      scenes/{scene_id}.jsonl    # transcript (ST message format, reused)
  rulesets/{ruleset_id}/{skills,dc_guidance,consequences}.yaml
  gm/
    settings.json                # active campaign, role-to-model mapping, ...
```

Bundled rulesets ship in the repo at `data/rulesets/{ruleset_id}/`; user
overrides live alongside in `{handle}/rulesets/`.

Writes go through `write-file-atomic` (already a dep) for crash safety.
Reads are cached per-process and invalidated on write. There is no schema
migration framework yet — we will add one when we ship something we can
break.

**Vector data**: Qdrant is the only vector store. Collections:

- `character_memory__{character_id}` — first-person character memories
- `world_fact__{campaign_id}` — campaign-scoped world facts

Naming preserves the `srstavern` convention so ported prompts and ingestion
code work unmodified.

The Qdrant client is `@qdrant/js-client-rest`. Embeddings use SillyTavern's
existing vector backends (`src/vectors/`), which already support OpenAI-
compatible, llama.cpp, Ollama, and others. The GM core wraps that as a
single `Embedder` interface.

## Consequences

- One database service to run alongside the Node app, instead of two.
- Game state is human-readable, easily diffed, and trivially backed up by
  copying the user directory.
- No SQL means we cannot do server-side joins. We compensate with
  in-memory aggregation; volumes will not be high enough for this to matter.
- Concurrent edits to the same campaign from two browser tabs are
  best-effort. For a single-user TTRPG that is acceptable; we will document
  the constraint.
- If we later need stronger consistency or query capability, we can swap
  the JSON layer for SQLite without touching prompts, RAG, or schemas.
