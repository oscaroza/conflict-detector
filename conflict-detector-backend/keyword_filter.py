import os
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List

KEYWORDS: Dict[str, Dict[str, Any]] = {
    "frappe": {
        "mots": [
            "strike",
            "airstrike",
            "airstrikes",
            "bombed",
            "bombing",
            "frappe",
            "explosion",
            "explosions",
            "blast",
            "hit",
            "attacked",
            "attack",
            "attacks",
            "shelling",
            "shelled",
            "artillery",
            "missile",
            "missiles",
            "rocket",
            "rockets",
            "launched",
            "intercepted",
            "intercept",
            "drone",
            "drones",
            "drone strike",
            "drone strikes",
            "uav",
            "destroyed",
            "destroy",
            "killed",
            "dead",
            "casualties",
            "troops",
            "troop",
            "forces",
            "military",
            "army",
            "navy",
            "carrier ship",
            "aircraft carrier",
            "warplane",
            "warplanes",
            "fighter jet",
            "fighter jets",
            "tank",
            "tanks",
            "invasion",
            "offensive",
            "advance",
            "retreat",
            "captured",
            "fallen",
            "shot down",
            "downed",
            "raid",
            "raids",
            "base hit",
            "air base",
            "airbase",
            "burning",
            "war",
            "conflict",
        ],
        "poids": 10,
    },
    "escalade_geopolitique": {
        "mots": [
            "military buildup",
            "troop buildup",
            "mobilization",
            "war footing",
            "retaliate",
            "retaliation",
            "vow to strike",
            "ready to defend",
            "preparing to strike",
            "warning to",
            "pay a price",
            "state of emergency",
            "air defense activated",
            "closed airspace",
            "internet blackout",
            "internet access cut off",
            "power station",
            "oil refinery",
            "ballistic",
            "american",
            "america",
            "iran",
            "israel",
            "france",
            "uk",
            "united kingdom",
            "tehran",
            "teheran",
            "palestine",
            "destroy",
            "destroyed",
            "strike",
            "missile",
        ],
        "poids": 8,
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
        "poids": -12,
    },
}

SEVERITY_KEYWORDS: Dict[str, List[str]] = {
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

def _safe_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


ALERT_SCORE_THRESHOLD = _safe_int_env("ALERT_SCORE_THRESHOLD", default=8, minimum=1, maximum=30)

TRUSTED_CHANNELS = {
    "bnonews",
    "osintdefender",
    "sentdefender",
    "faytuks",
    "clashreport",
    "noelreports",
}
LESS_VERIFIED_CHANNELS = {
    "middleeastspectator",
    "gazawarnews",
    "warmonitor3",
    "intelcrab",
    "tpyxialert",
}

GPS_PATTERN = re.compile(
    r"\b-?(?:90(?:\.0+)?|[1-8]?\d(?:\.\d+)?)\s*,\s*-?(?:180(?:\.0+)?|1[0-7]\d(?:\.\d+)?|[1-9]?\d(?:\.\d+)?)\b"
)
LINK_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)


@dataclass
class FilterResult:
    accepted: bool
    score: int
    severity: str
    confidence: int
    matched: Dict[str, Any]
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _normalize_text(text: str) -> str:
    return " ".join(str(text or "").lower().split())


def _normalize_channel(channel: str) -> str:
    return str(channel or "").strip().lower().lstrip("@")


def _contains_term(text: str, term: str) -> bool:
    term = term.strip().lower()
    if not term:
        return False

    words = [token for token in term.split() if token]
    if not words:
        return False

    escaped_words = [re.escape(token) for token in words]
    last = escaped_words[-1]
    if re.fullmatch(r"[a-z0-9]+", words[-1]):
        escaped_words[-1] = f"{last}(?:s|es)?"

    pattern = r"\b" + r"\s+".join(escaped_words) + r"\b"
    return re.search(pattern, text) is not None


def _find_matches(text: str, words: List[str]) -> List[str]:
    matches: List[str] = []
    seen = set()
    for word in words:
        normalized = word.strip().lower()
        if not normalized or normalized in seen:
            continue
        if _contains_term(text, normalized):
            matches.append(normalized)
            seen.add(normalized)
    return matches


def _compute_score(text: str) -> Dict[str, Any]:
    details: Dict[str, Any] = {}
    total_score = 0
    for category, payload in KEYWORDS.items():
        words = payload["mots"]
        weight = int(payload["poids"])
        matches = _find_matches(text, words)
        if not matches:
            continue

        delta = len(matches) * weight
        total_score += delta
        details[category] = {
            "matches": matches,
            "count": len(matches),
            "weight": weight,
            "delta": delta,
        }
    return {"score": total_score, "details": details}


def _compute_severity(text: str) -> str:
    for severity in ("critique", "haute", "moyen", "faible"):
        for token in SEVERITY_KEYWORDS[severity]:
            if _contains_term(text, token):
                return severity
    return "moyen"


def _compute_confidence(text: str, source_channel: str) -> Dict[str, Any]:
    confidence = 0
    factors: List[str] = []
    normalized_channel = _normalize_channel(source_channel)

    if normalized_channel in TRUSTED_CHANNELS:
        confidence += 30
        factors.append("trusted_channel:+30")

    if _contains_term(text, "confirmed") or _contains_term(text, "breaking"):
        confidence += 20
        factors.append("confirmed_or_breaking:+20")

    if GPS_PATTERN.search(text):
        confidence += 20
        factors.append("gps_detected:+20")

    if len(text) > 100:
        confidence += 15
        factors.append("long_message:+15")

    if LINK_PATTERN.search(text):
        confidence += 15
        factors.append("external_link:+15")

    if normalized_channel in LESS_VERIFIED_CHANNELS:
        confidence -= 20
        factors.append("less_verified_channel:-20")

    confidence = max(0, min(100, confidence))
    return {"confidence": confidence, "factors": factors}


def analyze_message(message_text: str, source_channel: str) -> FilterResult:
    text = _normalize_text(message_text)
    if not text:
        return FilterResult(
            accepted=False,
            score=0,
            severity="faible",
            confidence=0,
            matched={},
            reason="empty_message",
        )

    score_data = _compute_score(text)
    severity = _compute_severity(text)
    confidence_data = _compute_confidence(text, source_channel)

    accepted = score_data["score"] >= ALERT_SCORE_THRESHOLD
    reason = "accepted" if accepted else "score_below_threshold"
    if "exclusion" in score_data["details"] and not accepted:
        reason = "excluded_by_keywords"

    return FilterResult(
        accepted=accepted,
        score=int(score_data["score"]),
        severity=severity,
        confidence=int(confidence_data["confidence"]),
        matched={
            "keywords": score_data["details"],
            "confidence_factors": confidence_data["factors"],
        },
        reason=reason,
    )
