import asyncio
import os
from typing import Dict, List

from telethon import TelegramClient
from telethon.sessions import StringSession


def _read_env_file_if_present(path: str = ".env") -> None:
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _is_channel_like(entity: object) -> bool:
    return bool(getattr(entity, "broadcast", False) or getattr(entity, "megagroup", False))


async def main() -> None:
    _read_env_file_if_present(".env")

    api_id = int(str(os.getenv("TELEGRAM_API_ID", "0")).strip() or "0")
    api_hash = str(os.getenv("TELEGRAM_API_HASH", "")).strip()
    session_string = str(os.getenv("TELEGRAM_SESSION_STRING", "")).strip()
    session_name = str(os.getenv("TELETHON_SESSION_NAME", "conflict_detector")).strip() or "conflict_detector"

    if api_id <= 0 or not api_hash:
        raise RuntimeError("TELEGRAM_API_ID / TELEGRAM_API_HASH manquants dans conflict-detector-backend/.env")

    session = StringSession(session_string) if session_string else session_name
    client = TelegramClient(session, api_id, api_hash)
    await client.connect()

    try:
        if not await client.is_user_authorized():
            raise RuntimeError("Session Telegram non autorisée. Regénère TELEGRAM_SESSION_STRING puis réessaie.")

        rows: List[Dict[str, str]] = []
        async for dialog in client.iter_dialogs():
            entity = getattr(dialog, "entity", None)
            if entity is None or not _is_channel_like(entity):
                continue

            title = str(getattr(entity, "title", "") or getattr(dialog, "name", "") or "").strip()
            username = str(getattr(entity, "username", "") or "").strip()
            at_handle = f"@{username}" if username else ""
            rows.append(
                {
                    "title": title,
                    "handle": at_handle,
                    "id": str(getattr(entity, "id", "")),
                }
            )

        rows.sort(key=lambda row: row["title"].lower())

        print("\n=== Canaux détectés sur TON compte Telegram ===\n")
        for row in rows:
            handle = row["handle"] if row["handle"] else "(pas de @ - canal privé ou sans username)"
            print(f"- {row['title']} | {handle} | id={row['id']}")

        handles = [row["handle"] for row in rows if row["handle"]]
        print("\n=== TELEGRAM_CHANNELS (copie/colle) ===\n")
        print(",".join(handles))
        print("")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
