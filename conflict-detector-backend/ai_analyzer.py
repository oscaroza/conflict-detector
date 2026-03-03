import asyncio
import json
import os
import re
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional

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


AI_MODEL = os.getenv("GROQ_MODEL", "llama3-8b-8192").strip() or "llama3-8b-8192"
_CACHE_MAX_ITEMS = _safe_int_env("AI_CACHE_MAX_ITEMS", default=2000, minimum=100, maximum=10000)
_GROQ_TIMEOUT_SECONDS = _safe_int_env("GROQ_TIMEOUT_SECONDS", default=16, minimum=3, maximum=60)

_CLIENT_LOCK = threading.Lock()
_CLIENT: Optional[Groq] = None
_CACHE_LOCK = threading.Lock()
_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

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


def _neutral_result(error: str = "") -> Dict[str, Any]:
    return {
        "category": "autre",
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


def _normalize_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    category = str(payload.get("category") or "autre").strip().lower()
    if category not in _ALLOWED_CATEGORIES:
        category = "autre"

    severity = _SEVERITY_MAP.get(str(payload.get("severity") or "").strip().lower(), "moyenne")
    summary = " ".join(str(payload.get("summary") or "").split()).strip()
    if len(summary) > 500:
        summary = summary[:500].strip()

    return {
        "category": category,
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
        "You are a geopolitical conflict event classifier. "
        "Return ONLY valid JSON with keys: "
        "category, subcategories, severity, severity_score, countries, actors, summary, reliability_score, is_conflict_related. "
        "Allowed category values: missile, drone, frappe_aerienne, artillerie, conflit_terrestre, cyberattaque, diplomatie, terrorisme, nucleaire, autre. "
        "Allowed severity values: critique, haute, moyenne, faible. "
        "severity_score and reliability_score must be floats between 0.0 and 1.0. "
        "summary must be factual and max 2 short sentences."
    )
    user_payload = {
        "title": safe_title,
        "description": safe_description,
        "source": safe_source,
    }

    try:
        completion = client.chat.completions.create(
            model=AI_MODEL,
            temperature=0.1,
            max_tokens=420,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
        )
        content = ""
        if completion and completion.choices:
            content = str(completion.choices[0].message.content or "")
        raw = _extract_json_object(content)
        if not raw:
            return _neutral_result("invalid_groq_json")
        return _normalize_result(raw)
    except Exception as exc:
        return _neutral_result(str(exc))


async def analyze_event_async(title: str, description: str, source: str) -> Dict[str, Any]:
    return await asyncio.to_thread(analyze_event, title, description, source)


def ai_health() -> Dict[str, Any]:
    key_configured = bool(os.getenv("GROQ_API_KEY", "").strip())
    dependency_available = Groq is not None
    with _CACHE_LOCK:
        cache_size = len(_CACHE)
    return {
        "provider": "groq",
        "model": AI_MODEL,
        "api_key_configured": key_configured,
        "dependency_available": dependency_available,
        "cache_items": cache_size,
        "ready": key_configured and dependency_available,
    }
