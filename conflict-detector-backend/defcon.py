from __future__ import annotations

from typing import Any

NATO_COUNTRIES = {
    "albania",
    "belgium",
    "bulgaria",
    "canada",
    "croatia",
    "czech republic",
    "denmark",
    "estonia",
    "finland",
    "france",
    "germany",
    "greece",
    "hungary",
    "iceland",
    "italy",
    "latvia",
    "lithuania",
    "luxembourg",
    "montenegro",
    "netherlands",
    "north macedonia",
    "norway",
    "poland",
    "portugal",
    "romania",
    "slovakia",
    "slovenia",
    "spain",
    "sweden",
    "turkey",
    "united kingdom",
    "united states",
    "usa",
    "uk",
}


def _collect_nato_mentions(alerts: list[dict[str, Any]]) -> set[str]:
    mentioned: set[str] = set()

    for alert in alerts:
        country = str(alert.get("country", "")).strip().lower()
        if country in NATO_COUNTRIES:
            mentioned.add(country)

        text = str(alert.get("original_text", "")).lower()
        for nato_country in NATO_COUNTRIES:
            if nato_country in text:
                mentioned.add(nato_country)

    return mentioned


def calculate_defcon(alerts_last_2h: list[dict[str, Any]]) -> dict[str, Any]:
    critical_count = sum(1 for alert in alerts_last_2h if alert.get("severity") == "critique")
    high_count = sum(1 for alert in alerts_last_2h if alert.get("severity") == "haute")

    lower_texts = [str(alert.get("original_text", "")).lower() for alert in alerts_last_2h]
    nuclear_detected = any("nuclear" in text or "nuke" in text for text in lower_texts)
    nuclear_launch_detected = any("nuclear launch" in text for text in lower_texts)

    nato_mentions = _collect_nato_mentions(alerts_last_2h)
    nato_mentioned = bool(nato_mentions) or any("nato" in text for text in lower_texts)

    if nuclear_launch_detected and len(nato_mentions) >= 2:
        level = 1
        reason = "nuclear_launch_and_multiple_nato_countries"
    elif critical_count >= 10 or nuclear_detected:
        level = 2
        reason = "critical_spike_or_nuclear_detected"
    elif 5 <= critical_count <= 9 or nato_mentioned:
        level = 3
        reason = "elevated_critical_or_nato_mention"
    elif 2 <= critical_count <= 4 or high_count >= 5:
        level = 4
        reason = "moderate_escalation"
    else:
        level = 5
        reason = "low_activity"

    return {
        "level": level,
        "label": f"DEFCON {level}",
        "reason": reason,
        "critical_last_2h": critical_count,
        "high_last_2h": high_count,
        "nuclear_detected": nuclear_detected,
        "nato_countries_mentioned": sorted(nato_mentions),
    }
