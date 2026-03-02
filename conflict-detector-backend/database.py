import asyncio
import os
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

import aiosqlite

DB_PATH = os.getenv("SQLITE_PATH", "conflict_detector.db")


def _read_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def _read_float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = float(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


MAX_ALERTS = _read_int_env("MAX_ALERTS", default=500, minimum=100, maximum=5000)
DUPLICATE_WINDOW_SECONDS = _read_int_env("DUPLICATE_WINDOW_SECONDS", default=600, minimum=5, maximum=600)
SIMILARITY_THRESHOLD = _read_float_env("SIMILARITY_THRESHOLD", default=0.90, minimum=0.5, maximum=0.999)

_write_lock = asyncio.Lock()


def _normalize_text(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    raw = str(value or "").strip()
    if not raw:
        return datetime.now(timezone.utc)

    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


async def _connect() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    return conn


def _row_to_dict(row: Optional[aiosqlite.Row]) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    return dict(row)


async def init_db() -> None:
    conn = await _connect()
    try:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                title TEXT NOT NULL,
                type TEXT NOT NULL,
                country TEXT NOT NULL,
                region TEXT NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                severity TEXT NOT NULL,
                confidence INTEGER NOT NULL,
                source_channel TEXT NOT NULL,
                original_text TEXT NOT NULL,
                score INTEGER NOT NULL
            )
            """
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_country ON alerts(country)"
        )
        await conn.commit()
    finally:
        await conn.close()


async def _find_duplicate(
    conn: aiosqlite.Connection, message_text: str, event_ts: datetime
) -> Optional[Dict[str, Any]]:
    since = (event_ts - timedelta(seconds=DUPLICATE_WINDOW_SECONDS)).isoformat()
    cursor = await conn.execute(
        """
        SELECT id, original_text, timestamp
        FROM alerts
        WHERE timestamp >= ?
        ORDER BY timestamp DESC
        LIMIT 100
        """,
        (since,),
    )
    rows = await cursor.fetchall()
    await cursor.close()

    current = _normalize_text(message_text)
    if not current:
        return None

    for row in rows:
        candidate = _normalize_text(row["original_text"])
        ratio = SequenceMatcher(None, current, candidate).ratio()
        if ratio >= SIMILARITY_THRESHOLD:
            return {
                "duplicate_id": row["id"],
                "similarity": ratio,
                "timestamp": row["timestamp"],
            }

    return None


async def _prune_alerts(conn: aiosqlite.Connection) -> None:
    await conn.execute(
        """
        DELETE FROM alerts
        WHERE id NOT IN (
            SELECT id
            FROM alerts
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
        )
        """,
        (MAX_ALERTS,),
    )


async def insert_alert(alert: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    event_ts = _parse_timestamp(alert.get("timestamp"))
    source_text = str(alert.get("original_text") or "")

    async with _write_lock:
        conn = await _connect()
        try:
            duplicate = await _find_duplicate(conn, source_text, event_ts)
            if duplicate is not None:
                return None

            cursor = await conn.execute(
                """
                INSERT INTO alerts (
                    timestamp, title, type, country, region, lat, lng,
                    severity, confidence, source_channel, original_text, score
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_ts.isoformat(),
                    str(alert.get("title") or "")[:220] or "Alerte terrain",
                    str(alert.get("type") or "geopolitique"),
                    str(alert.get("country") or "Inconnu"),
                    str(alert.get("region") or "Global"),
                    float(alert.get("lat") or 0.0),
                    float(alert.get("lng") or 0.0),
                    str(alert.get("severity") or "moyen"),
                    int(alert.get("confidence") or 0),
                    str(alert.get("source_channel") or "unknown"),
                    source_text[:8000],
                    int(alert.get("score") or 0),
                ),
            )
            alert_id = cursor.lastrowid
            await cursor.close()
            await _prune_alerts(conn)
            await conn.commit()

            fetch = await conn.execute(
                "SELECT * FROM alerts WHERE id = ? LIMIT 1",
                (alert_id,),
            )
            row = await fetch.fetchone()
            await fetch.close()
            return _row_to_dict(row)
        finally:
            await conn.close()


async def get_alerts(
    limit: int = 100,
    severity: Optional[str] = None,
    country: Optional[str] = None,
) -> List[Dict[str, Any]]:
    safe_limit = max(1, min(limit, 500))
    sql = "SELECT * FROM alerts WHERE 1=1"
    params: List[Any] = []

    if severity:
        sql += " AND lower(severity) = lower(?)"
        params.append(severity.strip())

    if country:
        sql += " AND lower(country) = lower(?)"
        params.append(country.strip())

    sql += " ORDER BY timestamp DESC, id DESC LIMIT ?"
    params.append(safe_limit)

    conn = await _connect()
    try:
        cursor = await conn.execute(sql, tuple(params))
        rows = await cursor.fetchall()
        await cursor.close()
        return [dict(row) for row in rows]
    finally:
        await conn.close()


async def get_alerts_since(hours: int = 2) -> List[Dict[str, Any]]:
    window_hours = max(1, min(hours, 72))
    since = (datetime.now(timezone.utc) - timedelta(hours=window_hours)).isoformat()

    conn = await _connect()
    try:
        cursor = await conn.execute(
            """
            SELECT *
            FROM alerts
            WHERE timestamp >= ?
            ORDER BY timestamp DESC, id DESC
            """,
            (since,),
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return [dict(row) for row in rows]
    finally:
        await conn.close()
