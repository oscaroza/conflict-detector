from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

KEYWORDS = {
    "frappe": {
        "mots": [
            "strike",
            "airstrike",
            "bombed",
            "bombing",
            "frappe",
            "explosion",
            "blast",
            "hit",
            "attacked",
            "shelling",
            "shelled",
            "artillery",
            "missile",
            "rocket",
            "launched",
            "intercepted",
            "drone",
            "uav",
            "destroyed",
            "killed",
            "dead",
            "casualties",
            "troops",
            "forces",
            "military",
            "army",
            "navy",
            "warplane",
            "fighter jet",
            "tank",
            "invasion",
            "offensive",
            "advance",
            "retreat",
            "captured",
            "fallen",
        ],
        "poids": 10,
    },
    "terrain_confirme": {
        "mots": [
            "confirmed",
            "breaking",
            "urgent",
            "just in",
            "report",
            "multiple",
            "sources confirm",
            "footage",
            "video",
            "images show",
        ],
        "poids": 5,
    },
    "exclusion": {
        "mots": [
            "analysis",
            "opinion",
            "why did",
            "historical",
            "explained",
            "what does",
            "how will",
            "should",
            "policy",
            "interview",
            "weekly",
            "monthly",
            "review",
            "podcast",
            "thread",
        ],
        "poids": -20,
    },
}

SEVERITY_KEYWORDS = {
    "critique": [
        "nuclear",
        "nuke",
        "chemical weapon",
        "biological",
        "nato",
        "world war",
        "ww3",
        "ballistic missile",
        "icbm",
        "mass casualty",
        "hundreds killed",
        "capital city hit",
    ],
    "haute": [
        "airstrike",
        "missile strike",
        "multiple explosions",
        "city center",
        "dozens killed",
        "hospital",
        "civilian",
        "refugee",
    ],
    "moyen": [
        "shelling",
        "artillery",
        "drone attack",
        "border clash",
        "soldiers killed",
        "military base",
    ],
    "faible": [
        "shots fired",
        "patrol",
        "minor incident",
        "report of",
    ],
}

RELIABLE_CHANNELS = {
    "@bnonews",
    "@osintdefender",
}

LESS_VERIFIED_CHANNELS = {
    "@middleeastspectator",
    "@intelcrab",
    "@warmonitor3",
    "@gazawarnews",
    "@tpyxialert",
}

GPS_PATTERN = re.compile(
    r"\b-?(?:[1-8]?\d(?:\.\d+)?|90(?:\.0+)?)\s*,\s*-?(?:\d{1,2}(?:\.\d+)?|1[0-7]\d(?:\.\d+)?|180(?:\.0+)?)\b"
)
URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)


@dataclass(slots=True)
class FilterResult:
    accepted: bool
    score: int
    severity: str
    confidence: int
    event_type: str
    keyword_hits: dict[str, list[str]]


def _normalize_text(text: str) -> str:
    return " ".join(text.lower().strip().split())


def _find_hits(normalized_text: str, candidates: list[str]) -> list[str]:
    return [keyword for keyword in candidates if keyword in normalized_text]


def score_message(text: str) -> tuple[int, dict[str, list[str]]]:
    normalized_text = _normalize_text(text)
    total_score = 0
    hits: dict[str, list[str]] = {}

    for category, config in KEYWORDS.items():
        category_hits = _find_hits(normalized_text, config["mots"])
        if not category_hits:
            continue
        total_score += len(category_hits) * int(config["poids"])
        hits[category] = category_hits

    return total_score, hits


def determine_severity(text: str) -> str:
    normalized_text = _normalize_text(text)
    for severity in ("critique", "haute", "moyen", "faible"):
        for keyword in SEVERITY_KEYWORDS[severity]:
            if keyword in normalized_text:
                return severity
    return "faible"


def calculate_confidence(text: str, source_channel: str) -> int:
    normalized_text = _normalize_text(text)
    channel = source_channel.lower().strip()
    score = 0

    if channel in RELIABLE_CHANNELS:
        score += 30

    if "confirmed" in normalized_text or "breaking" in normalized_text:
        score += 20

    if GPS_PATTERN.search(text):
        score += 20

    if len(text) > 100:
        score += 15

    if URL_PATTERN.search(text):
        score += 15

    if channel in LESS_VERIFIED_CHANNELS:
        score -= 20

    return max(0, min(score, 100))


def determine_event_type(keyword_hits: dict[str, list[str]]) -> str:
    if keyword_hits.get("frappe"):
        return "frappe"
    if keyword_hits.get("terrain_confirme"):
        return "terrain_confirme"
    return "incident"


def evaluate_message(text: str, source_channel: str) -> FilterResult:
    score, hits = score_message(text)
    severity = determine_severity(text)
    confidence = calculate_confidence(text, source_channel)
    accepted = score >= 10

    return FilterResult(
        accepted=accepted,
        score=score,
        severity=severity,
        confidence=confidence,
        event_type=determine_event_type(hits),
        keyword_hits=hits,
    )


def result_to_dict(result: FilterResult) -> dict[str, Any]:
    return {
        "accepted": result.accepted,
        "score": result.score,
        "severity": result.severity,
        "confidence": result.confidence,
        "event_type": result.event_type,
        "keyword_hits": result.keyword_hits,
    }
