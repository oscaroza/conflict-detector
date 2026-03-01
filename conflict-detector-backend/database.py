from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any

import aiosqlite

MAX_ALERTS = 500
DEDUP_WINDOW_SECONDS = 60
DEDUP_SIMILARITY_THRESHOLD = 0.80


class AlertDatabase:
    def __init__(self, db_path: str = "alerts.db") -> None:
        self.db_path = db_path
        self._connection: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()

    async def connect(self) -> None:
        self._connection = await aiosqlite.connect(self.db_path)
        self._connection.row_factory = aiosqlite.Row

        await self._connection.execute("PRAGMA journal_mode=WAL;")
        await self._connection.execute("PRAGMA synchronous=NORMAL;")
        await self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                title TEXT NOT NULL,
                type TEXT NOT NULL,
                country TEXT NOT NULL,
                region TEXT NOT NULL,
                lat REAL,
                lng REAL,
                severity TEXT NOT NULL,
                confidence INTEGER NOT NULL,
                source_channel TEXT NOT NULL,
                original_text TEXT NOT NULL,
                score INTEGER NOT NULL
            );
            """
        )
        await self._connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);"
        )
        await self._connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);"
        )
        await self._connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_country ON alerts(country);"
        )
        await self._connection.commit()

    async def close(self) -> None:
        if self._connection is not None:
            await self._connection.close()
            self._connection = None

    @staticmethod
    def _normalize_text(text: str) -> str:
        return " ".join(text.lower().split())

    @staticmethod
    def _to_iso_utc(timestamp: datetime | str | None = None) -> tuple[datetime, str]:
        if timestamp is None:
            dt = datetime.now(timezone.utc)
        elif isinstance(timestamp, str):
            cleaned = timestamp.replace("Z", "+00:00")
            dt = datetime.fromisoformat(cleaned)
        else:
            dt = timestamp

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)

        dt = dt.replace(microsecond=0)
        return dt, dt.isoformat().replace("+00:00", "Z")

    async def _is_duplicate(self, original_text: str, timestamp_dt: datetime) -> bool:
        if self._connection is None:
            raise RuntimeError("Database not connected")

        threshold = (timestamp_dt - timedelta(seconds=DEDUP_WINDOW_SECONDS)).isoformat().replace(
            "+00:00", "Z"
        )
        query = (
            "SELECT original_text FROM alerts "
            "WHERE timestamp >= ? ORDER BY id DESC LIMIT 200"
        )

        async with self._connection.execute(query, (threshold,)) as cursor:
            recent_rows = await cursor.fetchall()

        normalized_new = self._normalize_text(original_text)
        for row in recent_rows:
            normalized_existing = self._normalize_text(row["original_text"])
            ratio = SequenceMatcher(None, normalized_new, normalized_existing).ratio()
            if ratio >= DEDUP_SIMILARITY_THRESHOLD:
                return True

        return False

    async def insert_alert(self, alert: dict[str, Any]) -> bool:
        if self._connection is None:
            raise RuntimeError("Database not connected")

        timestamp_dt, timestamp_iso = self._to_iso_utc(alert.get("timestamp"))

        async with self._write_lock:
            if await self._is_duplicate(alert["original_text"], timestamp_dt):
                return False

            await self._connection.execute(
                """
                INSERT INTO alerts (
                    timestamp, title, type, country, region, lat, lng,
                    severity, confidence, source_channel, original_text, score
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    timestamp_iso,
                    alert["title"],
                    alert["type"],
                    alert["country"],
                    alert["region"],
                    alert.get("lat"),
                    alert.get("lng"),
                    alert["severity"],
                    int(alert["confidence"]),
                    alert["source_channel"],
                    alert["original_text"],
                    int(alert["score"]),
                ),
            )
            await self._connection.execute(
                """
                DELETE FROM alerts
                WHERE id NOT IN (
                    SELECT id FROM alerts
                    ORDER BY timestamp DESC, id DESC
                    LIMIT ?
                )
                """,
                (MAX_ALERTS,),
            )
            await self._connection.commit()

        return True

    async def get_alerts(
        self,
        *,
        severity: str | None = None,
        country: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        if self._connection is None:
            raise RuntimeError("Database not connected")

        query = "SELECT * FROM alerts WHERE 1=1"
        params: list[Any] = []

        if severity:
            query += " AND LOWER(severity) = LOWER(?)"
            params.append(severity)

        if country:
            query += " AND LOWER(country) = LOWER(?)"
            params.append(country)

        query += " ORDER BY timestamp DESC, id DESC LIMIT ?"
        params.append(limit)

        async with self._connection.execute(query, tuple(params)) as cursor:
            rows = await cursor.fetchall()

        return [dict(row) for row in rows]

    async def get_recent_alerts(self, hours: int = 2) -> list[dict[str, Any]]:
        if self._connection is None:
            raise RuntimeError("Database not connected")

        threshold = (
            datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=hours)
        ).isoformat().replace("+00:00", "Z")

        query = "SELECT * FROM alerts WHERE timestamp >= ? ORDER BY timestamp DESC, id DESC"
        async with self._connection.execute(query, (threshold,)) as cursor:
            rows = await cursor.fetchall()

        return [dict(row) for row in rows]

    async def get_severity_counts(self, hours: int = 24) -> dict[str, int]:
        if self._connection is None:
            raise RuntimeError("Database not connected")

        threshold = (
            datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=hours)
        ).isoformat().replace("+00:00", "Z")

        query = (
            "SELECT severity, COUNT(*) AS total FROM alerts "
            "WHERE timestamp >= ? GROUP BY severity"
        )
        async with self._connection.execute(query, (threshold,)) as cursor:
            rows = await cursor.fetchall()

        counts = {"critique": 0, "haute": 0, "moyen": 0, "faible": 0}
        for row in rows:
            counts[row["severity"]] = row["total"]

        return counts

    async def get_top_countries(self, hours: int = 24, limit: int = 5) -> list[dict[str, Any]]:
        if self._connection is None:
            raise RuntimeError("Database not connected")

        threshold = (
            datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=hours)
        ).isoformat().replace("+00:00", "Z")

        query = (
            "SELECT country, COUNT(*) AS total FROM alerts "
            "WHERE timestamp >= ? AND country != 'Unknown' "
            "GROUP BY country ORDER BY total DESC LIMIT ?"
        )

        async with self._connection.execute(query, (threshold, limit)) as cursor:
            rows = await cursor.fetchall()

        return [dict(row) for row in rows]

    async def count_alerts(self) -> int:
        if self._connection is None:
            raise RuntimeError("Database not connected")

        async with self._connection.execute("SELECT COUNT(*) AS total FROM alerts") as cursor:
            row = await cursor.fetchone()

        return int(row["total"] if row else 0)
