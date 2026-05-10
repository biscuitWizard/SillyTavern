"""ttrpgtavern LorePack writer for the lore extractor.

Two outputs per run, both under ``<output_dir>/<campaign_id>/``:

* ``setting.yaml`` — written in ttrpgtavern ``LorePack`` shape (``pack_id``,
  ``pack_name``, ``description``, ``entries[]``). Each lore entry includes
  ``entry_kind``, ``importance``, and ``tags`` so the ttrpgtavern ingest
  pipeline can route and weight records correctly.
  Characters are folded into ``entry_kind: people`` lore entries rather than
  emitted as a separate ``characters`` list — this keeps everything in one
  file and works with the existing ``seed-packs.js`` / ``ingest.js`` without
  schema changes. Full NPC import (campaign library characters) is a separate
  future step.

* ``_review.json`` — full provenance: per-entry ``conflicts``, ``sources``,
  and per-character ``tier`` flag for human audit before ingest.

Per the ttrpgtavern ADR stack: the script's job ends at producing the YAML;
the operator picks the pack from the wizard's "Seed lore" step or calls
``applyLorePack()`` directly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from ._deps import get_logger
from .extract import ExtractionResult
from .schemas import ConsolidatedCharacter, ConsolidatedLore

log = get_logger(__name__)

# ttrpgtavern LoreEntry importance defaults by character tier
_TIER_IMPORTANCE = {"deity": 0.85, "mortal_permanent": 0.65}


def write_outputs(result: ExtractionResult, output_dir: Path) -> tuple[Path, Path]:
    """Write ``setting.yaml`` + ``_review.json`` for *result*.

    Returns ``(yaml_path, review_path)``.
    """
    out_root = (output_dir / result.campaign_id).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    pack_doc = _build_pack_doc(result)

    yaml_path = out_root / "setting.yaml"
    yaml_path.write_text(_dump_yaml(pack_doc), encoding="utf-8")
    log.info(
        "lore_writer.yaml_written",
        path=str(yaml_path),
        lore_entries=len(result.lore),
        character_entries=len(result.characters),
    )

    review_path = out_root / "_review.json"
    review_path.write_text(_build_review_json(result), encoding="utf-8")
    log.info("lore_writer.review_written", path=str(review_path))

    return yaml_path, review_path


# ---------------------------------------------------------------------------
# setting.yaml (ttrpgtavern LorePack shape)
# ---------------------------------------------------------------------------


def _build_pack_doc(result: ExtractionResult) -> dict[str, Any]:
    """Build the LorePack dict.

    Schema matches ttrpgtavern's ``LorePack`` / ``LoreEntry`` types in
    ``src/gm-core/lore/schemas.js``:

      pack_id, pack_name, description, entries: LoreEntry[]

    Each ``LoreEntry``: id, title, body, entry_kind, importance, tags,
    origin (fixed 'core'), source_type (fixed 'seed_pack').
    """
    series_display = result.series_url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ").title()

    entries: list[dict[str, Any]] = []

    # Lore entries
    for entry_kind, entry in result.lore:
        entries.append(_lore_to_entry(entry_kind, entry))

    # Characters → people lore entries
    for char in result.characters:
        entries.append(_character_to_entry(char))

    return {
        "pack_id": result.campaign_id,
        "pack_name": _humanize_id(result.campaign_id),
        "description": (
            f"Auto-extracted from the ScribbleHub serial \"{series_display}\" "
            f"({result.chapters_processed} chapters processed). "
            "Contains locations, factions, magic systems, history, artifacts, "
            "cosmology, and permanent setting characters as lore entries. "
            "Review _review.json before play to audit conflicts and character permanence flags."
        ),
        "entries": entries,
    }


def _lore_to_entry(entry_kind: str, entry: ConsolidatedLore) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": entry.id,
        "title": entry.title,
        "entry_kind": entry_kind,
        # Preserve the best-confidence value. For LLM-consolidated entries
        # (multi-chapter) we default to 0.8 since the merged body is broader.
        "importance": 0.8,
        "origin": "core",
        "source_type": "seed_pack",
        "body": entry.body.strip(),
    }
    if entry.tags:
        out["tags"] = list(entry.tags)
    return out


def _character_to_entry(char: ConsolidatedCharacter) -> dict[str, Any]:
    """Fold a character into a ``people`` lore entry.

    Body assembles all narrative fields in a readable format so the Narrator
    and Director can retrieve the character from world_lore RAG queries without
    a separate characters collection.
    """
    body_parts: list[str] = []
    if char.description:
        body_parts.append(char.description.strip())
    if char.role:
        body_parts.append(f"Role: {char.role.strip()}")
    if char.personality:
        body_parts.append(f"Personality: {char.personality.strip()}")
    if char.voice:
        body_parts.append(f"Voice: {char.voice.strip()}")
    if char.starting_memories:
        mem_lines = "\n".join(f"  - {m}" for m in char.starting_memories)
        body_parts.append(f"Memories (first-person, pre-plot):\n{mem_lines}")

    body = "\n\n".join(body_parts) if body_parts else char.name

    tags: list[str] = ["people"]
    if char.tier == "deity":
        tags.extend(["deity", "cosmology"])

    out: dict[str, Any] = {
        "id": char.id,
        "title": char.name,
        "entry_kind": "people",
        "importance": _TIER_IMPORTANCE.get(char.tier, 0.65),
        "origin": "core",
        "source_type": "seed_pack",
        "tags": tags,
        "body": body,
    }
    return out


def _humanize_id(campaign_id: str) -> str:
    return campaign_id.replace("-", " ").replace("_", " ").title()


def _dump_yaml(doc: dict[str, Any]) -> str:
    return yaml.safe_dump(
        doc,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=100,
    )


# ---------------------------------------------------------------------------
# _review.json
# ---------------------------------------------------------------------------


def _build_review_json(result: ExtractionResult) -> str:
    review: dict[str, Any] = {
        "campaign_id": result.campaign_id,
        "series_url": result.series_url,
        "chapters_processed": result.chapters_processed,
        "lore": [
            {
                "id": entry.id,
                "title": entry.title,
                "entry_kind": kind,
                "tags": list(entry.tags),
                "sources": list(entry.sources),
                "conflicts": list(entry.conflicts),
            }
            for kind, entry in result.lore
        ],
        "characters": [
            {
                "id": c.id,
                "name": c.name,
                "tier": c.tier,
                "role": c.role,
                "sources": list(c.sources),
                "conflicts": list(c.conflicts),
                "permanence_warnings": [
                    conflict for conflict in c.conflicts if conflict.startswith("PERMANENCE_FAIL")
                ],
            }
            for c in result.characters
        ],
    }
    return json.dumps(review, indent=2, ensure_ascii=False)


__all__ = ["write_outputs"]
