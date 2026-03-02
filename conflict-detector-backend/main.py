import asyncio
import json
import logging
import os
from collections import Counter
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional, Set

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from database import get_alerts, get_alerts_since, init_db, insert_alert
from defcon import build_activity_snapshot, calculate_defcon
from keyword_filter import analyze_message
from location_resolver import resolve_location
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


async def process_telegram_message(message: Dict[str, Any]) -> None:
    try:
        text = str(message.get("text") or "").strip()
        source_channel = str(message.get("source_channel") or "unknown")
        if not text:
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
        alert_payload = {
            "timestamp": message.get("timestamp"),
            "title": _build_title(text),
            "type": "geopolitique",
            "country": location["country"],
            "region": location["region"],
            "lat": location["lat"],
            "lng": location["lng"],
            "severity": analysis.severity,
            "confidence": analysis.confidence,
            "source_channel": source_channel,
            "original_text": text,
            "score": analysis.score,
        }

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
        )
    except Exception:
        # Skip silently on malformed message, keep service alive.
        logger.warning("message_pipeline_skipped_malformed")


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "at": datetime.now(timezone.utc).isoformat()}


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
    limit: int = Query(default=100, ge=1, le=500),
) -> Dict[str, Any]:
    alerts = await get_alerts(limit=limit, severity=severity, country=country)
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
    if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
        app.state.scraper = None
        app.state.scraper_task = None
        log_event("startup_complete", telegram_listener="disabled_missing_credentials")
        return

    if not os.getenv("TELEGRAM_SESSION_STRING"):
        scraper_preview = TelegramScraper(on_message=process_telegram_message)
        if not scraper_preview.has_local_session_file():
            app.state.scraper = None
            app.state.scraper_task = None
            log_event("startup_complete", telegram_listener="disabled_missing_session")
            return

    app.state.scraper = TelegramScraper(on_message=process_telegram_message)
    app.state.scraper_task = asyncio.create_task(app.state.scraper.run_forever())
    log_event("startup_complete")


@app.on_event("shutdown")
async def shutdown() -> None:
    scraper: Optional[TelegramScraper] = getattr(app.state, "scraper", None)
    scraper_task: Optional[asyncio.Task] = getattr(app.state, "scraper_task", None)

    if scraper is not None:
        await scraper.stop()
    if scraper_task is not None:
        scraper_task.cancel()
        try:
            await scraper_task
        except asyncio.CancelledError:
            pass
    log_event("shutdown_complete")
