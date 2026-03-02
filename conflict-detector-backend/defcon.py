import re
from collections import Counter
from typing import Any, Dict, Iterable, List, Set

NATO_COUNTRIES: Set[str] = {
    "albania",
    "allemagne",
    "belgium",
    "belgique",
    "bulgaria",
    "bulgarie",
    "canada",
    "croatia",
    "croatie",
    "czech republic",
    "republique tcheque",
    "czechia",
    "denmark",
    "danemark",
    "estonia",
    "estonie",
    "finland",
    "finlande",
    "france",
    "germany",
    "greece",
    "grece",
    "hungary",
    "hongrie",
    "iceland",
    "islande",
    "italy",
    "italie",
    "latvia",
    "lettonie",
    "lithuania",
    "lituanie",
    "luxembourg",
    "montenegro",
    "netherlands",
    "pays-bas",
    "north macedonia",
    "macedoine du nord",
    "norway",
    "norvege",
    "poland",
    "pologne",
    "portugal",
    "romania",
    "roumanie",
    "slovakia",
    "slovaquie",
    "slovenia",
    "slovenie",
    "spain",
    "espagne",
    "sweden",
    "suede",
    "turkey",
    "turquie",
    "united kingdom",
    "royaume-uni",
    "uk",
    "united states",
    "etats-unis",
    "usa",
}

NUCLEAR_TERMS = {
    "nuclear",
    "nuke",
    "atomic",
    "icbm",
    "ballistic missile",
    "radiation",
}
NUCLEAR_LAUNCH_TERMS = {
    "nuclear launch",
    "icbm launch",
    "strategic launch",
    "atomic launch",
}


def _norm(value: str) -> str:
    return " ".join(str(value or "").lower().split())


def _severity_norm(value: str) -> str:
    raw = _norm(value)
    mapping = {
        "critical": "critique",
        "high": "haute",
        "medium": "moyen",
        "low": "faible",
    }
    return mapping.get(raw, raw)


def _is_critical(value: str) -> bool:
    return _severity_norm(value) == "critique"


def _is_high(value: str) -> bool:
    return _severity_norm(value) == "haute"


def _extract_nato_mentions(alerts: Iterable[Dict[str, Any]]) -> Set[str]:
    mentions: Set[str] = set()
    for alert in alerts:
        country = _norm(alert.get("country", ""))
        if country in NATO_COUNTRIES:
            mentions.add(country)

        text = _norm(f"{alert.get('title', '')} {alert.get('original_text', '')}")
        for candidate in NATO_COUNTRIES:
            pattern = r"\b" + re.escape(candidate) + r"\b"
            if re.search(pattern, text):
                mentions.add(candidate)
    return mentions


def calculate_defcon(alerts_last_2h: List[Dict[str, Any]]) -> Dict[str, Any]:
    critical_count = 0
    high_count = 0
    nuclear_detected = False
    nuclear_launch_detected = False

    for alert in alerts_last_2h:
        severity = _severity_norm(alert.get("severity", ""))
        if severity == "critique":
            critical_count += 1
        elif severity == "haute":
            high_count += 1

        text = _norm(f"{alert.get('title', '')} {alert.get('original_text', '')}")
        if any(token in text for token in NUCLEAR_TERMS):
            nuclear_detected = True
        if any(token in text for token in NUCLEAR_LAUNCH_TERMS):
            nuclear_launch_detected = True

    nato_mentions = _extract_nato_mentions(alerts_last_2h)

    if nuclear_launch_detected and len(nato_mentions) >= 2:
        level = 1
        reason = "nuclear_launch_and_multiple_nato"
    elif critical_count >= 10 or nuclear_detected:
        level = 2
        reason = "critical_spike_or_nuclear_signal"
    elif (5 <= critical_count <= 9) or len(nato_mentions) >= 1:
        level = 3
        reason = "sustained_critical_or_nato_mention"
    elif (2 <= critical_count <= 4) or high_count >= 5:
        level = 4
        reason = "moderate_critical_or_many_high"
    else:
        level = 5
        reason = "low_critical_activity"

    return {
        "level": level,
        "reason": reason,
        "critical_count": critical_count,
        "high_count": high_count,
        "nuclear_detected": nuclear_detected,
        "nuclear_launch_detected": nuclear_launch_detected,
        "nato_mentions": sorted(nato_mentions),
    }


def build_activity_snapshot(alerts_last_2h: List[Dict[str, Any]]) -> Dict[str, Any]:
    severity_counter: Counter[str] = Counter()
    country_counter: Counter[str] = Counter()

    for alert in alerts_last_2h:
        severity_counter[_severity_norm(alert.get("severity", "moyen"))] += 1
        country = str(alert.get("country") or "Inconnu")
        if country != "Inconnu":
            country_counter[country] += 1

    top_countries = [
        {"country": country, "count": count}
        for country, count in country_counter.most_common(8)
    ]

    return {
        "total_alerts_2h": len(alerts_last_2h),
        "by_severity": dict(severity_counter),
        "top_countries": top_countries,
    }
