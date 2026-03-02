import asyncio
import logging
import os
import re
from pathlib import Path
from datetime import timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from telethon import TelegramClient, events
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession

logger = logging.getLogger("telegram_scraper")

DEFAULT_CHANNELS: List[str] = [
    "@intelslava",
    "@OSINTdefender",
    "@MiddleEastSpectator",
    "@GazaWarNews",
    "@TpyxiAlert",
    "@BNONews",
    "@sentdefender",
    "@WarMonitor3",
    "@IntelCrab",
    "@Faytuks",
    "@IntelTower",
    "@nexta_live",
    "@clashreport",
]


def _normalize_channel(value: str) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None

    if "t.me/" in raw:
        raw = raw.split("t.me/", 1)[1]

    raw = raw.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    raw = raw.strip().lstrip("@")
    if not raw:
        return None

    return f"@{raw}"


def resolve_channels() -> List[str]:
    configured = str(os.getenv("TELEGRAM_CHANNELS", "")).strip()
    parsed: List[str] = []
    if configured:
        for token in re.split(r"[,\n;]+", configured):
            channel = _normalize_channel(token)
            if channel:
                parsed.append(channel)

    # Merge defaults + env channels, preserve order and deduplicate.
    merged = DEFAULT_CHANNELS + parsed
    seen = set()
    channels: List[str] = []
    for channel in merged:
        normalized = _normalize_channel(channel)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        channels.append(normalized)
    return channels


class TelegramScraper:
    def __init__(
        self,
        on_message: Callable[[Dict[str, Any]], Awaitable[None]],
    ) -> None:
        self.on_message = on_message
        self.api_id = int(os.getenv("TELEGRAM_API_ID", "0"))
        self.api_hash = os.getenv("TELEGRAM_API_HASH", "").strip()
        self.session_name = os.getenv("TELETHON_SESSION_NAME", "conflict_detector")
        self.session_string = os.getenv("TELEGRAM_SESSION_STRING", "").strip()
        self._stop = asyncio.Event()
        self.client: Optional[TelegramClient] = None
        self._unauthorized_sleep = int(os.getenv("TELEGRAM_UNAUTHORIZED_RETRY_SECONDS", "300"))
        self._backfill_limit = max(0, int(os.getenv("TELEGRAM_BACKFILL_LIMIT", "180")))
        self._poll_seconds = max(15, int(os.getenv("TELEGRAM_POLL_SECONDS", "30")))
        self._poll_limit = max(1, min(30, int(os.getenv("TELEGRAM_POLL_LIMIT", "6"))))
        self._enable_polling = str(os.getenv("TELEGRAM_ENABLE_POLLING", "1")).strip().lower() not in {
            "0",
            "false",
            "no",
            "off",
        }
        self._last_seen_ids: Dict[str, int] = {}
        self._backfill_done = False
        self.channels = resolve_channels()

    def has_local_session_file(self) -> bool:
        path = Path(f"{self.session_name}.session")
        return path.exists()

    def _build_client(self) -> TelegramClient:
        session = StringSession(self.session_string) if self.session_string else self.session_name
        return TelegramClient(session, self.api_id, self.api_hash)

    async def _extract_channel_name(self, event: events.NewMessage.Event) -> str:
        try:
            chat = await event.get_chat()
        except Exception:
            chat = None

        username = getattr(chat, "username", None)
        if username:
            return f"@{username}"

        title = getattr(chat, "title", None) or "unknown_channel"
        return f"@{title}"

    async def _handle_event(self, event: events.NewMessage.Event) -> None:
        try:
            text = (event.raw_text or "").strip()
            if not text:
                return

            source_channel = await self._extract_channel_name(event)
            event_ts = event.date
            if event_ts.tzinfo is None:
                event_ts = event_ts.replace(tzinfo=timezone.utc)
            event_ts = event_ts.astimezone(timezone.utc)

            payload = {
                "id": event.id,
                "timestamp": event_ts.isoformat(),
                "source_channel": source_channel,
                "text": text,
            }
            await self.on_message(payload)

            source_key = _normalize_channel(source_channel) or source_channel
            previous = int(self._last_seen_ids.get(source_key, 0))
            if int(event.id or 0) > previous:
                self._last_seen_ids[source_key] = int(event.id)
        except Exception:
            logger.warning("telegram_event_processing_skipped")

    async def _run_once(self) -> None:
        self.client = self._build_client()

        @self.client.on(events.NewMessage(chats=self.channels))
        async def _on_new_message(event: events.NewMessage.Event) -> None:
            await self._handle_event(event)

        await self.client.connect()

        if not await self.client.is_user_authorized():
            logger.error(
                "telegram_not_authorized: configure TELEGRAM_SESSION_STRING (Render) ou cree une session locale"
            )
            await self.client.disconnect()
            await asyncio.sleep(max(30, self._unauthorized_sleep))
            return

        if not self._backfill_done and self._backfill_limit > 0:
            try:
                await self._run_backfill()
            finally:
                # Avoid rerunning full bootstrap history on each reconnect loop.
                self._backfill_done = True

        poll_task: Optional[asyncio.Task] = None
        if self._enable_polling and self._poll_seconds > 0:
            poll_task = asyncio.create_task(self._run_poll_loop())

        logger.info(
            "telegram_listener_started channels=%s polling=%s poll_seconds=%s poll_limit=%s",
            ",".join(self.channels),
            "on" if self._enable_polling else "off",
            self._poll_seconds,
            self._poll_limit,
        )
        try:
            await self.client.run_until_disconnected()
        finally:
            if poll_task is not None:
                poll_task.cancel()
                try:
                    await poll_task
                except asyncio.CancelledError:
                    pass

    async def _run_backfill(self) -> None:
        if self.client is None or self._backfill_limit <= 0:
            return

        logger.info("telegram_backfill_started per_channel_limit=%s", self._backfill_limit)
        total_messages = 0

        for channel in self.channels:
            accepted = 0
            skipped_empty = 0

            try:
                entity = await self.client.get_entity(channel)
                channel_name = getattr(entity, "username", None)
                source_channel = f"@{channel_name}" if channel_name else channel
                source_key = _normalize_channel(source_channel) or source_channel
                max_seen = int(self._last_seen_ids.get(source_key, 0))

                async for msg in self.client.iter_messages(entity, limit=self._backfill_limit):
                    text = (msg.raw_text or "").strip()
                    if not text:
                        skipped_empty += 1
                        continue

                    event_ts = msg.date
                    if event_ts.tzinfo is None:
                        event_ts = event_ts.replace(tzinfo=timezone.utc)
                    event_ts = event_ts.astimezone(timezone.utc)

                    payload = {
                        "id": msg.id,
                        "timestamp": event_ts.isoformat(),
                        "source_channel": source_channel,
                        "text": text,
                    }
                    await self.on_message(payload)
                    accepted += 1
                    total_messages += 1
                    max_seen = max(max_seen, int(msg.id or 0))

                if max_seen > 0:
                    self._last_seen_ids[source_key] = max_seen
                    normalized_channel = _normalize_channel(channel)
                    if normalized_channel:
                        self._last_seen_ids[normalized_channel] = max_seen

                logger.info(
                    "telegram_backfill_channel_done channel=%s seen=%s skipped_empty=%s",
                    source_channel,
                    accepted,
                    skipped_empty,
                )
            except FloodWaitError as exc:
                wait_seconds = max(5, int(getattr(exc, "seconds", 5)))
                logger.warning("telegram_backfill_flood_wait channel=%s wait_seconds=%s", channel, wait_seconds)
                await asyncio.sleep(wait_seconds)
            except Exception as exc:
                logger.warning("telegram_backfill_channel_failed channel=%s error=%s", channel, exc)

        logger.info("telegram_backfill_complete processed=%s", total_messages)

    async def _run_poll_loop(self) -> None:
        if self.client is None or not self._enable_polling:
            return

        logger.info(
            "telegram_polling_started per_channel_limit=%s interval_seconds=%s",
            self._poll_limit,
            self._poll_seconds,
        )
        while not self._stop.is_set() and self.client is not None and self.client.is_connected():
            for channel in self.channels:
                if self._stop.is_set() or self.client is None or not self.client.is_connected():
                    break

                normalized_channel = _normalize_channel(channel) or channel
                try:
                    entity = await self.client.get_entity(channel)
                    channel_name = getattr(entity, "username", None)
                    source_channel = f"@{channel_name}" if channel_name else channel
                    source_key = _normalize_channel(source_channel) or source_channel

                    last_seen = int(
                        max(
                            self._last_seen_ids.get(normalized_channel, 0),
                            self._last_seen_ids.get(source_key, 0),
                        )
                    )

                    batch = []
                    async for msg in self.client.iter_messages(entity, limit=self._poll_limit):
                        text = (msg.raw_text or "").strip()
                        if not text:
                            continue
                        msg_id = int(msg.id or 0)
                        if msg_id <= 0 or msg_id <= last_seen:
                            continue
                        batch.append(msg)

                    if not batch:
                        await asyncio.sleep(0.08)
                        continue

                    batch.sort(key=lambda item: int(item.id or 0))
                    for msg in batch:
                        event_ts = msg.date
                        if event_ts.tzinfo is None:
                            event_ts = event_ts.replace(tzinfo=timezone.utc)
                        event_ts = event_ts.astimezone(timezone.utc)

                        payload = {
                            "id": msg.id,
                            "timestamp": event_ts.isoformat(),
                            "source_channel": source_channel,
                            "text": (msg.raw_text or "").strip(),
                        }
                        await self.on_message(payload)
                        last_seen = max(last_seen, int(msg.id or 0))

                    self._last_seen_ids[normalized_channel] = last_seen
                    self._last_seen_ids[source_key] = last_seen
                    await asyncio.sleep(0.08)
                except FloodWaitError as exc:
                    wait_seconds = max(5, int(getattr(exc, "seconds", 5)))
                    logger.warning("telegram_poll_flood_wait channel=%s wait_seconds=%s", channel, wait_seconds)
                    await asyncio.sleep(wait_seconds)
                except Exception as exc:
                    logger.warning("telegram_poll_channel_failed channel=%s error=%s", channel, exc)

            await asyncio.sleep(self._poll_seconds)

    async def run_forever(self) -> None:
        if self.api_id <= 0 or not self.api_hash:
            raise RuntimeError("TELEGRAM_API_ID/TELEGRAM_API_HASH manquants")

        backoff_seconds = 3
        while not self._stop.is_set():
            try:
                await self._run_once()
                backoff_seconds = 3
            except asyncio.CancelledError:
                raise
            except FloodWaitError as exc:
                wait_seconds = max(5, int(getattr(exc, "seconds", 5)))
                logger.warning("telegram_flood_wait wait_seconds=%s", wait_seconds)
                await asyncio.sleep(wait_seconds)
            except Exception:
                logger.exception("telegram_disconnected_retrying_in=%s", backoff_seconds)
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, 90)
            finally:
                if self.client is not None:
                    try:
                        await self.client.disconnect()
                    except Exception:
                        pass
                    self.client = None

    async def stop(self) -> None:
        self._stop.set()
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:
                pass
