# TTRPG Tavern

A fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern) reshaped
into a tabletop-style TTRPG experience: a Campaign Manager is the first
screen; play happens in scenes orchestrated by an AI Director, narrated by
an AI World Narrator, and populated by AI character actors. The player
controls one player character with stats, items, statuses, and skills;
checks are rolled against an installable ruleset.

This is not a SillyTavern extension; it modifies the host directly. See
the architecture docs and ADRs for the rationale and shape.

## Status

Early development. See `.cursor/plans/` for the live phase plan.

## Quick start (development)

Requirements: Node 20+, Docker (for Qdrant).

```sh
# 1. Install Node deps (one-time, slow first time)
npm install

# 2. Start Qdrant in the background (vector database for memories)
docker compose up -d qdrant

# 3. Start TTRPG Tavern on the host
npm start
```

Then open http://localhost:8000.

To shut down Qdrant:

```sh
docker compose down
# or to also wipe its data:
docker compose down -v
```

## Architecture

- **All-Node fork.** Director, Narrator, actors, skill checks, RAG, ruleset
  loader, scene-end pipeline all run inside this repo as JS modules. No
  Python sidecar. See [ADR 0002](docs/adr/0002-all-node-no-python.md).
- **JSON files for game state.** Campaigns, characters, sheets, lore, and
  scene transcripts live as JSON / JSONL in the per-user data directory.
  Vector memories live in Qdrant. See
  [ADR 0003](docs/adr/0003-json-state-qdrant-vectors.md).
- **Cannibalized chat substrate.** Scenes are first-class objects in our
  schema, not SillyTavern group chats. The Scene view reuses ST's message
  renderer and input bar. See
  [ADR 0004](docs/adr/0004-cannibalize-st-chat-substrate.md).
- **Direct fork, not extension.** See
  [ADR 0001](docs/adr/0001-fork-not-extension.md).

For the system map and per-turn flow:

- [docs/architecture/README.md](docs/architecture/README.md)
- [docs/architecture/program-flow.md](docs/architecture/program-flow.md)

## Reference (not runtime)

A prior attempt at this idea lives at `../srstavern/` (Python sidecar +
extensions). It is reference material for prompts, schemas, ruleset YAML,
and eval scenarios. We are not running it.

## License

AGPL-3.0 (inherited from SillyTavern).
