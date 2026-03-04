import asyncio
import json
import os
import re
import threading
import time
import logging
from collections import OrderedDict, deque
from typing import Any, Dict, Optional, Tuple

try:
    from groq import Groq
except Exception:  # pragma: no cover - fallback when dependency not installed yet
    Groq = None  # type: ignore


def _safe_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


AI_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant").strip() or "llama-3.1-8b-instant"
_CACHE_MAX_ITEMS = _safe_int_env("AI_CACHE_MAX_ITEMS", default=2000, minimum=100, maximum=10000)
_GROQ_TIMEOUT_SECONDS = _safe_int_env("GROQ_TIMEOUT_SECONDS", default=16, minimum=3, maximum=60)
_RATE_LIMIT_COOLDOWN_SECONDS = _safe_int_env("GROQ_RATE_LIMIT_COOLDOWN_SECONDS", default=25, minimum=3, maximum=300)
_MODEL_FALLBACKS = [
    item.strip()
    for item in str(os.getenv("GROQ_MODEL_FALLBACKS", "llama-3.1-8b-instant")).split(",")
    if item.strip()
]

_CLIENT_LOCK = threading.Lock()
_CLIENT: Optional[Groq] = None
_CACHE_LOCK = threading.Lock()
_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_MODEL_STATE_LOCK = threading.Lock()
_DISABLED_MODELS = set()
_RATE_LIMITED_UNTIL_MONOTONIC = 0.0
_AI_RATE_LIMIT_PER_MINUTE = _safe_int_env("AI_RATE_LIMIT_PER_MINUTE", default=5, minimum=1, maximum=120)
_AI_QUEUE_MAX_ITEMS = _safe_int_env("AI_QUEUE_MAX_ITEMS", default=600, minimum=50, maximum=5000)
_AI_RETRY_DELAY_SECONDS = _safe_int_env("AI_RETRY_DELAY_SECONDS", default=60, minimum=5, maximum=900)
_AI_QUEUE: Optional[asyncio.PriorityQueue] = None
_AI_WORKER: Optional[asyncio.Task] = None
_AI_QUEUE_LOCK = asyncio.Lock()
_AI_RATE_WINDOW = deque(maxlen=5000)
_AI_PROCESSED_WINDOW = deque(maxlen=5000)
_AI_PENDING_COUNT = 0
_AI_ENQUEUE_SEQUENCE = 0
_AI_LAST_CALL_MONOTONIC = 0.0
_AI_WORKER_COUNT = 1
_LOGGER = logging.getLogger("ai_analyzer")

_ALLOWED_CATEGORIES = {
    "missile",
    "drone",
    "frappe_aerienne",
    "artillerie",
    "conflit_terrestre",
    "cyberattaque",
    "diplomatie",
    "terrorisme",
    "nucleaire",
    "autre",
}

_SEVERITY_MAP = {
    "critique": "critique",
    "critical": "critique",
    "haute": "haute",
    "high": "haute",
    "moyenne": "moyenne",
    "moyen": "moyenne",
    "medium": "moyenne",
    "faible": "faible",
    "low": "faible",
}

_EVENT_TYPE_MAP = {
    "terrain_event": "terrain_event",
    "press_return": "press_return",
    "diplomatic": "diplomatic",
}


def _neutral_result(error: str = "") -> Dict[str, Any]:
    return {
        "category": "autre",
        "event_type": "press_return",
        "actor": "",
        "actor_action": "",
        "target": "",
        "location_of_event": "",
        "context": "",
        "subcategories": [],
        "severity": "moyenne",
        "severity_score": 0.0,
        "countries": [],
        "actors": [],
        "summary": "",
        "reliability_score": 0.0,
        "is_conflict_related": False,
        "ai_analyzed": False,
        "ai_provider": "groq",
        "ai_model": AI_MODEL,
        "ai_error": str(error or "").strip(),
        "ai_retryable": False,
        "ai_retry_in_seconds": 0,
    }


def _clamp_score(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    if parsed != parsed:
        return 0.0
    return max(0.0, min(1.0, round(parsed, 4)))


def _as_str_list(value: Any) -> list:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value is None:
        return []
    raw = str(value).strip()
    if not raw:
        return []
    return [item.strip() for item in re.split(r"[,\n;]+", raw) if item.strip()]


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed:
        return default
    return parsed


def _priority_from_score(priority_score: Any) -> float:
    # PriorityQueue pops the smallest value first. Negative score means higher score first.
    score = _safe_float(priority_score, default=0.0)
    score = max(-9999.0, min(9999.0, score))
    return -score


def _extract_json_object(raw: str) -> Dict[str, Any]:
    content = str(raw or "").strip()
    if not content:
        return {}

    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", content, flags=re.DOTALL)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _error_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    response = getattr(exc, "response", None)
    if response is not None:
        status_code = getattr(response, "status_code", None)
        if status_code:
            message = f"HTTP {status_code}: {message}"
        try:
            payload = response.json()
            if payload:
                message = f"{message} | {json.dumps(payload, ensure_ascii=False)}"
        except Exception:
            pass
    return message


def _is_rate_limit_error(message: str) -> bool:
    text = str(message or "").lower()
    return "429" in text or "rate limit" in text or "too many requests" in text


def _is_decommissioned_error(message: str) -> bool:
    text = str(message or "").lower()
    return "decommissioned" in text or "no longer supported" in text or "model_not_found" in text


def _mark_model_disabled(model_name: str) -> None:
    normalized = str(model_name or "").strip()
    if not normalized:
        return
    with _MODEL_STATE_LOCK:
        _DISABLED_MODELS.add(normalized)


def _set_rate_limit_cooldown() -> None:
    global _RATE_LIMITED_UNTIL_MONOTONIC
    with _MODEL_STATE_LOCK:
        _RATE_LIMITED_UNTIL_MONOTONIC = max(
            _RATE_LIMITED_UNTIL_MONOTONIC,
            time.monotonic() + float(_RATE_LIMIT_COOLDOWN_SECONDS),
        )


def _cooldown_remaining_seconds() -> int:
    with _MODEL_STATE_LOCK:
        remaining = _RATE_LIMITED_UNTIL_MONOTONIC - time.monotonic()
    return max(0, int(round(remaining)))


def _model_candidates() -> list:
    disabled = set()
    with _MODEL_STATE_LOCK:
        disabled = set(_DISABLED_MODELS)

    ordered = []
    seen = set()
    for name in [AI_MODEL, *_MODEL_FALLBACKS]:
        candidate = str(name or "").strip()
        if not candidate or candidate in seen or candidate in disabled:
            continue
        seen.add(candidate)
        ordered.append(candidate)
    return ordered


def _set_model_in_result(payload: Dict[str, Any], model_name: str) -> Dict[str, Any]:
    normalized = dict(payload or {})
    normalized["ai_model"] = str(model_name or AI_MODEL)
    return normalized


def _normalize_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    category = str(payload.get("category") or "autre").strip().lower()
    if category not in _ALLOWED_CATEGORIES:
        category = "autre"

    severity = _SEVERITY_MAP.get(str(payload.get("severity") or "").strip().lower(), "moyenne")
    event_type = _EVENT_TYPE_MAP.get(str(payload.get("event_type") or "").strip().lower(), "press_return")
    summary = " ".join(str(payload.get("summary") or "").split()).strip()
    if len(summary) > 500:
        summary = summary[:500].strip()
    actor = " ".join(str(payload.get("actor") or "").split()).strip()[:120]
    actor_action = " ".join(str(payload.get("actor_action") or "").split()).strip()[:120]
    target = " ".join(str(payload.get("target") or "").split()).strip()[:140]
    location_of_event = " ".join(str(payload.get("location_of_event") or "").split()).strip()[:180]
    context = " ".join(str(payload.get("context") or "").split()).strip()[:220]

    return {
        "category": category,
        "event_type": event_type,
        "actor": actor,
        "actor_action": actor_action,
        "target": target,
        "location_of_event": location_of_event,
        "context": context,
        "subcategories": _as_str_list(payload.get("subcategories")),
        "severity": severity,
        "severity_score": _clamp_score(payload.get("severity_score")),
        "countries": _as_str_list(payload.get("countries")),
        "actors": _as_str_list(payload.get("actors")),
        "summary": summary,
        "reliability_score": _clamp_score(payload.get("reliability_score")),
        "is_conflict_related": bool(payload.get("is_conflict_related")),
        "ai_analyzed": True,
        "ai_provider": "groq",
        "ai_model": AI_MODEL,
        "ai_error": "",
    }


def _get_client() -> Optional["Groq"]:
    global _CLIENT
    if Groq is None:
        return None
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        return None

    with _CLIENT_LOCK:
        if _CLIENT is None:
            _CLIENT = Groq(api_key=api_key, timeout=_GROQ_TIMEOUT_SECONDS)
    return _CLIENT


def get_cached_analysis(cache_key: str) -> Optional[Dict[str, Any]]:
    key = str(cache_key or "").strip()
    if not key:
        return None

    with _CACHE_LOCK:
        if key not in _CACHE:
            return None
        payload = _CACHE.pop(key)
        _CACHE[key] = payload
        return dict(payload)


def set_cached_analysis(cache_key: str, payload: Dict[str, Any]) -> None:
    key = str(cache_key or "").strip()
    if not key:
        return
    with _CACHE_LOCK:
        _CACHE[key] = dict(payload or {})
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX_ITEMS:
            _CACHE.popitem(last=False)


def analyze_event(title: str, description: str, source: str) -> Dict[str, Any]:
    client = _get_client()
    if client is None:
        return _neutral_result("missing_groq_api_key")

    safe_title = str(title or "").strip()[:280]
    safe_description = str(description or "").strip()[:5000]
    safe_source = str(source or "").strip()[:280]

    system_prompt = (
        "You are a geopolitical conflict event classifier and triage assistant. "
        "Return ONLY valid JSON with keys: "
        "category, event_type, actor, actor_action, target, location_of_event, context, "
        "subcategories, severity, severity_score, countries, actors, summary, reliability_score, is_conflict_related. "
        "Allowed category values: missile, drone, frappe_aerienne, artillerie, conflit_terrestre, cyberattaque, diplomatie, terrorisme, nucleaire, autre. "
        "Allowed event_type values: terrain_event, press_return, diplomatic. "
        "actor is who performs the physical action. "
        "actor_action is the concrete action performed by actor. "
        "target is who/what receives the action. "
        "location_of_event is where the physical event occurred. "
        "context is diplomatic/observer reactions around the event. "
        "Do not mix actor and target. "
        "If the grammatical subject uses observer verbs (condemns, protests, reacts to, denounces, was hit by, suffered), "
        "the real actor is often in the complement clause. "
        "Allowed severity values: critique, haute, moyenne, faible. "
        "severity_score and reliability_score must be floats between 0.0 and 1.0. "
        "summary must be factual and max 2 short sentences. "
        "terrain_event means direct field act (strike, explosion, troop movement, confirmed arrest/death). "
        "press_return means article/opinion/retrospective/explainer not direct ground act. "
        "diplomatic means declarations/meetings/communiques."
    )
    user_payload = {
        "title": safe_title,
        "description": safe_description,
        "source": safe_source,
    }

    last_error = "unknown_error"
    user_content = json.dumps(user_payload, ensure_ascii=False)
    model_candidates = _model_candidates()
    if not model_candidates:
        return _neutral_result("no_available_groq_models")

    rate_limited_models = set()

    for model_name in model_candidates:
        model_hit_rate_limit = False
        for force_json_mode in (True, False):
            request_payload = {
                "model": model_name,
                "temperature": 0.1,
                "max_tokens": 420,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
            }
            if force_json_mode:
                request_payload["response_format"] = {"type": "json_object"}

            try:
                completion = client.chat.completions.create(**request_payload)
                content = ""
                if completion and completion.choices:
                    content = str(completion.choices[0].message.content or "")
                raw = _extract_json_object(content)
                if not raw:
                    last_error = f"invalid_groq_json model={model_name} json_mode={force_json_mode}"
                    continue

                normalized = _normalize_result(raw)
                return _set_model_in_result(normalized, model_name)
            except Exception as exc:
                error_message = _error_text(exc)
                if _is_decommissioned_error(error_message):
                    _mark_model_disabled(model_name)
                if _is_rate_limit_error(error_message):
                    model_hit_rate_limit = True
                    rate_limited_models.add(model_name)
                    last_error = f"model={model_name} rate_limit={error_message}"
                    # Immediate fallback to next model (no wait).
                    break
                last_error = f"model={model_name} json_mode={force_json_mode} error={error_message}"
                continue
        if model_hit_rate_limit:
            continue

    if model_candidates and len(rate_limited_models) == len(model_candidates):
        retryable = _neutral_result("all_models_rate_limited")
        retryable["ai_retryable"] = True
        retryable["ai_retry_in_seconds"] = int(_AI_RETRY_DELAY_SECONDS)
        return _set_model_in_result(retryable, AI_MODEL)
    return _set_model_in_result(_neutral_result(last_error), AI_MODEL)


async def _rate_limited_wait() -> None:
    global _AI_LAST_CALL_MONOTONIC
    min_interval = 60.0 / float(max(1, _AI_RATE_LIMIT_PER_MINUTE))
    now = time.monotonic()
    wait_for = 0.0
    if _AI_LAST_CALL_MONOTONIC > 0:
        wait_for = (_AI_LAST_CALL_MONOTONIC + min_interval) - now
    if wait_for > 0:
        await asyncio.sleep(wait_for)
    now = time.monotonic()
    _AI_LAST_CALL_MONOTONIC = now
    _AI_RATE_WINDOW.append(now)


def _next_sequence() -> int:
    global _AI_ENQUEUE_SEQUENCE
    sequence = _AI_ENQUEUE_SEQUENCE
    _AI_ENQUEUE_SEQUENCE += 1
    return sequence


def _queue_entry(
    priority_score: float,
    title: str,
    description: str,
    source: str,
    fut: asyncio.Future,
    retry_count: int = 0,
) -> Tuple[float, int, str, str, str, asyncio.Future, int]:
    return (
        _priority_from_score(priority_score),
        _next_sequence(),
        title,
        description,
        source,
        fut,
        max(0, int(retry_count)),
    )


async def _requeue_after_delay(
    priority_score: float,
    title: str,
    description: str,
    source: str,
    fut: asyncio.Future,
    retry_count: int,
    delay_seconds: int,
) -> None:
    global _AI_PENDING_COUNT
    try:
        await asyncio.sleep(max(1, int(delay_seconds)))
        await _ensure_ai_worker()
        if _AI_QUEUE is None:
            if not fut.done():
                fut.set_result(_neutral_result("ai_queue_not_initialized_after_retry"))
            _AI_PENDING_COUNT = max(0, _AI_PENDING_COUNT - 1)
            return
        await _AI_QUEUE.put(
            _queue_entry(
                priority_score=priority_score,
                title=title,
                description=description,
                source=source,
                fut=fut,
                retry_count=retry_count,
            )
        )
    except Exception as exc:
        if not fut.done():
            fut.set_result(_neutral_result(f"ai_retry_requeue_error:{exc}"))
        _AI_PENDING_COUNT = max(0, _AI_PENDING_COUNT - 1)
        _LOGGER.warning("ai_retry_requeue_error", exc_info=True)


async def _ai_worker_loop() -> None:
    global _AI_PENDING_COUNT
    if _AI_QUEUE is None:
        return

    while True:
        _priority, _sequence, title, description, source, fut, retry_count = await _AI_QUEUE.get()
        requeued = False
        try:
            await _rate_limited_wait()
            result = await asyncio.to_thread(analyze_event, title, description, source)
            if result.get("ai_retryable"):
                retry_delay = max(1, int(result.get("ai_retry_in_seconds") or _AI_RETRY_DELAY_SECONDS))
                next_retry_count = int(retry_count) + 1
                _LOGGER.warning(
                    "ai_retry_scheduled retry_in_seconds=%s retry_count=%s source=%s",
                    retry_delay,
                    next_retry_count,
                    str(source or "")[:80],
                )
                asyncio.create_task(
                    _requeue_after_delay(
                        priority_score=-float(_priority),
                        title=title,
                        description=description,
                        source=source,
                        fut=fut,
                        retry_count=next_retry_count,
                        delay_seconds=retry_delay,
                    )
                )
                requeued = True
            else:
                _AI_PROCESSED_WINDOW.append(time.monotonic())
                if not fut.done():
                    fut.set_result(result)
        except Exception as exc:
            if not fut.done():
                fut.set_result(_neutral_result(f"ai_worker_error:{exc}"))
            _LOGGER.warning("ai_worker_error", exc_info=True)
        finally:
            if not requeued:
                _AI_PENDING_COUNT = max(0, _AI_PENDING_COUNT - 1)
            _AI_QUEUE.task_done()


async def _ensure_ai_worker() -> None:
    global _AI_QUEUE, _AI_WORKER
    async with _AI_QUEUE_LOCK:
        if _AI_QUEUE is None:
            _AI_QUEUE = asyncio.PriorityQueue(maxsize=_AI_QUEUE_MAX_ITEMS)
        if _AI_WORKER is None or _AI_WORKER.done():
            _AI_WORKER = asyncio.create_task(_ai_worker_loop())


async def enqueue_event_analysis(
    title: str,
    description: str,
    source: str,
    priority_score: float = 0.0,
) -> asyncio.Future:
    global _AI_PENDING_COUNT
    await _ensure_ai_worker()
    if _AI_QUEUE is None:
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        fut.set_result(_neutral_result("ai_queue_not_initialized"))
        return fut

    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _AI_PENDING_COUNT += 1
    await _AI_QUEUE.put(
        _queue_entry(
            priority_score=float(priority_score),
            title=title,
            description=description,
            source=source,
            fut=fut,
            retry_count=0,
        )
    )
    return fut


async def analyze_event_async(
    title: str,
    description: str,
    source: str,
    priority_score: float = 0.0,
) -> Dict[str, Any]:
    fut = await enqueue_event_analysis(
        title=title,
        description=description,
        source=source,
        priority_score=priority_score,
    )
    return await fut


def ai_health() -> Dict[str, Any]:
    key_configured = bool(os.getenv("GROQ_API_KEY", "").strip())
    dependency_available = Groq is not None
    with _CACHE_LOCK:
        cache_size = len(_CACHE)
    with _MODEL_STATE_LOCK:
        disabled_models = sorted(_DISABLED_MODELS)
    queue_length = _AI_QUEUE.qsize() if _AI_QUEUE is not None else 0
    queue_capacity = _AI_QUEUE_MAX_ITEMS
    now = time.monotonic()
    while _AI_PROCESSED_WINDOW and now - _AI_PROCESSED_WINDOW[0] > 60:
        _AI_PROCESSED_WINDOW.popleft()
    saturation_pct = 0.0
    if queue_capacity > 0:
        saturation_pct = min(100.0, round((queue_length / queue_capacity) * 100.0, 2))
    return {
        "provider": "groq",
        "model": AI_MODEL,
        "model_fallbacks": _model_candidates(),
        "configured_fallbacks": list(_MODEL_FALLBACKS),
        "disabled_models": disabled_models,
        "cooldown_remaining_seconds": _cooldown_remaining_seconds(),
        "api_key_configured": key_configured,
        "dependency_available": dependency_available,
        "cache_items": cache_size,
        "queue_length": queue_length,
        "queue_capacity": queue_capacity,
        "queue_mode": "priority_by_score_desc",
        "worker_count": _AI_WORKER_COUNT,
        "pending_count": _AI_PENDING_COUNT,
        "processed_last_minute": len(_AI_PROCESSED_WINDOW),
        "rate_limit_per_minute": _AI_RATE_LIMIT_PER_MINUTE,
        "retry_delay_seconds": _AI_RETRY_DELAY_SECONDS,
        "saturation_pct": saturation_pct,
        "ready": key_configured and dependency_available,
    }
