from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from database import AlertDatabase
from defcon import calculate_defcon
from keyword_filter import evaluate_message
from location_resolver import resolve_location
from telegram_scraper import DEFAULT_CHANNELS, TelegramScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("conflict_detector")


def _load_dotenv(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key and key not in os.environ:
            os.environ[key] = value


class WebSocketHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            clients = list(self._clients)

        if not clients:
            return

        stale_clients: list[WebSocket] = []
        for client in clients:
            try:
                await client.send_json(payload)
            except Exception:
                stale_clients.append(client)

        if stale_clients:
            async with self._lock:
                for client in stale_clients:
                    self._clients.discard(client)


def _format_timestamp(ts: datetime | str | None) -> str:
    if ts is None:
        ts_dt = datetime.now(timezone.utc)
    elif isinstance(ts, str):
        ts_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    else:
        ts_dt = ts

    if ts_dt.tzinfo is None:
        ts_dt = ts_dt.replace(tzinfo=timezone.utc)
    else:
        ts_dt = ts_dt.astimezone(timezone.utc)

    return ts_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _build_title(text: str, max_len: int = 120) -> str:
    one_line = " ".join(text.strip().split())
    if len(one_line) <= max_len:
        return one_line
    return f"{one_line[:max_len - 3]}..."


class AlertPipeline:
    def __init__(self, db: AlertDatabase, ws_hub: WebSocketHub) -> None:
        self.db = db
        self.ws_hub = ws_hub

    async def handle_telegram_message(self, payload: dict[str, Any]) -> None:
        text = str(payload.get("text", "")).strip()
        if not text:
            return

        source_channel = str(payload.get("channel", "unknown")).strip()

        try:
            decision = evaluate_message(text, source_channel)
            if not decision.accepted:
                logger.info(
                    "alert_rejected channel=%s score=%s severity=%s confidence=%s",
                    source_channel,
                    decision.score,
                    decision.severity,
                    decision.confidence,
                )
                return

            location = resolve_location(text)
            alert = {
                "timestamp": _format_timestamp(payload.get("timestamp")),
                "title": _build_title(text),
                "type": decision.event_type,
                "country": location["country"],
                "region": location["region"],
                "lat": location["lat"],
                "lng": location["lng"],
                "severity": decision.severity,
                "confidence": decision.confidence,
                "source_channel": source_channel,
                "original_text": text,
                "score": decision.score,
            }

            inserted = await self.db.insert_alert(alert)
            if not inserted:
                logger.info(
                    "alert_duplicate channel=%s score=%s",
                    source_channel,
                    decision.score,
                )
                return

            logger.info(
                "alert_accepted channel=%s score=%s severity=%s confidence=%s country=%s region=%s",
                source_channel,
                decision.score,
                decision.severity,
                decision.confidence,
                alert["country"],
                alert["region"],
            )

            await self.ws_hub.broadcast({"type": "alert", "data": alert})

        except Exception:
            logger.exception("pipeline_error channel=%s", source_channel)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_dotenv()

    db_path = os.getenv("SQLITE_PATH", "alerts.db")
    db = AlertDatabase(db_path=db_path)
    await db.connect()

    ws_hub = WebSocketHub()
    pipeline = AlertPipeline(db=db, ws_hub=ws_hub)

    app.state.db = db
    app.state.ws_hub = ws_hub
    app.state.pipeline = pipeline
    app.state.scraper = None
    app.state.scraper_task = None

    api_id_raw = os.getenv("TELEGRAM_API_ID", "").strip()
    api_hash = os.getenv("TELEGRAM_API_HASH", "").strip()

    if api_id_raw and api_hash:
        try:
            api_id = int(api_id_raw)
            scraper = TelegramScraper(
                api_id=api_id,
                api_hash=api_hash,
                channels=DEFAULT_CHANNELS,
                on_message=pipeline.handle_telegram_message,
            )
            scraper_task = asyncio.create_task(scraper.run_forever(), name="telegram-listener")
            app.state.scraper = scraper
            app.state.scraper_task = scraper_task
            logger.info("telegram_listener_started channels=%s", len(DEFAULT_CHANNELS))
        except ValueError:
            logger.error("invalid_telegram_api_id value=%s", api_id_raw)
    else:
        logger.warning("telegram_listener_disabled reason=missing_credentials")

    try:
        yield
    finally:
        scraper = app.state.scraper
        scraper_task = app.state.scraper_task

        if scraper is not None:
            await scraper.stop()

        if scraper_task is not None:
            scraper_task.cancel()
            with suppress(asyncio.CancelledError):
                await scraper_task

        await db.close()


app = FastAPI(title="Conflict Detector Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        ),
    }


@app.get("/api/alerts")
async def get_alerts(
    severity: str | None = Query(default=None),
    country: str | None = Query(default=None),
) -> dict[str, Any]:
    db: AlertDatabase = app.state.db
    alerts = await db.get_alerts(severity=severity, country=country, limit=100)
    return {
        "count": len(alerts),
        "alerts": alerts,
    }


@app.get("/api/stats")
async def get_stats() -> dict[str, Any]:
    db: AlertDatabase = app.state.db

    alerts_last_2h = await db.get_recent_alerts(hours=2)
    severity_last_24h = await db.get_severity_counts(hours=24)
    top_countries = await db.get_top_countries(hours=24, limit=10)
    stored_alerts = await db.count_alerts()

    defcon_payload = calculate_defcon(alerts_last_2h)

    return {
        "defcon": defcon_payload,
        "counters": {
            "stored_alerts": stored_alerts,
            "alerts_last_2h": len(alerts_last_2h),
            "severity_last_24h": severity_last_24h,
        },
        "top_countries": top_countries,
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    hub: WebSocketHub = app.state.ws_hub
    await hub.connect(websocket)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("websocket_connection_error")
    finally:
        await hub.disconnect(websocket)
