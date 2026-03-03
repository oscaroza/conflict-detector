import asyncio
import hashlib
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Awaitable, Callable, Dict, List, Optional

try:
    import feedparser
except Exception:  # pragma: no cover - fallback when dependency not installed yet
    feedparser = None  # type: ignore

logger = logging.getLogger("rss_scraper")

DEFAULT_RSS_FEEDS: List[Dict[str, str]] = [
    {"name": "BBC World", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
    {"name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
    {
        "name": "Google News Conflict",
        "url": "https://news.google.com/rss/search?q=missile+OR+airstrike+OR+drone+OR+war+OR+conflict&hl=en-US&gl=US&ceid=US:en",
    },
    {
        "name": "Google News Geopolitics",
        "url": "https://news.google.com/rss/search?q=iran+OR+israel+OR+ukraine+OR+russia+OR+gaza+war&hl=en-US&gl=US&ceid=US:en",
    },
]


def _safe_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def _normalize_text(value: str) -> str:
    return " ".join(str(value or "").split())


def _strip_html(value: str) -> str:
    text = re.sub(r"<[^>]*>", " ", str(value or ""))
    return _normalize_text(text)


def _parse_datetime_candidate(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        raw = str(value or "").strip()
        if not raw:
            return None
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            try:
                dt = parsedate_to_datetime(raw)
            except Exception:
                return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _entry_timestamp(entry: Dict[str, Any]) -> datetime:
    for key in (
        "published",
        "updated",
        "created",
        "pubDate",
    ):
        parsed = _parse_datetime_candidate(entry.get(key))
        if parsed:
            return parsed

    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        candidate = entry.get(key)
        if candidate:
            try:
                parsed = datetime(*candidate[:6], tzinfo=timezone.utc)
                return parsed.astimezone(timezone.utc)
            except Exception:
                continue
    return datetime.now(timezone.utc)


def _build_source_ref(entry_id: str, link: str, title: str) -> str:
    base = entry_id or link or title
    digest = hashlib.sha1(base.encode("utf-8", errors="ignore")).hexdigest()
    return f"rss:{digest}"


def resolve_rss_feeds() -> List[Dict[str, str]]:
    configured = str(os.getenv("RSS_FEED_URLS", "")).strip()
    if not configured:
        return list(DEFAULT_RSS_FEEDS)

    feeds: List[Dict[str, str]] = []
    for token in re.split(r"[\n,;]+", configured):
        url = str(token or "").strip()
        if not url:
            continue
        name = url
        if "|" in url:
            left, right = url.split("|", 1)
            name = left.strip() or right.strip()
            url = right.strip()
        feeds.append({"name": name[:120], "url": url})

    return feeds if feeds else list(DEFAULT_RSS_FEEDS)


class RSSScraper:
    def __init__(self, on_item: Callable[[Dict[str, Any]], Awaitable[None]]) -> None:
        self.on_item = on_item
        self.feeds = resolve_rss_feeds()
        self.enabled = str(os.getenv("RSS_ENABLE", "1")).strip().lower() not in {
            "0",
            "false",
            "no",
            "off",
        }
        if feedparser is None:
            self.enabled = False
        self.poll_seconds = _safe_int_env("RSS_POLL_SECONDS", default=120, minimum=30, maximum=3600)
        self.items_per_feed = _safe_int_env("RSS_ITEMS_PER_FEED", default=20, minimum=5, maximum=80)
        self.max_age_hours = _safe_int_env("RSS_MAX_AGE_HOURS", default=48, minimum=1, maximum=168)
        self._stop = asyncio.Event()

    async def _fetch_feed(self, feed: Dict[str, str]) -> List[Dict[str, Any]]:
        if feedparser is None:
            return []
        url = str(feed.get("url") or "").strip()
        if not url:
            return []

        parsed = await asyncio.to_thread(feedparser.parse, url)
        entries = list(parsed.entries or [])[: self.items_per_feed]
        source_name = str(feed.get("name") or parsed.feed.get("title") or url).strip()[:180]
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self.max_age_hours)
        normalized: List[Dict[str, Any]] = []

        for entry in entries:
            title = _strip_html(entry.get("title") or "")
            description = _strip_html(entry.get("summary") or entry.get("description") or "")
            link = str(entry.get("link") or "").strip()[:1200]
            entry_id = str(entry.get("id") or "").strip()
            if not title:
                continue

            timestamp = _entry_timestamp(entry)
            if timestamp < cutoff:
                continue

            source_ref = _build_source_ref(entry_id, link, title)
            normalized.append(
                {
                    "id": entry_id or source_ref,
                    "timestamp": timestamp.isoformat(),
                    "source_name": source_name,
                    "source_url": link,
                    "title": title[:220],
                    "description": description[:5000],
                    "source_ref": source_ref,
                }
            )
        return normalized

    async def run_once(self) -> int:
        accepted = 0
        for feed in self.feeds:
            try:
                items = await self._fetch_feed(feed)
                for item in items:
                    await self.on_item(item)
                    accepted += 1
            except Exception as exc:
                logger.warning("rss_feed_failed name=%s error=%s", feed.get("name"), exc)
        return accepted

    async def run_forever(self) -> None:
        if not self.enabled:
            return
        logger.info(
            "rss_listener_started feeds=%s poll_seconds=%s items_per_feed=%s max_age_hours=%s",
            len(self.feeds),
            self.poll_seconds,
            self.items_per_feed,
            self.max_age_hours,
        )
        while not self._stop.is_set():
            try:
                await self.run_once()
            except Exception:
                logger.exception("rss_cycle_failed")
            await asyncio.sleep(self.poll_seconds)

    async def stop(self) -> None:
        self._stop.set()
