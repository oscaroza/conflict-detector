import asyncio
import logging
import os
import re
from difflib import get_close_matches
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
    "@geopolitics_prime",
    "@verkhovnaraofukraine",
    "@frontier_conflict1",
    "War Monitor",
    "Ukraine War - Intel News",
    "War Noir",
    "Lord Of War",
    "Mannie's War Room",
    "Israel War Live",
]


def _normalize_channel(value: str) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None

    if "t.me/" in raw:
        raw = raw.split("t.me/", 1)[1]

    raw = raw.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0].strip()
    if not raw:
        return None

    # Keep channel titles as-is (they may contain spaces).
    if any(ch.isspace() for ch in raw):
        return raw

    # Normalize username-like tokens to @handle.
    handle = raw.lstrip("@").strip()
    if not handle:
        return None
    return f"@{handle}"


def _normalize_dialog_title(value: str) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""

    raw = raw.replace("’", "'").replace("`", "'")
    raw = re.sub(r"[\u2013\u2014]+", "-", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw


def _compact_dialog_title_key(value: str) -> str:
    normalized = _normalize_dialog_title(value)
    if not normalized:
        return ""
    return re.sub(r"[^a-z0-9]+", "", normalized)


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
        self._watched_channels: List[Dict[str, Any]] = []
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

    def _channel_cache_key(self, value: str) -> str:
        normalized = _normalize_channel(value)
        if not normalized:
            return str(value or "").strip().lower()
        if normalized.startswith("@"):
            return normalized.lower()
        return normalized.lower()

    async def _build_dialog_indexes(self) -> Dict[str, Any]:
        if self.client is None:
            return {
                "username_index": {},
                "title_index": {},
            }

        username_index: Dict[str, Dict[str, Any]] = {}
        title_index: Dict[str, List[Dict[str, Any]]] = {}

        async for dialog in self.client.iter_dialogs():
            entity = getattr(dialog, "entity", None)
            if entity is None:
                continue

            username = str(getattr(entity, "username", "") or "").strip()
            title = str(getattr(entity, "title", "") or getattr(dialog, "name", "") or "").strip()
            source_channel = f"@{username}" if username else f"@{title}" if title else "unknown_channel"

            entry = {
                "entity": entity,
                "source_channel": source_channel,
                "title": title,
                "username": f"@{username}" if username else "",
            }

            if username:
                username_index[f"@{username.lower()}"] = entry

            for key in (_normalize_dialog_title(title), _compact_dialog_title_key(title)):
                if not key:
                    continue
                title_index.setdefault(key, []).append(entry)

        return {
            "username_index": username_index,
            "title_index": title_index,
        }

    async def _resolve_watched_channels(self) -> List[Dict[str, Any]]:
        if self.client is None:
            return []

        resolved: List[Dict[str, Any]] = []
        seen_keys = set()
        indexes = await self._build_dialog_indexes()
        username_index: Dict[str, Dict[str, Any]] = indexes["username_index"]
        title_index: Dict[str, List[Dict[str, Any]]] = indexes["title_index"]

        for requested in self.channels:
            resolved_entry: Optional[Dict[str, Any]] = None
            try:
                entity = await self.client.get_entity(requested)
                username = getattr(entity, "username", None)
                source_channel = f"@{username}" if username else str(requested)
                resolved_entry = {
                    "requested": requested,
                    "entity": entity,
                    "source_channel": source_channel,
                }
            except Exception:
                # Fallback 1: username lookup from dialogs already available in account.
                requested_username_key = str(requested or "").strip().lower()
                username_match = username_index.get(requested_username_key)

                if username_match is not None:
                    resolved_entry = {
                        "requested": requested,
                        "entity": username_match["entity"],
                        "source_channel": username_match["source_channel"],
                    }
                    logger.info(
                        "telegram_channel_resolved_by_dialog_username requested=%s resolved=%s",
                        requested,
                        username_match["source_channel"],
                    )
                else:
                    # Fallback 2: dialog title lookup (exact normalized or compact key).
                    requested_title_seed = str(requested or "").strip().lstrip("@")
                    title_candidates: List[Dict[str, Any]] = []
                    for key in (
                        _normalize_dialog_title(requested_title_seed),
                        _compact_dialog_title_key(requested_title_seed),
                    ):
                        if key and key in title_index:
                            title_candidates.extend(title_index[key])
                    if title_candidates:
                        picked = title_candidates[0]
                        resolved_entry = {
                            "requested": requested,
                            "entity": picked["entity"],
                            "source_channel": picked["source_channel"],
                        }
                        logger.info(
                            "telegram_channel_resolved_by_dialog_title requested=%s resolved=%s",
                            requested,
                            picked["source_channel"],
                        )
                    else:
                        # Best-effort suggestion for logs.
                        suggestion = None
                        suggestion_seed = _normalize_dialog_title(requested_title_seed) or requested_title_seed.lower()
                        if suggestion_seed:
                            possible = list(title_index.keys()) + list(username_index.keys())
                            matches = get_close_matches(suggestion_seed, possible, n=1, cutoff=0.86)
                            if matches:
                                suggestion_key = matches[0]
                                if suggestion_key in username_index:
                                    suggestion = username_index[suggestion_key]["source_channel"]
                                else:
                                    suggestion_entries = title_index.get(suggestion_key, [])
                                    if suggestion_entries:
                                        suggestion = suggestion_entries[0]["source_channel"]

                        if suggestion:
                            logger.warning(
                                "telegram_channel_unresolved channel=%s suggestion=%s",
                                requested,
                                suggestion,
                            )
                        else:
                            logger.warning("telegram_channel_unresolved channel=%s", requested)

            if resolved_entry is None:
                continue

            key = self._channel_cache_key(resolved_entry["source_channel"])
            if key in seen_keys:
                continue
            seen_keys.add(key)
            resolved.append(resolved_entry)

        return resolved

    async def _run_once(self) -> None:
        self.client = self._build_client()

        await self.client.connect()

        if not await self.client.is_user_authorized():
            logger.error(
                "telegram_not_authorized: configure TELEGRAM_SESSION_STRING (Render) ou cree une session locale"
            )
            await self.client.disconnect()
            await asyncio.sleep(max(30, self._unauthorized_sleep))
            return

        self._watched_channels = await self._resolve_watched_channels()
        if not self._watched_channels:
            logger.error("telegram_no_channels_resolved")
            await self.client.disconnect()
            await asyncio.sleep(max(30, self._unauthorized_sleep))
            return

        async def _on_new_message(event: events.NewMessage.Event) -> None:
            await self._handle_event(event)

        self.client.add_event_handler(
            _on_new_message,
            events.NewMessage(chats=[entry["entity"] for entry in self._watched_channels]),
        )

        if not self._backfill_done and self._backfill_limit > 0:
            try:
                await self._run_backfill(self._watched_channels)
            finally:
                # Avoid rerunning full bootstrap history on each reconnect loop.
                self._backfill_done = True

        poll_task: Optional[asyncio.Task] = None
        if self._enable_polling and self._poll_seconds > 0:
            poll_task = asyncio.create_task(self._run_poll_loop())

        logger.info(
            "telegram_listener_started channels=%s polling=%s poll_seconds=%s poll_limit=%s",
            ",".join(entry["source_channel"] for entry in self._watched_channels),
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

    async def _run_backfill(self, channels: Optional[List[Dict[str, Any]]] = None) -> None:
        if self.client is None or self._backfill_limit <= 0:
            return
        if channels is None:
            channels = self._watched_channels

        logger.info("telegram_backfill_started per_channel_limit=%s", self._backfill_limit)
        total_messages = 0

        for channel_info in channels:
            accepted = 0
            skipped_empty = 0

            try:
                entity = channel_info["entity"]
                source_channel = channel_info["source_channel"]
                requested = channel_info["requested"]
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
                    normalized_channel = _normalize_channel(requested)
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
                logger.warning(
                    "telegram_backfill_flood_wait channel=%s wait_seconds=%s",
                    channel_info.get("source_channel") or channel_info.get("requested"),
                    wait_seconds,
                )
                await asyncio.sleep(wait_seconds)
            except Exception as exc:
                logger.warning(
                    "telegram_backfill_channel_failed channel=%s error=%s",
                    channel_info.get("source_channel") or channel_info.get("requested"),
                    exc,
                )

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
            for channel_info in self._watched_channels:
                if self._stop.is_set() or self.client is None or not self.client.is_connected():
                    break

                requested = channel_info["requested"]
                source_channel = channel_info["source_channel"]
                normalized_channel = _normalize_channel(requested) or requested
                try:
                    entity = channel_info["entity"]
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
                    logger.warning("telegram_poll_flood_wait channel=%s wait_seconds=%s", source_channel, wait_seconds)
                    await asyncio.sleep(wait_seconds)
                except Exception as exc:
                    logger.warning("telegram_poll_channel_failed channel=%s error=%s", source_channel, exc)

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
