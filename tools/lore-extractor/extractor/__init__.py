"""Lore extractor — convert a fan-fiction series into a ttrpgtavern LorePack.

This is offline tooling. It walks a Scribblehub series, asks an LLM (Gemini
or any OpenAI-compat provider) to extract worldbuilding from each chapter into
structured ``LoreCandidate`` / ``CharacterCandidate`` records, consolidates
duplicates across chapters, and emits a ``setting.yaml`` in ttrpgtavern
``LorePack`` format plus ``_review.json`` for human audit before ingest.

The resulting ``setting.yaml`` is placed at
``data/lore-packs/<campaign-id>/setting.yaml`` in the ttrpgtavern repo and
picked up automatically by the wizard's "Seed lore" step.

Public surface:

  - schemas: ``LoreCandidate``, ``CharacterCandidate``, ``ChapterExtraction``,
    ``ConsolidatedLore``, ``ConsolidatedCharacter``, ``Kind``, ``Tier``,
    ``ALLOWED_TAGS``
  - extract: ``run_extraction(...)`` — top-level driver wired by the CLI.
"""

from .extract import ExtractionResult, run_extraction
from .schemas import (
    ALLOWED_TAGS,
    ChapterExtraction,
    CharacterCandidate,
    ConsolidatedCharacter,
    ConsolidatedLore,
    Kind,
    LoreCandidate,
    Tier,
)

__all__ = [
    "ALLOWED_TAGS",
    "ChapterExtraction",
    "CharacterCandidate",
    "ConsolidatedCharacter",
    "ConsolidatedLore",
    "ExtractionResult",
    "Kind",
    "LoreCandidate",
    "Tier",
    "run_extraction",
]
