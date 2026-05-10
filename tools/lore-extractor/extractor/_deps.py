"""Minimal inlined dependencies — replaces srstavern.* package imports.

Lets the lore extractor run standalone without the full srstavern Python
package installed. Contains: error classes, structured logging, LLM clients
(OpenAI-compat + Gemini native).
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Literal, Protocol, TypeVar

import structlog
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ExtractorError(Exception):
    """Base error for the lore extractor."""

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class StructuredOutputError(ExtractorError):
    """Raised when an LLM call returned unparseable or empty structured output."""


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def configure_logging(level: str = "info") -> None:
    log_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(stream=sys.stdout, level=log_level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.dev.ConsoleRenderer(colors=False),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


# ---------------------------------------------------------------------------
# LLM client protocol
# ---------------------------------------------------------------------------

T = TypeVar("T", bound=BaseModel)
Role = Literal["director", "actor", "charactergen"]


class LLMClient(Protocol):
    role: Role
    provider: str
    base_url: str
    model: str

    async def chat(self, *, system: str, user: str) -> str: ...
    async def structured(self, *, schema: type[T], system: str, user: str) -> T: ...


# ---------------------------------------------------------------------------
# OpenAI-compat client
# ---------------------------------------------------------------------------


class OpenAICompatClient:
    provider: str = "openai-compat"

    def __init__(
        self,
        *,
        role: Role,
        base_url: str,
        model: str,
        api_key: str = "",
        extra_body: dict[str, Any] | None = None,
    ) -> None:
        from openai import AsyncOpenAI

        self.role = role
        self.base_url = base_url
        self.model = model
        self._extra_body = extra_body or None
        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key or "no-key-needed")

    def _kwargs(self, **kw: Any) -> dict[str, Any]:
        if self._extra_body:
            kw["extra_body"] = self._extra_body
        return kw

    async def chat(self, *, system: str, user: str) -> str:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        resp = await self._client.chat.completions.create(**self._kwargs(model=self.model, messages=messages))
        return (resp.choices[0].message.content or "").strip()

    async def structured(self, *, schema: type[T], system: str, user: str) -> T:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        json_schema = {"name": schema.__name__, "schema": schema.model_json_schema(), "strict": True}
        try:
            resp = await self._client.chat.completions.create(
                **self._kwargs(
                    model=self.model,
                    messages=messages,
                    response_format={"type": "json_schema", "json_schema": json_schema},
                )
            )
        except Exception as exc:
            raise StructuredOutputError(
                f"LLM provider rejected structured-output request: {exc}",
                details={"role": self.role, "model": self.model, "schema": schema.__name__},
            ) from exc

        choice = resp.choices[0] if resp.choices else None
        message = getattr(choice, "message", None) if choice is not None else None
        finish_reason = getattr(choice, "finish_reason", None) if choice is not None else None
        content = ((message.content if message is not None else None) or "").strip()
        if not content or content == "{}":
            raise StructuredOutputError(
                "LLM returned empty structured output",
                details={"role": self.role, "model": self.model, "raw": content, "finish_reason": finish_reason},
            )
        try:
            return schema.model_validate_json(content)
        except Exception as exc:
            raise StructuredOutputError(
                f"Failed to parse structured output: {exc}",
                details={"role": self.role, "raw": content[:500]},
            ) from exc


# ---------------------------------------------------------------------------
# Gemini native client
# ---------------------------------------------------------------------------

SAFETY_OFF: list[dict[str, str]] = [
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "OFF"},
]

GEMINI_HOST = "generativelanguage.googleapis.com"
DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def _is_retryable_http_error(exc: BaseException) -> bool:
    import httpx

    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code == 429 or 500 <= exc.response.status_code < 600
    return False


class GeminiNativeClient:
    provider: str = "gemini-native"

    def __init__(
        self,
        *,
        role: Role,
        model: str,
        api_key: str,
        base_url: str = DEFAULT_GEMINI_BASE_URL,
        safety_settings: list[dict[str, str]] | None = None,
        timeout: float = 180.0,
        max_attempts: int = 5,
    ) -> None:
        if not api_key:
            raise ValueError("GeminiNativeClient requires a non-empty api_key")
        self.role = role
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._safety_settings = safety_settings
        self._timeout = timeout
        self._max_attempts = max_attempts

    async def chat(self, *, system: str, user: str) -> str:
        body = self._build_body(system=system, user=user, json_mode=False)
        text, _ = await self._call(body)
        return text.strip()

    async def structured(self, *, schema: type[T], system: str, user: str) -> T:
        body = self._build_body(system=system, user=user, json_mode=True)
        try:
            text, finish_reason = await self._call(body)
        except Exception as exc:
            raise StructuredOutputError(
                f"Gemini rejected structured-output request: {exc}",
                details={"role": self.role, "model": self.model, "schema": schema.__name__},
            ) from exc

        content = (text or "").strip()
        if not content or content == "{}":
            raise StructuredOutputError(
                "Gemini returned empty structured output",
                details={"role": self.role, "model": self.model, "raw": content, "finish_reason": finish_reason},
            )
        try:
            return schema.model_validate_json(content)
        except Exception as exc:
            raise StructuredOutputError(
                f"Failed to parse Gemini structured output: {exc}",
                details={"role": self.role, "schema": schema.__name__, "raw": content[:500]},
            ) from exc

    def _build_body(self, *, system: str, user: str, json_mode: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0.2},
        }
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        if self._safety_settings:
            body["safetySettings"] = self._safety_settings
        return body

    async def _call(self, body: dict[str, Any]) -> tuple[str, str | None]:
        import httpx
        from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential

        url = f"{self.base_url}/models/{self.model}:generateContent"
        headers = {"x-goog-api-key": self._api_key, "Content-Type": "application/json"}

        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(self._max_attempts),
            wait=wait_exponential(multiplier=4, min=15, max=120),
            retry=retry_if_exception(_is_retryable_http_error),
            reraise=True,
        ):
            with attempt:
                async with httpx.AsyncClient(timeout=self._timeout) as http:
                    resp = await http.post(url, headers=headers, json=body)
                    resp.raise_for_status()
                    data = resp.json()

        return _gemini_extract_text(data)


def _gemini_extract_text(data: dict[str, Any]) -> tuple[str, str | None]:
    candidates = data.get("candidates") or []
    if not candidates:
        feedback = data.get("promptFeedback") or {}
        block_reason = feedback.get("blockReason")
        return "", f"prompt_blocked:{block_reason}" if block_reason else None

    candidate = candidates[0]
    finish_reason = candidate.get("finishReason")
    parts = ((candidate.get("content") or {}).get("parts")) or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p.get("text"), str))
    return text, finish_reason


__all__ = [
    "ExtractorError",
    "StructuredOutputError",
    "configure_logging",
    "get_logger",
    "LLMClient",
    "OpenAICompatClient",
    "GeminiNativeClient",
    "SAFETY_OFF",
    "GEMINI_HOST",
    "DEFAULT_GEMINI_BASE_URL",
]
