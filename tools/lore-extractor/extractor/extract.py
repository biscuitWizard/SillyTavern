"""End-to-end lore extraction pipeline.

Stages:

  1. ``discover_chapters(series_url)``  — single TOC AJAX call.
  2. *per chapter*: ``extract_chapter(...)`` — one structured LLM call returning
     a ``ChapterExtraction`` (lore + characters). Result cached to disk.
  3. ``group_lore(...)`` and ``group_characters(...)`` — pure local grouping
     by ``(kind, normalized_title)`` and ``(tier, normalized_name)``.
  4. *per group*: ``consolidate_lore_group(...)`` /
     ``consolidate_character_group(...)`` — one structured LLM call each.
  5. Closed-tag filter + final validation; ``run_extraction`` returns an
     :class:`ExtractionResult` the writer module turns into a ttrpgtavern
     ``LorePack`` YAML plus ``_review.json``.

The pipeline is sequential so ``known_titles`` / ``known_names`` recaps thread
into each prompt correctly.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from ._deps import LLMClient, StructuredOutputError, get_logger
from .fetcher import (
    DEFAULT_RPS,
    ChapterRef,
    ChapterText,
    _PolitenessGate,
    _client,
    discover_chapters,
    fetch_chapter,
)
from .prompts import (
    consolidate_character_system_prompt,
    consolidate_lore_system_prompt,
    consolidate_user_prompt_character,
    consolidate_user_prompt_lore,
    extraction_system_prompt,
    extraction_user_prompt,
)
from .schemas import (
    ALLOWED_TAGS,
    ChapterExtraction,
    CharacterCandidate,
    ConsolidatedCharacter,
    ConsolidatedLore,
    Kind,
    LoreCandidate,
)

log = get_logger(__name__)

#: Bump when prompts or output schemas change; invalidates per-chapter cache.
PROMPT_VERSION = "v1"

MAX_STARTING_MEMORIES = 5


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ExtractionResult:
    """Everything the writer needs to emit the ttrpgtavern lore pack + review JSON."""

    campaign_id: str
    series_url: str
    chapters_processed: int
    #: List of (entry_kind, consolidated_entry) pairs. The kind is determined
    #: from the grouping key and stored alongside the entry rather than inside
    #: ConsolidatedLore to avoid polluting the LLM schema.
    lore: list[tuple[str, ConsolidatedLore]] = field(default_factory=list)
    characters: list[ConsolidatedCharacter] = field(default_factory=list)
    skipped_tags: dict[str, list[str]] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Per-chapter extraction (cached)
# ---------------------------------------------------------------------------


def _candidates_cache_path(output_dir: Path, chapter_url: str) -> Path:
    key = hashlib.sha1(f"{PROMPT_VERSION}::{chapter_url}".encode()).hexdigest()
    return output_dir / "_cache" / "candidates" / f"{key}.json"


_SCHEMA_REMINDER = """

# IMPORTANT — schema reminder, your previous attempt failed validation

Re-read the schema. The two lists have DIFFERENT field names:

  - `lore[]` items use:       title, body, kind, tags
  - `characters[]` items use: name, description, role, personality, voice, starting_memories, tier

Do NOT put `title` or `body` on a `characters[]` item. Do NOT put `name` or
`description` on a `lore[]` item. Both lists may be empty.

Return strict JSON only — no commentary, no markdown fence.
"""


async def extract_chapter(
    chapter: ChapterText,
    *,
    client: LLMClient,
    output_dir: Path,
    known_lore_titles: list[str],
    known_character_names: list[str],
) -> ChapterExtraction:
    """One structured LLM call per chapter. Cached by chapter URL + prompt version."""
    cache_path = _candidates_cache_path(output_dir, chapter.url)
    if cache_path.is_file():
        log.debug("lore_extract.candidates_cache_hit", url=chapter.url)
        return ChapterExtraction.model_validate_json(cache_path.read_text(encoding="utf-8"))

    sys_prompt = extraction_system_prompt()
    user_prompt = extraction_user_prompt(
        chapter,
        known_lore_titles=known_lore_titles,
        known_character_names=known_character_names,
    )
    log.info(
        "lore_extract.calling_llm",
        url=chapter.url,
        chapter_chars=len(chapter.prose),
        known_lore=len(known_lore_titles),
        known_chars=len(known_character_names),
    )
    try:
        extraction = await client.structured(schema=ChapterExtraction, system=sys_prompt, user=user_prompt)
    except StructuredOutputError as exc:
        details = getattr(exc, "details", {}) or {}
        finish_reason = details.get("finish_reason")
        if finish_reason and (finish_reason.startswith("prompt_blocked") or "SAFETY" in finish_reason):
            raise
        log.info("lore_extract.retrying_with_schema_reminder", url=chapter.url)
        extraction = await client.structured(
            schema=ChapterExtraction,
            system=sys_prompt,
            user=user_prompt + _SCHEMA_REMINDER,
        )

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(extraction.model_dump_json(indent=2), encoding="utf-8")
    log.info("lore_extract.chapter_done", url=chapter.url, lore=len(extraction.lore), characters=len(extraction.characters))
    return extraction


# ---------------------------------------------------------------------------
# Grouping
# ---------------------------------------------------------------------------

_STRIP_TOKENS = (
    "the ", "a ", "an ", "city of ", "kingdom of ", "land of ",
    "house of ", "order of ", "temple of ", "god of ", "goddess of ",
    "lord ", "lady ", "king ", "queen ", "saint ",
)


def normalize_title(title: str) -> str:
    t = title.strip().lower()
    t = re.sub(r"\([^)]*\)", " ", t)
    t = t.split(",", 1)[0]
    for tok in _STRIP_TOKENS:
        if t.startswith(tok):
            t = t[len(tok):]
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t or "untitled"


def group_lore(candidates: list[LoreCandidate]) -> dict[tuple[str, str], list[LoreCandidate]]:
    out: dict[tuple[str, str], list[LoreCandidate]] = {}
    for c in candidates:
        key = (c.kind, normalize_title(c.title))
        out.setdefault(key, []).append(c)
    return out


def group_characters(candidates: list[CharacterCandidate]) -> dict[tuple[str, str], list[CharacterCandidate]]:
    out: dict[tuple[str, str], list[CharacterCandidate]] = {}
    for c in candidates:
        key = (c.tier, normalize_title(c.name))
        out.setdefault(key, []).append(c)
    return out


# ---------------------------------------------------------------------------
# Per-group consolidation
# ---------------------------------------------------------------------------


async def consolidate_lore_group(
    title: str, candidates: list[LoreCandidate], *, client: LLMClient
) -> ConsolidatedLore:
    if len(candidates) == 1:
        c = candidates[0]
        return ConsolidatedLore(
            id=normalize_title(c.title),
            title=c.title,
            body=c.body,
            tags=list(_filter_tags(c.tags)),
            conflicts=[],
            sources=[c.source_url],
        )

    sys_prompt = consolidate_lore_system_prompt()
    user_prompt = consolidate_user_prompt_lore(title, candidates)
    merged = await client.structured(schema=ConsolidatedLore, system=sys_prompt, user=user_prompt)
    forced_id = normalize_title(merged.title) or merged.id
    return merged.model_copy(
        update={
            "id": forced_id,
            "tags": list(_filter_tags(merged.tags)),
            "sources": _dedupe_preserve_order(
                [*merged.sources, *(c.source_url for c in candidates)]
            ),
        }
    )


async def consolidate_character_group(
    name: str, candidates: list[CharacterCandidate], *, client: LLMClient
) -> ConsolidatedCharacter:
    if len(candidates) == 1:
        c = candidates[0]
        return ConsolidatedCharacter(
            id=normalize_title(c.name),
            name=c.name,
            role=c.role,
            description=c.description,
            personality=c.personality,
            voice=c.voice,
            starting_memories=list(c.starting_memories[:MAX_STARTING_MEMORIES]),
            tier=c.tier,
            conflicts=[],
            sources=[c.source_url],
        )

    sys_prompt = consolidate_character_system_prompt()
    user_prompt = consolidate_user_prompt_character(name, candidates)
    merged = await client.structured(schema=ConsolidatedCharacter, system=sys_prompt, user=user_prompt)
    forced_id = normalize_title(merged.name) or merged.id
    return merged.model_copy(
        update={
            "id": forced_id,
            "starting_memories": list(merged.starting_memories[:MAX_STARTING_MEMORIES]),
            "sources": _dedupe_preserve_order(
                [*merged.sources, *(c.source_url for c in candidates)]
            ),
        }
    )


def _filter_tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    for t in tags:
        norm = t.strip().lower().replace(" ", "_")
        if norm in ALLOWED_TAGS:
            out.append(norm)
        elif norm:
            log.debug("lore_extract.tag_filtered", tag=t)
    return _dedupe_preserve_order(out)


def _dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------


async def run_extraction(
    *,
    series_url: str,
    campaign_id: str,
    output_dir: Path,
    client: LLMClient,
    max_chapters: int | None = None,
    only_chapter: str | None = None,
    rps: float = DEFAULT_RPS,
) -> ExtractionResult:
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    gate = _PolitenessGate(rps)
    async with _client() as http:
        chapters = await discover_chapters(series_url, output_dir=output_dir, gate=gate, client=http)
        log.info("lore_extract.toc_loaded", series_url=series_url, chapter_count=len(chapters))

        chapters = _filter_chapters(chapters, only_chapter=only_chapter, max_chapters=max_chapters)

        all_lore: list[LoreCandidate] = []
        all_chars: list[CharacterCandidate] = []
        known_lore_titles: list[str] = []
        known_char_names: list[str] = []

        for ref in chapters:
            try:
                chapter = await fetch_chapter(ref.url, output_dir=output_dir, gate=gate, client=http)
            except Exception as exc:
                log.error("lore_extract.fetch_failed", url=ref.url, error=str(exc))
                continue

            try:
                extraction = await extract_chapter(
                    chapter,
                    client=client,
                    output_dir=output_dir,
                    known_lore_titles=known_lore_titles,
                    known_character_names=known_char_names,
                )
            except StructuredOutputError as exc:
                details = getattr(exc, "details", {}) or {}
                log.error(
                    "lore_extract.structured_output_failed",
                    url=ref.url,
                    error=str(exc),
                    finish_reason=details.get("finish_reason"),
                )
                continue

            all_lore.extend(extraction.lore)
            all_chars.extend(extraction.characters)
            for c in extraction.lore:
                if c.title not in known_lore_titles:
                    known_lore_titles.append(c.title)
            for c in extraction.characters:
                if c.name not in known_char_names:
                    known_char_names.append(c.name)

    log.info(
        "lore_extract.candidates_collected",
        lore_candidates=len(all_lore),
        character_candidates=len(all_chars),
    )

    lore_groups = group_lore(all_lore)
    char_groups = group_characters(all_chars)
    log.info("lore_extract.groups_built", lore_groups=len(lore_groups), character_groups=len(char_groups))

    # (entry_kind, ConsolidatedLore) pairs — kind comes from the grouping key
    consolidated_lore: list[tuple[str, ConsolidatedLore]] = []
    consolidated_chars: list[ConsolidatedCharacter] = []

    for (kind, _slug), group in sorted(lore_groups.items()):
        try:
            merged = await consolidate_lore_group(group[0].title, group, client=client)
            consolidated_lore.append((kind, merged))
        except StructuredOutputError as exc:
            log.error("lore_extract.consolidate_lore_failed", kind=kind, title=group[0].title, error=str(exc))

    for (tier, _slug), group in sorted(char_groups.items()):
        try:
            merged = await consolidate_character_group(group[0].name, group, client=client)
            consolidated_chars.append(merged)
        except StructuredOutputError as exc:
            log.error("lore_extract.consolidate_character_failed", tier=tier, name=group[0].name, error=str(exc))

    consolidated_lore = _dedupe_lore_by_id(consolidated_lore)
    consolidated_chars = _dedupe_chars_by_id(consolidated_chars)

    log.info(
        "lore_extract.run_complete",
        lore_entries=len(consolidated_lore),
        characters=len(consolidated_chars),
        chapters=len(chapters),
    )

    return ExtractionResult(
        campaign_id=campaign_id,
        series_url=series_url,
        chapters_processed=len(chapters),
        lore=consolidated_lore,
        characters=consolidated_chars,
    )


def _filter_chapters(
    chapters: list[ChapterRef],
    *,
    only_chapter: str | None,
    max_chapters: int | None,
) -> list[ChapterRef]:
    if only_chapter:
        chapters = [c for c in chapters if only_chapter in c.url]
    if max_chapters is not None:
        chapters = chapters[:max_chapters]
    return chapters


def _dedupe_lore_by_id(items: list[tuple[str, ConsolidatedLore]]) -> list[tuple[str, ConsolidatedLore]]:
    seen: set[str] = set()
    out: list[tuple[str, ConsolidatedLore]] = []
    for kind, entry in items:
        if entry.id in seen:
            log.warning("lore_extract.duplicate_lore_id_dropped", id=entry.id)
            continue
        seen.add(entry.id)
        out.append((kind, entry))
    return out


def _dedupe_chars_by_id(items: list[ConsolidatedCharacter]) -> list[ConsolidatedCharacter]:
    seen: set[str] = set()
    out: list[ConsolidatedCharacter] = []
    for item in items:
        if item.id in seen:
            log.warning("lore_extract.duplicate_char_id_dropped", id=item.id)
            continue
        seen.add(item.id)
        out.append(item)
    return out


def load_cached_extraction(output_dir: Path, chapter_url: str) -> ChapterExtraction | None:
    path = _candidates_cache_path(output_dir, chapter_url)
    if not path.is_file():
        return None
    return ChapterExtraction.model_validate_json(path.read_text(encoding="utf-8"))


__all__ = [
    "ExtractionResult",
    "MAX_STARTING_MEMORIES",
    "PROMPT_VERSION",
    "consolidate_character_group",
    "consolidate_lore_group",
    "extract_chapter",
    "group_characters",
    "group_lore",
    "load_cached_extraction",
    "normalize_title",
    "run_extraction",
]
