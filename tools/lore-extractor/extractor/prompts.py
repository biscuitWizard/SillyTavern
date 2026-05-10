"""Prompt builders for the lore-extractor pipeline.

Three prompt families:

* Extraction (per chapter): ``extraction_system_prompt`` + ``extraction_user_prompt``
* Consolidation (cross-chapter): ``consolidate_lore_system_prompt`` /
  ``consolidate_character_system_prompt`` + ``consolidate_user_prompt_lore`` /
  ``consolidate_user_prompt_character``

Prompt builders take only DTOs and return strings — no I/O.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .schemas import ALLOWED_TAGS

if TYPE_CHECKING:
    from .fetcher import ChapterText
    from .schemas import CharacterCandidate, LoreCandidate

KIND_VOCAB = (
    "location, faction, culture, people, history, magic, artifact, bestiary, "
    "cosmology, language, pantheon, custom"
)
TIER_VOCAB = "deity | mortal_permanent"


def extraction_system_prompt() -> str:
    tags_csv = ", ".join(sorted(ALLOWED_TAGS))
    return f"""You are a careful worldbuilding archivist. Your job is to read one chapter of a fan-fiction story and extract ONLY the worldbuilding that exists independently of the plot, into a strict JSON schema.

Output two lists:

  - `lore[]`   — settings, factions, magic systems, history, etc.
  - `characters[]` — deities and permanent setting NPCs only.

You will be wrong by default. The pull toward extracting plot-driven content is strong. Resist it. When in doubt, EXCLUDE.

# Rule 1: lore inclusion (the would-this-be-true-without-the-story test)

A lore entry qualifies if it would still be true had the protagonist's story never been written and the protagonist never existed.

INCLUDE these `kind`s (closed vocabulary):
  {KIND_VOCAB}

Allowed `tags` (closed vocabulary; pick the subset that fits, or none):
  {tags_csv}

EXCLUDE:
  - Plot events ("Marcus rescued the princess").
  - Dialogue and inner monologue.
  - Party composition, gear acquired during the plot, kill counts.
  - Anything that requires a specific story character to make sense.
  - Individual deities (those go under characters[], not lore[]).

Lore few-shot:
  INCLUDE (location, [city]): "Ironhold — A walled trade city built around an iron mine, run by the Magnate Council."
  INCLUDE (pantheon, [pantheon, religion]): "The Twelve — a dodecad of gods organized into three orders of four."
  INCLUDE (history, [era]): "The Sundering Years — a 200-year period when the southern continent was torn from the mainland."
  INCLUDE (magic, [spell_system]): "Ley-binding — magic is woven from named ley lines; only those born in a node city can shape them."
  EXCLUDE: "Marcus's fight with the dragon" — plot event.
  EXCLUDE: "The protagonist's enchanted sword" — plot prop.
  EXCLUDE: "Helios, the Sun God" — individual deity, goes under characters[].
  EXCLUDE: "The Adventuring Party" — story-only construct.

# Rule 2: character inclusion (the permanence test)

A character qualifies for `characters[]` if and only if ALL THREE of the following hold:

  1. They existed before the protagonist's story began (or, for deities, pre-date mortals).
  2. They hold an institutional or cosmological position that defines them more than any relationship to the protagonist (deity, monarch, archmage, high priest, headmaster, guildmaster, ancient lich-king).
  3. They would still hold that position if the protagonist disappeared from the narrative.

If a character's importance is primarily defined by their plot role with the protagonist (mentor, love interest, rival, party member, recurring antagonist), EXCLUDE them.

`tier` is one of: {TIER_VOCAB}

HARD EXCLUSIONS, regardless of how much they appear in the chapter:
  - Demigods, chosen ones, ascended mortals, sealed champions, divine vessels.
  - Protagonists, antagonists, party members, love interests, mentors, rivals.
  - Characters introduced as the focus of a chapter or arc, unless the chapter explicitly frames them as a long-pre-existing institution.

Character few-shot:
  INCLUDE (deity): "Helios — the Sun God, who has ridden his chariot since the world was made."
  INCLUDE (mortal_permanent): "Queen Aldira — has ruled the Bright Kingdom for 40 years; pragmatic, unsmiling."
  INCLUDE (mortal_permanent): "Brother Marcus, head of the Iron Monastery — has held the post for 200 years."
  EXCLUDE: "Lyra, the Chosen of the Sun God" — demigod / chosen one.
  EXCLUDE: "Captain Aria, the protagonist's mentor and rival" — defined by relationship to protagonist.
  EXCLUDE: "Old Tom, the barmaid the protagonist befriends" — incidental NPC.

# Output rules

  - Every `body` must be 1-3 paragraphs of pure setting prose. Do not name story characters in lore bodies.
  - Every `starting_memories` entry on a character is a single first-person observation rooted in pre-plot history. Cap at 5 per character.
  - Every entry MUST include a `source_url` and SHOULD include a short `supporting_quote` (verbatim, <= 240 chars).
  - `confidence` is 1.0 when the source explicitly canonizes the fact, lower when inferring.
  - If the chapter contributes no new worldbuilding, return {{"lore": [], "characters": []}}.
  - NEVER invent worldbuilding the source did not state or strongly imply.
"""


def extraction_user_prompt(
    chapter: ChapterText,
    *,
    known_lore_titles: list[str],
    known_character_names: list[str],
) -> str:
    known_lore = ", ".join(sorted(set(known_lore_titles))) or "(none yet)"
    known_chars = ", ".join(sorted(set(known_character_names))) or "(none yet)"
    return f"""Source URL (use this verbatim as the `source_url` for every candidate):
  {chapter.url}

Chapter title: {chapter.title}

Already-extracted lore titles (mark new mentions of these as the same entity by reusing the title; do not add a duplicate entry):
  {known_lore}

Already-extracted character names (same rule):
  {known_chars}

# Chapter prose

{chapter.prose}
"""


def consolidate_lore_system_prompt() -> str:
    return f"""You are merging multiple per-chapter excerpts about the same worldbuilding entity into one canonical lore entry. The schema requires `id` (kebab-case stable), `title`, `body`, `tags`, `conflicts[]`, and `sources[]`.

Rules:

  - Preserve every concrete fact from the inputs. Do not drop details to "tighten" prose.
  - Drop plot references and story-character names from the merged body.
  - When two excerpts disagree on a concrete detail, record one short note per disagreement in `conflicts[]`. Pick the most-recent or highest-confidence value for the body.
  - `tags` is the union of input tags, filtered to the closed vocabulary: {", ".join(sorted(ALLOWED_TAGS))}
  - `sources[]` is every distinct `source_url` that contributed.
  - `id` MUST be lowercase kebab-case derived from the title; no spaces, no underscores.
"""


def consolidate_character_system_prompt() -> str:
    return f"""You are merging multiple per-chapter excerpts about the same permanent setting character into one canonical character entry. The schema requires `id`, `name`, `role`, `description`, `personality`, `voice`, `starting_memories[]` (cap 5), `tier`, `conflicts[]`, `sources[]`.

Rules:

  - Preserve every concrete fact about the character's pre-plot life.
  - `tier` is one of {TIER_VOCAB}.
  - **Permanence guard.** If the character no longer passes the permanence test on review, STILL EMIT the entry but add a `conflicts[]` entry of the form: "PERMANENCE_FAIL: <one-sentence reason>".
  - `starting_memories[]` is capped at 5. Pick the most distinctive ones; deduplicate near-paraphrases.
  - Drop story-arc context from `description` / `personality` / `voice`.
  - `sources[]` is every distinct `source_url` that contributed.
  - `id` MUST be lowercase kebab-case derived from the name.
"""


def consolidate_user_prompt_lore(title: str, candidates: list[LoreCandidate]) -> str:
    return _consolidate_user_prompt(
        kind_label="lore entry",
        title_label=f"title: {title}",
        excerpts=[
            (
                f"[#{i}] kind={c.kind}  source={c.source_url}  confidence={c.confidence}\n"
                f"  tags: {', '.join(c.tags) or '(none)'}\n"
                f"  body: {c.body}\n"
                f"  supporting_quote: {c.supporting_quote or '(none)'}"
            )
            for i, c in enumerate(candidates, start=1)
        ],
    )


def consolidate_user_prompt_character(name: str, candidates: list[CharacterCandidate]) -> str:
    return _consolidate_user_prompt(
        kind_label="character entry",
        title_label=f"name: {name}",
        excerpts=[
            (
                f"[#{i}] tier={c.tier}  source={c.source_url}  confidence={c.confidence}\n"
                f"  role: {c.role or '(unspecified)'}\n"
                f"  description: {c.description or '(none)'}\n"
                f"  personality: {c.personality or '(none)'}\n"
                f"  voice: {c.voice or '(none)'}\n"
                f"  starting_memories: {c.starting_memories or '(none)'}\n"
                f"  supporting_quote: {c.supporting_quote or '(none)'}"
            )
            for i, c in enumerate(candidates, start=1)
        ],
    )


def _consolidate_user_prompt(*, kind_label: str, title_label: str, excerpts: list[str]) -> str:
    body = "\n\n".join(excerpts)
    return f"""Merge the following per-chapter excerpts into one canonical {kind_label}.

{title_label}
excerpts: {len(excerpts)}

{body}
"""
