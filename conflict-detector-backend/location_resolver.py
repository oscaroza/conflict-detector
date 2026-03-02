import re
from typing import Any, Dict, List, Tuple

LOCATIONS: Dict[str, Dict[str, Any]] = {
    "ukraine": {"lat": 48.3794, "lng": 31.1656, "country": "Ukraine", "region": "Europe", "kind": "country"},
    "kyiv": {"lat": 50.4501, "lng": 30.5234, "country": "Ukraine", "region": "Europe", "kind": "city"},
    "kiev": {"lat": 50.4501, "lng": 30.5234, "country": "Ukraine", "region": "Europe", "kind": "city"},
    "kharkiv": {"lat": 49.9935, "lng": 36.2304, "country": "Ukraine", "region": "Europe", "kind": "city"},
    "odesa": {"lat": 46.4825, "lng": 30.7233, "country": "Ukraine", "region": "Europe", "kind": "city"},
    "lviv": {"lat": 49.8397, "lng": 24.0297, "country": "Ukraine", "region": "Europe", "kind": "city"},
    "donetsk": {"lat": 48.0159, "lng": 37.8028, "country": "Ukraine", "region": "Europe", "kind": "city"},
    "russia": {"lat": 61.5240, "lng": 105.3188, "country": "Russie", "region": "Europe", "kind": "country"},
    "moscow": {"lat": 55.7558, "lng": 37.6173, "country": "Russie", "region": "Europe", "kind": "city"},
    "st petersburg": {"lat": 59.9311, "lng": 30.3609, "country": "Russie", "region": "Europe", "kind": "city"},
    "rostov": {"lat": 47.2357, "lng": 39.7015, "country": "Russie", "region": "Europe", "kind": "city"},
    "belarus": {"lat": 53.7098, "lng": 27.9534, "country": "Biélorussie", "region": "Europe", "kind": "country"},
    "poland": {"lat": 51.9194, "lng": 19.1451, "country": "Pologne", "region": "Europe", "kind": "country"},
    "romania": {"lat": 45.9432, "lng": 24.9668, "country": "Roumanie", "region": "Europe", "kind": "country"},
    "moldova": {"lat": 47.4116, "lng": 28.3699, "country": "Moldavie", "region": "Europe", "kind": "country"},
    "gaza": {"lat": 31.3547, "lng": 34.3088, "country": "Palestine", "region": "Moyen-Orient", "kind": "country"},
    "gaza strip": {
        "lat": 31.3547,
        "lng": 34.3088,
        "country": "Palestine",
        "region": "Moyen-Orient",
        "kind": "country",
    },
    "gaza city": {"lat": 31.5017, "lng": 34.4668, "country": "Palestine", "region": "Moyen-Orient", "kind": "city"},
    "rafah": {"lat": 31.2969, "lng": 34.2436, "country": "Palestine", "region": "Moyen-Orient", "kind": "city"},
    "israel": {"lat": 31.0461, "lng": 34.8516, "country": "Israël", "region": "Moyen-Orient", "kind": "country"},
    "tel aviv": {"lat": 32.0853, "lng": 34.7818, "country": "Israël", "region": "Moyen-Orient", "kind": "city"},
    "jerusalem": {"lat": 31.7683, "lng": 35.2137, "country": "Israël", "region": "Moyen-Orient", "kind": "city"},
    "haifa": {"lat": 32.7940, "lng": 34.9896, "country": "Israël", "region": "Moyen-Orient", "kind": "city"},
    "iran": {"lat": 32.4279, "lng": 53.6880, "country": "Iran", "region": "Moyen-Orient", "kind": "country"},
    "tehran": {"lat": 35.6892, "lng": 51.3890, "country": "Iran", "region": "Moyen-Orient", "kind": "city"},
    "isfahan": {"lat": 32.6546, "lng": 51.6680, "country": "Iran", "region": "Moyen-Orient", "kind": "city"},
    "tabriz": {"lat": 38.0962, "lng": 46.2738, "country": "Iran", "region": "Moyen-Orient", "kind": "city"},
    "iraq": {"lat": 33.2232, "lng": 43.6793, "country": "Iraq", "region": "Moyen-Orient", "kind": "country"},
    "baghdad": {"lat": 33.3152, "lng": 44.3661, "country": "Iraq", "region": "Moyen-Orient", "kind": "city"},
    "basra": {"lat": 30.5085, "lng": 47.7804, "country": "Iraq", "region": "Moyen-Orient", "kind": "city"},
    "syria": {"lat": 34.8021, "lng": 38.9968, "country": "Syrie", "region": "Moyen-Orient", "kind": "country"},
    "damascus": {"lat": 33.5138, "lng": 36.2765, "country": "Syrie", "region": "Moyen-Orient", "kind": "city"},
    "aleppo": {"lat": 36.2021, "lng": 37.1343, "country": "Syrie", "region": "Moyen-Orient", "kind": "city"},
    "idlib": {"lat": 35.9306, "lng": 36.6339, "country": "Syrie", "region": "Moyen-Orient", "kind": "city"},
    "lebanon": {"lat": 33.8547, "lng": 35.8623, "country": "Liban", "region": "Moyen-Orient", "kind": "country"},
    "beirut": {"lat": 33.8938, "lng": 35.5018, "country": "Liban", "region": "Moyen-Orient", "kind": "city"},
    "yemen": {"lat": 15.5527, "lng": 48.5164, "country": "Yémen", "region": "Moyen-Orient", "kind": "country"},
    "sanaa": {"lat": 15.3694, "lng": 44.1910, "country": "Yémen", "region": "Moyen-Orient", "kind": "city"},
    "aden": {"lat": 12.7855, "lng": 45.0187, "country": "Yémen", "region": "Moyen-Orient", "kind": "city"},
    "saudi arabia": {
        "lat": 23.8859,
        "lng": 45.0792,
        "country": "Arabie saoudite",
        "region": "Moyen-Orient",
        "kind": "country",
    },
    "saudi": {"lat": 23.8859, "lng": 45.0792, "country": "Arabie saoudite", "region": "Moyen-Orient", "kind": "country"},
    "riyadh": {"lat": 24.7136, "lng": 46.6753, "country": "Arabie saoudite", "region": "Moyen-Orient", "kind": "city"},
    "jeddah": {"lat": 21.5433, "lng": 39.1728, "country": "Arabie saoudite", "region": "Moyen-Orient", "kind": "city"},
    "ras tanura": {"lat": 26.6434, "lng": 50.1591, "country": "Arabie saoudite", "region": "Moyen-Orient", "kind": "city"},
    "kuwait": {"lat": 29.3117, "lng": 47.4818, "country": "Koweït", "region": "Moyen-Orient", "kind": "country"},
    "kuwait city": {"lat": 29.3759, "lng": 47.9774, "country": "Koweït", "region": "Moyen-Orient", "kind": "city"},
    "qatar": {"lat": 25.3548, "lng": 51.1839, "country": "Qatar", "region": "Moyen-Orient", "kind": "country"},
    "doha": {"lat": 25.2854, "lng": 51.5310, "country": "Qatar", "region": "Moyen-Orient", "kind": "city"},
    "doha west": {"lat": 29.3690, "lng": 47.8920, "country": "Koweït", "region": "Moyen-Orient", "kind": "city"},
    "bahrain": {"lat": 26.0667, "lng": 50.5577, "country": "Bahreïn", "region": "Moyen-Orient", "kind": "country"},
    "manama": {"lat": 26.2285, "lng": 50.5860, "country": "Bahreïn", "region": "Moyen-Orient", "kind": "city"},
    "cyprus": {"lat": 35.1264, "lng": 33.4299, "country": "Chypre", "region": "Moyen-Orient", "kind": "country"},
    "nicosia": {"lat": 35.1856, "lng": 33.3823, "country": "Chypre", "region": "Moyen-Orient", "kind": "city"},
    "akrotiri": {"lat": 34.5902, "lng": 32.9877, "country": "Chypre", "region": "Moyen-Orient", "kind": "city"},
    "raf akrotiri": {"lat": 34.5902, "lng": 32.9877, "country": "Chypre", "region": "Moyen-Orient", "kind": "city"},
    "uae": {"lat": 23.4241, "lng": 53.8478, "country": "Emirats arabes unis", "region": "Moyen-Orient", "kind": "country"},
    "united arab emirates": {
        "lat": 23.4241,
        "lng": 53.8478,
        "country": "Emirats arabes unis",
        "region": "Moyen-Orient",
        "kind": "country",
    },
    "dubai": {"lat": 25.2048, "lng": 55.2708, "country": "Emirats arabes unis", "region": "Moyen-Orient", "kind": "city"},
    "abu dhabi": {
        "lat": 24.4539,
        "lng": 54.3773,
        "country": "Emirats arabes unis",
        "region": "Moyen-Orient",
        "kind": "city",
    },
    "ahvaz": {"lat": 31.3183, "lng": 48.6706, "country": "Iran", "region": "Moyen-Orient", "kind": "city"},
    "ahwaz": {"lat": 31.3183, "lng": 48.6706, "country": "Iran", "region": "Moyen-Orient", "kind": "city"},
    "strait of hormuz": {"lat": 26.5667, "lng": 56.2500, "country": "Iran", "region": "Moyen-Orient", "kind": "city"},
    "hormuz": {"lat": 26.5667, "lng": 56.2500, "country": "Iran", "region": "Moyen-Orient", "kind": "city"},
    "jordan": {"lat": 30.5852, "lng": 36.2384, "country": "Jordanie", "region": "Moyen-Orient", "kind": "country"},
    "turkey": {"lat": 38.9637, "lng": 35.2433, "country": "Turquie", "region": "Moyen-Orient", "kind": "country"},
    "ankara": {"lat": 39.9334, "lng": 32.8597, "country": "Turquie", "region": "Moyen-Orient", "kind": "city"},
    "istanbul": {"lat": 41.0082, "lng": 28.9784, "country": "Turquie", "region": "Moyen-Orient", "kind": "city"},
    "armenia": {"lat": 40.0691, "lng": 45.0382, "country": "Arménie", "region": "Caucase", "kind": "country"},
    "azerbaijan": {"lat": 40.1431, "lng": 47.5769, "country": "Azerbaïdjan", "region": "Caucase", "kind": "country"},
    "georgia": {"lat": 42.3154, "lng": 43.3569, "country": "Géorgie", "region": "Caucase", "kind": "country"},
    "sudan": {"lat": 12.8628, "lng": 30.2176, "country": "Soudan", "region": "Afrique", "kind": "country"},
    "khartoum": {"lat": 15.5007, "lng": 32.5599, "country": "Soudan", "region": "Afrique", "kind": "city"},
    "port sudan": {"lat": 19.6158, "lng": 37.2164, "country": "Soudan", "region": "Afrique", "kind": "city"},
    "south sudan": {
        "lat": 6.8770,
        "lng": 31.3070,
        "country": "Soudan du Sud",
        "region": "Afrique",
        "kind": "country",
    },
    "ethiopia": {"lat": 9.1450, "lng": 40.4897, "country": "Éthiopie", "region": "Afrique", "kind": "country"},
    "somalia": {"lat": 5.1521, "lng": 46.1996, "country": "Somalie", "region": "Afrique", "kind": "country"},
    "libya": {"lat": 26.3351, "lng": 17.2283, "country": "Libye", "region": "Afrique", "kind": "country"},
    "tripoli": {"lat": 32.8872, "lng": 13.1913, "country": "Libye", "region": "Afrique", "kind": "city"},
    "egypt": {"lat": 26.8206, "lng": 30.8025, "country": "Égypte", "region": "Afrique", "kind": "country"},
    "sinai": {"lat": 29.5000, "lng": 33.8000, "country": "Égypte", "region": "Afrique", "kind": "city"},
    "taiwan": {"lat": 23.6978, "lng": 120.9605, "country": "Taïwan", "region": "Asie", "kind": "country"},
    "taipei": {"lat": 25.0330, "lng": 121.5654, "country": "Taïwan", "region": "Asie", "kind": "city"},
    "china": {"lat": 35.8617, "lng": 104.1954, "country": "Chine", "region": "Asie", "kind": "country"},
    "beijing": {"lat": 39.9042, "lng": 116.4074, "country": "Chine", "region": "Asie", "kind": "city"},
    "shanghai": {"lat": 31.2304, "lng": 121.4737, "country": "Chine", "region": "Asie", "kind": "city"},
    "pakistan": {"lat": 30.3753, "lng": 69.3451, "country": "Pakistan", "region": "Asie", "kind": "country"},
    "islamabad": {"lat": 33.6844, "lng": 73.0479, "country": "Pakistan", "region": "Asie", "kind": "city"},
    "karachi": {"lat": 24.8607, "lng": 67.0011, "country": "Pakistan", "region": "Asie", "kind": "city"},
    "lahore": {"lat": 31.5497, "lng": 74.3436, "country": "Pakistan", "region": "Asie", "kind": "city"},
    "india": {"lat": 20.5937, "lng": 78.9629, "country": "Inde", "region": "Asie", "kind": "country"},
    "myanmar": {"lat": 21.9162, "lng": 95.9560, "country": "Myanmar", "region": "Asie", "kind": "country"},
    "afghanistan": {"lat": 33.9391, "lng": 67.7100, "country": "Afghanistan", "region": "Asie", "kind": "country"},
    "north korea": {
        "lat": 40.3399,
        "lng": 127.5101,
        "country": "Corée du Nord",
        "region": "Asie",
        "kind": "country",
    },
    "pyongyang": {"lat": 39.0392, "lng": 125.7625, "country": "Corée du Nord", "region": "Asie", "kind": "city"},
    "south korea": {
        "lat": 35.9078,
        "lng": 127.7669,
        "country": "Corée du Sud",
        "region": "Asie",
        "kind": "country",
    },
    "seoul": {"lat": 37.5665, "lng": 126.9780, "country": "Corée du Sud", "region": "Asie", "kind": "city"},
    "japan": {"lat": 36.2048, "lng": 138.2529, "country": "Japon", "region": "Asie", "kind": "country"},
    "tokyo": {"lat": 35.6762, "lng": 139.6503, "country": "Japon", "region": "Asie", "kind": "city"},
    "philippines": {"lat": 12.8797, "lng": 121.7740, "country": "Philippines", "region": "Asie", "kind": "country"},
    "manila": {"lat": 14.5995, "lng": 120.9842, "country": "Philippines", "region": "Asie", "kind": "city"},
    "venezuela": {"lat": 6.4238, "lng": -66.5897, "country": "Venezuela", "region": "Amérique", "kind": "country"},
    "colombia": {"lat": 4.5709, "lng": -74.2973, "country": "Colombie", "region": "Amérique", "kind": "country"},
    "united states": {
        "lat": 39.8283,
        "lng": -98.5795,
        "country": "United States of America",
        "region": "Amerique du Nord",
        "kind": "country",
    },
    "united states of america": {
        "lat": 39.8283,
        "lng": -98.5795,
        "country": "United States of America",
        "region": "Amerique du Nord",
        "kind": "country",
    },
    "usa": {"lat": 39.8283, "lng": -98.5795, "country": "United States of America", "region": "Amerique du Nord", "kind": "country"},
    "washington": {
        "lat": 38.9072,
        "lng": -77.0369,
        "country": "United States of America",
        "region": "Amerique du Nord",
        "kind": "city",
    },
    "mali": {"lat": 17.5707, "lng": -3.9962, "country": "Mali", "region": "Afrique", "kind": "country"},
    "niger": {"lat": 17.6078, "lng": 8.0817, "country": "Niger", "region": "Afrique", "kind": "country"},
    "burkina faso": {
        "lat": 12.2383,
        "lng": -1.5616,
        "country": "Burkina Faso",
        "region": "Afrique",
        "kind": "country",
    },
    "nigeria": {"lat": 9.0820, "lng": 8.6753, "country": "Nigeria", "region": "Afrique", "kind": "country"},
}

DEFAULT_LOCATION = {
    "country": "Inconnu",
    "region": "Global",
    "lat": 20.0,
    "lng": 0.0,
    "kind": "unknown",
    "matched_term": "",
}


def _contains_term(text: str, term: str) -> bool:
    pattern = r"\b" + re.escape(term.lower()) + r"\b"
    return re.search(pattern, text) is not None


def resolve_location(text: str) -> Dict[str, Any]:
    normalized = " ".join(str(text or "").lower().split())
    if not normalized:
        return dict(DEFAULT_LOCATION)

    candidates: List[Tuple[int, int, str, Dict[str, Any]]] = []
    for term, payload in LOCATIONS.items():
        if _contains_term(normalized, term):
            specificity = 2 if payload.get("kind") == "city" else 1
            candidates.append((specificity, len(term), term, payload))

    if not candidates:
        return dict(DEFAULT_LOCATION)

    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    _, _, matched_term, best = candidates[0]
    return {
        "country": best["country"],
        "region": best["region"],
        "lat": best["lat"],
        "lng": best["lng"],
        "kind": best["kind"],
        "matched_term": matched_term,
    }
