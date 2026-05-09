# ADR 0004: Cannibalize the SillyTavern chat substrate; scenes are first-class

Status: Accepted
Date: 2026-05-09

## Context

A scene in TTRPG Tavern is a bounded, multi-actor exchange that ends when the
player triggers it. The prior `srstavern` ADR-001 mapped each scene to a
SillyTavern group chat, with scene metadata in `chatMetadata` and Manual
reply mode to suppress ST's built-in scheduler. That worked, but it also
inherited everything ST's group-chat UX implies: the chat is the top-level
container; the user navigates between chats; there is no campaign above.

We are inverting that. The user navigates Campaign Manager → Campaign →
Scene. A scene is a first-class object in our schema; it is not a group chat
the user happens to be in.

We still want what ST's chat machinery gives us cheaply:

- A proven message renderer with avatars, system messages, swipes,
  formatting, regex.
- A robust input form with token counting, draft saving, paste handling.
- A JSONL transcript format that already round-trips through `addOneMessage`,
  `chat[]`, `chat_metadata`, and the persistence endpoints.

So the substrate stays. The shell, navigation, and persistence semantics
change.

## Decision

Scenes are not ST group chats. They are records in our own JSON layout (see
ADR 0003).

The Scene view in the frontend reuses ST's chat DOM (`#chat`,
`#send_form`, `#send_textarea`), `addOneMessage()`, and the message
renderer. It does not reuse ST's group-chat scheduler, group-membership
machinery, or chat-list navigation.

Scene transcripts are persisted as JSONL files using the same line schema
ST already writes for chats. We get the format for free; we just point a
different writer at a different path.

Player input in a scene is intercepted before `Generate()` runs. The GM core
takes over: the `POST /api/gm/turn` endpoint runs the Director loop and
streams `TurnEvent`s back as NDJSON. Each event becomes a message via
`addOneMessage()`. ST's standard generation path is short-circuited with
`abort(true)`-equivalent semantics inside our pre-empt point.

The `#chat` and `#form_sheld` elements are deleted from `index.html`
outright. A `<div id="gm-root">` takes their slot inside `#sheld` and
hosts the Campaign Manager, Campaign Main, and Scene views. The other
chat-first chrome (left-nav drawer, character list, world-info panel)
remains in the DOM today and will be hidden or rerouted as later phases
need them.

The ST character card stays as the avatar/identity carrier for in-scene
display: when a campaign character is created or updated, we mirror name
and portrait to a card. The campaign character JSON is the source of
truth.

## Consequences

- We get ST's polished message renderer for in-scene reuse without
  adopting its navigation model.
- The "scene = group chat" assumption from `srstavern` is gone. Slash
  commands like `/scene start` and the Manual-mode dance are not needed.
- ST module-load code that does `$('#chat')` returns an empty jQuery
  set; that is intentionally harmless and the affected handlers no-op.
  Code that hard-references `getElementById('chat')` checks for null.
- Cannibalization concentrates ST coupling in a few files:
  - `public/index.html` — stylesheet and module script tags, `#gm-root`
    replacing `#chat` + `#form_sheld` inside `#sheld`.
  - `public/scripts/gm/bootstrap.js` — render Campaign Manager into
    `#gm-root`.
  - `public/script.js` — later phases will pre-empt `Generate()` when in
    a scene.
  - `public/scripts/gm/st-bridge.js` (future) — every other ST internal
    we depend on.
- Upstream ST changes to `addOneMessage()` or `Generate()` are the most
  likely to bite us at merge time. We will keep the surface narrow.
