# Phase 2 — Character + sheet model

Status: Pending.

## Goal

Define the canonical Character + CharacterSheet schemas for the project,
build a guided character creation wizard for the player character (PC),
and persist characters as JSON under each campaign. The PC has stats,
items, statuses, skills, and notes — enough to feed both prompt
construction and the skill-check engine in Phase 6.

## Scope

- `Character` and `CharacterSheet` schemas, ported and adapted from
  `[../../../srstavern/legacy/sidecar/srstavern/library/schemas.py](../../../srstavern/legacy/sidecar/srstavern/library/schemas.py)`.
  Flat shape: `stats`, `statuses`, `items`, `skills`, `notes`.
- `src/gm-core/library/store.js` — JSON-backed CharacterStore, atomic
  writes, in-process cache, scoped per campaign.
- `src/gm-core/sheets/store.js` — derives a `CharacterSheet` view from
  a Character record; in-place mutators for HP / abilities / items /
  statuses / skills.
- HTTP endpoints under `/api/gm/characters` and `/api/gm/sheets` (CRUD
  and granular sheet mutations).
- Frontend character creation wizard (`character-wizard.js`):
  multi-step modal that lets the player pick a name, write a physical
  description, allocate starting stats, pick proficient skills, and
  describe a few starting items.
- Campaign Main view lists the party (just the PC for now) with a
  small sheet panel preview.
- One-way mirror to a SillyTavern character card on Character create /
  update, so ST's avatar / identity machinery has something to render
  in Phase 3 scenes.

## Out of scope

- AI-driven character generation (Phase 6 / 10 territory; the legacy
  `charactergen/` module is reference-only here).
- AI-controlled (NPC) characters (Phase 5).
- Skill-check rules logic (Phase 6).
- Inventory math, encumbrance, status effects ticking, etc. — `items`
  and `statuses` are free-form blobs in this phase.

## Files

Planned:

- `src/gm-core/library/schemas.js`, `src/gm-core/library/schemas.d.ts`
- `src/gm-core/library/store.js`
- `src/gm-core/sheets/store.js`, `src/gm-core/sheets/operations.js`
- `src/gm-core/library/yaml.js` — `to_yaml_dict()` equivalent that
  renders a sheet for inclusion in actor prompts (Phase 5 will use this).
- `src/endpoints/gm.js` — extended with `/characters` and `/sheets`
  routes.
- `public/scripts/gm/character-wizard.js`
- `public/scripts/gm/sheet-panel.js` (read-only preview for Phase 2;
  full editor in Phase 5/10)
- `public/scripts/gm/party-panel.js`
- `src/gm-core/integrations/st-card-mirror.js` — calls existing ST
  character endpoints to write the avatar/name mirror.

## Schemas

`Character` (JSON, `{handle}/campaigns/{cid}/characters/{char_id}.json`):

```ts
type Character = {
    id: string;                      // slug
    campaign_id: string;
    name: string;
    is_player: boolean;              // exactly one Character per campaign with true (Phase 2)
    description: string;             // physical + personality description
    sheet: CharacterSheet;
    st_card_avatar: string | null;   // mirrored ST card avatar filename
    created_at: string;
    updated_at: string;
};

type CharacterSheet = {
    stats: Record<string, number | string>;   // e.g. { strength: 14, hp: 28, max_hp: 28, ac: 13, proficiency_bonus: 2 }
    statuses: Record<string, string>;         // e.g. { 'on_fire': '1d6 fire damage at start of turn' }
    items: Item[];
    skills: string[];                         // skill IDs proficient in (validated against ruleset in Phase 6)
    notes: string;                            // free-form player notes
};

type Item = {
    id: string;
    name: string;
    description: string;
    influences: string[];                     // stat keys this item modifies (informational; engine wiring in Phase 6+)
};
```

Sheet HTTP routes (planned, all under `/api/gm/sheets/{character_id}`):

- `GET /` — full snapshot.
- `PUT /stats/{key}` — set one stat.
- `PATCH /stats/{key}` — adjust by delta.
- `PUT /statuses/{key}` / `DELETE /statuses/{key}`.
- `POST /items` / `PUT /items/{id}` / `DELETE /items/{id}`.
- `PUT /skills` — replace whole list.
- `PUT /notes`.

## Acceptance criteria

- Creating a character through the wizard writes
  `{handle}/campaigns/{cid}/characters/{char_id}.json` and the Party
  panel shows the PC.
- Re-opening the campaign restores the same Character data.
- A ST character card with the same avatar appears in ST's
  characters dir (verifiable via `data/{handle}/characters/`).
- The sheet preview shows stats, items, and skills from the JSON.
- All HTTP routes accept and reject inputs per the schema (basic
  validation: types and required fields).

## Depends on

Phase 0, Phase 1 (full).
