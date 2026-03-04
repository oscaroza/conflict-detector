import asyncio
import json
import logging
import os
import re
from difflib import SequenceMatcher
from collections import Counter
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional, Set

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from ai_analyzer import (
    ai_health as get_ai_health,
    analyze_event_async,
    enqueue_event_analysis,
    get_cached_analysis,
    set_cached_analysis,
)
from database import (
    DUPLICATE_WINDOW_SECONDS,
    SIMILARITY_THRESHOLD,
    get_alert_by_source_ref,
    get_alerts,
    get_alerts_since,
    init_db,
    insert_alert,
    update_alert_ai_fields,
)
from defcon import build_activity_snapshot, calculate_defcon
from keyword_filter import ALERT_SCORE_THRESHOLD, analyze_message
from location_resolver import resolve_location
from rss_scraper import RSSScraper
from telegram_scraper import TelegramScraper

logger = logging.getLogger("conflict_detector")

_PIPELINE_COUNTERS = {
    "accepted_requests": 0,
    "rejected_requests": 0,
}


def _safe_float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = float(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def _safe_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))

_RSS_DUPLICATE_TITLE_THRESHOLD = _safe_float_env("RSS_DUPLICATE_TITLE_THRESHOLD", default=0.70, minimum=0.5, maximum=0.98)
_RSS_DUPLICATE_WINDOW_SECONDS = _safe_int_env(
    "RSS_DUPLICATE_WINDOW_SECONDS",
    default=6 * 3600,
    minimum=300,
    maximum=7 * 24 * 3600,
)
_RSS_DUPLICATE_CACHE_MAX_ITEMS = _safe_int_env("RSS_DUPLICATE_CACHE_MAX_ITEMS", default=1200, minimum=80, maximum=5000)
_RSS_TITLE_CACHE: List[Dict[str, Any]] = []
_RSS_TITLE_CACHE_LOCK = asyncio.Lock()


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")


def log_event(event: str, **fields: Any) -> None:
    normalized_event = str(event or "").strip().lower()
    if normalized_event in {"alert_accepted", "rss_alert_accepted"}:
        _PIPELINE_COUNTERS["accepted_requests"] = int(_PIPELINE_COUNTERS.get("accepted_requests", 0)) + 1
    elif normalized_event in {"alert_rejected", "rss_alert_rejected", "rss_rejected_no_keywords", "rss_rejected_duplicate"}:
        _PIPELINE_COUNTERS["rejected_requests"] = int(_PIPELINE_COUNTERS.get("rejected_requests", 0)) + 1

    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    logger.info(json.dumps(payload, ensure_ascii=False))


def pipeline_counters_snapshot() -> Dict[str, int]:
    return {
        "accepted_requests": int(_PIPELINE_COUNTERS.get("accepted_requests", 0)),
        "rejected_requests": int(_PIPELINE_COUNTERS.get("rejected_requests", 0)),
    }


class WebSocketManager:
    def __init__(self) -> None:
        self._clients: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self._clients:
                self._clients.remove(websocket)

    async def broadcast(self, payload: Dict[str, Any]) -> None:
        stale: List[WebSocket] = []
        async with self._lock:
            clients = list(self._clients)

        for client in clients:
            try:
                await client.send_json(payload)
            except Exception:
                stale.append(client)

        if stale:
            async with self._lock:
                for client in stale:
                    self._clients.discard(client)


class SSEManager:
    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    async def broadcast(self, event: str, payload: Dict[str, Any]) -> None:
        data = f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        async with self._lock:
            subscribers = list(self._subscribers)

        for queue in subscribers:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                try:
                    _ = queue.get_nowait()
                    queue.put_nowait(data)
                except Exception:
                    pass


app = FastAPI(title="Conflict Detector Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _build_title(text: str) -> str:
    first_line = (text or "").strip().splitlines()[0] if text else ""
    title = first_line.strip()[:220]
    return title or "Alerte terrain"


def _normalize_rss_title_for_dedupe(title: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()
    return re.sub(r"\s+", " ", normalized)


def _prune_rss_title_cache(now_ts: float) -> None:
    cutoff_ts = now_ts - float(_RSS_DUPLICATE_WINDOW_SECONDS)
    if _RSS_TITLE_CACHE:
        _RSS_TITLE_CACHE[:] = [item for item in _RSS_TITLE_CACHE if float(item.get("seen_at", 0.0)) >= cutoff_ts]
    if len(_RSS_TITLE_CACHE) > _RSS_DUPLICATE_CACHE_MAX_ITEMS:
        overflow = len(_RSS_TITLE_CACHE) - _RSS_DUPLICATE_CACHE_MAX_ITEMS
        del _RSS_TITLE_CACHE[:overflow]


async def _find_rss_title_duplicate(title: str, source_ref: str) -> Optional[Dict[str, Any]]:
    normalized_title = _normalize_rss_title_for_dedupe(title)
    if not normalized_title:
        return None

    async with _RSS_TITLE_CACHE_LOCK:
        now_ts = datetime.now(timezone.utc).timestamp()
        _prune_rss_title_cache(now_ts)

        for candidate in reversed(_RSS_TITLE_CACHE):
            candidate_source_ref = str(candidate.get("source_ref") or "").strip()
            if source_ref and candidate_source_ref and source_ref == candidate_source_ref:
                continue

            candidate_title = str(candidate.get("normalized_title") or "").strip()
            if not candidate_title:
                continue

            similarity = SequenceMatcher(None, normalized_title, candidate_title).ratio()
            if similarity > _RSS_DUPLICATE_TITLE_THRESHOLD:
                return {
                    "similarity": round(float(similarity), 4),
                    "source_ref": candidate_source_ref,
                    "source_name": str(candidate.get("source_name") or "").strip(),
                    "source_url": str(candidate.get("source_url") or "").strip(),
                    "title": str(candidate.get("title") or "").strip(),
                }
    return None


async def _register_rss_title(title: str, source_ref: str, source_name: str, source_url: str) -> None:
    normalized_title = _normalize_rss_title_for_dedupe(title)
    if not normalized_title:
        return

    async with _RSS_TITLE_CACHE_LOCK:
        now_ts = datetime.now(timezone.utc).timestamp()
        _prune_rss_title_cache(now_ts)
        _RSS_TITLE_CACHE.append(
            {
                "normalized_title": normalized_title,
                "title": str(title or "").strip()[:220],
                "source_ref": str(source_ref or "").strip(),
                "source_name": str(source_name or "").strip()[:180],
                "source_url": str(source_url or "").strip()[:1200],
                "seen_at": now_ts,
            }
        )
        if len(_RSS_TITLE_CACHE) > _RSS_DUPLICATE_CACHE_MAX_ITEMS:
            overflow = len(_RSS_TITLE_CACHE) - _RSS_DUPLICATE_CACHE_MAX_ITEMS
            del _RSS_TITLE_CACHE[:overflow]


async def _seed_rss_title_cache_from_db() -> None:
    rss_alerts = await get_alerts(limit=min(_RSS_DUPLICATE_CACHE_MAX_ITEMS, 500), source_type="rss")
    if not rss_alerts:
        return

    async with _RSS_TITLE_CACHE_LOCK:
        _RSS_TITLE_CACHE.clear()
        now_ts = datetime.now(timezone.utc).timestamp()
        cutoff_ts = now_ts - float(_RSS_DUPLICATE_WINDOW_SECONDS)

        for alert in reversed(rss_alerts):
            title = str(alert.get("title") or "").strip()
            normalized_title = _normalize_rss_title_for_dedupe(title)
            if not normalized_title:
                continue

            seen_at = datetime.now(timezone.utc).timestamp()
            raw_ts = str(alert.get("timestamp") or "").strip()
            try:
                parsed_ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
                if parsed_ts > 0:
                    seen_at = parsed_ts
            except Exception:
                pass

            if seen_at < cutoff_ts:
                continue

            _RSS_TITLE_CACHE.append(
                {
                    "normalized_title": normalized_title,
                    "title": title[:220],
                    "source_ref": str(alert.get("source_ref") or "").strip(),
                    "source_name": str(alert.get("source_channel") or "").strip()[:180],
                    "source_url": str(alert.get("source_url") or "").strip()[:1200],
                    "seen_at": seen_at,
                }
            )

        _prune_rss_title_cache(now_ts)


def _normalize_channel_handle(source_channel: str) -> str:
    raw = str(source_channel or "").strip().lstrip("@")
    return re.sub(r"[^a-zA-Z0-9_]", "", raw)


def _build_telegram_source_url(source_channel: str, message_id: Any) -> str:
    channel_handle = _normalize_channel_handle(source_channel)
    msg = str(message_id or "").strip()
    if channel_handle and msg.isdigit():
        return f"https://t.me/{channel_handle}/{msg}"
    if channel_handle:
        return f"https://t.me/{channel_handle}"
    return ""


def _build_source_ref(prefix: str, source: str, item_id: Any) -> str:
    source_part = str(source or "").strip().lower()
    id_part = str(item_id or "").strip().lower()
    if source_part and id_part:
        return f"{prefix}:{source_part}:{id_part}"
    if id_part:
        return f"{prefix}:{id_part}"
    if source_part:
        return f"{prefix}:{source_part}"
    return ""


def _map_ai_severity_to_pipeline(value: str, fallback: str) -> str:
    normalized = str(value or "").strip().lower()
    return {
        "critique": "critique",
        "critical": "critique",
        "haute": "haute",
        "high": "haute",
        "moyenne": "moyen",
        "moyen": "moyen",
        "medium": "moyen",
        "faible": "faible",
        "low": "faible",
    }.get(normalized, fallback)


_FALLBACK_CATEGORY_TERMS: Dict[str, List[str]] = {
    "nucleaire": [
        "nuclear",
        "nuke",
        "radioactive",
        "radiation",
        "warhead",
        "icbm",
    ],
    "missile": [
        "missile",
        "ballistic",
        "rocket",
        "cruise missile",
        "launcher",
        "intercepted",
    ],
    "drone": [
        "drone",
        "uav",
        "kamikaze drone",
        "loitering munition",
        "shahed",
    ],
    "frappe_aerienne": [
        "airstrike",
        "air strike",
        "bombing",
        "fighter jet",
        "jet strike",
        "strike",
    ],
    "artillerie": [
        "artillery",
        "shelling",
        "mortar",
        "howitzer",
        "barrage",
    ],
    "conflit_terrestre": [
        "troops",
        "infantry",
        "ground assault",
        "tank",
        "armored",
        "battle",
        "clash",
        "frontline",
        "incursion",
    ],
    "cyberattaque": [
        "cyberattack",
        "cyber attack",
        "ddos",
        "ransomware",
        "hacked",
        "malware",
    ],
    "terrorisme": [
        "terror",
        "terrorist",
        "suicide bombing",
        "hostage",
        "isil",
        "isis",
    ],
    "diplomatie": [
        "condemn",
        "protest",
        "sanction",
        "summit",
        "meeting",
        "ceasefire talks",
        "communique",
        "statement",
    ],
}

_FALLBACK_TERRAIN_TERMS = [
    "strike",
    "attacked",
    "bombed",
    "launched",
    "explosion",
    "detonation",
    "clash",
    "troops",
    "deployed",
]
_FALLBACK_DIPLO_TERMS = [
    "condemn",
    "condemns",
    "protest",
    "protests",
    "statement",
    "announced",
    "announces",
    "meeting",
    "summit",
    "talks",
    "sanctions",
]
_FALLBACK_PRESS_TERMS = [
    "analysis",
    "opinion",
    "explainer",
    "throwback",
    "history",
    "retrospective",
    "anniversary",
    "years ago",
]

_RSS_GROQ_GATE_TERMS = [
    # Militaire / conflit
    "war",
    "warfare",
    "military",
    "troops",
    "soldiers",
    "army",
    "navy",
    "air force",
    "airforce",
    "airstrike",
    "air strike",
    "strike",
    "attack",
    "bomb",
    "missile",
    "rocket",
    "explosion",
    "blast",
    "gunfire",
    "shooting",
    "killed",
    "wounded",
    "casualties",
    "dead",
    "death",
    "hostage",
    "siege",
    "invasion",
    "offensive",
    "ceasefire",
    "frontline",
    "battlefield",
    "combat",
    "weapons",
    "artillery",
    "drone",
    "tank",
    "warship",
    # Geopolitique
    "conflict",
    "crisis",
    "tension",
    "sanctions",
    "nuclear",
    "terrorism",
    "terrorist",
    "coup",
    "protest",
    "riot",
    "uprising",
    "rebel",
    "militia",
    "insurgent",
    "hostilities",
    "diplomatic",
    "ultimatum",
    "threat",
    "aggression",
    "annexation",
    "occupation",
    "blockade",
    # Organisations / acteurs
    "nato",
    "iaea",
    "hamas",
    "hezbollah",
    "isis",
    "wagner",
    "houthis",
    "taliban",
]
_RSS_GROQ_GATE_SPECIAL_PATTERNS = {
    "UN": re.compile(r"\b(?:UN|U\.N\.)\b"),
}


def _normalize_lookup_text(value: str) -> str:
    return f" {re.sub(r'[^a-z0-9]+', ' ', str(value or '').lower()).strip()} "


def _keyword_term_variants(normalized_term: str) -> List[str]:
    base = re.sub(r"[^a-z0-9]+", " ", str(normalized_term or "").lower()).strip()
    if not base:
        return []

    tokens = [token for token in base.split(" ") if token]
    if not tokens:
        return []

    tail = tokens[-1]
    tail_forms = [tail]

    if len(tail) >= 4:
        tail_forms.extend([f"{tail}s", f"{tail}es"])
        if tail.endswith("y") and len(tail) >= 5:
            tail_forms.append(f"{tail[:-1]}ies")
        if tail.endswith("e") and len(tail) >= 5:
            tail_forms.extend([f"{tail[:-1]}ing", f"{tail}d"])
        else:
            tail_forms.extend([f"{tail}ing", f"{tail}ed"])

    variants: List[str] = []
    seen = set()
    for tail_variant in tail_forms:
        candidate_tokens = tokens[:-1] + [tail_variant]
        candidate = " ".join(candidate_tokens).strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        variants.append(candidate)
    return variants


def _find_matched_terms(normalized_text: str, terms: List[str]) -> List[str]:
    matches: List[str] = []
    seen = set()
    for term in terms:
        normalized_term = re.sub(r"[^a-z0-9]+", " ", str(term or "").lower()).strip()
        if not normalized_term or normalized_term in seen:
            continue
        variants = _keyword_term_variants(normalized_term)
        if any(f" {variant} " in normalized_text for variant in variants):
            matches.append(normalized_term)
            seen.add(normalized_term)
    return matches


def _rss_has_groq_keywords(title: str, description: str) -> Dict[str, Any]:
    scan_text = " ".join(part for part in [str(title or ""), str(description or "")] if part).strip()
    if not scan_text:
        return {"accepted": False, "matched_keywords": []}

    normalized_text = _normalize_lookup_text(scan_text)
    matches = _find_matched_terms(normalized_text, _RSS_GROQ_GATE_TERMS)

    for label, pattern in _RSS_GROQ_GATE_SPECIAL_PATTERNS.items():
        if pattern.search(scan_text):
            matches.append(label)

    deduped: List[str] = []
    seen = set()
    for token in matches:
        key = str(token or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(str(token).strip())

    return {"accepted": bool(deduped), "matched_keywords": deduped}


def _fallback_ai_severity(base_severity: str) -> Dict[str, Any]:
    severity_map = {
        "critique": ("critique", 0.92),
        "haute": ("haute", 0.76),
        "moyen": ("moyenne", 0.54),
        "faible": ("faible", 0.30),
    }
    normalized = str(base_severity or "").strip().lower()
    severity, score = severity_map.get(normalized, ("moyenne", 0.50))
    return {"severity": severity, "severity_score": score}


def _build_keyword_fallback_ai(payload: Dict[str, Any]) -> Dict[str, Any]:
    source_text = " ".join(
        [
            str(payload.get("title") or ""),
            str(payload.get("summary") or ""),
            str(payload.get("original_text") or ""),
        ]
    ).strip()
    normalized_text = _normalize_lookup_text(source_text)

    category_scores: Dict[str, int] = {}
    category_matches: Dict[str, List[str]] = {}
    for category, terms in _FALLBACK_CATEGORY_TERMS.items():
        matched = _find_matched_terms(normalized_text, terms)
        if matched:
            category_scores[category] = len(matched)
            category_matches[category] = matched

    chosen_category = "autre"
    if category_scores:
        chosen_category = max(
            category_scores.items(),
            key=lambda item: (item[1], item[0] != "diplomatie"),
        )[0]
    elif _find_matched_terms(normalized_text, _FALLBACK_DIPLO_TERMS):
        chosen_category = "diplomatie"

    terrain_hits = _find_matched_terms(normalized_text, _FALLBACK_TERRAIN_TERMS)
    diplomatic_hits = _find_matched_terms(normalized_text, _FALLBACK_DIPLO_TERMS)
    press_hits = _find_matched_terms(normalized_text, _FALLBACK_PRESS_TERMS)

    if terrain_hits:
        event_type = "terrain_event"
    elif diplomatic_hits:
        event_type = "diplomatic"
    elif press_hits:
        event_type = "press_return"
    elif chosen_category == "diplomatie":
        event_type = "diplomatic"
    elif chosen_category == "autre":
        event_type = "press_return"
    else:
        event_type = "terrain_event"

    fallback_severity = _fallback_ai_severity(str(payload.get("severity") or "moyen"))
    confidence_raw = int(payload.get("confidence") or 0)
    reliability_score = max(0.0, min(1.0, round(confidence_raw / 100.0, 4)))

    country = str(payload.get("country") or "").strip()
    region = str(payload.get("region") or "").strip()
    location_of_event = region if region and region.lower() != "global" else country
    if not location_of_event or location_of_event.lower() == "inconnu":
        location_of_event = ""

    summary_seed = str(payload.get("summary") or payload.get("title") or "").strip()
    if len(summary_seed) > 260:
        summary_seed = f"{summary_seed[:257].rstrip()}..."

    subcategories = category_matches.get(chosen_category, [])[:4]
    if not subcategories:
        subcategories = (terrain_hits or diplomatic_hits or press_hits)[:4]

    return {
        "category": chosen_category,
        "event_type": event_type,
        "actor": "",
        "actor_action": "",
        "target": "",
        "location_of_event": location_of_event,
        "context": "",
        "subcategories": subcategories,
        "severity": fallback_severity["severity"],
        "severity_score": fallback_severity["severity_score"],
        "countries": [country] if country and country.lower() != "inconnu" else [],
        "actors": [],
        "summary": summary_seed,
        "reliability_score": reliability_score,
        "is_conflict_related": chosen_category != "autre" and event_type != "press_return",
    }


async def _analyze_with_cache(
    cache_key: str,
    title: str,
    description: str,
    source: str,
    priority_score: float = 0.0,
) -> Dict[str, Any]:
    cached = get_cached_analysis(cache_key)
    if cached is not None:
        return cached

    analyzed = await analyze_event_async(
        title=title,
        description=description,
        source=source,
        priority_score=priority_score,
    )
    set_cached_analysis(cache_key, analyzed)
    return analyzed


def _pending_ai_result(error: str = "queued_for_ai_analysis") -> Dict[str, Any]:
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
        "ai_model": str(get_ai_health().get("model") or ""),
        "ai_error": str(error or "").strip(),
    }


def _track_background_task(task: asyncio.Task) -> None:
    tasks: Set[asyncio.Task] = getattr(app.state, "background_tasks", set())
    tasks.add(task)

    def _cleanup(done_task: asyncio.Task) -> None:
        tasks.discard(done_task)

    task.add_done_callback(_cleanup)
    app.state.background_tasks = tasks


async def _apply_async_ai_enrichment(
    *,
    alert_id: int,
    base_alert: Dict[str, Any],
    cache_key: str,
    title: str,
    description: str,
    source: str,
    priority_score: float,
) -> None:
    try:
        cached = get_cached_analysis(cache_key)
        if cached is not None:
            ai_result = cached
        else:
            ai_future = await enqueue_event_analysis(
                title=title,
                description=description,
                source=source,
                priority_score=priority_score,
            )
            ai_result = await ai_future
            set_cached_analysis(cache_key, ai_result)

        enriched_payload = _apply_ai_enrichment(base_alert, ai_result)
        updated = await update_alert_ai_fields(alert_id=alert_id, payload=enriched_payload)
        if updated is None:
            return

        ws_manager: WebSocketManager = app.state.ws_manager
        await ws_manager.broadcast({"type": "alert_updated", "alert": updated})
        sse_manager: SSEManager = app.state.sse_manager
        await sse_manager.broadcast("alert-updated", {"alert": updated})
        log_event(
            "alert_ai_enriched",
            alert_id=updated["id"],
            source=str(updated.get("source_channel") or ""),
            ai_analyzed=bool(updated.get("ai_analyzed")),
            ai_category=updated.get("ai_category"),
            ai_model=ai_result.get("ai_model"),
            ai_error=str(ai_result.get("ai_error") or "")[:220],
        )
    except Exception:
        logger.warning("alert_ai_enrichment_failed", exc_info=True)


def _apply_ai_enrichment(payload: Dict[str, Any], ai_result: Dict[str, Any]) -> Dict[str, Any]:
    enriched = dict(payload)
    ai = dict(ai_result or {})

    enriched["ai_analyzed"] = bool(ai.get("ai_analyzed"))
    enriched["ai_category"] = str(ai.get("category") or "autre")
    enriched["ai_event_type"] = str(ai.get("event_type") or "press_return")
    enriched["event_actor"] = str(ai.get("actor") or "").strip()
    enriched["event_actor_action"] = str(ai.get("actor_action") or "").strip()
    enriched["event_target"] = str(ai.get("target") or "").strip()
    enriched["event_location"] = str(ai.get("location_of_event") or "").strip()
    enriched["event_context"] = str(ai.get("context") or "").strip()
    enriched["ai_subcategories"] = list(ai.get("subcategories") or [])
    enriched["ai_severity"] = str(ai.get("severity") or "moyenne")
    enriched["ai_severity_score"] = float(ai.get("severity_score") or 0.0)
    enriched["ai_countries"] = list(ai.get("countries") or [])
    enriched["ai_actors"] = list(ai.get("actors") or [])
    enriched["ai_summary"] = str(ai.get("summary") or "").strip()
    enriched["ai_reliability_score"] = float(ai.get("reliability_score") or 0.0)
    enriched["ai_is_conflict_related"] = bool(ai.get("is_conflict_related"))

    if enriched["ai_analyzed"]:
        refined_severity = _map_ai_severity_to_pipeline(enriched["ai_severity"], enriched.get("severity", "moyen"))
        enriched["severity"] = refined_severity
        if enriched["ai_summary"] and len(enriched["ai_summary"]) >= 16:
            enriched["summary"] = enriched["ai_summary"]
        confidence = int(enriched.get("confidence") or 0)
        reliability = int(round(max(0.0, min(1.0, enriched["ai_reliability_score"])) * 100))
        enriched["confidence"] = max(0, min(100, int(round(confidence * 0.65 + reliability * 0.35))))
    else:
        fallback = _build_keyword_fallback_ai(enriched)
        enriched["ai_category"] = fallback["category"]
        enriched["ai_event_type"] = fallback["event_type"]
        enriched["event_actor"] = fallback["actor"]
        enriched["event_actor_action"] = fallback["actor_action"]
        enriched["event_target"] = fallback["target"]
        enriched["event_location"] = fallback["location_of_event"]
        enriched["event_context"] = fallback["context"]
        enriched["ai_subcategories"] = fallback["subcategories"]
        enriched["ai_severity"] = fallback["severity"]
        enriched["ai_severity_score"] = float(fallback["severity_score"])
        enriched["ai_countries"] = fallback["countries"]
        enriched["ai_actors"] = fallback["actors"]
        enriched["ai_summary"] = fallback["summary"]
        enriched["ai_reliability_score"] = float(fallback["reliability_score"])
        enriched["ai_is_conflict_related"] = bool(fallback["is_conflict_related"])

    return enriched


async def process_telegram_message(message: Dict[str, Any]) -> None:
    try:
        text = str(message.get("text") or "").strip()
        source_channel = str(message.get("source_channel") or "unknown")
        source_ref = _build_source_ref("telegram", source_channel, message.get("id"))
        if not text:
            return
        if source_ref:
            existing = await get_alert_by_source_ref(source_ref)
            if existing is not None:
                return

        analysis = analyze_message(text, source_channel)
        if not analysis.accepted:
            log_event(
                "alert_rejected",
                source_channel=source_channel,
                score=analysis.score,
                reason=analysis.reason,
            )
            return

        location = resolve_location(text)
        title = _build_title(text)
        cache_key = source_ref or f"telegram:{source_channel}:{message.get('timestamp')}"
        cached_ai_result = get_cached_analysis(cache_key)
        ai_result = cached_ai_result if cached_ai_result is not None else _pending_ai_result()
        alert_payload = {
            "timestamp": message.get("timestamp"),
            "title": title,
            "summary": text,
            "type": "geopolitique",
            "country": location["country"],
            "region": location["region"],
            "lat": location["lat"],
            "lng": location["lng"],
            "severity": analysis.severity,
            "confidence": analysis.confidence,
            "source_channel": source_channel,
            "source_type": "telegram",
            "source_ref": source_ref,
            "source_url": _build_telegram_source_url(source_channel, message.get("id")),
            "original_text": text,
            "score": analysis.score,
        }
        alert_payload = _apply_ai_enrichment(alert_payload, ai_result)

        inserted = await insert_alert(alert_payload)
        if inserted is None:
            log_event(
                "alert_skipped_duplicate",
                source_channel=source_channel,
                score=analysis.score,
            )
            return

        ws_manager: WebSocketManager = app.state.ws_manager
        await ws_manager.broadcast({"type": "new_alert", "alert": inserted})
        sse_manager: SSEManager = app.state.sse_manager
        await sse_manager.broadcast("new-alert", {"alert": inserted})

        if cached_ai_result is None:
            task = asyncio.create_task(
                _apply_async_ai_enrichment(
                    alert_id=int(inserted["id"]),
                    base_alert=dict(inserted),
                    cache_key=cache_key,
                    title=title,
                    description=text,
                    source=source_channel,
                    priority_score=float(analysis.score),
                )
            )
            _track_background_task(task)

        log_event(
            "alert_accepted",
            alert_id=inserted["id"],
            source_channel=source_channel,
            severity=inserted["severity"],
            confidence=inserted["confidence"],
            country=inserted["country"],
            score=inserted["score"],
            ai_analyzed=bool(inserted.get("ai_analyzed")),
            ai_category=inserted.get("ai_category"),
            ai_model=ai_result.get("ai_model"),
            ai_error=str(ai_result.get("ai_error") or "")[:220],
        )
    except Exception:
        # Skip silently on malformed message, keep service alive.
        logger.warning("message_pipeline_skipped_malformed")


async def process_rss_item(item: Dict[str, Any]) -> None:
    try:
        title = str(item.get("title") or "").strip()[:220]
        description = str(item.get("description") or "").strip()
        source_name = str(item.get("source_name") or "RSS").strip() or "RSS"
        source_ref = str(item.get("source_ref") or "").strip()
        source_url = str(item.get("source_url") or "").strip()
        combined_text = " ".join(part for part in [title, description] if part).strip()
        if not combined_text:
            return

        if source_ref:
            existing = await get_alert_by_source_ref(source_ref)
            if existing is not None:
                return

        keyword_gate = _rss_has_groq_keywords(title=title, description=description)
        if not keyword_gate["accepted"]:
            log_event(
                "rss_rejected_no_keywords",
                source=source_name,
                source_ref=source_ref,
                source_url=source_url,
                title=(title or "")[:180],
            )
            return

        analysis = analyze_message(combined_text, source_name)
        if not analysis.accepted:
            log_event(
                "rss_alert_rejected",
                source=source_name,
                score=analysis.score,
                reason=analysis.reason,
            )
            return

        location = resolve_location(combined_text)
        ai_title = title or _build_title(combined_text)
        ai_description = description or combined_text

        duplicate_match = await _find_rss_title_duplicate(ai_title, source_ref)
        if duplicate_match is not None:
            log_event(
                "rss_rejected_duplicate",
                source=source_name,
                source_ref=source_ref,
                source_url=source_url,
                title=(ai_title or "")[:180],
                duplicate_source_ref=str(duplicate_match.get("source_ref") or ""),
                duplicate_source=str(duplicate_match.get("source_name") or ""),
                duplicate_url=str(duplicate_match.get("source_url") or ""),
                duplicate_title=str(duplicate_match.get("title") or "")[:180],
                similarity=float(duplicate_match.get("similarity") or 0.0),
                threshold=float(_RSS_DUPLICATE_TITLE_THRESHOLD),
            )
            return

        cache_key = source_ref or f"rss:{source_url or title}"
        cached_ai_result = get_cached_analysis(cache_key)
        ai_result = cached_ai_result if cached_ai_result is not None else _pending_ai_result()

        alert_payload = {
            "timestamp": item.get("timestamp"),
            "title": ai_title,
            "summary": description[:1200],
            "type": "geopolitique",
            "country": location["country"],
            "region": location["region"],
            "lat": location["lat"],
            "lng": location["lng"],
            "severity": analysis.severity,
            "confidence": analysis.confidence,
            "source_channel": source_name,
            "source_type": "rss",
            "source_ref": source_ref,
            "source_url": source_url,
            "original_text": combined_text,
            "score": analysis.score,
        }
        alert_payload = _apply_ai_enrichment(alert_payload, ai_result)

        inserted = await insert_alert(alert_payload)
        if inserted is None:
            log_event(
                "rss_rejected_duplicate",
                source=source_name,
                source_ref=source_ref,
                source_url=source_url,
                title=(ai_title or "")[:180],
                reason="db_duplicate_guard",
            )
            return

        await _register_rss_title(ai_title, source_ref, source_name, source_url)

        ws_manager: WebSocketManager = app.state.ws_manager
        await ws_manager.broadcast({"type": "new_alert", "alert": inserted})
        sse_manager: SSEManager = app.state.sse_manager
        await sse_manager.broadcast("new-alert", {"alert": inserted})

        if cached_ai_result is None:
            task = asyncio.create_task(
                _apply_async_ai_enrichment(
                    alert_id=int(inserted["id"]),
                    base_alert=dict(inserted),
                    cache_key=cache_key,
                    title=ai_title,
                    description=ai_description,
                    source=source_name,
                    priority_score=float(analysis.score),
                )
            )
            _track_background_task(task)

        log_event(
            "rss_alert_accepted",
            alert_id=inserted["id"],
            source=source_name,
            severity=inserted["severity"],
            confidence=inserted["confidence"],
            country=inserted["country"],
            score=inserted["score"],
            ai_analyzed=bool(inserted.get("ai_analyzed")),
            ai_category=inserted.get("ai_category"),
            ai_model=ai_result.get("ai_model"),
            ai_error=str(ai_result.get("ai_error") or "")[:220],
        )
    except Exception:
        logger.warning("rss_pipeline_skipped_malformed")


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "at": datetime.now(timezone.utc).isoformat()}


@app.get("/api/ai/health")
async def ai_health() -> Dict[str, Any]:
    return {
        **get_ai_health(),
        **pipeline_counters_snapshot(),
    }


@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "service": "Conflict Detector Backend",
        "status": "online",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/api/alerts")
async def api_alerts(
    severity: Optional[str] = Query(default=None),
    country: Optional[str] = Query(default=None),
    source_type: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> Dict[str, Any]:
    alerts = await get_alerts(limit=limit, severity=severity, country=country, source_type=source_type)
    return {"count": len(alerts), "alerts": alerts}


@app.get("/api/countries")
async def api_countries() -> List[str]:
    alerts = await get_alerts(limit=500)
    countries = sorted(
        {
            str(alert.get("country") or "").strip()
            for alert in alerts
            if str(alert.get("country") or "").strip() and str(alert.get("country")).strip() != "Inconnu"
        }
    )
    return countries


@app.get("/api/regions")
async def api_regions() -> List[str]:
    alerts = await get_alerts(limit=500)
    regions = sorted(
        {
            str(alert.get("region") or "").strip()
            for alert in alerts
            if str(alert.get("region") or "").strip() and str(alert.get("region")).strip() != "Global"
        }
    )
    return regions


@app.get("/api/stats")
async def api_stats() -> Dict[str, Any]:
    recent_alerts = await get_alerts_since(hours=2)
    defcon = calculate_defcon(recent_alerts)
    snapshot = build_activity_snapshot(recent_alerts)
    source_counter = Counter(str(alert.get("source_channel") or "unknown") for alert in recent_alerts)

    return {
        "at": datetime.now(timezone.utc).isoformat(),
        "defcon": defcon,
        **snapshot,
        **pipeline_counters_snapshot(),
        "top_sources": [
            {"source_channel": name, "count": count}
            for name, count in source_counter.most_common(8)
        ],
    }


@app.get("/api/stream")
async def api_stream() -> StreamingResponse:
    sse_manager: SSEManager = app.state.sse_manager
    queue = await sse_manager.subscribe()

    async def event_generator() -> AsyncIterator[str]:
        yield f"event: connected\ndata: {json.dumps({'at': datetime.now(timezone.utc).isoformat()})}\n\n"
        try:
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                    yield message
                except asyncio.TimeoutError:
                    yield f"event: ping\ndata: {json.dumps({'at': datetime.now(timezone.utc).isoformat()})}\n\n"
        finally:
            await sse_manager.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    ws_manager: WebSocketManager = app.state.ws_manager
    await ws_manager.connect(websocket)
    await websocket.send_json({"type": "connected", "at": datetime.now(timezone.utc).isoformat()})

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket)


@app.on_event("startup")
async def startup() -> None:
    configure_logging()
    await init_db()
    await _seed_rss_title_cache_from_db()

    app.state.ws_manager = WebSocketManager()
    app.state.sse_manager = SSEManager()
    app.state.scraper = None
    app.state.scraper_task = None
    app.state.rss_scraper = RSSScraper(on_item=process_rss_item)
    app.state.rss_task = None
    app.state.background_tasks = set()

    telegram_status = "disabled"
    telegram_channels = 0
    polling_enabled = False
    poll_seconds = 0
    poll_limit = 0
    backfill_limit = 0
    backfill_startup_max = 0

    if os.getenv("TELEGRAM_API_ID") and os.getenv("TELEGRAM_API_HASH"):
        telegram_enabled = True
        if not os.getenv("TELEGRAM_SESSION_STRING"):
            scraper_preview = TelegramScraper(on_message=process_telegram_message)
            if not scraper_preview.has_local_session_file():
                telegram_enabled = False
                telegram_status = "disabled_missing_session"
        if telegram_enabled:
            app.state.scraper = TelegramScraper(on_message=process_telegram_message)
            app.state.scraper_task = asyncio.create_task(app.state.scraper.run_forever())
            telegram_status = "enabled"
            telegram_channels = len(app.state.scraper.channels)
            polling_enabled = app.state.scraper._enable_polling
            poll_seconds = app.state.scraper._poll_seconds
            poll_limit = app.state.scraper._poll_limit
            backfill_limit = app.state.scraper._backfill_limit
            backfill_startup_max = app.state.scraper._backfill_startup_max
    else:
        telegram_status = "disabled_missing_credentials"

    rss_status = "disabled"
    rss_feeds = len(app.state.rss_scraper.feeds)
    if app.state.rss_scraper.enabled:
        app.state.rss_task = asyncio.create_task(app.state.rss_scraper.run_forever())
        rss_status = "enabled"

    log_event(
        "startup_complete",
        telegram_listener=telegram_status,
        telegram_channels=telegram_channels,
        rss_listener=rss_status,
        rss_feeds=rss_feeds,
        rss_poll_seconds=app.state.rss_scraper.poll_seconds,
        rss_duplicate_title_threshold=_RSS_DUPLICATE_TITLE_THRESHOLD,
        rss_duplicate_window_seconds=_RSS_DUPLICATE_WINDOW_SECONDS,
        alert_score_threshold=ALERT_SCORE_THRESHOLD,
        duplicate_window_seconds=DUPLICATE_WINDOW_SECONDS,
        similarity_threshold=SIMILARITY_THRESHOLD,
        backfill_limit=backfill_limit,
        backfill_startup_max=backfill_startup_max,
        polling_enabled=polling_enabled,
        poll_seconds=poll_seconds,
        poll_limit=poll_limit,
        ai_provider="groq",
        ai_model=get_ai_health().get("model"),
        ai_ready=bool(get_ai_health().get("ready")),
    )


@app.on_event("shutdown")
async def shutdown() -> None:
    scraper: Optional[TelegramScraper] = getattr(app.state, "scraper", None)
    scraper_task: Optional[asyncio.Task] = getattr(app.state, "scraper_task", None)
    rss_scraper: Optional[RSSScraper] = getattr(app.state, "rss_scraper", None)
    rss_task: Optional[asyncio.Task] = getattr(app.state, "rss_task", None)
    background_tasks: Set[asyncio.Task] = getattr(app.state, "background_tasks", set())

    if scraper is not None:
        await scraper.stop()
    if scraper_task is not None:
        scraper_task.cancel()
        try:
            await scraper_task
        except asyncio.CancelledError:
            pass

    if rss_scraper is not None:
        await rss_scraper.stop()
    if rss_task is not None:
        rss_task.cancel()
        try:
            await rss_task
        except asyncio.CancelledError:
            pass

    for task in list(background_tasks):
        task.cancel()
    for task in list(background_tasks):
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
    log_event("shutdown_complete")
