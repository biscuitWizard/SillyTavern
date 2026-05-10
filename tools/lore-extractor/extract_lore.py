#!/usr/bin/env python3
"""Lore extractor CLI — ttrpgtavern edition.

Walks a Scribblehub series, asks an LLM to extract worldbuilding into
structured records, consolidates duplicates across chapters, and emits a
ttrpgtavern ``LorePack`` (``setting.yaml``) plus a provenance file
(``_review.json``) under ``<output_dir>/<campaign_id>/``.

Quick start (Gemini, free tier):

    export GEMINI_API_KEY=<your-key>
    cd tools/lore-extractor
    pip install -r requirements.txt
    python extract_lore.py \\
        --series-url https://www.scribblehub.com/series/580870/this-ascent-to-divinity-is-lewder-than-expected/ \\
        --campaign-id ascent-to-divinity \\
        --output-dir ../../data/lore-packs

The resulting ``setting.yaml`` at ``data/lore-packs/<campaign-id>/setting.yaml``
is immediately usable from the wizard's "Seed lore" step.

Re-running is idempotent: per-chapter extraction results are cached under
``<output_dir>/_cache/candidates/``; unchanged chapters are not re-fetched.
Use ``--refresh`` to wipe the HTML cache and re-fetch all chapters.

Alternate provider (any OpenAI-compat endpoint):

    export OPENAI_API_KEY=<your-key>
    python extract_lore.py \\
        --series-url ... --campaign-id ... \\
        --base-url https://api.openai.com/v1 \\
        --model gpt-4o \\
        --api-key-env OPENAI_API_KEY
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Allow running as `python extract_lore.py` from the tools/lore-extractor/ dir
# without installing the package, and also as `python -m tools.lore-extractor.extract_lore`
# from the repo root.
sys.path.insert(0, str(Path(__file__).parent))

from extractor._deps import (
    DEFAULT_GEMINI_BASE_URL,
    GEMINI_HOST,
    SAFETY_OFF,
    GeminiNativeClient,
    LLMClient,
    OpenAICompatClient,
    configure_logging,
    get_logger,
)
from extractor.extract import run_extraction
from extractor.fetcher import DEFAULT_RPS, clear_cache
from extractor.writer import write_outputs

DEFAULT_MODEL = "gemini-2.5-flash"

log = get_logger(__name__)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Extract worldbuilding from a Scribblehub series into a ttrpgtavern LorePack.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--series-url",
        required=True,
        help="Scribblehub series URL, e.g. https://www.scribblehub.com/series/580870/<slug>/",
    )
    p.add_argument(
        "--campaign-id",
        required=True,
        help="kebab-case id; becomes <output-dir>/<campaign-id>/setting.yaml",
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        default=Path("../../data/lore-packs"),
        help="Output root (default: ../../data/lore-packs relative to this script)",
    )
    p.add_argument(
        "--model",
        default=os.environ.get("LORE_EXTRACTOR_MODEL", DEFAULT_MODEL),
        help=f"Model id (default {DEFAULT_MODEL})",
    )
    p.add_argument(
        "--base-url",
        default=os.environ.get("LORE_EXTRACTOR_BASE_URL", ""),
        help=(
            "Provider base URL. Empty (default) auto-selects the native Gemini endpoint "
            f"({DEFAULT_GEMINI_BASE_URL}). Pass an OpenAI-compat URL to use a different provider."
        ),
    )
    p.add_argument(
        "--api-key-env",
        default="GEMINI_API_KEY",
        help="Environment variable holding the API key (default GEMINI_API_KEY)",
    )
    p.add_argument(
        "--only-chapter",
        default=None,
        help="Process only chapter URLs containing this substring (for prompt iteration)",
    )
    p.add_argument(
        "--max-chapters",
        type=int,
        default=None,
        help="Process only the first N chapters in reading order",
    )
    p.add_argument(
        "--rps",
        type=float,
        default=DEFAULT_RPS,
        help=f"Outbound requests per second to Scribblehub (default {DEFAULT_RPS})",
    )
    p.add_argument(
        "--refresh",
        action="store_true",
        help="Wipe the HTML cache before running (forces re-fetch from Scribblehub)",
    )
    p.add_argument(
        "--log-level",
        default=os.environ.get("LOG_LEVEL", "info"),
        choices=["debug", "info", "warning", "error"],
    )
    return p.parse_args()


async def run() -> int:
    args = parse_args()
    configure_logging(args.log_level)

    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        print(
            f"error: {args.api_key_env} is not set in the environment.",
            file=sys.stderr,
        )
        print(
            f"  For Gemini: export GEMINI_API_KEY=<key>",
            file=sys.stderr,
        )
        return 2

    # Resolve output dir relative to the script location so the default
    # (../../data/lore-packs) lands in the ttrpgtavern repo root.
    if not args.output_dir.is_absolute():
        output_dir = (Path(__file__).parent / args.output_dir).resolve()
    else:
        output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.refresh:
        clear_cache(output_dir)

    base_url = args.base_url or DEFAULT_GEMINI_BASE_URL
    is_gemini = GEMINI_HOST in base_url

    client: LLMClient
    if is_gemini:
        native_base = base_url.split("/openai")[0].rstrip("/")
        client = GeminiNativeClient(
            role="charactergen",
            model=args.model,
            api_key=api_key,
            base_url=native_base,
            safety_settings=SAFETY_OFF,
        )
        safety_note = "disabled (native Gemini safetySettings=OFF)"
    else:
        client = OpenAICompatClient(
            role="charactergen",
            base_url=base_url,
            model=args.model,
            api_key=api_key,
        )
        safety_note = "provider-default"

    log.info(
        "extract_lore.starting",
        series_url=args.series_url,
        campaign_id=args.campaign_id,
        output_dir=str(output_dir),
        model=args.model,
        safety=safety_note,
    )

    try:
        result = await run_extraction(
            series_url=args.series_url,
            campaign_id=args.campaign_id,
            output_dir=output_dir,
            client=client,
            max_chapters=args.max_chapters,
            only_chapter=args.only_chapter,
            rps=args.rps,
        )
    except Exception as exc:
        log.error("extract_lore.failed", error=str(exc), exc_info=True)
        print(f"error: extraction failed: {exc}", file=sys.stderr)
        return 1

    yaml_path, review_path = write_outputs(result, output_dir)
    deities = sum(1 for c in result.characters if c.tier == "deity")
    mortals = sum(1 for c in result.characters if c.tier == "mortal_permanent")

    print()
    print(f"setting.yaml  -> {yaml_path}")
    print(f"_review.json  -> {review_path}")
    print(
        f"  chapters processed : {result.chapters_processed}\n"
        f"  lore entries       : {len(result.lore)}\n"
        f"  characters (people): {len(result.characters)} "
        f"({deities} deity, {mortals} mortal_permanent)\n"
        f"\n"
        f"  Place setting.yaml at data/lore-packs/{result.campaign_id}/setting.yaml\n"
        f"  to make the pack available from the wizard's Seed Lore step."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
