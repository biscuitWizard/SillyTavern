# Phase 4 — Director + Narrator

Status: Pending.

## Goal

Make scenes interactive. Each player turn runs a Director loop on the
backend that decides what happens next (`speak: narrator` or
`end_turn` to begin with), invokes the World Narrator for prose, and
streams the results back as `TurnEvent`s. This is the first phase
where the LLM does anything in a scene.

## Scope

- `src/gm-core/director/loop.js` — the main per-turn loop. Bounded by
  a step cap (default 8). Each iteration calls the Director LLM with
  a structured-output schema and dispatches the resulting action.
- `src/gm-core/director/schemas.{js,d.ts}` — `DirectorDecision`
  discriminated union; in this phase only `speak` and `end_turn`
  variants exist.
- `src/gm-core/director/prompts.js` — Director system + user prompt
  builders. Inputs: actor list, recent transcript tail (≤ 4000
  chars), player intent, campaign addendum. **No RAG snippets in the
  Director prompt — ever.** (See ADR 0004.)
- `src/gm-core/narrator/prompts.js` — World Narrator prompt builder.
  Inputs: intent, transcript tail. RAG comes later (Phase 7).
- `src/gm-core/llm/client.js` — thin wrapper around ST's existing
  chat-completion gateway (`src/endpoints/backends/chat-completions.js`).
  Two methods: `chat({ messages, ... })` for prose, and
  `structured({ messages, schema, ... })` that picks per-provider
  structured-output mode (OpenAI `response_format: json_schema strict:
  true`; Anthropic forced tool-use; fall back to text-mode JSON with
  parse + retry).
- `POST /api/gm/turn` — NDJSON streaming endpoint. Body:
  `{ campaign_id, scene_id, user_input }`. Emits `TurnEvent`s, one
  per line, ending with `{ kind: 'end_of_turn' }`.
- Frontend Scene view: parse the NDJSON stream, render each event:
  `status` updates a small "Director thinking..." chip; `message`
  events get appended via `addOneMessage` with the speaker's identity;
  `error` events surface as toasts; `end_of_turn` re-enables the
  input bar.
- Connection profile selection lives in a small Settings popup
  surfaced from the Campaign Main / Scene topbar gear.

## Out of scope

- Multi-actor scenes (Phase 5).
- Skill checks (Phase 6).
- RAG (Phase 7).
- Scene-end pipeline (Phase 8).
- `spawn_character`, `remove_character`, `add_lore`, `propose_scene`
  Director actions — they are stubbed in the schema but not yet
  dispatched.

## Files

Planned:

- `src/gm-core/director/loop.js`
- `src/gm-core/director/schemas.js`, `schemas.d.ts`
- `src/gm-core/director/prompts.js`
- `src/gm-core/narrator/prompts.js`
- `src/gm-core/llm/client.js`, `client.d.ts`
- `src/gm-core/llm/structured-strategies.js` — provider-specific
  structured-output adapters.
- `src/endpoints/gm.js` — `/turn` route, with NDJSON response.
- `public/scripts/gm/scene.js` — extended to consume the NDJSON
  stream and render events.
- `public/scripts/gm/turn-events.js` — small render layer per kind.

## Schemas

`DirectorDecision` (Phase 4 subset):

```ts
type DirectorDecision =
    | { action: 'speak'; actor: 'narrator'; intent: string; rationale: string }
    | { action: 'end_turn'; rationale: string };
```

Subsequent phases extend the union with `skill_check`,
`spawn_character`, `remove_character`, `add_lore`, `propose_scene`.
**Adding a variant is the only way to add a Director capability** —
the dispatcher rejects unknown actions.

### Reasoning contract (all phases)

Every Director tool call requires `rationale` (≥ 80 chars) with a
4-step structure: (1) what the player did, (2) stakes/spotlight,
(3) why this tool, (4) expected next beat. This forces chain-of-thought
before action.

### Trivial-action exception (rule 7a)

Not every player action should trigger `skill_check`. Casual
conversation, ordering a drink, or scanning an unthreatened room are
`speak` moments — the dice are reserved for outcomes where a different
roll result would meaningfully change the next beat.

`TurnEvent` (NDJSON wire format):

```ts
type TurnEvent =
    | { kind: 'status'; phase: 'directing' | 'awaiting_actor' | 'closing' }
    | { kind: 'message'; actor: 'narrator' | string; text: string }
    | { kind: 'error'; code: string; message: string; retryable: boolean }
    | { kind: 'end_of_turn'; reason: 'director' | 'cap' | 'error' };
```

`TurnContext` (server-side, not on the wire):

```ts
type TurnContext = {
    campaign: Campaign;
    scene: Scene;
    actors: Character[];                // PC + NPCs in scene; just [PC] in Phase 4
    transcript_tail_text: string;       // ~4000 char tail of transcript for prompts
    user_input: string;
    director_intent: string | null;     // populated after the first speak action
    max_director_steps: number;         // default 8
};
```

## Acceptance criteria

- Player input in a scene triggers `POST /api/gm/turn`; the Director
  picks `speak: narrator`; the Narrator returns prose; the prose
  streams into `#chat` as a `narrator` message and persists to the
  transcript JSONL with `extra.role = 'narrator'`.
- The Director ends the turn within the step cap.
- A failed structured call surfaces an `error` event in chat (not a
  raw stack trace) and the input bar re-enables.
- Switching connection profiles in Settings changes which
  provider/model is used, end-to-end.
- The Director prompt never contains RAG content (verified by reading
  the prompt-builder unit tests).

## Depends on

Phases 1 (shell), 2 (PC has a name and identity), 3 (transcript I/O,
scene mode flip).
