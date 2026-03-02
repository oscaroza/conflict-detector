import asyncio
import logging
import os
from pathlib import Path
from datetime import timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from telethon import TelegramClient, events
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession

logger = logging.getLogger("telegram_scraper")

CHANNELS: List[str] = [
    "@intelslava",
    "@OSINTdefender",
    "@MiddleEastSpectator",
    "@GazaWarNews",
    "@TpyxiAlert",
    "@BNONews",
    "@sentdefender",
    "@WarMonitor3",
    "@IntelCrab",
]


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
        except Exception:
            logger.warning("telegram_event_processing_skipped")

    async def _run_once(self) -> None:
        self.client = self._build_client()

        @self.client.on(events.NewMessage(chats=CHANNELS))
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

        logger.info("telegram_listener_started channels=%s", ",".join(CHANNELS))
        await self.client.run_until_disconnected()

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
