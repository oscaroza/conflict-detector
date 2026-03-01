from __future__ import annotations

import re
from typing import Any

LOCATIONS: dict[str, dict[str, Any]] = {
    "ukraine": {"lat": 48.3794, "lng": 31.1656, "country": "Ukraine", "kind": "country"},
    "kyiv": {"lat": 50.4501, "lng": 30.5234, "country": "Ukraine", "kind": "city", "region": "Kyiv"},
    "kharkiv": {"lat": 49.9935, "lng": 36.2304, "country": "Ukraine", "kind": "city", "region": "Kharkiv"},
    "odesa": {"lat": 46.4825, "lng": 30.7233, "country": "Ukraine", "kind": "city", "region": "Odesa"},
    "odessa": {"lat": 46.4825, "lng": 30.7233, "country": "Ukraine", "kind": "city", "region": "Odesa"},
    "dnipro": {"lat": 48.4647, "lng": 35.0462, "country": "Ukraine", "kind": "city", "region": "Dnipro"},
    "donetsk": {"lat": 48.0159, "lng": 37.8029, "country": "Ukraine", "kind": "city", "region": "Donetsk"},
    "luhansk": {"lat": 48.5740, "lng": 39.3078, "country": "Ukraine", "kind": "city", "region": "Luhansk"},
    "gaza": {"lat": 31.3547, "lng": 34.3088, "country": "Palestine", "kind": "region", "region": "Gaza"},
    "gaza strip": {"lat": 31.3547, "lng": 34.3088, "country": "Palestine", "kind": "region", "region": "Gaza"},
    "iran": {"lat": 32.4279, "lng": 53.6880, "country": "Iran", "kind": "country"},
    "tehran": {"lat": 35.6892, "lng": 51.3890, "country": "Iran", "kind": "city", "region": "Tehran"},
    "isfahan": {"lat": 32.6546, "lng": 51.6680, "country": "Iran", "kind": "city", "region": "Isfahan"},
    "israel": {"lat": 31.0461, "lng": 34.8516, "country": "Israel", "kind": "country"},
    "tel aviv": {"lat": 32.0853, "lng": 34.7818, "country": "Israel", "kind": "city", "region": "Tel Aviv"},
    "jerusalem": {"lat": 31.7683, "lng": 35.2137, "country": "Israel", "kind": "city", "region": "Jerusalem"},
    "haifa": {"lat": 32.7940, "lng": 34.9896, "country": "Israel", "kind": "city", "region": "Haifa"},
    "russia": {"lat": 61.5240, "lng": 105.3188, "country": "Russia", "kind": "country"},
    "moscow": {"lat": 55.7558, "lng": 37.6173, "country": "Russia", "kind": "city", "region": "Moscow"},
    "saint petersburg": {"lat": 59.9311, "lng": 30.3609, "country": "Russia", "kind": "city", "region": "Saint Petersburg"},
    "syria": {"lat": 34.8021, "lng": 38.9968, "country": "Syria", "kind": "country"},
    "damascus": {"lat": 33.5138, "lng": 36.2765, "country": "Syria", "kind": "city", "region": "Damascus"},
    "aleppo": {"lat": 36.2021, "lng": 37.1343, "country": "Syria", "kind": "city", "region": "Aleppo"},
    "lebanon": {"lat": 33.8547, "lng": 35.8623, "country": "Lebanon", "kind": "country"},
    "beirut": {"lat": 33.8938, "lng": 35.5018, "country": "Lebanon", "kind": "city", "region": "Beirut"},
    "yemen": {"lat": 15.5527, "lng": 48.5164, "country": "Yemen", "kind": "country"},
    "sanaa": {"lat": 15.3694, "lng": 44.1910, "country": "Yemen", "kind": "city", "region": "Sanaa"},
    "aden": {"lat": 12.7855, "lng": 45.0187, "country": "Yemen", "kind": "city", "region": "Aden"},
    "iraq": {"lat": 33.2232, "lng": 43.6793, "country": "Iraq", "kind": "country"},
    "baghdad": {"lat": 33.3152, "lng": 44.3661, "country": "Iraq", "kind": "city", "region": "Baghdad"},
    "basra": {"lat": 30.5085, "lng": 47.7804, "country": "Iraq", "kind": "city", "region": "Basra"},
    "sudan": {"lat": 12.8628, "lng": 30.2176, "country": "Sudan", "kind": "country"},
    "khartoum": {"lat": 15.5007, "lng": 32.5599, "country": "Sudan", "kind": "city", "region": "Khartoum"},
    "taiwan": {"lat": 23.6978, "lng": 120.9605, "country": "Taiwan", "kind": "country"},
    "taipei": {"lat": 25.0330, "lng": 121.5654, "country": "Taiwan", "kind": "city", "region": "Taipei"},
    "china": {"lat": 35.8617, "lng": 104.1954, "country": "China", "kind": "country"},
    "beijing": {"lat": 39.9042, "lng": 116.4074, "country": "China", "kind": "city", "region": "Beijing"},
    "shanghai": {"lat": 31.2304, "lng": 121.4737, "country": "China", "kind": "city", "region": "Shanghai"},
    "pakistan": {"lat": 30.3753, "lng": 69.3451, "country": "Pakistan", "kind": "country"},
    "islamabad": {"lat": 33.6844, "lng": 73.0479, "country": "Pakistan", "kind": "city", "region": "Islamabad"},
    "karachi": {"lat": 24.8607, "lng": 67.0011, "country": "Pakistan", "kind": "city", "region": "Karachi"},
    "myanmar": {"lat": 21.9162, "lng": 95.9560, "country": "Myanmar", "kind": "country"},
    "yangon": {"lat": 16.8409, "lng": 96.1735, "country": "Myanmar", "kind": "city", "region": "Yangon"},
    "naypyidaw": {"lat": 19.7633, "lng": 96.0785, "country": "Myanmar", "kind": "city", "region": "Naypyidaw"},
    "united states": {"lat": 37.0902, "lng": -95.7129, "country": "United States", "kind": "country"},
    "usa": {"lat": 37.0902, "lng": -95.7129, "country": "United States", "kind": "country"},
    "u.s.": {"lat": 37.0902, "lng": -95.7129, "country": "United States", "kind": "country"},
    "washington": {"lat": 38.9072, "lng": -77.0369, "country": "United States", "kind": "city", "region": "Washington"},
    "new york": {"lat": 40.7128, "lng": -74.0060, "country": "United States", "kind": "city", "region": "New York"},
    "canada": {"lat": 56.1304, "lng": -106.3468, "country": "Canada", "kind": "country"},
    "ottawa": {"lat": 45.4215, "lng": -75.6972, "country": "Canada", "kind": "city", "region": "Ottawa"},
    "mexico": {"lat": 23.6345, "lng": -102.5528, "country": "Mexico", "kind": "country"},
    "brazil": {"lat": -14.2350, "lng": -51.9253, "country": "Brazil", "kind": "country"},
    "argentina": {"lat": -38.4161, "lng": -63.6167, "country": "Argentina", "kind": "country"},
    "venezuela": {"lat": 6.4238, "lng": -66.5897, "country": "Venezuela", "kind": "country"},
    "colombia": {"lat": 4.5709, "lng": -74.2973, "country": "Colombia", "kind": "country"},
    "peru": {"lat": -9.1900, "lng": -75.0152, "country": "Peru", "kind": "country"},
    "chile": {"lat": -35.6751, "lng": -71.5430, "country": "Chile", "kind": "country"},
    "united kingdom": {"lat": 55.3781, "lng": -3.4360, "country": "United Kingdom", "kind": "country"},
    "uk": {"lat": 55.3781, "lng": -3.4360, "country": "United Kingdom", "kind": "country"},
    "london": {"lat": 51.5074, "lng": -0.1278, "country": "United Kingdom", "kind": "city", "region": "London"},
    "france": {"lat": 46.2276, "lng": 2.2137, "country": "France", "kind": "country"},
    "paris": {"lat": 48.8566, "lng": 2.3522, "country": "France", "kind": "city", "region": "Paris"},
    "germany": {"lat": 51.1657, "lng": 10.4515, "country": "Germany", "kind": "country"},
    "berlin": {"lat": 52.5200, "lng": 13.4050, "country": "Germany", "kind": "city", "region": "Berlin"},
    "poland": {"lat": 51.9194, "lng": 19.1451, "country": "Poland", "kind": "country"},
    "warsaw": {"lat": 52.2297, "lng": 21.0122, "country": "Poland", "kind": "city", "region": "Warsaw"},
    "belarus": {"lat": 53.7098, "lng": 27.9534, "country": "Belarus", "kind": "country"},
    "moldova": {"lat": 47.4116, "lng": 28.3699, "country": "Moldova", "kind": "country"},
    "romania": {"lat": 45.9432, "lng": 24.9668, "country": "Romania", "kind": "country"},
    "estonia": {"lat": 58.5953, "lng": 25.0136, "country": "Estonia", "kind": "country"},
    "latvia": {"lat": 56.8796, "lng": 24.6032, "country": "Latvia", "kind": "country"},
    "lithuania": {"lat": 55.1694, "lng": 23.8813, "country": "Lithuania", "kind": "country"},
    "finland": {"lat": 61.9241, "lng": 25.7482, "country": "Finland", "kind": "country"},
    "sweden": {"lat": 60.1282, "lng": 18.6435, "country": "Sweden", "kind": "country"},
    "norway": {"lat": 60.4720, "lng": 8.4689, "country": "Norway", "kind": "country"},
    "denmark": {"lat": 56.2639, "lng": 9.5018, "country": "Denmark", "kind": "country"},
    "netherlands": {"lat": 52.1326, "lng": 5.2913, "country": "Netherlands", "kind": "country"},
    "amsterdam": {"lat": 52.3676, "lng": 4.9041, "country": "Netherlands", "kind": "city", "region": "Amsterdam"},
    "belgium": {"lat": 50.5039, "lng": 4.4699, "country": "Belgium", "kind": "country"},
    "brussels": {"lat": 50.8503, "lng": 4.3517, "country": "Belgium", "kind": "city", "region": "Brussels"},
    "spain": {"lat": 40.4637, "lng": -3.7492, "country": "Spain", "kind": "country"},
    "madrid": {"lat": 40.4168, "lng": -3.7038, "country": "Spain", "kind": "city", "region": "Madrid"},
    "italy": {"lat": 41.8719, "lng": 12.5674, "country": "Italy", "kind": "country"},
    "rome": {"lat": 41.9028, "lng": 12.4964, "country": "Italy", "kind": "city", "region": "Rome"},
    "greece": {"lat": 39.0742, "lng": 21.8243, "country": "Greece", "kind": "country"},
    "athens": {"lat": 37.9838, "lng": 23.7275, "country": "Greece", "kind": "city", "region": "Athens"},
    "turkey": {"lat": 38.9637, "lng": 35.2433, "country": "Turkey", "kind": "country"},
    "ankara": {"lat": 39.9334, "lng": 32.8597, "country": "Turkey", "kind": "city", "region": "Ankara"},
    "istanbul": {"lat": 41.0082, "lng": 28.9784, "country": "Turkey", "kind": "city", "region": "Istanbul"},
    "armenia": {"lat": 40.0691, "lng": 45.0382, "country": "Armenia", "kind": "country"},
    "azerbaijan": {"lat": 40.1431, "lng": 47.5769, "country": "Azerbaijan", "kind": "country"},
    "georgia": {"lat": 42.3154, "lng": 43.3569, "country": "Georgia", "kind": "country"},
    "egypt": {"lat": 26.8206, "lng": 30.8025, "country": "Egypt", "kind": "country"},
    "cairo": {"lat": 30.0444, "lng": 31.2357, "country": "Egypt", "kind": "city", "region": "Cairo"},
    "libya": {"lat": 26.3351, "lng": 17.2283, "country": "Libya", "kind": "country"},
    "tripoli": {"lat": 32.8872, "lng": 13.1913, "country": "Libya", "kind": "city", "region": "Tripoli"},
    "tunisia": {"lat": 33.8869, "lng": 9.5375, "country": "Tunisia", "kind": "country"},
    "algeria": {"lat": 28.0339, "lng": 1.6596, "country": "Algeria", "kind": "country"},
    "morocco": {"lat": 31.7917, "lng": -7.0926, "country": "Morocco", "kind": "country"},
    "saudi arabia": {"lat": 23.8859, "lng": 45.0792, "country": "Saudi Arabia", "kind": "country"},
    "riyadh": {"lat": 24.7136, "lng": 46.6753, "country": "Saudi Arabia", "kind": "city", "region": "Riyadh"},
    "jeddah": {"lat": 21.4858, "lng": 39.1925, "country": "Saudi Arabia", "kind": "city", "region": "Jeddah"},
    "uae": {"lat": 23.4241, "lng": 53.8478, "country": "United Arab Emirates", "kind": "country"},
    "united arab emirates": {"lat": 23.4241, "lng": 53.8478, "country": "United Arab Emirates", "kind": "country"},
    "dubai": {"lat": 25.2048, "lng": 55.2708, "country": "United Arab Emirates", "kind": "city", "region": "Dubai"},
    "abu dhabi": {"lat": 24.4539, "lng": 54.3773, "country": "United Arab Emirates", "kind": "city", "region": "Abu Dhabi"},
    "qatar": {"lat": 25.3548, "lng": 51.1839, "country": "Qatar", "kind": "country"},
    "doha": {"lat": 25.2854, "lng": 51.5310, "country": "Qatar", "kind": "city", "region": "Doha"},
    "oman": {"lat": 21.4735, "lng": 55.9754, "country": "Oman", "kind": "country"},
    "jordan": {"lat": 30.5852, "lng": 36.2384, "country": "Jordan", "kind": "country"},
    "afghanistan": {"lat": 33.9391, "lng": 67.7100, "country": "Afghanistan", "kind": "country"},
    "kabul": {"lat": 34.5553, "lng": 69.2075, "country": "Afghanistan", "kind": "city", "region": "Kabul"},
    "india": {"lat": 20.5937, "lng": 78.9629, "country": "India", "kind": "country"},
    "new delhi": {"lat": 28.6139, "lng": 77.2090, "country": "India", "kind": "city", "region": "New Delhi"},
    "mumbai": {"lat": 19.0760, "lng": 72.8777, "country": "India", "kind": "city", "region": "Mumbai"},
    "bangladesh": {"lat": 23.6850, "lng": 90.3563, "country": "Bangladesh", "kind": "country"},
    "sri lanka": {"lat": 7.8731, "lng": 80.7718, "country": "Sri Lanka", "kind": "country"},
    "nepal": {"lat": 28.3949, "lng": 84.1240, "country": "Nepal", "kind": "country"},
    "bhutan": {"lat": 27.5142, "lng": 90.4336, "country": "Bhutan", "kind": "country"},
    "japan": {"lat": 36.2048, "lng": 138.2529, "country": "Japan", "kind": "country"},
    "tokyo": {"lat": 35.6762, "lng": 139.6503, "country": "Japan", "kind": "city", "region": "Tokyo"},
    "south korea": {"lat": 35.9078, "lng": 127.7669, "country": "South Korea", "kind": "country"},
    "seoul": {"lat": 37.5665, "lng": 126.9780, "country": "South Korea", "kind": "city", "region": "Seoul"},
    "north korea": {"lat": 40.3399, "lng": 127.5101, "country": "North Korea", "kind": "country"},
    "pyongyang": {"lat": 39.0392, "lng": 125.7625, "country": "North Korea", "kind": "city", "region": "Pyongyang"},
    "philippines": {"lat": 12.8797, "lng": 121.7740, "country": "Philippines", "kind": "country"},
    "indonesia": {"lat": -0.7893, "lng": 113.9213, "country": "Indonesia", "kind": "country"},
    "malaysia": {"lat": 4.2105, "lng": 101.9758, "country": "Malaysia", "kind": "country"},
    "singapore": {"lat": 1.3521, "lng": 103.8198, "country": "Singapore", "kind": "country"},
    "thailand": {"lat": 15.8700, "lng": 100.9925, "country": "Thailand", "kind": "country"},
    "vietnam": {"lat": 14.0583, "lng": 108.2772, "country": "Vietnam", "kind": "country"},
    "ethiopia": {"lat": 9.1450, "lng": 40.4897, "country": "Ethiopia", "kind": "country"},
    "eritrea": {"lat": 15.1794, "lng": 39.7823, "country": "Eritrea", "kind": "country"},
    "somalia": {"lat": 5.1521, "lng": 46.1996, "country": "Somalia", "kind": "country"},
    "kenya": {"lat": -0.0236, "lng": 37.9062, "country": "Kenya", "kind": "country"},
    "nigeria": {"lat": 9.0820, "lng": 8.6753, "country": "Nigeria", "kind": "country"},
    "chad": {"lat": 15.4542, "lng": 18.7322, "country": "Chad", "kind": "country"},
    "niger": {"lat": 17.6078, "lng": 8.0817, "country": "Niger", "kind": "country"},
    "mali": {"lat": 17.5707, "lng": -3.9962, "country": "Mali", "kind": "country"},
    "burkina faso": {"lat": 12.2383, "lng": -1.5616, "country": "Burkina Faso", "kind": "country"},
    "central african republic": {"lat": 6.6111, "lng": 20.9394, "country": "Central African Republic", "kind": "country"},
    "democratic republic of the congo": {"lat": -4.0383, "lng": 21.7587, "country": "DR Congo", "kind": "country"},
    "drc": {"lat": -4.0383, "lng": 21.7587, "country": "DR Congo", "kind": "country"},
}

_COMPILED_PATTERNS: list[tuple[str, re.Pattern[str], dict[str, Any]]] = [
    (
        location_name,
        re.compile(rf"(?<!\\w){re.escape(location_name)}(?!\\w)", re.IGNORECASE),
        location_data,
    )
    for location_name, location_data in LOCATIONS.items()
]


def resolve_location(text: str) -> dict[str, Any]:
    if not text:
        return {
            "country": "Unknown",
            "region": "Unknown",
            "lat": None,
            "lng": None,
            "matched": None,
            "kind": None,
        }

    matches: list[tuple[int, int, str, dict[str, Any]]] = []

    for location_name, pattern, location_data in _COMPILED_PATTERNS:
        if not pattern.search(text):
            continue

        kind = location_data.get("kind", "country")
        specificity = 2 if kind == "city" else 1
        matches.append((specificity, len(location_name), location_name, location_data))

    if not matches:
        return {
            "country": "Unknown",
            "region": "Unknown",
            "lat": None,
            "lng": None,
            "matched": None,
            "kind": None,
        }

    _, _, location_name, location_data = max(matches, key=lambda item: (item[0], item[1]))
    resolved_kind = location_data.get("kind", "country")

    if resolved_kind == "city":
        region = location_data.get("region", location_name.title())
    elif resolved_kind == "region":
        region = location_data.get("region", location_data.get("country", "Unknown"))
    else:
        region = location_data.get("country", "Unknown")

    return {
        "country": location_data.get("country", "Unknown"),
        "region": region,
        "lat": location_data.get("lat"),
        "lng": location_data.get("lng"),
        "matched": location_name,
        "kind": resolved_kind,
    }
