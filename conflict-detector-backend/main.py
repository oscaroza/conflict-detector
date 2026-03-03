import asyncio
import json
import logging
import os
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional, Set

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from ai_analyzer import (
    ai_health as get_ai_health,
    analyze_event_async,
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
)
from defcon import build_activity_snapshot, calculate_defcon
from keyword_filter import ALERT_SCORE_THRESHOLD, analyze_message
from location_resolver import resolve_location
from rss_scraper import RSSScraper
from telegram_scraper import TelegramScraper

logger = logging.getLogger("conflict_detector")


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")


def log_event(event: str, **fields: Any) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    logger.info(json.dumps(payload, ensure_ascii=False))


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


async def _analyze_with_cache(cache_key: str, title: str, description: str, source: str) -> Dict[str, Any]:
    cached = get_cached_analysis(cache_key)
    if cached is not None:
        return cached

    analyzed = await analyze_event_async(title=title, description=description, source=source)
    set_cached_analysis(cache_key, analyzed)
    return analyzed


def _apply_ai_enrichment(payload: Dict[str, Any], ai_result: Dict[str, Any]) -> Dict[str, Any]:
    enriched = dict(payload)
    ai = dict(ai_result or {})

    enriched["ai_analyzed"] = bool(ai.get("ai_analyzed"))
    enriched["ai_category"] = str(ai.get("category") or "autre")
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
        ai_result = await _analyze_with_cache(
            cache_key=source_ref or f"telegram:{source_channel}:{message.get('timestamp')}",
            title=title,
            description=text,
            source=source_channel,
        )
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
        ai_result = await _analyze_with_cache(
            cache_key=source_ref or f"rss:{source_url or title}",
            title=title or _build_title(combined_text),
            description=description or combined_text,
            source=source_name,
        )

        alert_payload = {
            "timestamp": item.get("timestamp"),
            "title": title or _build_title(combined_text),
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
            return

        ws_manager: WebSocketManager = app.state.ws_manager
        await ws_manager.broadcast({"type": "new_alert", "alert": inserted})
        sse_manager: SSEManager = app.state.sse_manager
        await sse_manager.broadcast("new-alert", {"alert": inserted})
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
        )
    except Exception:
        logger.warning("rss_pipeline_skipped_malformed")


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "at": datetime.now(timezone.utc).isoformat()}


@app.get("/api/ai/health")
async def ai_health() -> Dict[str, Any]:
    return get_ai_health()


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

    app.state.ws_manager = WebSocketManager()
    app.state.sse_manager = SSEManager()
    app.state.scraper = None
    app.state.scraper_task = None
    app.state.rss_scraper = RSSScraper(on_item=process_rss_item)
    app.state.rss_task = None

    telegram_status = "disabled"
    telegram_channels = 0
    polling_enabled = False
    poll_seconds = 0
    poll_limit = 0
    backfill_limit = 0

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
        alert_score_threshold=ALERT_SCORE_THRESHOLD,
        duplicate_window_seconds=DUPLICATE_WINDOW_SECONDS,
        similarity_threshold=SIMILARITY_THRESHOLD,
        backfill_limit=backfill_limit,
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
    log_event("shutdown_complete")
