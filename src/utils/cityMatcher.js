function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CITY_DATA = [
  { name: "Tehran", countryName: "Iran", countryCode: "IR", region: "Asia", lat: 35.6892, lng: 51.389, aliases: ["teheran", "téhéran"] },
  { name: "Isfahan", countryName: "Iran", countryCode: "IR", region: "Asia", lat: 32.6539, lng: 51.666 },
  { name: "Tabriz", countryName: "Iran", countryCode: "IR", region: "Asia", lat: 38.0962, lng: 46.2738 },
  { name: "Mashhad", countryName: "Iran", countryCode: "IR", region: "Asia", lat: 36.2605, lng: 59.6168 },
  { name: "Tel Aviv", countryName: "Israel", countryCode: "IL", region: "Asia", lat: 32.0853, lng: 34.7818 },
  { name: "Jerusalem", countryName: "Israel", countryCode: "IL", region: "Asia", lat: 31.7683, lng: 35.2137 },
  { name: "Haifa", countryName: "Israel", countryCode: "IL", region: "Asia", lat: 32.794, lng: 34.9896 },
  { name: "Gaza City", countryName: "Palestine", countryCode: "PS", region: "Asia", lat: 31.5017, lng: 34.4668, aliases: ["gaza"] },
  { name: "Khan Younis", countryName: "Palestine", countryCode: "PS", region: "Asia", lat: 31.346, lng: 34.3063 },
  { name: "Rafah", countryName: "Palestine", countryCode: "PS", region: "Asia", lat: 31.2969, lng: 34.2431 },
  { name: "Beirut", countryName: "Lebanon", countryCode: "LB", region: "Asia", lat: 33.8938, lng: 35.5018 },
  { name: "Tyre", countryName: "Lebanon", countryCode: "LB", region: "Asia", lat: 33.2704, lng: 35.2038 },
  { name: "Damascus", countryName: "Syria", countryCode: "SY", region: "Asia", lat: 33.5138, lng: 36.2765 },
  { name: "Aleppo", countryName: "Syria", countryCode: "SY", region: "Asia", lat: 36.2021, lng: 37.1343 },
  { name: "Idlib", countryName: "Syria", countryCode: "SY", region: "Asia", lat: 35.93, lng: 36.6339 },
  { name: "Baghdad", countryName: "Iraq", countryCode: "IQ", region: "Asia", lat: 33.3152, lng: 44.3661 },
  { name: "Erbil", countryName: "Iraq", countryCode: "IQ", region: "Asia", lat: 36.1911, lng: 44.0092 },
  { name: "Basra", countryName: "Iraq", countryCode: "IQ", region: "Asia", lat: 30.5085, lng: 47.7804 },
  { name: "Sanaa", countryName: "Yemen", countryCode: "YE", region: "Asia", lat: 15.3694, lng: 44.191, aliases: ["sana", "sanaa"] },
  { name: "Aden", countryName: "Yemen", countryCode: "YE", region: "Asia", lat: 12.7855, lng: 45.0187 },
  { name: "Hodeidah", countryName: "Yemen", countryCode: "YE", region: "Asia", lat: 14.7978, lng: 42.9545 },
  { name: "Kyiv", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 50.4501, lng: 30.5234, aliases: ["kiev"] },
  { name: "Kharkiv", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 49.9935, lng: 36.2304 },
  { name: "Odesa", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 46.4825, lng: 30.7233, aliases: ["odessa"] },
  { name: "Dnipro", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 48.4647, lng: 35.0462 },
  { name: "Zaporizhzhia", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 47.8388, lng: 35.1396, aliases: ["zaporozhye"] },
  { name: "Donetsk", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 48.0159, lng: 37.8028 },
  { name: "Luhansk", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 48.574, lng: 39.3078 },
  { name: "Sevastopol", countryName: "Ukraine", countryCode: "UA", region: "Europe", lat: 44.6166, lng: 33.5254 },
  { name: "Moscow", countryName: "Russia", countryCode: "RU", region: "Europe", lat: 55.7558, lng: 37.6173, aliases: ["moscou"] },
  { name: "Belgorod", countryName: "Russia", countryCode: "RU", region: "Europe", lat: 50.5954, lng: 36.5879 },
  { name: "Kursk", countryName: "Russia", countryCode: "RU", region: "Europe", lat: 51.7304, lng: 36.1926 },
  { name: "Rostov-on-Don", countryName: "Russia", countryCode: "RU", region: "Europe", lat: 47.2357, lng: 39.7015, aliases: ["rostov on don"] },
  { name: "St Petersburg", countryName: "Russia", countryCode: "RU", region: "Europe", lat: 59.9311, lng: 30.3609, aliases: ["saint petersburg"] },
  { name: "Khartoum", countryName: "Sudan", countryCode: "SD", region: "Africa", lat: 15.5007, lng: 32.5599 },
  { name: "Omdurman", countryName: "Sudan", countryCode: "SD", region: "Africa", lat: 15.6445, lng: 32.4777 },
  { name: "El Fasher", countryName: "Sudan", countryCode: "SD", region: "Africa", lat: 13.6279, lng: 25.3494, aliases: ["al fashir"] },
  { name: "Tripoli", countryName: "Libya", countryCode: "LY", region: "Africa", lat: 32.8872, lng: 13.1913 },
  { name: "Benghazi", countryName: "Libya", countryCode: "LY", region: "Africa", lat: 32.1167, lng: 20.0667 },
  { name: "Goma", countryName: "DR Congo", countryCode: "CD", region: "Africa", lat: -1.6585, lng: 29.2204 },
  { name: "Kinshasa", countryName: "DR Congo", countryCode: "CD", region: "Africa", lat: -4.4419, lng: 15.2663 },
  { name: "Mogadishu", countryName: "Somalia", countryCode: "SO", region: "Africa", lat: 2.0469, lng: 45.3182 },
  { name: "Kismayo", countryName: "Somalia", countryCode: "SO", region: "Africa", lat: -0.3582, lng: 42.5454 },
  { name: "Nairobi", countryName: "Kenya", countryCode: "KE", region: "Africa", lat: -1.2921, lng: 36.8219 },
  { name: "Minsk", countryName: "Belarus", countryCode: "BY", region: "Europe", lat: 53.9045, lng: 27.5615 },
  { name: "Tbilisi", countryName: "Georgia", countryCode: "GE", region: "Asia", lat: 41.7151, lng: 44.8271 },
  { name: "Yerevan", countryName: "Armenia", countryCode: "AM", region: "Asia", lat: 40.1792, lng: 44.4991 },
  { name: "Baku", countryName: "Azerbaijan", countryCode: "AZ", region: "Asia", lat: 40.4093, lng: 49.8671 },
  { name: "Ankara", countryName: "Turkey", countryCode: "TR", region: "Asia", lat: 39.9334, lng: 32.8597 },
  { name: "Istanbul", countryName: "Turkey", countryCode: "TR", region: "Asia", lat: 41.0082, lng: 28.9784 },
  { name: "Doha", countryName: "Qatar", countryCode: "QA", region: "Asia", lat: 25.2854, lng: 51.531, aliases: ["doha qatar"] },
  { name: "Dubai", countryName: "United Arab Emirates", countryCode: "AE", region: "Asia", lat: 25.2048, lng: 55.2708, aliases: ["dubai uae", "dubaï"] },
  { name: "Abu Dhabi", countryName: "United Arab Emirates", countryCode: "AE", region: "Asia", lat: 24.4539, lng: 54.3773, aliases: ["abou dhabi", "abu dabi", "abou dabi"] },
  {
    name: "Duqm",
    countryName: "Oman",
    countryCode: "OM",
    region: "Asia",
    lat: 19.6711,
    lng: 57.7058,
    aliases: ["duqm port", "port of duqm", "commercial port of duqm", "omani commercial port of duqm"]
  },
  { name: "Muscat", countryName: "Oman", countryCode: "OM", region: "Asia", lat: 23.588, lng: 58.3829, aliases: ["masqat"] },
  { name: "Sohar", countryName: "Oman", countryCode: "OM", region: "Asia", lat: 24.3419, lng: 56.7294 },
  { name: "Salalah", countryName: "Oman", countryCode: "OM", region: "Asia", lat: 17.0194, lng: 54.0897 },
  {
    name: "Bandar Abbas",
    countryName: "Iran",
    countryCode: "IR",
    region: "Asia",
    lat: 27.1832,
    lng: 56.2666,
    aliases: ["bandar-e abbas", "bandar abbas port"]
  },
  { name: "Riyadh", countryName: "Saudi Arabia", countryCode: "SA", region: "Asia", lat: 24.7136, lng: 46.6753 },
  { name: "Jeddah", countryName: "Saudi Arabia", countryCode: "SA", region: "Asia", lat: 21.4858, lng: 39.1925 },
  { name: "Amman", countryName: "Jordan", countryCode: "JO", region: "Asia", lat: 31.9539, lng: 35.9106 },
  { name: "Cairo", countryName: "Egypt", countryCode: "EG", region: "Africa", lat: 30.0444, lng: 31.2357, aliases: ["le caire"] },
  { name: "Alexandria", countryName: "Egypt", countryCode: "EG", region: "Africa", lat: 31.2001, lng: 29.9187 },
  { name: "Washington", countryName: "United States", countryCode: "US", region: "Americas", lat: 38.9072, lng: -77.0369, aliases: ["washington dc"] },
  { name: "New York", countryName: "United States", countryCode: "US", region: "Americas", lat: 40.7128, lng: -74.006 },
  { name: "Seoul", countryName: "South Korea", countryCode: "KR", region: "Asia", lat: 37.5665, lng: 126.978 },
  { name: "Pyongyang", countryName: "North Korea", countryCode: "KP", region: "Asia", lat: 39.0392, lng: 125.7625 },
  { name: "Taipei", countryName: "Taiwan", countryCode: "TW", region: "Asia", lat: 25.033, lng: 121.5654 },
  { name: "Kaohsiung", countryName: "Taiwan", countryCode: "TW", region: "Asia", lat: 22.6273, lng: 120.3014 },
  { name: "Beijing", countryName: "China", countryCode: "CN", region: "Asia", lat: 39.9042, lng: 116.4074 },
  { name: "Shanghai", countryName: "China", countryCode: "CN", region: "Asia", lat: 31.2304, lng: 121.4737 }
];

const CITY_PATTERNS = CITY_DATA.flatMap((city) => {
  const aliases = [city.name, ...(city.aliases || [])];
  return aliases.map((alias) => {
    const normalizedAlias = normalizeText(alias).replace(/\s+/g, " ").trim();
    return {
      city,
      normalizedAlias,
      regex: new RegExp(`\\b${escapeRegExp(normalizedAlias)}\\b`, "i")
    };
  });
}).sort((a, b) => b.normalizedAlias.length - a.normalizedAlias.length);

function extractCity(text, countryInfo = null) {
  const normalizedText = normalizeText(text).replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return null;
  }

  const countryCode = String(countryInfo?.code || "").toUpperCase();

  const byCountry = CITY_PATTERNS.find((pattern) => {
    if (!pattern.regex.test(normalizedText)) {
      return false;
    }
    if (!countryCode || countryCode === "XX") {
      return false;
    }
    return pattern.city.countryCode === countryCode;
  });

  // If a country is already known, only accept cities from that same country.
  // This avoids cross-country marker drift (e.g. country Iran + city Riyadh).
  const matched =
    countryCode && countryCode !== "XX"
      ? byCountry
      : CITY_PATTERNS.find((pattern) => pattern.regex.test(normalizedText));
  if (!matched) {
    return null;
  }

  return {
    name: matched.city.name,
    countryName: matched.city.countryName,
    countryCode: matched.city.countryCode,
    region: matched.city.region,
    lat: matched.city.lat,
    lng: matched.city.lng
  };
}

module.exports = { extractCity };
