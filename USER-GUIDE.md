# TTRPG Tavern — User Guide

A frontend-focused walkthrough for setting up and playing a campaign.

This guide assumes the app is already running (`npm start` plus
`docker compose up -d qdrant`) and you can open it in a browser. If you
need help getting that far, see [README.md](README.md) for the
five-minute developer start.

---

## Quick map

```
Campaign Manager  →  Campaign Main  →  Scene  →  Campaign Main
       │                  │   │            │
       │                  │   └── Memory ──┤
   resume / new       start scene        end scene
```

Three primary surfaces and one optional one:

- **Campaign Manager** — the home screen. Pick or create a campaign.
- **Campaign Main** — the hub for a single campaign. Your character
  card, scene history, and the **Start Scene** button live here.
- **Scene** — where play actually happens. You type, the Director runs
  the turn, and the Narrator + characters answer.
- **Memory Explorer** — a per-campaign tab for browsing what the AI
  remembers (world lore, character notes, Director / Narrator notes,
  the player journal). Optional, but extremely useful for debugging
  and curating long campaigns.

---

## Before you start: connect a model

TTRPG Tavern dispatches every AI turn directly through your active
SillyTavern connection profile. The first thing the app does on every
campaign and scene view is verify that profile is healthy. Until it is,
the campaign content is dimmed and a banner appears with one big button:

> **Connection required** — Open API settings

Click that, or click the **plug icon** (`fa-plug`) in any topbar.
SillyTavern's standard API drawer opens. From there:

1. Open **Connection Manager**, choose or create a Connection Profile.
2. Pick a provider, fill in the URL / API key, and choose a model.
3. Click **Connect** until the status pill shows online.
4. (Optional) On that same profile, set per-role model overrides:
   - `gm-director-model`
   - `gm-narrator-model`
   - `gm-actor-model`
   These fields let the Director, Narrator, and AI characters all use
   the *same* connection but different models. Leave them blank to use
   the profile's default model for every role.

When the gate clears, the dim disappears, the banner is removed, and
**Start Scene** + **New campaign** become live. If the connection ever
drops (token expired, server restart), the banner returns until you
reconnect — your work is not lost.

---

## 1. Create a campaign

From the **Campaign Manager**:

1. Click **New campaign** (top-right) or the dashed **+ New Campaign**
   tile in the grid.
2. Fill in the modal:
   - **Name** — required. The displayed campaign title.
   - **Brief** — a one- or two-sentence pitch. Shows on the campaign
     card and in the campaign hero banner. The Director treats this
     as setting flavor.
   - **Ruleset** — defaults to `dnd5e`. This decides the starter stat
     pack pre-filled into your character sheet, and which skills /
     dice rules adjudicate skill checks. (Phase 6 expands this; for
     now `dnd5e` is the supported default.)
   - **Banner theme** — purely cosmetic; pick whatever fits the vibe.
3. Click **Create**.

You land on **Campaign Main** for the new campaign.

> **Tip:** Each campaign is fully isolated. Characters, scenes, and AI
> memories from one campaign do not bleed into another.

---

## 2. Create your character

The first time you open a campaign without a player character, the
**Character wizard** opens automatically. (You can also open it later
with **Create your character** on Campaign Main.)

The wizard runs a four-step flow for the **player character** (PC):

### Step 1 — Identity

- **Name** — the character's name. The Director, Narrator, and
  every NPC will use this.
- **Appearance** — short physical description. Shown on the
  sidebar card and seeded into AI prompts.
- **Personality** — how they act under pressure, who they are. The
  Director uses this to decide when this character would or would
  not push back on something.
- **Voice** — speech cadence, idioms, accent — anything that gives
  this person a recognizable mouth. The Actor LLM reads this when
  voicing the PC's reactions to NPC dialogue.

### Step 2 — Background

This step is **only for the PC**, and it matters more than it looks.

The Director treats your background as canon and seeds the world
from it. Locations you mention, NPCs you reference, secrets you
hint at — they're allowed to show up in scenes. A few paragraphs
beats one good sentence.

A useful structure:

> Where does your character come from? What did they leave behind?
> What brings them here, and what do they hope for?  What do they
> fear?

### Step 3 — Stats

A key/value grid pre-filled from your ruleset's starter pack
(`dnd5e` ships level, HP, AC, the six abilities, etc.). You can:

- Edit any value in place.
- Delete a stat with the trash icon.
- Click **+ Add stat** to add a new key/value of your own.

Empty values are dropped on save. Numeric-looking values are stored
as numbers; everything else stays as text.

### Step 4 — Confirm

A read-only summary. Click **Create character** to commit, or
**Back** to edit anything.

The character is saved to disk under the active campaign and
immediately appears on the left sidebar of Campaign Main.

> **NPCs** use the same wizard with no Background step. You create
> NPCs from inside a scene — see "Add NPCs to a scene" below.

---

## 3. The Campaign Main hub

This is the per-campaign home. Three things live here:

### Left sidebar — your character

- Portrait (avatar) and name.
- "Player character" tag and the appearance line you wrote.
- A compact **key stats** grid (level, HP, AC, the six abilities
  if present, then the next few stats up to 12 cells).
- **Open sheet** opens the full KV editor. From there you can:
  - Edit any stat or status.
  - Add new keys.
  - Delete keys.
  - Saves are immediate; the sidebar refreshes live.

### Hero banner + body

- Banner shows the campaign name, brief, ruleset chip, and a
  scene count + "last played" timestamp.
- **Start Scene** is the primary action. It creates a fresh scene
  and routes you straight into Scene mode.
- **Scene history** lists every scene in the campaign, newest
  first, with status (Active / Closed), last-played time, and
  message count. Click any row to reopen it. Closed scenes open
  read-only.

### Topbar

- **Back arrow** → Campaign Manager.
- **Hub / Memory** tab switcher (see "Memory Explorer" below).
- **Plug icon** → API settings drawer.
- **Trash icon** → delete this campaign. Asks to confirm; the
  campaign, its characters, scenes, and Qdrant memory collections
  are all removed together.

---

## 4. Run a scene

Click **Start Scene**. The view flips into Scene mode:

- **Center column** is SillyTavern's chat surface — every line in
  the scene scrolls here.
- **Left sidebar** keeps your PC card pinned.
- **Right sidebar** is the **In scene** roster of every character
  currently participating.
- **Top input bar** is where you type. The placeholder reads:
  *"Describe what your character does next…"*

### Take a turn

1. Type your intent in the input bar.

   Good examples:
   > Jack draws his sword and slowly walks toward the door.
   > I try to talk Amelia down — she knows me.
   > "Who told you that?" I ask, trying to keep my voice level.

2. Press **Enter** (or the send button).
3. The Director runs. A small chip near the top right shows what's
   happening:
   - *Director thinking…* — deciding what to do.
   - *Voice incoming…* — the Narrator or an AI character is about
     to speak.
   - *Rolling…* — a skill check just got requested.
   - *Wrapping up…* — the turn is closing.
4. Lines stream in:
   - **Narrator** lines (italic prose-style) describe what the world
     does or how it changes.
   - **Actor** lines (an NPC speaking in their voice) appear under
     the NPC's name and portrait.
   - **Roll cards** appear inline when the Director requests a skill
     check, showing the d20, modifier, and pass / fail.
5. When the turn ends, the chip clears and you can type again.

### Add NPCs to a scene

The right sidebar's **Add to scene** button opens a small picker:

- **Existing characters** in this campaign that aren't already in the
  scene — click to add.
- **Create NPC** — opens the same character wizard in NPC mode
  (Identity → Stats → Confirm; no Background step). After you
  create an NPC this way, they're automatically added to the scene.

The Director can also spawn NPCs on its own as the story develops
(`spawn` events). Either way, the roster updates live.

Click any NPC card to open their sheet — exactly the same editor
as the PC sheet. You're free to tweak NPC stats whenever you want.

### End a scene

Click **End Scene** in the top-right. After confirming, the scene
is closed, summarized server-side, and the relevant memories are
written into the campaign's stores. You're returned to Campaign
Main, with the scene now visible in **Scene history** as
"Closed".

You can reopen a closed scene from history; it loads read-only so
you can re-read what happened without nudging the AI.

### If something goes wrong

- **No connection profile / no model** — the input bar refuses to
  send and you're routed to the API drawer with a system message
  explaining what's missing. Fix the profile, click Connect, then
  retry.
- **Turn errors** — a system-styled message appears in the chat,
  the chip flashes "Turn failed" briefly, and the input is freed
  so you can adjust and retry.
- **Back arrow mid-turn** — aborts the in-flight turn and returns
  to Campaign Main. The transcript still has whatever finished
  streaming.

---

## 5. The Memory Explorer

Once a campaign exists, a **Memory** tab is exposed in the campaign
topbar (next to **Hub**). Click it to open the **Memory Explorer**.

This is where you inspect, filter, and edit everything the AI
remembers for this campaign. It's organized into five collections:

| Collection           | What it holds                                                                |
|----------------------|------------------------------------------------------------------------------|
| **World Lore**       | Shared canon — facts about the world. Both seeded "core" lore and "generated" lore the Director added during play. |
| **Character memory** | One row per character (PC and NPC). Each character's first-person opinions, observations, and notes. Private to that character. |
| **Director Memory**  | Director-only pacing notes: what beats hit, what to set up later. The player can read these here; the LLM never shows them in scene. |
| **Narrator Memory**  | The Narrator's continuity notes: what the room currently feels like, recurring sensory details, established weather. |
| **Player Journal**   | What the player has actually seen / been told. Useful as a recap. |

### Layout

- **Left rail** — the collection list. World Lore is at the top, each
  character has their own row, then Director, Narrator, Player
  Journal. Click a row to focus that collection.
- **Center pane** — the records in the focused collection.
  - **Search** — free-text search; runs against the vector store with a
    short debounce.
  - **Tags** — comma-separated tag filter (e.g. `eldoria, faction`).
  - **Origin / Entry kind** filters appear when World Lore is active
    (e.g. only `core` entries, only `location` entries).
  - The summary line shows how many records are loaded; **Load more**
    paginates.
- **Right pane** — the record editor for whatever row you click.
  Edit content, tags, importance, valence, and "temporally blind"
  (excludes from memory decay). World Lore records also expose the
  origin and entry kind selectors.
  - **Save** writes through to disk first and Qdrant second.
  - **Delete** asks to confirm, then removes the record everywhere.

### Topbar actions

- **Hub / Memory** tab switcher mirrors the campaign topbar.
- **Seed lore** — opens a menu of available **lore packs** (bundled
  starter worlds). Pick one (e.g. *Eldoria — The Twilit Forest*) to
  ingest its entries straight into this campaign's World Lore. Safe
  to run multiple times; ingestion is idempotent.
- **Reconcile** — re-runs the disk-canonical reconcile pass. Use this
  if Qdrant ever looks empty (e.g. you wiped its volume) — the records
  on disk are replayed and the index is rebuilt. A toast reports the
  result (`ingested 12 · reembedded 0 · pruned 0`).
- **Plug icon** — same API settings drawer.

### Live feed

A collapsible panel in the corner tails **memory writes** as they
happen. While a turn is running, you can watch new opinions, lore
entries, and continuity notes flash in. Useful for sanity-checking
what the AI is committing to memory.

### Health banner

If Qdrant is unreachable (Docker stopped, port collision), a yellow
banner appears at the top of the Explorer:

> Qdrant unreachable at http://localhost:6333. Records may be
> served from the disk mirror only.

The disk mirrors are the source of truth — the app keeps working —
but search quality degrades until Qdrant comes back. Bring it back
with `docker compose up -d qdrant`, then click **Reconcile**.

---

## 6. Putting it together — a typical session

1. Launch the app, click the **plug icon**, confirm Connection Profile
   is selected and online.
2. **New campaign** → name it, write a brief, pick a banner.
3. Wizard pops automatically: Identity → Background (write a few
   paragraphs!) → Stats → Confirm.
4. *(Optional)* Open **Memory** → **Seed lore** → apply a starter
   pack so the world has something to draw from.
5. Back on Hub, click **Start Scene**.
6. Type your intent. Read the Narrator, react to NPCs, watch roll
   cards, type again. Repeat.
7. *(Optional)* Add an NPC mid-scene from the **In scene** sidebar,
   either from the existing roster or a fresh **Create NPC** flow.
8. **End Scene** when the beat feels finished.
9. Open **Memory** to see what got remembered. Edit anything that's
   off — the AI is using these notes next turn.
10. Hit **Start Scene** again, or come back tomorrow; the campaign
    resumes exactly where you left off.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Hub content is dim with a yellow banner | No connection profile, no model on the profile, or ST reports offline | Open API settings, fix the profile, click **Connect**. |
| Pressing Enter does nothing | Same as above | Same fix. The input only sends when the gate is clear. |
| Wizard never opens for a brand-new campaign | Connection gate is still closed | Connect first; the wizard auto-opens after the gate clears. |
| Avatars are missing | Character was created without uploading a portrait | Open the sheet panel; portraits are optional, the icon fallback is fine. |
| Memory tab is empty | New campaign, no memories yet | Run a scene, or click **Seed lore** in the Memory Explorer. |
| Memory Explorer health banner appears | Qdrant container is down | `docker compose up -d qdrant`, then click **Reconcile**. |
| Turn errors with a red system message | Provider rate limit, bad API key, model timed out | Check the message; fix the connection; retry. The transcript is preserved. |

---

## 8. Where data lives

You generally don't need this section to play, but it helps when you
want to back things up.

- **Campaigns / characters / scenes / transcripts** — JSON / JSONL
  files in your per-user data directory.
- **World lore (core)** — YAML files inside the campaign's `lore/core/`
  directory (seeded from lore packs).
- **World lore (generated) + all memory types** — JSONL append-only
  mirrors. These are the source of truth.
- **Vector index** — Qdrant. Always rebuildable from the JSONL mirrors
  via the Reconcile button.

A campaign is portable: copy its directory and the lore packs you used,
and you can restore everything (including memory) on another machine
by running **Reconcile** once.

---

## 9. Keyboard cheat-sheet

| Where | Key | What it does |
|---|---|---|
| Scene input | **Enter** | Send the player message and run the turn. |
| Scene input | **Shift+Enter** | Newline (no send). |
| Sheet panel | **Esc** | Close the sheet modal. |
| Character wizard | **Esc** / click overlay | Cancel the wizard. |
| Memory Explorer | Click left rail row | Switch active collection. |
| Memory Explorer | Click center row | Open in the right-pane editor. |

---

That's the whole frontend loop. Anything you can do from a
keyboard-and-screen perspective is documented above. Deeper internals
(prompts, memory schemas, Director loop, ruleset adapters) live under
[`docs/`](docs/) and [`DESIGN.md`](DESIGN.md).
