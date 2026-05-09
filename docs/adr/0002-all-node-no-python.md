# ADR 0002: All-Node fork, no Python sidecar

Status: Accepted
Date: 2026-05-09

## Context

The prior `srstavern` design ran orchestration (Director loop, RAG service,
skill checks, ruleset loader, scene-end pipeline, evals) in a Python FastAPI
sidecar alongside SillyTavern. That gave us Pydantic, pytest, and ergonomic
LLM-client libraries, but it also gave us:

- A second runtime to install, package, and ship.
- An HTTP boundary at every interaction (NDJSON streaming, CORS, auth).
- Two type systems to keep in sync (Pydantic ↔ TypeScript .d.ts).
- Two deployment surfaces (compose for local dev; whatever for distribution).

For a single-user, single-process desktop-style app, that boundary is a tax,
not a feature. The user explicitly asked for a "directly modify SillyTavern"
approach.

## Decision

All orchestration code lives in the `ttrpgtavern` Node repo. New modules:

- Backend (`src/gm-core/`): Director loop, narrator/actor prompt builders,
  skill-check engine, ruleset loader, RAG service (Qdrant client), scene
  state, scene-end pipeline, LLM client wrappers.
- Backend HTTP (`src/endpoints/gm.js`): one router that exposes the GM core
  to the frontend (`POST /api/gm/turn` NDJSON, `/campaigns/*`, `/scenes/*`,
  `/characters/*`, `/sheets/*`, `/lore/*`, `/rulesets/*`, `/rag/*`).
- Frontend (`public/scripts/gm/`): Campaign Manager, Campaign Main, Scene
  view, character wizard, side panels.

Code style follows existing SillyTavern: JavaScript with JSDoc, plus `.d.ts`
files for shared schemas (Director action union, sheet, ruleset, turn events).
No TypeScript build step.

LLM I/O reuses SillyTavern's existing chat-completion gateway
(`src/endpoints/backends/chat-completions.js`) and connection profile
machinery. Structured Director output uses provider-native modes
(OpenAI `response_format: json_schema strict: true`; Anthropic forced
tool-use) wrapped behind a thin `src/gm-core/llm/client.js`.

The `srstavern` Python codebase is reference, not runtime. We port concepts,
prompts, and YAML data verbatim where useful, and reimplement orchestration
in JS.

## Consequences

- One process, one install, one set of logs. Easier ops.
- No HTTP roundtrip between UI and orchestration; we can call into
  `gm-core` directly from request handlers.
- We lose Pydantic's discriminated-union ergonomics. We compensate with
  JSDoc + `.d.ts` and runtime guards in the discriminator handlers.
- We give up easy Python LLM libraries. Reusing ST's gateway covers most
  of what we need; if we need something Python-only later, we add a
  per-feature script tool, not a permanent sidecar.
- Eval harness moves to a Node test runner.
