# lore-extractor

Offline tool that walks a [Scribblehub](https://www.scribblehub.com) series, asks an LLM
(Gemini or any OpenAI-compat provider) to extract worldbuilding from each chapter, consolidates
duplicates across the full run, and writes a ttrpgtavern **LorePack** (`setting.yaml`) plus a
human-readable provenance file (`_review.json`).

The resulting `setting.yaml` slots directly into `data/lore-packs/<campaign-id>/` and is
available from the wizard's **Seed Lore** step with no further backend changes.

## How it works

```
Series URL
    │
    ▼
TOC discovery (Scribblehub admin-ajax) ──► cached HTML
    │
    ├─ per chapter ──► LLM call (ChapterExtraction) ──► cached JSON candidate
    │
    ├─ group by (kind, normalized_title)
    │   └─ per group ──► LLM consolidation call ──► ConsolidatedLore
    │
    ├─ group by (tier, normalized_name)
    │   └─ per group ──► LLM consolidation call ──► ConsolidatedCharacter
    │
    └─ write
         ├─ setting.yaml   (LorePack: entries[] = lore + characters-as-people)
         └─ _review.json   (sources, conflicts, permanence flags)
```

Characters (deities + permanent institutional NPCs) are folded into `entry_kind: people` lore
entries so everything lives in one file. Full campaign-library NPC import is a separate step.

## Prerequisites

Python 3.11+ recommended.

```bash
cd tools/lore-extractor
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Usage

### With Gemini (recommended — free tier available)

```bash
export GEMINI_API_KEY=<your-key>

python extract_lore.py \
    --series-url https://www.scribblehub.com/series/580870/this-ascent-to-divinity-is-lewder-than-expected/ \
    --campaign-id ascent-to-divinity \
    --output-dir ../../data/lore-packs
```

### With OpenAI or any OpenAI-compat provider

```bash
export OPENAI_API_KEY=<your-key>

python extract_lore.py \
    --series-url <url> --campaign-id <id> \
    --output-dir ../../data/lore-packs \
    --base-url https://api.openai.com/v1 \
    --model gpt-4o \
    --api-key-env OPENAI_API_KEY
```

### Iterate on prompts against a single chapter

```bash
python extract_lore.py \
    --series-url <url> --campaign-id <id> \
    --output-dir ../../data/lore-packs \
    --only-chapter chapter/1081395/ --refresh
```

### Process in chunks (resume-safe)

```bash
# First chunk
python extract_lore.py --series-url <url> --campaign-id <id> --max-chapters 50
# Re-running picks up from cache — already-extracted chapters skip the LLM call.
python extract_lore.py --series-url <url> --campaign-id <id> --max-chapters 100
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--series-url` | _(required)_ | Scribblehub series URL |
| `--campaign-id` | _(required)_ | kebab-case id → `<output-dir>/<id>/setting.yaml` |
| `--output-dir` | `../../data/lore-packs` | Output root (relative to this script) |
| `--model` | `gemini-2.5-flash` | Model id; env `LORE_EXTRACTOR_MODEL` overrides |
| `--base-url` | Gemini native endpoint | Provider base URL |
| `--api-key-env` | `GEMINI_API_KEY` | Env var holding the API key |
| `--only-chapter` | _(none)_ | Process only URLs containing this substring |
| `--max-chapters` | _(none)_ | Cap on chapters processed |
| `--rps` | `1.0` | Outbound requests/second to Scribblehub |
| `--refresh` | `false` | Wipe HTML cache before running |
| `--log-level` | `info` | `debug / info / warning / error` |

## Output

```
<output-dir>/
  <campaign-id>/
    setting.yaml     ← LorePack; place at data/lore-packs/<id>/setting.yaml
    _review.json     ← provenance: sources, conflicts, permanence flags
  _cache/
    html/            ← raw chapter HTML (keyed by SHA1)
    candidates/      ← per-chapter LLM output (keyed by prompt-version + URL)
```

The cache makes re-runs idempotent. Delete `_cache/candidates/` to force
re-extraction; delete `_cache/html/` (or use `--refresh`) to re-fetch prose.

## Notes on content

The extractor applies two strict rules:

1. **Lore inclusion test** — a fact qualifies only if it would still be true had the
   protagonist's story never been written.
2. **Character permanence test** — a character qualifies only if they held an
   institutional/cosmological position that pre-dates and is independent of the protagonist.

Chapters that contribute no new worldbuilding produce an empty candidate (no LLM wasted on
consolidation). The `_review.json` file tracks `conflicts[]` (contradictions across chapters)
and `permanence_warnings[]` (characters that may not pass the permanence test) for human audit.
