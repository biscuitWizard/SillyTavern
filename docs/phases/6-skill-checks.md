# Phase 6 — Skill checks + first ruleset

Status: Pending.

## Goal

When a Director decides a player action requires resolution, the
backend runs a structured skill-check decision, rolls deterministic
dice against the active ruleset, and forces the Narrator to narrate
the consequence. Players see a transparent roll card in chat. The
first bundled ruleset is D&D 5e, ported verbatim from the legacy
project.

## Scope

- Bundled ruleset at `data/rulesets/dnd5e/` — three YAML files
  (`skills.yaml`, `dc_guidance.yaml`, `consequences.yaml`) ported from
  `[../../../srstavern/legacy/sidecar/srstavern/rulesets/dnd5e/](../../../srstavern/legacy/sidecar/srstavern/rulesets/dnd5e/)`.
- `src/gm-core/rulesets/loader.js` — load + cache rulesets by id;
  resolve precedence: user pack at `{handle}/rulesets/{id}/` wins
  over bundled.
- `src/gm-core/rulesets/schemas.js`, `schemas.d.ts` — typed `Ruleset`
  with abilities, skills, DC bands, severity ladder, clamp range.
- `src/gm-core/skillcheck/engine.js` — three exports:
  - `decide({ ruleset, intent, actor, transcript_tail })` — structured
    LLM call returning `SkillCheckDecision`.
  - `roll({ ruleset, character, decision })` — pure: d20 + ability
    modifier + proficiency bonus when proficient; returns
    `RollOutcome`.
  - `renderRollCard({ ruleset, decision, outcome, character })` —
    builds a `RollCard` object the frontend renders.
- `DirectorDecision` extended with
  `skill_check: { actor: <character_id>; intent: string }`. The
  Director picks *who* attempts and *what they're trying to do*; the
  adjudicator (`decide`) picks the skill, ability, DC, and failure
  severity.
- After a real roll, the loop forces the Narrator with
  `post_roll: true` metadata so the prompt builder frames the prose
  as the consequence of the roll.
- Frontend: new `roll` `TurnEvent` kind renders a card (skill name, DC,
  d20 + modifiers = total, success/fail, severity badge) in the
  transcript, theme-matched to the GM shell.

## Out of scope

- AI-generated character sheets / NPCs (`charactergen/`) — Phase 10
  candidate.
- Multi-roll mechanics (group checks, advantage / disadvantage from
  conditions).
- Custom ruleset import / editor UI (Phase 10).
- RAG-augmented adjudication (deferred; the legacy project notes RAG
  in `decide()` was deferred to its Phase 7 — same here).

## Files

Planned:

- `data/rulesets/dnd5e/skills.yaml`
- `data/rulesets/dnd5e/dc_guidance.yaml`
- `data/rulesets/dnd5e/consequences.yaml`
- `src/gm-core/rulesets/loader.js`, `schemas.js`, `schemas.d.ts`,
  `routes.js`
- `src/gm-core/skillcheck/engine.js`, `schemas.d.ts`,
  `prompts.js`
- `src/gm-core/director/loop.js` — extended skill-check dispatcher;
  forced-narrator path after a real roll.
- `src/gm-core/director/schemas.js` — extend `DirectorDecision`.
- `src/endpoints/gm.js` — `GET /rulesets`, `GET /rulesets/{id}`.
- `public/scripts/gm/turn-events.js` — render `roll` events.
- `public/css/gm.css` — `.gm-roll-card` styling (success / fail /
  severity color cues).

## Schemas

`Ruleset`:

```ts
type Ruleset = {
    id: string;
    name: string;
    abilities: Ability[];               // e.g. STR, DEX, CON, INT, WIS, CHA
    skills: Skill[];
    dc_bands: DcBand[];                 // e.g. 5 trivial, 10 easy, ... 30 nearly impossible
    severity_ladder: ('minor'|'moderate'|'major'|'severe'|'lethal')[];
    dc_min: number;                     // clamp lower
    dc_max: number;                     // clamp upper
};

type Skill = {
    id: string;                         // e.g. 'athletics'
    name: string;                       // 'Athletics'
    ability_id: string;                 // 'strength'
    description: string;
};
```

`SkillCheckDecision` (from `engine.decide`):

```ts
type SkillCheckDecision = {
    required: boolean;                  // false → no roll, no forced narrator
    skill_id: string | null;
    ability_id: string | null;
    dc: number | null;                  // clamped to ruleset range
    failure_severity: SeverityLevel | null;
    justification: string;
};
```

`RollOutcome` (from `engine.roll`, pure function):

```ts
type RollOutcome = {
    d20: number;                        // 1..20
    ability_modifier: number;
    proficiency_bonus: number;          // 0 if not proficient
    total: number;
    success: boolean;
    margin: number;                     // total - dc
    crit: 'natural_20' | 'natural_1' | null;
};
```

`RollCard` (frontend rendering payload):

```ts
type RollCard = {
    actor_id: string;
    actor_name: string;
    skill_name: string;
    ability_name: string;
    dc: number;
    breakdown: { d20: number; ability_modifier: number; proficiency_bonus: number; total: number };
    outcome: 'success' | 'failure';
    severity: SeverityLevel | null;
    justification: string;
};
```

## Acceptance criteria

- D&D 5e ruleset loads and `GET /api/gm/rulesets` lists it.
- The Director can pick `skill_check`; the adjudicator picks an
  appropriate skill / DC; the dice roll runs deterministically (seed
  optional) and consistently with the ruleset.
- A roll card renders in chat with breakdown and outcome.
- After a real roll, the very next event is a Narrator `message`
  with `extra.post_roll = true`.
- A "no check needed" decision (`required: false`) does not force
  the Narrator; the loop returns to the Director.
- A unit test asserts DC clamping; another asserts ability override
  when the LLM disagrees with the ruleset's skill→ability mapping.

## Depends on

Phases 4 (Director + Narrator), 5 (multi-actor — actors can also be
the subject of rolls).
