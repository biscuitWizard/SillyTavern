# TTRPG Tavern — Design

This is the single source-of-truth statement of what TTRPG Tavern is. It
captures the goals, the player experience, the roles in the system, the
core loops, the features, and the principles that constrain how we build
it. Everything else (ADRs, architecture docs, phase plans) flows from
here.

If you only have time to read one document in this repo, read this one.

## Vision

TTRPG Tavern is a fork of SillyTavern reshaped into a tabletop-style
single-player TTRPG. The player creates a character; an AI Director
orchestrates each turn; an AI World Narrator paints the world; AI
characters live in it and react to the player. Play happens in *scenes*
inside *campaigns*. Skill checks are real, transparent, and rolled
against an installable ruleset. The user-facing flow is curated: it is
not a chat app you happen to be playing a game in; it is a campaign tool
that uses chat as a building block.

## The experience

Opening the app does not show a chat window or a character list. It
shows your **campaigns**. From there:

```
Campaign Manager  →  Campaign Main  →  Scene  →  back to Campaign Main
   |                       |                |
   resume / new            start scene      end scene (player triggered)
```

- **Campaign Manager** is the home screen. Pick up where you left off,
  start a new world, browse rulesets and lore.
- **Campaign Main** is the per-campaign hub. Your party (the PC plus
  any NPCs the campaign cares about), recent scene history, lore
  overview, "Start Scene" CTA.
- **Scene** is where play happens. The player types intent; the
  Director runs the turn; messages from the Narrator and from any AI
  characters present scroll into a chat-like surface; skill check
  cards render inline when a roll happens; the player ends the scene
  with a button when it feels finished.
- After **End Scene**, control returns to Campaign Main with a fresh
  scene closed in the history, summarized, and its memories baked
  into the world.

Chat history, character cards, and world info from stock SillyTavern
are not how the player navigates. They are reachable through the
campaign and scene shells when relevant.

## Roles

There are five conceptual roles. Three of them are LLM personas with
strict, separate prompts.

- **Player** — the human. Drives the game by typing intent in the Scene
  view ("Jack attempts to jump the ledge") and by ending scenes.

- **Player Character (PC)** — the player's identity in scenes. Has a
  full character sheet (stats, items, statuses, skills, notes), a
  physical description, and persists across scenes. Exactly one per
  campaign.

- **Director** — an LLM that emits **structured output only**, never
  prose. On each player turn, the Director runs a loop: decide what
  happens next, dispatch it (call the Narrator, call a specific
  character, request a skill check, mutate world state), receive the
  result, decide again, until the turn ends. The Director is the
  intermediary between the player and every other AI persona. The
  Director never "speaks" in the world.

- **World Narrator** — an LLM that writes **prose** for the world:
  setting description, what physically happens, the consequences of a
  roll. Sees campaign-scoped world facts (RAG) and its own continuity
  notes (`narrator_memory`); never sees character memories.

- **Actor (AI character)** — an LLM persona for any non-player
  character in the scene. Sees its own sheet (rendered as YAML), its
  own first-person memories (RAG), world facts (RAG), and a recent
  transcript window. Never sees other characters' sheets, other
  characters' memories, or the Director's rationale.

## The core loop, in plain English

When the player types something in an active scene:

1. The player's message is appended to the on-disk transcript and
   shown in the chat surface.
2. SillyTavern's standard `Generate()` is **pre-empted** — the GM
   core takes over.
3. The Director runs a bounded loop (default 8 steps). Each step the
   Director picks one structured action. Possible actions evolve by
   phase but include:
   - `speak: narrator` — the Narrator writes prose.
   - `speak: <character_id>` — that character speaks/acts in
     character.
   - `skill_check: { actor, intent }` — adjudicate a check (see
     below).
   - `spawn_character` / `remove_character` — change scene roster.
   - `add_lore` — record a new world fact.
   - `propose_scene` — outside an active scene, suggest the next one.
   - `end_turn` — give the floor back to the player.
4. The Narrator and actor outputs stream into the chat surface as
   real messages, attributed to the right speaker.
5. When the Director picks `end_turn`, the input bar re-enables and
   it is the player's turn again.

The loop is implemented server-side and streams results to the
frontend as `TurnEvent`s over NDJSON.

## Skill checks

When the Director picks `skill_check`, three things happen:

1. **Adjudicate.** A separate structured LLM call decides: is a check
   actually required? If yes, which skill, which ability, what DC,
   what failure severity? The decision is constrained by the active
   ruleset (skill must exist, DC is clamped to the ruleset's range,
   ability is overridden if the LLM disagrees with the
   skill→ability mapping).
2. **Roll.** A pure function rolls d20 + ability modifier from the
   actor's sheet + proficiency bonus when the actor is proficient.
   No LLM in the loop. Returns `{ d20, modifier, total, success,
   margin }`.
3. **Narrate.** A real roll always forces the Narrator next, with
   `post_roll: true` metadata so the prompt frames the prose as the
   consequence of the roll.

The player sees a transparent **roll card** in chat: skill, DC,
breakdown, total, outcome, severity. There is no hidden adjudication.

### Worked example

Player input (PC = Jack): *"Jack attempts to jump the ledge."*

| Turn         | What the player sees                                                          |
|--------------|--------------------------------------------------------------------------------|
| Player       | "Jack attempts to jump the ledge."                                            |
| Director     | (status pill: "rolling")                                                       |
| Roll card    | Athletics · DC 12 · d20=15 + STR mod +2 = 17 · **success**                    |
| Narrator     | "Jack pushes off cleanly, the gap unfolding under him, and lands on his feet." |
| Actor: Amelia | "Wow, that was a crazy jump, Jack!"                                          |
| Director     | (status pill: "ending turn")                                                   |
| (player's turn) | input bar re-enables                                                       |

If the roll had failed, the Director might pick a `severe` failure;
the Narrator would describe the consequence (Jack falls, takes
damage); if Jack's HP hits 0, the Narrator narrates his death and the
Director still ends the turn — the world reacts to the rules, the
rules don't bend to the story.

## Memory

Two storage layers:

- **Authoritative state** lives as JSON files on disk (campaigns,
  characters, sheets, lore, scene metadata, transcripts). Human-
  readable, easy to back up. **Disk is canonical.**
- **Long-term memory** lives in **Qdrant** as a derived index that we
  rebuild from disk on boot. Five collection kinds, all
  campaign-scoped:
  - `world_lore__{cid}` — unified seed + generated world facts
    (origin tag in payload).
  - `character_memory__{cid}__{character_id}` — per-character
    first-person memories.
  - `director_memory__{cid}` — Director pacing log.
  - `narrator_memory__{cid}` — Narrator continuity notes.
  - `player_journal__{cid}` — out-of-fiction player notes.

  Every write hits an append-only disk JSONL mirror first, then
  Qdrant. On boot, a reconcile pass replays missing records into
  Qdrant; wiping the Qdrant volume is a recoverable operation.

Memory injection rules — these are properties of the system,
enforced in code (Phase 7 relaxes the original Director-RAG-free rule;
the adjudicator stays strictly clean):

| Caller        | character_memory                | world_lore                        | director_memory     | narrator_memory     | player_journal     |
|---------------|---------------------------------|-----------------------------------|---------------------|---------------------|--------------------|
| Director      | **never**                       | top 6 + `search_memory` tool      | own, top 2          | **never**           | top 1              |
| World Narrator | **never**                      | top 6 + `search_memory` tool      | **never**           | own, top 2          | top 1              |
| Actor X       | own, top 4 (X's only)           | top 5 + `search_memory` tool       | **never**           | **never**           | top 1 (read-only)  |
| Skill-check adjudicator | **never**             | **never**                          | **never**           | **never**           | **never**          |
| Post-roll Narrator | **never**                  | top 6                              | **never**           | own, top 2          | top 1              |

When a character is called, the latest authoritative version of their
sheet is rendered as YAML and included in their prompt. Sheets are
not cached across calls; the prompt is built fresh each time.

Sheets are key-value bags. `stats` and `statuses` accept arbitrary
keys; conventional keys (`hp`, `max_hp`, `ac`, `proficiency_bonus`,
…) are agreed by convention, not pinned by schema. New characters get
their starter pack from the campaign's `ruleset_id` via the in-memory
ruleset registry (Phase 5 seam; Phase 6 swaps this for a YAML
loader). Sheet edits are CRUD on the KV bag — not a schema migration.

RAG snippets are spliced into the prompt for that one call. They are
**never persisted to the transcript**. After the actor responds, the
context that included Amelia's memories about Jack's jumping abilities
is gone — the next prompt to anyone else does not carry it. Context
stays clean.

## Scenes

A scene is a bounded multi-actor exchange ended by the player. Scenes
are first-class objects in our schema. They are not SillyTavern group
chats; we cannibalize ST's chat substrate (message renderer, input bar,
JSONL transcript format) but the navigation, persistence, and
participant model are ours.

The in-scene roster is `scene.participants` — a list of character ids.
The Director can `spawn_character: library` (pull a campaign character
in) or `remove_character` (write them out); the player can do the
same explicitly from the right sidebar. The PC sheet is always
visible in the GM shell while a campaign is loaded — pinned in the
left sidebar across both Campaign Main and Scene views.

End Scene runs a pipeline:

1. Build a transcript view (last ~60 lines, not the whole window).
2. Structured `SceneSummary` LLM call.
3. Per-participant structured `MemoryExtraction` LLM call.
4. Write extracted memories to each character's collection.
5. Write key events as world facts.
6. Mark the scene closed and return to Campaign Main.

The pipeline is deterministic in its writes: re-running on the same
transcript with the same scene id is idempotent.

## Rulesets

Skill check resolution is data-driven. A ruleset is a triple of YAML
files (`skills.yaml`, `dc_guidance.yaml`, `consequences.yaml`)
defining abilities, skills (with skill→ability mapping), DC bands,
clamp range, and a severity ladder for failure consequences.

- Bundled rulesets ship in `data/rulesets/{id}/`. The first one is
  D&D 5e, ported from the prior `srstavern` work.
- User-installed packs override at `{handle}/rulesets/{id}/`.
- Switching a campaign's ruleset is a single field on `Campaign.ruleset_id`.

The same engine handles every ruleset. Rules are never hard-coded into
the engine; the engine reads from the loaded ruleset.

## Tools

Models can call tools to interact with the world:

- Read / mutate stats (set, adjust, conditions, items).
- Create / update / delete characters.
- Search lore and memories within their allowed scope.
- Invoke a skill check (Director only).
- Add a world fact (Director only).
- Propose a scene (Director only, outside an active scene).

Tools are exposed through SillyTavern's existing `ToolManager`
plumbing for any model that supports function calling, and through
direct in-process calls inside the GM core's structured-output paths
when the provider supports JSON-schema strict mode.

## Ask mode (out-of-fiction GM advisor)

The **Ask tab** lets the player talk to the GM outside of active scenes.
Questions like "What does my character know about the king?" or
"Update my HP to 15" are handled here.

Ask runs its own **agent loop** (`src/gm-core/ask/loop.js`), structurally
similar to the Director loop but with a different tool set:

- `mutate_sheet` — set/adjust/clear stats, items, statuses.
- `mutate_identity` — propose changes to identity fields (name,
  appearance, etc.). PC identity changes emit an `identity_edit_request`
  event and require player approval; NPC changes apply immediately.
- `search_memory` — query RAG collections (world_lore, character_memory,
  player_journal).
- `add_lore` — commit a new world-lore record to the vector DB.
- `answer_player` — terminal tool. The loop ends when this is called;
  its `reply` is the GM's answer shown to the player.

The Ask loop uses `tool_choice: 'required'` and caps at 6 steps.
It sees the full PC sheet (rendered as YAML), campaign context, recent
Ask transcript, and RAG hits for world lore, character memory, and
player journal.

The endpoint (`POST /api/gm/campaigns/:cid/ask`) streams NDJSON events
(`status`, `tool_step`, `answer`, `identity_edit_request`, `error`) so
the panel can show incremental progress. The Ask panel persists its own
transcript via `askStore`.

## UI principles

1. **Curated, not freeform.** The player navigates a deliberate flow
   (Campaign Manager → Campaign → Scene). Chat is a means, not the
   home.
2. **Reuse, don't reinvent visuals.** The Scene view borrows ST's
   message renderer, input bar, avatars, and transcript format —
   they are good and they are there.
3. **Transparent mechanics.** Rolls show their work. The player can
   see exactly what skill was picked, what DC was set, and what the
   die rolled. No black-box dice.
4. **One screen does one thing.** The Campaign Manager is for
   choosing a campaign. Campaign Main is for context. Scene is for
   play. Settings is for settings. We do not stack modes.
5. **Curated chrome.** SillyTavern's left-nav drawer, character list,
   and world-info panel are not how the player gets things done in
   TTRPG mode. Where they're still useful (e.g. connection profiles
   for model selection), we surface them through the GM shell, not
   through their stock entry points.

## Technical principles

1. **Direct fork, in-process.** All orchestration runs inside the
   `ttrpgtavern` Node app — Director loop, Narrator/actor/adjudicator
   prompts, RAG service, ruleset loader, scene-end pipeline.
   No Python sidecar; no separate orchestrator process. See
   [ADR 0002](docs/adr/0002-all-node-no-python.md).
2. **JavaScript + JSDoc, with `.d.ts` for shared schemas.** Matches
   SillyTavern's existing style; no extra build step.
3. **JSON for state, Qdrant for vectors.** No Postgres. No SQLite.
   See [ADR 0003](docs/adr/0003-json-state-qdrant-vectors.md).
4. **Strict context isolation.** Per-actor prompts are rebuilt from
   authoritative state every call. The transcript shown to the
   player is not the prompt sent to any LLM. Other actors' sheets and
   memories are not in actor X's prompt. The skill-check adjudicator
   never sees RAG snippets — it does not even import `MemoryService`.
   These are tested as system properties.
5. **Structured output is non-negotiable for the Director.** The
   Director's only output channel is a discriminated-union schema.
   Adding a Director capability is adding a variant to the union; the
   dispatcher rejects unknown actions.
6. **Pre-empt over hook.** When in a scene, we pre-empt SillyTavern's
   `Generate()` rather than trying to live inside its pipeline. ST's
   chat substrate is reused for rendering and persistence; ST's
   generation pipeline is bypassed in TTRPG mode.
7. **Cannibalize the chat substrate, replace the navigation.** ST's
   `#chat` and `#form_sheld` stay in the DOM (so internal references
   keep working) but are hidden by default and shown again only when
   the Scene view enters scene mode. The shell wrapping them is
   ours. See [ADR 0004](docs/adr/0004-cannibalize-st-chat-substrate.md).
8. **Plan on the prior art, port concepts not code.** The
   `../srstavern/` Python sidecar work is reference material —
   prompts, schemas, ruleset YAML, eval scenarios — that we port and
   adapt to JavaScript. We do not run any of it.

## What this fork is, and is not

**Is:**

- A campaign-first reshaping of SillyTavern's UX.
- An in-process Node app with one external dependency (Qdrant).
- File-based for game state; vector-DB-based for memories only.
- A single-user, single-player TTRPG tool.

**Is not:**

- A SillyTavern extension.
- A Python sidecar app.
- A multi-user / shared-campaign system.
- A general-purpose chat client with a TTRPG plugin bolted on.

## Where to read more

- **System map and per-turn flow** — [docs/architecture/README.md](docs/architecture/README.md),
  [docs/architecture/program-flow.md](docs/architecture/program-flow.md).
- **Locked decisions** — [docs/adr/](docs/adr/).
- **What ships when** — [docs/phases/README.md](docs/phases/README.md)
  and the per-phase docs in that directory.
- **Prior art (reference, not runtime)** — `../srstavern/docs/` and
  `../srstavern/legacy/sidecar/`.

## Source of this document

This document distills the original project brief and the architectural
choices made during the kickoff conversation. When in conflict with
older docs, this document wins; we update those docs to match.
