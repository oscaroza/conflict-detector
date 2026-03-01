from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
import logging
import os
from typing import Any

from telethon import TelegramClient, events
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession

logger = logging.getLogger(__name__)

DEFAULT_CHANNELS = [
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
        *,
        api_id: int,
        api_hash: str,
        on_message: Callable[[dict[str, Any]], Awaitable[None]],
        channels: list[str] | None = None,
        session_name: str = "conflict_detector",
    ) -> None:
        self.api_id = api_id
        self.api_hash = api_hash
        self.channels = channels or DEFAULT_CHANNELS
        self.on_message = on_message
        self.session_name = session_name
        self._client: TelegramClient | None = None
        self._stop_event = asyncio.Event()

    def _build_client(self) -> TelegramClient:
        session_string = os.getenv("TELEGRAM_SESSION", "").strip()
        if session_string:
            session = StringSession(session_string)
        else:
            session = self.session_name

        return TelegramClient(
            session=session,
            api_id=self.api_id,
            api_hash=self.api_hash,
            auto_reconnect=True,
            connection_retries=None,
            retry_delay=5,
            request_retries=5,
        )

    def _register_handler(self, client: TelegramClient) -> None:
        @client.on(events.NewMessage(chats=self.channels))
        async def _handle_new_message(event: events.NewMessage.Event) -> None:
            message = event.message
            raw_text = (message.message or "").strip()
            if not raw_text:
                return

            try:
                chat = await event.get_chat()
                username = getattr(chat, "username", None)
                source_channel = f"@{username}" if username else getattr(chat, "title", "unknown")

                timestamp = message.date or datetime.now(timezone.utc)
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
                else:
                    timestamp = timestamp.astimezone(timezone.utc)

                payload: dict[str, Any] = {
                    "channel": source_channel,
                    "text": raw_text,
                    "timestamp": timestamp,
                    "message_id": message.id,
                }

                if username:
                    payload["message_url"] = f"https://t.me/{username}/{message.id}"

                await self.on_message(payload)
            except Exception:
                logger.exception("event_handler_failed")

    async def run_forever(self) -> None:
        retry_delay = 5

        while not self._stop_event.is_set():
            self._client = self._build_client()
            self._register_handler(self._client)

            try:
                await self._client.connect()

                if not await self._client.is_user_authorized():
                    logger.error(
                        "telegram_not_authorized session_missing=true hint=authenticate_locally_once"
                    )
                    await asyncio.sleep(60)
                    continue

                logger.info(
                    "telegram_connected channels=%s",
                    ",".join(self.channels),
                )
                retry_delay = 5

                await self._client.run_until_disconnected()
                if not self._stop_event.is_set():
                    logger.warning("telegram_disconnected reconnecting=true")

            except FloodWaitError as flood_wait:
                wait_seconds = max(5, flood_wait.seconds)
                logger.warning(
                    "telegram_flood_wait wait_seconds=%s", wait_seconds
                )
                await asyncio.sleep(wait_seconds)

            except Exception:
                logger.exception(
                    "telegram_listener_error retry_in_seconds=%s", retry_delay
                )
                await asyncio.sleep(retry_delay)
                retry_delay = min(120, retry_delay * 2)

            finally:
                if self._client and self._client.is_connected():
                    await self._client.disconnect()

        logger.info("telegram_listener_stopped")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._client and self._client.is_connected():
            await self._client.disconnect()
