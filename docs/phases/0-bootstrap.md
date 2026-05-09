# Phase 0 — Bootstrap

Status: **Done**.

## Goal

Lay down the project shape: lock the architectural decisions, bring up the
one external service we depend on (Qdrant), and write enough docs that
anyone joining the project can read three files and understand what we are
building.

## Scope

- ADRs for the four locked decisions (fork over extension, all-Node over
  Python sidecar, JSON state with Qdrant for vectors, cannibalize the
  ST chat substrate).
- Architecture overview README and program-flow doc.
- `docker-compose.yml` that brings up Qdrant in the default profile and
  the full Node + Qdrant stack under `--profile app`.
- Updated repo `README.md` with quick-start instructions for the fork.
- Phase docs (this directory).

## Out of scope

- Any runtime code. Phase 0 is documentation and local infra only.
- Postgres or any second database service.
- A Python sidecar of any kind.

## Files

Added:

- [docs/adr/0001-fork-not-extension.md](../adr/0001-fork-not-extension.md)
- [docs/adr/0002-all-node-no-python.md](../adr/0002-all-node-no-python.md)
- [docs/adr/0003-json-state-qdrant-vectors.md](../adr/0003-json-state-qdrant-vectors.md)
- [docs/adr/0004-cannibalize-st-chat-substrate.md](../adr/0004-cannibalize-st-chat-substrate.md)
- [docs/architecture/README.md](../architecture/README.md)
- [docs/architecture/program-flow.md](../architecture/program-flow.md)
- [docker-compose.yml](../../docker-compose.yml)
- [docs/phases/README.md](README.md) and the per-phase docs in this
  directory.

Modified:

- [README.md](../../README.md) — replaced upstream blurb with fork-specific
  quick start.

## Schemas

None this phase.

## Acceptance criteria

- `docker compose up qdrant` brings Qdrant up and the healthcheck passes.
- `docker compose --profile app up` builds and starts the Node container
  alongside Qdrant.
- The four ADRs and the architecture README all link consistently and
  describe the same system.
- A new contributor can read [README.md](../../README.md),
  [docs/architecture/README.md](../architecture/README.md), and
  [docs/architecture/program-flow.md](../architecture/program-flow.md) and
  describe the per-turn flow without asking.

## Depends on

Nothing. This is the foundation.
