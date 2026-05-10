"""Scribblehub TOC + chapter prose fetcher with on-disk HTML cache.

Two public surfaces:

* :func:`discover_chapters` — given a series URL, return every chapter URL
  in reading order via Scribblehub's admin-ajax.php ``pagenum=-1`` trick.
* :func:`fetch_chapter` — given a chapter URL, return its prose with author
  notes / spoiler boxes stripped.

Both honour a disk cache rooted at ``<output_dir>/_cache/html/``.
Requests are polite by default: 1 RPS, ``tenacity`` retry with jitter on
5xx / 429. We use ``curl_cffi`` with ``impersonate="chrome120"`` to clear
Cloudflare's bot-management challenge on Scribblehub.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from curl_cffi import CurlError
from curl_cffi.requests import AsyncSession
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from ._deps import ExtractorError, get_logger

log = get_logger(__name__)

IMPERSONATE_PROFILE = "chrome120"
DEFAULT_RPS = 1.0
AJAX_URL = "https://www.scribblehub.com/wp-admin/admin-ajax.php"

PROSE_SELECTORS = ("#chp_raw", "div.chp_raw_l", "div.chapter-content", "#chapter-content")
NOISE_SELECTORS = (
    "div.wi_authornotes",
    "div.spoiler-tag",
    "div.spoiler-text",
    "div.divspoiler",
    "div.scrolltop",
    "p.spoiler-tag",
    "div.adsbygoogle",
    "ins.adsbygoogle",
    "script",
    "style",
)
CHAPTER_URL_RE = re.compile(r"https://www\.scribblehub\.com/read/[^/]+/chapter/\d+/?")


class FetchError(ExtractorError):
    """Network / parse failure during chapter or TOC fetch."""


class _RetryableFetchError(FetchError):
    """Internal marker so tenacity retries 5xx/429 but not 4xx parse errors."""


@dataclass(slots=True, frozen=True)
class ChapterRef:
    url: str
    title: str
    index: int  # 0-based reading order


@dataclass(slots=True, frozen=True)
class ChapterText:
    url: str
    title: str
    prose: str


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def _cache_dir(output_dir: Path) -> Path:
    return output_dir / "_cache" / "html"


def _cache_key(kind: str, url: str) -> str:
    return hashlib.sha1(f"{kind}::{url}".encode()).hexdigest()


def _cache_read(output_dir: Path, kind: str, url: str) -> str | None:
    path = _cache_dir(output_dir) / f"{_cache_key(kind, url)}.html"
    if path.is_file():
        return path.read_text(encoding="utf-8")
    return None


def _cache_write(output_dir: Path, kind: str, url: str, body: str) -> None:
    cache = _cache_dir(output_dir)
    cache.mkdir(parents=True, exist_ok=True)
    (cache / f"{_cache_key(kind, url)}.html").write_text(body, encoding="utf-8")


def clear_cache(output_dir: Path) -> int:
    cache = _cache_dir(output_dir)
    if not cache.is_dir():
        return 0
    n = sum(1 for p in cache.iterdir() if p.is_file() and p.unlink() is None)
    log.info("lore_fetcher.cache_cleared", removed=n, dir=str(cache))
    return n


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


class _PolitenessGate:
    def __init__(self, rps: float) -> None:
        self._gap = 1.0 / rps if rps > 0 else 0.0
        self._lock = asyncio.Lock()
        self._next_ok = 0.0

    async def wait(self) -> None:
        if self._gap <= 0:
            return
        async with self._lock:
            now = asyncio.get_event_loop().time()
            sleep_for = max(0.0, self._next_ok - now)
            if sleep_for:
                await asyncio.sleep(sleep_for)
            self._next_ok = asyncio.get_event_loop().time() + self._gap


def _client(timeout: float = 30.0) -> AsyncSession:
    return AsyncSession(impersonate=IMPERSONATE_PROFILE, timeout=timeout)


@retry(
    reraise=True,
    stop=stop_after_attempt(4),
    wait=wait_exponential_jitter(initial=1.0, max=15.0),
    retry=retry_if_exception_type((_RetryableFetchError, CurlError)),
)
async def _http_get(client: AsyncSession, url: str) -> str:
    resp = await client.get(url)
    status = resp.status_code
    if status in (429, 500, 502, 503, 504):
        raise _RetryableFetchError(f"HTTP {status} fetching {url}", details={"url": url, "status": status})
    if status >= 400:
        raise FetchError(f"HTTP {status} fetching {url}", details={"url": url, "status": status})
    return resp.text


@retry(
    reraise=True,
    stop=stop_after_attempt(4),
    wait=wait_exponential_jitter(initial=1.0, max=15.0),
    retry=retry_if_exception_type((_RetryableFetchError, CurlError)),
)
async def _http_post(client: AsyncSession, url: str, data: dict[str, str], *, referer: str | None = None) -> str:
    headers: dict[str, str] = {"X-Requested-With": "XMLHttpRequest"}
    if referer:
        headers["Referer"] = referer
    resp = await client.post(url, data=data, headers=headers)
    status = resp.status_code
    if status in (429, 500, 502, 503, 504):
        raise _RetryableFetchError(f"HTTP {status} POSTing to {url}", details={"url": url, "status": status})
    if status >= 400:
        raise FetchError(f"HTTP {status} POSTing to {url}", details={"url": url, "status": status})
    return resp.text


# ---------------------------------------------------------------------------
# TOC discovery
# ---------------------------------------------------------------------------


def _series_id_from_url(series_url: str) -> str:
    parsed = urlparse(series_url)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2 or parts[0] != "series" or not parts[1].isdigit():
        raise FetchError(
            f"Cannot extract series id from {series_url!r}",
            details={"series_url": series_url},
        )
    return parts[1]


async def discover_chapters(
    series_url: str,
    *,
    output_dir: Path,
    gate: _PolitenessGate | None = None,
    client: AsyncSession | None = None,
) -> list[ChapterRef]:
    series_id = _series_id_from_url(series_url)
    cache_url = f"{series_url}#toc-{series_id}"
    cached = _cache_read(output_dir, "toc", cache_url)
    if cached is not None:
        log.debug("lore_fetcher.toc_cache_hit", series_id=series_id)
        return _parse_toc_html(cached)

    own_client = False
    if client is None:
        client = _client()
        own_client = True
    if gate is None:
        gate = _PolitenessGate(DEFAULT_RPS)

    try:
        await gate.wait()
        body = await _http_post(
            client,
            AJAX_URL,
            {"action": "wi_getreleases_pagination", "pagenum": "-1", "mypostid": series_id},
            referer=series_url,
        )
    finally:
        if own_client:
            await client.close()

    chapters = _parse_toc_html(body)
    if not chapters:
        raise FetchError(
            "Scribblehub TOC parse returned 0 chapters; selector drift?",
            details={"series_id": series_id, "body_len": len(body)},
        )

    _cache_write(output_dir, "toc", cache_url, body)
    log.info("lore_fetcher.toc_fetched", series_id=series_id, chapters=len(chapters))
    return chapters


def _parse_toc_html(body: str) -> list[ChapterRef]:
    soup = BeautifulSoup(body, "html.parser")
    seen: set[str] = set()
    refs: list[tuple[str, str]] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not CHAPTER_URL_RE.match(href):
            continue
        if href in seen:
            continue
        seen.add(href)
        title = (a.get_text() or "").strip() or href.rstrip("/").rsplit("/", 1)[-1]
        refs.append((href, title))
    refs.reverse()  # Scribblehub lists newest first; reverse to reading order
    return [ChapterRef(url=u, title=t, index=i) for i, (u, t) in enumerate(refs)]


# ---------------------------------------------------------------------------
# Chapter prose
# ---------------------------------------------------------------------------


async def fetch_chapter(
    chapter_url: str,
    *,
    output_dir: Path,
    gate: _PolitenessGate | None = None,
    client: AsyncSession | None = None,
) -> ChapterText:
    cached = _cache_read(output_dir, "chapter", chapter_url)
    if cached is not None:
        log.debug("lore_fetcher.chapter_cache_hit", url=chapter_url)
        return _parse_chapter_html(chapter_url, cached)

    own_client = False
    if client is None:
        client = _client()
        own_client = True
    if gate is None:
        gate = _PolitenessGate(DEFAULT_RPS)

    try:
        await gate.wait()
        body = await _http_get(client, chapter_url)
    finally:
        if own_client:
            await client.close()

    _cache_write(output_dir, "chapter", chapter_url, body)
    parsed = _parse_chapter_html(chapter_url, body)
    log.info("lore_fetcher.chapter_fetched", url=chapter_url, title=parsed.title, chars=len(parsed.prose))
    return parsed


def _parse_chapter_html(chapter_url: str, body: str) -> ChapterText:
    soup = BeautifulSoup(body, "html.parser")

    title_el = soup.find("div", class_="chapter-title") or soup.find("h1", class_="chapter-title")
    if title_el is not None:
        title = title_el.get_text(strip=True)
    else:
        head_title = soup.find("title")
        title = head_title.get_text(strip=True) if head_title else chapter_url

    container = None
    for sel in PROSE_SELECTORS:
        container = soup.select_one(sel)
        if container is not None:
            break
    if container is None:
        raise FetchError(
            f"Could not locate prose container in {chapter_url!r}",
            details={"url": chapter_url, "tried": list(PROSE_SELECTORS)},
        )

    for noisy_sel in NOISE_SELECTORS:
        for noisy in container.select(noisy_sel):
            noisy.decompose()

    paragraphs = [p.get_text(" ", strip=True) for p in container.find_all("p")]
    paragraphs = [p for p in paragraphs if p]
    text = "\n\n".join(paragraphs) if paragraphs else container.get_text("\n", strip=True)

    return ChapterText(url=chapter_url, title=title, prose=text)
