# ADR 0001: Fork SillyTavern, do not ship as an extension

Status: Accepted
Date: 2026-05-09

## Context

The TTRPG Tavern experience needs deep changes to SillyTavern's UX:

- The first screen should be a Campaign Manager, not a chat with the assistant.
- Navigation is Campaign Manager → Campaign → Scene; chat is no longer the
  top-level container.
- The chat shell, input bar, message renderer, and avatar machinery are still
  useful as building blocks, but the user-facing flow they enable today is the
  wrong shape.
- Multi-actor scene orchestration (Director, Narrator, AI characters) needs to
  pre-empt the standard `Generate()` pipeline at every player turn.

Stock SillyTavern extensions can attach panels, register slash commands, hook
events, and intercept generation, but they cannot replace the top-level shell
or change the user's launch flow without fragile DOM surgery from the side.

A prior attempt (`../srstavern/`) tried to keep stock SillyTavern and pile the
new behavior into extensions plus a Python sidecar. The boundary itself
became a tax: every change had to thread through HTTP, two extension manifests,
and the assumption that ST's chat-first UX is intact underneath.

## Decision

Treat `ttrpgtavern` as a **fork** of SillyTavern. Modify `public/index.html`,
`public/script.js`, the welcome flow, and any other surface area that is in
the way of the curated TTRPG experience. Reuse ST's chat substrate where it
helps (message rendering, input form, avatars, character cards) but cannibalize
the navigation and orchestration layers.

Upstream merges from SillyTavern remain valuable but are not a constraint on
the design. We will keep changes localized to a small set of touch points to
make merges tractable, but we will not block ourselves to preserve them.

## Consequences

- We can replace the first screen and route directly to the Campaign Manager.
- We can pre-empt `Generate()` with the GM core without depending on the
  `generate_interceptor` contract.
- Upstream merges will require manual conflict resolution at the
  cannibalized files. We will isolate ST-internal coupling behind a
  `public/scripts/gm/st-bridge.js`-style shim to keep the surface small.
- Extensions remain a valid mechanism for optional add-ons (e.g. tooling,
  experimental UIs). They are not the home of core functionality.
