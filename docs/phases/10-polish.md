# Phase 10 — Polish

Status: Pending.

## Goal

Make the system ergonomic for actual play: per-role model assignments,
ruleset picker, lore editor, memory inspector, campaign import/export,
and the deferred-feature affordances we left as placeholders in
earlier phases.

## Scope

This phase is a checklist of independently-shippable polish items.
Order is suggested but not strict.

1. **Per-role model assignments**
   - Settings UI to pick which connection profile (and optionally
     model override) is used for each role: Director, Narrator,
     Actors, Skill-check adjudicator, Embedder.
   - Persisted to `{handle}/gm/settings.json`.
   - Reflected in a small status pill on the Scene view ("Director:
     gpt-4o · Narrator: claude-3.5").

2. **Ruleset picker + import**
   - Browse rulesets (bundled + user packs).
   - Activate a ruleset for a campaign (changes `Campaign.ruleset_id`).
   - Import a ruleset zip into `{handle}/rulesets/`.
   - View a ruleset's skill list + DC bands in a read-only panel.

3. **Lore editor**
   - List, view, create, edit, delete world facts (which are also
     written into `world_fact__{campaign_id}` for retrieval).
   - Tag editor; recency decay toggle per fact.

4. **Memory inspector**
   - Per-character memory browser: list, search, view, delete.
   - "What did the actor see in their last call" debug view that
     dumps the actually-built prompt (for trust-building, not for
     editing).

5. **AI-driven character generation**
   - "Generate from pitch" path that takes a short pitch +
     ruleset and fills in a draft character (sheet, description,
     starting memories). Player edits, then saves.
   - Bundle the legacy `charactergen` prompts as a starting point.

6. **Campaign import / export**
   - Export a campaign as a single zip:
     `campaign.json + characters/* + lore/* + scenes/* + a Qdrant
     dump for the relevant collections`.
   - Import the inverse.
   - Used both for portability and for sharing seed campaigns.

7. **Scene-end preview**
   - "Preview summary" button on End Scene that runs the pipeline
     in dry-run mode and shows the proposed summary + memories
     before committing.

8. **Per-actor mute / chip UI**
   - Right-click an actor chip in the Party panel to mute them in
     the current scene (Director may not pick them).

9. **Onboarding polish**
   - Empty-state copy on the Campaign Manager when no campaigns
     exist.
   - First-run dialog that points the user at "Create your first
     campaign" and at the bundled ruleset.
   - Inline help on the character wizard.

10. **Telemetry-free debug overlay**
    - Toggleable HUD that shows: current Director step, retries,
      per-call latency, prompt length, RAG snippet count. No data
      leaves the machine.

## Out of scope

- A mobile-first / tablet-first responsive redesign.
- Multi-user collaboration / shared campaigns.
- Real-time push-based scene updates (still request/response NDJSON).
- Anything not listed above; new items go in a Phase 11+ doc rather
  than expanding this phase.

## Files

This phase touches many small surfaces; specific file lists land in
the per-item PRs. Anchor points:

- `public/scripts/gm/settings.js` (new) — model-per-role panel.
- `public/scripts/gm/lore-editor.js`, `memory-inspector.js`,
  `ruleset-picker.js` (new).
- `src/endpoints/gm.js` — extended endpoints for import/export and
  the inspector views.
- `src/gm-core/charactergen/` — ported AI character generation.
- `src/gm-core/portability/{export,import}.js` — campaign zips.

## Acceptance criteria

Each item ships independently with its own acceptance bar:

- Per-role model assignment: changing it changes which provider is
  hit for that role in the next turn, observable in logs.
- Ruleset picker: switching a campaign's ruleset changes which YAML
  pack the skill-check engine loads.
- Lore editor: a fact created in the editor is retrievable from
  Qdrant immediately and shows up in actor prompts.
- Memory inspector: the dumped prompt for an actor matches what the
  Narrator-call test asserts.
- AI character gen: a generated draft passes schema validation and
  can be saved without manual edits.
- Campaign export → import on a fresh data dir produces a working
  campaign with all scenes and memories intact.
- Preview summary shows the same output that End Scene would
  produce, modulo non-determinism.

## Depends on

All earlier phases. Each polish item lists its specific dependency in
its own PR.
