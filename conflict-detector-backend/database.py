import asyncio
import json
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
_JSON_LIST_COLUMNS = {"ai_subcategories", "ai_countries", "ai_actors"}
_BOOL_COLUMNS = {"ai_analyzed", "ai_is_conflict_related"}


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed == parsed else default


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _json_list_dump(value: Any) -> str:
    if isinstance(value, list):
        data = [str(item).strip() for item in value if str(item).strip()]
    elif value is None:
        data = []
    else:
        raw = str(value).strip()
        data = [raw] if raw else []
    return json.dumps(data, ensure_ascii=False)


def _json_list_load(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]

    raw = str(value or "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = [raw]
    if not isinstance(parsed, list):
        parsed = [parsed]
    return [str(item).strip() for item in parsed if str(item).strip()]


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
    data = dict(row)
    for column in _JSON_LIST_COLUMNS:
        if column in data:
            data[column] = _json_list_load(data.get(column))
    for column in _BOOL_COLUMNS:
        if column in data:
            data[column] = bool(int(data.get(column) or 0))

    if "ai_severity_score" in data:
        data["ai_severity_score"] = max(0.0, min(1.0, _safe_float(data.get("ai_severity_score"), 0.0)))
    if "ai_reliability_score" in data:
        data["ai_reliability_score"] = max(0.0, min(1.0, _safe_float(data.get("ai_reliability_score"), 0.0)))
    return data


async def _ensure_column(
    conn: aiosqlite.Connection, existing_columns: set, name: str, definition: str
) -> None:
    if name in existing_columns:
        return
    await conn.execute(f"ALTER TABLE alerts ADD COLUMN {name} {definition}")
    existing_columns.add(name)


async def _migrate_alerts_schema(conn: aiosqlite.Connection) -> None:
    cursor = await conn.execute("PRAGMA table_info(alerts)")
    rows = await cursor.fetchall()
    await cursor.close()
    existing_columns = {str(row["name"]) for row in rows}

    await _ensure_column(conn, existing_columns, "source_type", "TEXT NOT NULL DEFAULT 'telegram'")
    await _ensure_column(conn, existing_columns, "source_ref", "TEXT NOT NULL DEFAULT ''")
    await _ensure_column(conn, existing_columns, "source_url", "TEXT NOT NULL DEFAULT ''")
    await _ensure_column(conn, existing_columns, "ai_analyzed", "INTEGER NOT NULL DEFAULT 0")
    await _ensure_column(conn, existing_columns, "ai_category", "TEXT NOT NULL DEFAULT 'autre'")
    await _ensure_column(conn, existing_columns, "ai_event_type", "TEXT NOT NULL DEFAULT 'press_return'")
    await _ensure_column(conn, existing_columns, "ai_subcategories", "TEXT NOT NULL DEFAULT '[]'")
    await _ensure_column(conn, existing_columns, "ai_severity", "TEXT NOT NULL DEFAULT 'moyenne'")
    await _ensure_column(conn, existing_columns, "ai_severity_score", "REAL NOT NULL DEFAULT 0.0")
    await _ensure_column(conn, existing_columns, "ai_countries", "TEXT NOT NULL DEFAULT '[]'")
    await _ensure_column(conn, existing_columns, "ai_actors", "TEXT NOT NULL DEFAULT '[]'")
    await _ensure_column(conn, existing_columns, "ai_summary", "TEXT NOT NULL DEFAULT ''")
    await _ensure_column(conn, existing_columns, "ai_reliability_score", "REAL NOT NULL DEFAULT 0.0")
    await _ensure_column(conn, existing_columns, "ai_is_conflict_related", "INTEGER NOT NULL DEFAULT 0")
    await _ensure_column(conn, existing_columns, "event_actor", "TEXT NOT NULL DEFAULT ''")
    await _ensure_column(conn, existing_columns, "event_actor_action", "TEXT NOT NULL DEFAULT ''")
    await _ensure_column(conn, existing_columns, "event_target", "TEXT NOT NULL DEFAULT ''")
    await _ensure_column(conn, existing_columns, "event_location", "TEXT NOT NULL DEFAULT ''")
    await _ensure_column(conn, existing_columns, "event_context", "TEXT NOT NULL DEFAULT ''")


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
        await _migrate_alerts_schema(conn)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_country ON alerts(country)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_source_ref ON alerts(source_ref)"
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
    source_ref = str(alert.get("source_ref") or "").strip()

    async with _write_lock:
        conn = await _connect()
        try:
            if source_ref:
                source_cursor = await conn.execute(
                    "SELECT id FROM alerts WHERE source_ref = ? LIMIT 1",
                    (source_ref,),
                )
                source_row = await source_cursor.fetchone()
                await source_cursor.close()
                if source_row is not None:
                    return None

            duplicate = await _find_duplicate(conn, source_text, event_ts)
            if duplicate is not None:
                return None

            cursor = await conn.execute(
                """
                INSERT INTO alerts (
                    timestamp, title, type, country, region, lat, lng,
                    severity, confidence, source_channel, original_text, score,
                    source_type, source_ref, source_url,
                    ai_analyzed, ai_category, ai_event_type, ai_subcategories, ai_severity, ai_severity_score,
                    ai_countries, ai_actors, ai_summary, ai_reliability_score, ai_is_conflict_related,
                    event_actor, event_actor_action, event_target, event_location, event_context
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    str(alert.get("source_type") or "telegram"),
                    source_ref[:500],
                    str(alert.get("source_url") or "")[:1200],
                    1 if bool(alert.get("ai_analyzed")) else 0,
                    str(alert.get("ai_category") or "autre")[:80],
                    str(alert.get("ai_event_type") or "press_return")[:40],
                    _json_list_dump(alert.get("ai_subcategories")),
                    str(alert.get("ai_severity") or "moyenne")[:32],
                    max(0.0, min(1.0, _safe_float(alert.get("ai_severity_score"), 0.0))),
                    _json_list_dump(alert.get("ai_countries")),
                    _json_list_dump(alert.get("ai_actors")),
                    str(alert.get("ai_summary") or "")[:1200],
                    max(0.0, min(1.0, _safe_float(alert.get("ai_reliability_score"), 0.0))),
                    1 if bool(alert.get("ai_is_conflict_related")) else 0,
                    str(alert.get("event_actor") or "")[:120],
                    str(alert.get("event_actor_action") or "")[:120],
                    str(alert.get("event_target") or "")[:160],
                    str(alert.get("event_location") or "")[:220],
                    str(alert.get("event_context") or "")[:300],
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


async def update_alert_ai_fields(alert_id: int, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    safe_id = _safe_int(alert_id, 0)
    if safe_id <= 0:
        return None

    async with _write_lock:
        conn = await _connect()
        try:
            cursor = await conn.execute(
                """
                UPDATE alerts
                SET
                    severity = ?,
                    confidence = ?,
                    ai_analyzed = ?,
                    ai_category = ?,
                    ai_event_type = ?,
                    ai_subcategories = ?,
                    ai_severity = ?,
                    ai_severity_score = ?,
                    ai_countries = ?,
                    ai_actors = ?,
                    ai_summary = ?,
                    ai_reliability_score = ?,
                    ai_is_conflict_related = ?,
                    event_actor = ?,
                    event_actor_action = ?,
                    event_target = ?,
                    event_location = ?,
                    event_context = ?
                WHERE id = ?
                """,
                (
                    str(payload.get("severity") or "moyen")[:32],
                    max(0, min(100, _safe_int(payload.get("confidence"), 0))),
                    1 if bool(payload.get("ai_analyzed")) else 0,
                    str(payload.get("ai_category") or "autre")[:80],
                    str(payload.get("ai_event_type") or "press_return")[:40],
                    _json_list_dump(payload.get("ai_subcategories")),
                    str(payload.get("ai_severity") or "moyenne")[:32],
                    max(0.0, min(1.0, _safe_float(payload.get("ai_severity_score"), 0.0))),
                    _json_list_dump(payload.get("ai_countries")),
                    _json_list_dump(payload.get("ai_actors")),
                    str(payload.get("ai_summary") or "")[:1200],
                    max(0.0, min(1.0, _safe_float(payload.get("ai_reliability_score"), 0.0))),
                    1 if bool(payload.get("ai_is_conflict_related")) else 0,
                    str(payload.get("event_actor") or "")[:120],
                    str(payload.get("event_actor_action") or "")[:120],
                    str(payload.get("event_target") or "")[:160],
                    str(payload.get("event_location") or "")[:220],
                    str(payload.get("event_context") or "")[:300],
                    safe_id,
                ),
            )
            await cursor.close()

            await conn.commit()
            fetch = await conn.execute("SELECT * FROM alerts WHERE id = ? LIMIT 1", (safe_id,))
            row = await fetch.fetchone()
            await fetch.close()
            return _row_to_dict(row)
        finally:
            await conn.close()


async def get_alert_by_source_ref(source_ref: str) -> Optional[Dict[str, Any]]:
    normalized = str(source_ref or "").strip()
    if not normalized:
        return None

    conn = await _connect()
    try:
        cursor = await conn.execute(
            "SELECT * FROM alerts WHERE source_ref = ? ORDER BY id DESC LIMIT 1",
            (normalized,),
        )
        row = await cursor.fetchone()
        await cursor.close()
        return _row_to_dict(row)
    finally:
        await conn.close()


async def get_alerts(
    limit: int = 100,
    severity: Optional[str] = None,
    country: Optional[str] = None,
    source_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    safe_limit = max(1, min(limit, 500))
    sql = "SELECT * FROM alerts WHERE 1=1"
    params: List[Any] = []

    if severity:
        normalized_severity = str(severity).strip().lower()
        normalized_severity = {
            "moyenne": "moyen",
            "medium": "moyen",
            "high": "haute",
            "critical": "critique",
            "low": "faible",
        }.get(normalized_severity, normalized_severity)
        sql += " AND lower(severity) = lower(?)"
        params.append(normalized_severity)

    if country:
        sql += " AND lower(country) = lower(?)"
        params.append(country.strip())

    if source_type:
        sql += " AND lower(source_type) = lower(?)"
        params.append(str(source_type).strip())

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
