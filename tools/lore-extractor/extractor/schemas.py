"""Pydantic schemas for the lore extractor pipeline.

Two layers:

* **Per-chapter extraction.** ``LoreCandidate``, ``CharacterCandidate``, and
  the ``ChapterExtraction`` wrapper are filled by an LLM in a single
  structured-output call per chapter. They carry per-source provenance
  (``source_url``, ``supporting_quote``, ``confidence``) the consolidator
  later folds into ``sources``.

* **Cross-chapter consolidation.** ``ConsolidatedLore`` and
  ``ConsolidatedCharacter`` are produced by a second LLM call per
  ``(kind, normalized_title)`` or ``(tier, normalized_name)`` group. They
  validate as lore-pack shape plus internal fields (``conflicts``, ``sources``,
  ``tier``) the writer strips before YAML emission and keeps in ``_review.json``.

All Pydantic models use ``extra="forbid"`` so the OpenAI-compat structured
output gets a strict schema.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Closed vocabularies
# ---------------------------------------------------------------------------

Kind = Literal[
    "location",
    "faction",
    "culture",
    "people",
    "history",
    "magic",
    "artifact",
    "bestiary",
    "cosmology",
    "language",
    "pantheon",
    "custom",
]

Tier = Literal["deity", "mortal_permanent"]

ALLOWED_TAGS: frozenset[str] = frozenset(
    {
        "location", "city", "region", "landmark", "tavern", "temple", "wilderness", "plane",
        "faction", "organization", "guild", "order", "government", "criminal", "noble_house", "cult",
        "culture", "people", "ancestry", "language",
        "history", "era", "war", "treaty",
        "magic", "artifact", "spell_system",
        "bestiary", "species",
        "cosmology", "pantheon", "religion", "deity",
        "economy", "law", "tradition", "custom",
    }
)


# ---------------------------------------------------------------------------
# Per-chapter extraction
# ---------------------------------------------------------------------------


class LoreCandidate(BaseModel):
    """One worldbuilding candidate extracted from one chapter."""

    model_config = ConfigDict(extra="forbid")

    kind: Kind = Field(
        description="Closed vocabulary; pick the most specific. Never 'deity' here — deities are characters."
    )
    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    source_url: str
    supporting_quote: str = Field(default="", max_length=1000)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class CharacterCandidate(BaseModel):
    """One permanent setting character extracted from one chapter."""

    model_config = ConfigDict(extra="forbid")

    tier: Tier
    name: str = Field(min_length=1)
    role: str = Field(default="")
    description: str = Field(default="")
    personality: str = Field(default="")
    voice: str = Field(default="")
    starting_memories: list[str] = Field(default_factory=list)
    source_url: str
    supporting_quote: str = Field(default="", max_length=1000)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class ChapterExtraction(BaseModel):
    """Single per-chapter LLM call returns one of these."""

    model_config = ConfigDict(extra="forbid")

    lore: list[LoreCandidate] = Field(default_factory=list)
    characters: list[CharacterCandidate] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Consolidation outputs
# ---------------------------------------------------------------------------


class ConsolidatedLore(BaseModel):
    """A merged lore entry with provenance.

    The writer strips ``conflicts`` and ``sources`` before YAML emission and
    keeps them in ``_review.json``.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)


class ConsolidatedCharacter(BaseModel):
    """A merged character entry with provenance."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    role: str = ""
    description: str = ""
    personality: str = ""
    voice: str = ""
    starting_memories: list[str] = Field(default_factory=list)
    tier: Tier
    conflicts: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
