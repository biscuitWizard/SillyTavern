# Phases

The TTRPG Tavern roadmap is broken into phases. Each phase is sized to ship
something a player or developer can poke at, even if the gameplay loop is
not yet complete. Lower-numbered phases are foundations; higher-numbered
phases stack on them.

| #  | Phase                                            | Status         |
|----|--------------------------------------------------|----------------|
| 0  | [Bootstrap](0-bootstrap.md)                      | Done           |
| 1  | [Campaign-first shell](1-shell.md)               | Visual POC done |
| 2  | [Character + sheet model](2-character-sheet.md)  | Pending        |
| 3  | [Scene shell (no AI)](3-scene-shell.md)          | Pending        |
| 4  | [Director + Narrator](4-director-narrator.md)    | Done           |
| 5  | [Multi-actor](5-multi-actor.md)                  | Done           |
| 6  | [Skill checks + ruleset](6-skill-checks.md)      | Pending        |
| 7  | [RAG (Qdrant)](7-rag.md)                         | Pending        |
| 8  | [Scene-end pipeline](8-scene-end.md)             | Done           |
| 9  | [Strict-GM evals](9-evals.md)                    | Pending        |
| 10 | [Polish](10-polish.md)                           | Pending        |

## How a phase doc is structured

Each phase doc has the same sections, in this order:

1. **Goal** — one paragraph: why this phase exists, what it unlocks.
2. **Scope** — the user-visible / developer-visible deliverables.
3. **Out of scope** — explicit non-goals so we do not scope-creep.
4. **Files** — concrete paths the phase adds or modifies (with deep
   references to the relevant ADRs and architecture docs).
5. **Schemas** — any data shapes introduced or extended in this phase.
6. **Acceptance criteria** — what "done" looks like; the checks we run
   before declaring the phase shipped.
7. **Depends on** — which earlier phases must be in place.

Open questions get inline TODOs in the doc rather than a dedicated section,
so they show up where the work happens.

## Working with the phase plan

- The live status of each phase lives in the plan file under
  `.cursor/plans/`. The table above is updated when a phase ships.
- Phases that turned out larger than expected get split mid-flight; the
  next phase is renumbered or a sub-phase doc is added (e.g.
  `4a-foo.md`).
- "Visual POC" status (Phase 1 today) means the user-facing shell exists
  with mock data and no backend wiring; the full phase wires real
  endpoints and persistence.

## See also

- [../architecture/README.md](../architecture/README.md) — system map.
- [../architecture/program-flow.md](../architecture/program-flow.md) —
  per-turn flow.
- [../adr/](../adr/) — locked architectural decisions.
