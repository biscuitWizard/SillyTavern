# Phase 9 — Strict-GM evals

Status: Pending.

## Goal

Lock the Director and skill-check adjudicator against common failure
modes (DC manipulation, wrong skill picks, drama-pass refusals,
unjustified free re-rolls). Tests run in CI as fast prompt-only
checks; an opt-in flag runs them against a live LLM for periodic
regression hunting.

## Scope

- Port the legacy eval harness from
  `[../../../srstavern/legacy/sidecar/srstavern/evals/](../../../srstavern/legacy/sidecar/srstavern/evals/)`
  to a Node test runner. Two modes:
  1. **Prompt-only** (default in CI): build the prompt for a scenario
     and run phrase-based predicate assertions on it (e.g. "system
     prompt mentions DC clamping rules", "skill names list is
     sorted", "no instruction tells the model to invent stats").
  2. **Live LLM** (opt-in via `TTRPG_RUN_LIVE_EVALS=1`): run the
     scenarios through the configured LLM and assert on the
     `DirectorDecision` / `SkillCheckDecision` shape (e.g. `dc >=
     min_dc`, `skill_id not in [<weak picks>]`, `failure_severity
     not 'lethal'`).
- Scenarios as plain JS data, easy to add. Starting set ports the
  legacy ones: `rooftop_dragon`, `lockpick_retry`,
  `threaten_with_knife`, plus a few new ones for the TTRPG-style
  flow.
- Predicates as named exports: `min_dc(15)`, `skill_in([...])`,
  `skill_not_in([...])`, `decided_required(true)`, etc.

## Out of scope

- A regression dashboard / UI (Phase 10+ if desired).
- Multi-turn scenarios that require carrying state between turns.
- Cross-ruleset branching scenarios (the bundled evals target the
  D&D 5e ruleset only).

## Files

Planned:

- `tests/gm-core/evals/scenarios.js`
- `tests/gm-core/evals/predicates.js`
- `tests/gm-core/evals/harness.js`
- `tests/gm-core/evals/run.js` — entrypoint; respects
  `TTRPG_RUN_LIVE_EVALS`.
- `package.json` — `npm run evals` and `npm run evals:live` scripts.

## Schemas

`Scenario`:

```ts
type Scenario = {
    id: string;
    description: string;             // human-readable
    setup: {
        ruleset_id: string;
        actor: PartialCharacter;     // sheet snippet sufficient for the prompt
        intent: string;              // what the player is trying to do
        transcript_tail: string;     // optional setup text
    };
    expects: {
        director?: PromptPredicate[];        // predicates over Director prompt / decision
        skillcheck?: PromptPredicate[];      // predicates over adjudicator prompt / decision
    };
};

type PromptPredicate =
    | { name: 'prompt_includes'; needle: string }
    | { name: 'prompt_excludes'; needle: string }
    | { name: 'min_dc'; value: number }
    | { name: 'max_dc'; value: number }
    | { name: 'skill_in'; values: string[] }
    | { name: 'skill_not_in'; values: string[] }
    | { name: 'severity_at_most'; level: SeverityLevel }
    | { name: 'decided_required'; value: boolean }
    | { name: 'no_action'; action: string };
```

## Acceptance criteria

- `npm run evals` runs all scenarios in prompt-only mode and finishes
  in under 5 seconds without network access.
- `TTRPG_RUN_LIVE_EVALS=1 npm run evals:live` runs the live-LLM
  variant against the configured connection profile and reports per-
  scenario pass/fail with the actual decision JSON for failures.
- Adding a scenario is a one-file change in
  `tests/gm-core/evals/scenarios.js`; no test runner plumbing
  required.
- CI runs prompt-only on every push.

## Depends on

Phases 4 (Director), 6 (skill checks). Live mode additionally needs
a configured connection profile.
