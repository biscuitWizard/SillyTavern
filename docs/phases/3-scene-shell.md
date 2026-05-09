# Phase 3 — Scene shell (no AI)

Status: Pending.

## Goal

Wire the Scene view as a real navigation target: from Campaign Main, the
player can start a scene, see a chat-like surface where their input is
recorded, and end the scene to return to Campaign Main. No AI, no
Director, no Narrator yet — just the substrate that those layers will
plug into.

## Scope

- "Start Scene" button in Campaign Main creates a new Scene record on
  disk and routes the GM shell to the Scene view.
- Scene view re-uses ST's chat substrate: `body.tt-mode-scene` flips
  CSS so `#chat` and `#form_sheld` come back from `display: none` and
  the GM shell hides; `addOneMessage()` is used to append player
  messages; `chat[]` holds the current scene's messages in memory.
- Player messages get appended to the in-memory `chat[]` and persisted
  to `{handle}/campaigns/{cid}/scenes/{scene_id}.jsonl` using the same
  line schema ST already writes for chats. We get format compatibility
  for free; we just point a different writer at a different path.
- A simple "End Scene" button writes a `closed` status to the scene's
  metadata file and returns the GM shell to Campaign Main. No
  summary / memory pipeline yet (Phase 8).
- Scene history list on Campaign Main: each scene shows name, status,
  message count, last activity.
- Player's input does not trigger ST's `Generate()` — the Scene view
  pre-empts before ST's chat-completion pipeline runs (the same
  pre-emption point that the Director will use in Phase 4).

## Out of scope

- Director / Narrator / actors (Phase 4+).
- Skill checks (Phase 6).
- RAG (Phase 7).
- Scene-end summarization / memory extraction (Phase 8).
- Scene history search, replay, export, fork.

## Files

Planned:

- `src/gm-core/scenes/store.js` — JSON-backed SceneStore for metadata.
- `src/gm-core/scenes/transcript.js` — JSONL append/read for the
  per-scene message log; reuses ST's line schema (`name`,
  `force_avatar`, `mes`, `is_user`, `is_system`, `send_date`,
  `extra`).
- `src/endpoints/gm.js` — extended with `/scenes/*` routes.
- `public/scripts/gm/scene.js` — the Scene view module.
- `public/scripts/gm/router.js` — minimal client-side router for
  `manager` / `campaign` / `scene` views (small, no framework).
- `public/scripts/gm/st-bridge.js` — first version: enter / exit
  scene mode (toggles `body.tt-mode-scene`), append to `chat[]`,
  call `addOneMessage()`, persist to disk.
- `public/script.js` — pre-empt `Generate()` when the GM shell is in
  scene mode. Short hook, single early-return.
- `public/css/gm.css` — `body.tt-mode-scene` rules: show `#chat` and
  `#form_sheld`, hide `#gm-root`, theme `#chat` to match the GM
  palette.

## Schemas

`Scene` metadata (JSON, `{handle}/campaigns/{cid}/scenes/{scene_id}.json`):

```ts
type Scene = {
    id: string;
    campaign_id: string;
    name: string;
    status: 'active' | 'closed';
    participants: string[];          // character_ids; just [PC.id] in Phase 3
    location: string;                // free-form for now; structured location ref later
    started_at: string;
    ended_at: string | null;
    message_count: number;           // updated atomically when transcript is appended
};
```

Transcript entry (JSONL line, `{handle}/campaigns/{cid}/scenes/{scene_id}.jsonl`):

```ts
type TranscriptLine = {
    name: string;
    force_avatar?: string;
    mes: string;
    is_user: boolean;
    is_system: boolean;
    send_date: string;
    extra?: {
        // Phase 4+ adds: role ('player' | 'narrator' | 'actor'),
        //                kind ('message' | 'roll' | 'state'), ...
    };
};
```

Routes (planned):

- `POST /api/gm/scenes` — create scene under a campaign.
- `GET /api/gm/scenes/{id}` — metadata.
- `GET /api/gm/scenes/{id}/transcript?after=N` — transcript lines.
- `POST /api/gm/scenes/{id}/messages` — append a player line (no AI).
- `POST /api/gm/scenes/{id}/end` — set status to `closed`.

## Acceptance criteria

- "Start Scene" creates the scene metadata JSON and an empty
  `.jsonl` file, then transitions the UI to the Scene view.
- Typing in the input bar appends a line to `chat[]`, renders via
  `addOneMessage()`, and persists to the JSONL transcript.
- ST's standard `Generate()` does *not* fire on player input.
- "End Scene" closes the scene, writes status, and returns the UI to
  Campaign Main with the scene now visible in the scene history list.
- Reopening the campaign and clicking the closed scene loads the
  transcript back into the Scene view (read-only or read-write — TBD,
  but the file lives).

## Depends on

Phase 1 (full), Phase 2 (need a player character to attribute messages
to).
