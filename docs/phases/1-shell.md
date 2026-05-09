# Phase 1 — Campaign-first shell

Status: **Visual POC done**, full wiring pending.

## Goal

Replace SillyTavern's chat-first launch experience with a Campaign Manager
as the primary surface. The user opens TTRPG Tavern and sees campaigns,
not a chat with the assistant. Navigation is Campaign Manager →
Campaign Main → Scene; everything else is reached through campaigns.

## Scope

**Visual POC (shipped):**

- Cannibalize `#sheld`: keep ST's `#chat` and `#form_sheld` in the DOM
  for ST internals to find, but hide them via CSS and put a new
  `#gm-root` in their place.
- Stretch `#sheld` to the full viewport so the GM shell has room.
- Render a Campaign Manager screen into `#gm-root`: top bar with brand,
  page header with "+ New Campaign" CTA, grid of mock campaign cards,
  Resources section with deferred-feature tiles, footer.
- Hard-coded mock campaign data; no backend.
- Validated in a real browser (full-viewport screenshot).

**Full phase (pending):**

- `GET/POST/DELETE /api/gm/campaigns` HTTP endpoints in a new
  `src/endpoints/gm.js` router, mounted from `src/server-startup.js`.
- `src/gm-core/campaigns/store.js` — JSON-backed CampaignStore (atomic
  writes via `write-file-atomic`, in-process cache).
- Per-user campaign directory under
  `{handle}/campaigns/{campaign_id}/campaign.json`.
- Replace mock data in the Campaign Manager with a real `fetch` of the
  endpoint.
- Click on a campaign opens a placeholder Campaign Main view that lists
  scenes (empty for now) and has a "Start Scene" stub. No scene logic
  yet — that lands in Phase 3.
- Wire the Settings icon to a minimal popup (just a placeholder; real
  model assignments are Phase 10).

## Out of scope

- Any LLM calls.
- Character creation (Phase 2).
- Active scenes / message rendering (Phase 3).
- Lore editor, ruleset picker, memory inspector, model assignments —
  those resource tiles are intentional placeholders.

## Files

Added (visual POC):

- [public/scripts/gm/bootstrap.js](../../public/scripts/gm/bootstrap.js)
- [public/scripts/gm/campaign-manager.js](../../public/scripts/gm/campaign-manager.js)
- [public/scripts/gm/mock-data.js](../../public/scripts/gm/mock-data.js)
  — *delete this when the real endpoint lands.*
- [public/css/gm.css](../../public/css/gm.css)

Modified (visual POC):

- [public/index.html](../../public/index.html) — added the gm.css link
  tag, the bootstrap module script tag, and `<div id="gm-root">` inside
  `#sheld` ahead of `#chat`.

Planned for full phase:

- `src/endpoints/gm.js` — new Express router.
- `src/server-startup.js` — mount the router at `/api/gm`.
- `src/gm-core/campaigns/store.js`, `src/gm-core/campaigns/schemas.js`,
  `src/gm-core/campaigns/schemas.d.ts`.
- `src/constants.js` — add `campaigns` and `gm` entries to
  `USER_DIRECTORY_TEMPLATE`.
- `public/scripts/gm/campaign-main.js` — placeholder Campaign Main view.
- `public/scripts/gm/api.js` — small `fetch` wrapper for `/api/gm/*`.

## Schemas

`Campaign` (JSON, `{handle}/campaigns/{id}/campaign.json`):

```ts
type Campaign = {
    id: string;            // slug, used as directory name
    name: string;
    brief: string;         // short pitch (≤ 280 chars), shown on cards
    ruleset_id: string;    // points at data/rulesets/{id}/ or {handle}/rulesets/{id}/
    addendum: string;      // GM addendum injected into Director system prompt
    banner_theme: 'shadows' | 'frontier' | 'hollow' | 'default';
    current_scene_id: string | null;
    last_played_at: string | null;  // ISO 8601, null when never opened
    created_at: string;
    updated_at: string;
};
```

`CampaignSummary` (HTTP response shape, used by the Campaign Manager grid):

```ts
type CampaignSummary = Pick<Campaign, 'id' | 'name' | 'brief' | 'ruleset_id' | 'banner_theme' | 'last_played_at'> & {
    scene_count: number;
};
```

## Acceptance criteria

Visual POC (already met):

- Loading `http://localhost:8050/` shows the Campaign Manager filling the
  viewport, ST's top icon bar still visible above.
- Three mock campaign cards render with banners, briefs, and metadata;
  the "+ New Campaign" placeholder card is present.
- Console shows `[gm] Campaign Manager mounted.` and no errors.

Full phase:

- Creating a campaign via the wizard's first step writes
  `{handle}/campaigns/{id}/campaign.json` and the new campaign appears
  in the grid on next load.
- Deleting a campaign removes the directory.
- Clicking a campaign opens the Campaign Main view; clicking back
  returns to the manager.

## Depends on

Phase 0.
