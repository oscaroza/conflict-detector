const Parser = require("rss-parser");
const Alert = require("../models/Alert");
const Settings = require("../models/Settings");
const { extractCountry, extractCountryMentions } = require("../utils/countryMatcher");
const { extractCity } = require("../utils/cityMatcher");
const { extractStrategicArea } = require("../utils/strategicAreaMatcher");
const { inferOccurredAt } = require("../utils/eventTimeParser");
const streamService = require("./streamService");

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"
  }
});

const FETCH_TIMEOUT_MS = 15000;
const GDELT_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const TELEGRAM_SYNC_TIMEOUT_MS = 12000;
const TELEGRAM_SYNC_DEFAULT_LIMIT = 120;
const AI_QUEUE_STATUS_CACHE_MS = 12000;
const DEFAULT_AI_RATE_LIMIT_PER_MINUTE = 10;

function readNumberEnv(name, defaultValue, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function readBooleanEnv(name, defaultValue = true) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return defaultValue;
}

const ENABLE_GDELT = readBooleanEnv("ENABLE_GDELT", true);
const TELEGRAM_SYNC_MIN_INTERVAL_MS = readNumberEnv("TELEGRAM_SYNC_MIN_INTERVAL_SECONDS", 45, 10, 900) * 1000;
const TELEGRAM_SYNC_CACHE_MAX_AGE_MS = readNumberEnv("TELEGRAM_SYNC_CACHE_MAX_AGE_SECONDS", 180, 30, 3600) * 1000;

const FEEDS = [
  {
    sourceName: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "The Guardian World",
    url: "https://www.theguardian.com/world/rss",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News War Live 60m",
    url: "https://news.google.com/rss/search?q=missile+OR+airstrike+OR+drone+strike+OR+military+base+hit+OR+soldiers+killed+OR+casualties+when:1h&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News Battlefield 6h",
    url: "https://news.google.com/rss/search?q=artillery+OR+rocket+OR+shelling+OR+battlefield+OR+frontline+OR+troops+when:6h&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News US-Iran 6h",
    url: "https://news.google.com/rss/search?q=US+Iran+missile+OR+US+Iran+attack+OR+Iran+strike+OR+Tehran+Washington+conflict+when:6h&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News Ukraine War 6h",
    url: "https://news.google.com/rss/search?q=Ukraine+Russia+war+OR+frontline+OR+Kharkiv+OR+Donetsk+OR+missile+strike+when:6h&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News Middle East 6h",
    url: "https://news.google.com/rss/search?q=Israel+Gaza+OR+Lebanon+Hezbollah+OR+Syria+airstrike+OR+Red+Sea+attack+OR+Yemen+Houthis+when:6h&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News Asia Tensions 6h",
    url: "https://news.google.com/rss/search?q=Taiwan+strait+OR+South+China+Sea+OR+North+Korea+missile+OR+Kashmir+clashes+when:6h&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News Africa Conflicts 12h",
    url: "https://news.google.com/rss/search?q=Sudan+war+OR+Sahel+attack+OR+Congo+rebels+OR+Somalia+military+operation+when:12h&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  }
];

const GDELT_STREAMS = [
  {
    sourceName: "GDELT War Signals",
    query:
      "(missile OR airstrike OR drone strike OR artillery OR shelling OR military base attacked OR soldiers killed OR casualties OR nuclear plant explosion OR ceasefire collapsed) AND (war OR conflict)",
    maxRecords: 60
  },
  {
    sourceName: "GDELT Regional Escalation",
    query:
      "(Ukraine OR Russia OR Israel OR Gaza OR Lebanon OR Iran OR Taiwan OR South China Sea OR Sudan OR Yemen OR Syria) AND (missile OR strike OR artillery OR drone OR casualties OR offensive OR escalation)",
    maxRecords: 70
  },
  {
    sourceName: "GDELT Conflict Fatalities",
    query:
      "(war OR conflict OR clashes OR offensive OR raid) AND (killed OR dead OR wounded OR casualties OR death toll)",
    maxRecords: 70
  }
];

function resolveTelegramBackendBaseUrl() {
  const raw = String(process.env.TELEGRAM_OSINT_API_URL || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function resolveTelegramFetchLimit() {
  const raw = Number(process.env.TELEGRAM_OSINT_FETCH_LIMIT);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 300) {
    return Math.round(raw);
  }
  return TELEGRAM_SYNC_DEFAULT_LIMIT;
}

function normalizeTelegramSourceName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Telegram OSINT";
  return raw.startsWith("@") ? raw : `@${raw.replace(/^@+/, "")}`;
}

function buildTelegramChannelBaseUrl(sourceName) {
  const raw = String(sourceName || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const handle = raw.replace(/^@+/, "").trim();
  if (!handle) return "";
  return `https://t.me/${encodeURIComponent(handle)}`;
}

function buildTelegramSourceUrl(alert, sourceName, backendBaseUrl) {
  const uniqueToken = encodeURIComponent(String(alert?.id || `${Date.now()}`));
  const channelBase = buildTelegramChannelBaseUrl(sourceName);
  if (channelBase) {
    return `${channelBase}#alert-${uniqueToken}`;
  }
  if (backendBaseUrl) {
    return `${backendBaseUrl}/api/alerts?limit=1#telegram-${uniqueToken}`;
  }
  return `https://t.me/#telegram-${uniqueToken}`;
}

function normalizeTelegramSeverity(rawSeverity, text) {
  const normalized = String(rawSeverity || "")
    .trim()
    .toLowerCase();

  const mapped = {
    critique: "critical",
    critical: "critical",
    haute: "high",
    high: "high",
    moyen: "medium",
    medium: "medium",
    faible: "low",
    low: "low"
  }[normalized];

  if (mapped) return mapped;
  return classifySeverity(text);
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 35;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeCountryInfo(countryInfo) {
  const codeRaw = String(countryInfo?.code ?? "XX").trim();
  const normalizedCode = codeRaw ? codeRaw.toUpperCase() : "";

  return {
    name: String(countryInfo?.name || "Inconnu").trim() || "Inconnu",
    code: normalizedCode,
    region: String(countryInfo?.region || "Global").trim() || "Global",
    lat: Number.isFinite(Number(countryInfo?.lat)) ? Number(countryInfo.lat) : 20,
    lng: Number.isFinite(Number(countryInfo?.lng)) ? Number(countryInfo.lng) : 0,
    area: Number.isFinite(Number(countryInfo?.area)) ? Number(countryInfo.area) : 0
  };
}

function isUnknownCountryInfo(countryInfo) {
  const normalizedName = String(countryInfo?.name || "").trim().toLowerCase();
  const normalizedCode = String(countryInfo?.code || "").trim().toUpperCase();
  return !normalizedName || normalizedName === "inconnu" || normalizedCode === "XX";
}

function normalizeLocationLabel(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function expandCountryAbbreviations(value) {
  return String(value || "")
    .replace(/\bU\.?S\.?A?\b/g, "United States of America")
    .replace(/\bU\.?K\.?\b/g, "United Kingdom");
}

function detectDirectionalHint(text) {
  const input = String(text || "");
  const hints = DIRECTION_PATTERN_MAP.filter((item) => item.regex.test(input)).map((item) => item.key);
  return Array.from(new Set(hints)).join(",");
}

function directionalOffsetScale(countryInfo) {
  const area = Number(countryInfo?.area || 0);
  if (area >= 6_000_000) return 2.5;
  if (area >= 2_000_000) return 2.1;
  if (area >= 800_000) return 1.6;
  if (area >= 300_000) return 1.2;
  return 0.8;
}

function applyDirectionalOffset(lat, lng, directionalHint, countryInfo) {
  const hints = String(directionalHint || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!hints.length || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat, lng };
  }

  const scale = directionalOffsetScale(countryInfo);
  let nextLat = lat;
  let nextLng = lng;

  if (hints.includes("north")) {
    nextLat += scale;
  }
  if (hints.includes("south")) {
    nextLat -= scale;
  }
  if (hints.includes("east")) {
    nextLng += scale;
  }
  if (hints.includes("west")) {
    nextLng -= scale;
  }

  return {
    lat: Math.max(-89.5, Math.min(89.5, nextLat)),
    lng: Math.max(-179.5, Math.min(179.5, nextLng))
  };
}

function resolveBorderLocationFromMentions(articleText, mentions = []) {
  const normalized = normalizeLocationLabel(articleText);
  const hasBorderWord = /(border|frontier|frontiere|frontière)/i.test(String(articleText || ""));
  if (!hasBorderWord || !normalized) {
    return null;
  }

  const uniqueMentions = [];
  const seen = new Set();
  for (const mention of mentions) {
    const code = String(mention?.code || "").toUpperCase();
    if (!code || code === "XX" || seen.has(code)) {
      continue;
    }
    seen.add(code);
    uniqueMentions.push(mention);
    if (uniqueMentions.length >= 2) {
      break;
    }
  }

  if (uniqueMentions.length < 2) {
    return null;
  }

  const [first, second] = uniqueMentions;
  if (!Number.isFinite(first?.lat) || !Number.isFinite(first?.lng) || !Number.isFinite(second?.lat) || !Number.isFinite(second?.lng)) {
    return null;
  }

  const midLat = (Number(first.lat) + Number(second.lat)) / 2;
  const midLng = (Number(first.lng) + Number(second.lng)) / 2;
  return {
    name: `Frontiere ${first.name} - ${second.name}`,
    lat: midLat,
    lng: midLng,
    countries: [first.name, second.name]
  };
}

function resolveGeoSignals(articleText, initialCountryInfo = null) {
  const lookupText = expandCountryAbbreviations(articleText);
  let countryInfo = normalizeCountryInfo(initialCountryInfo || extractCountry(lookupText));
  const strategicArea = extractStrategicArea(lookupText);
  const directionalHint = detectDirectionalHint(lookupText);
  const mentions = extractCountryMentions(lookupText, 4);
  const borderLocation = resolveBorderLocationFromMentions(lookupText, mentions);
  const exactCity = extractCity(lookupText, countryInfo);

  if (exactCity && isUnknownCountryInfo(countryInfo)) {
    countryInfo = normalizeCountryInfo({
      name: exactCity.countryName,
      code: exactCity.countryCode,
      region: exactCity.region || "Global",
      lat: exactCity.lat,
      lng: exactCity.lng
    });
  }

  if (borderLocation && isUnknownCountryInfo(countryInfo)) {
    const firstMention = mentions[0];
    if (firstMention) {
      countryInfo = normalizeCountryInfo(firstMention);
    }
  }

  if (strategicArea && isUnknownCountryInfo(countryInfo)) {
    countryInfo = normalizeCountryInfo({
      name: strategicArea.name,
      code: "",
      region: strategicArea.region || "Global",
      lat: strategicArea.lat,
      lng: strategicArea.lng
    });
  }

  let cityInfo = borderLocation
    ? {
        name: borderLocation.name,
        countryName: countryInfo.name,
        countryCode: countryInfo.code,
        region: countryInfo.region || "Global",
        lat: borderLocation.lat,
        lng: borderLocation.lng,
        isBorder: true
      }
    : exactCity;

  if (!cityInfo && strategicArea) {
    const countryKey = normalizeLocationLabel(countryInfo?.name);
    const areaKey = normalizeLocationLabel(strategicArea.name);
    if (!countryKey || countryKey !== areaKey) {
      cityInfo = {
        name: strategicArea.name,
        countryName: countryInfo.name,
        countryCode: countryInfo.code,
        region: strategicArea.region || countryInfo.region || "Global",
        lat: strategicArea.lat,
        lng: strategicArea.lng,
        isStrategicArea: true
      };
    }
  }

  return {
    countryInfo,
    cityInfo,
    strategicArea,
    geoMeta: {
      strategicArea: strategicArea?.name || "",
      directionalHint,
      isBorder: Boolean(borderLocation),
      borderCountries: borderLocation?.countries || []
    }
  };
}

function computeMarkerCoordinates({
  cityInfo,
  strategicArea,
  countryInfo,
  rawLat = null,
  rawLng = null,
  allowRawOverride = false,
  applyDirection = true,
  directionalHint = ""
}) {
  const haversineDistanceBetween = (latA, lngA, latB, lngB) => {
    if (![latA, lngA, latB, lngB].every((value) => Number.isFinite(value))) {
      return Number.POSITIVE_INFINITY;
    }

    const earthRadiusKm = 6371;
    const dLat = ((latB - latA) * Math.PI) / 180;
    const dLng = ((lngB - lngA) * Math.PI) / 180;
    const p1 = (latA * Math.PI) / 180;
    const p2 = (latB * Math.PI) / 180;
    const aVal =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(p1) * Math.cos(p2);
    const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
    return earthRadiusKm * c;
  };

  const maxRawDistanceKm = (info) => {
    const area = Number(info?.area || 0);
    if (area >= 6_000_000) return 2500;
    if (area >= 2_000_000) return 1800;
    if (area >= 800_000) return 1200;
    if (area >= 300_000) return 850;
    return 600;
  };

  const canUseRawCoordinates = () => {
    if (!allowRawOverride) return false;
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) return false;
    if (isUnknownCountryInfo(countryInfo)) return false;
    const countryLat = Number(countryInfo?.lat);
    const countryLng = Number(countryInfo?.lng);
    const distance = haversineDistanceBetween(Number(rawLat), Number(rawLng), countryLat, countryLng);
    return Number.isFinite(distance) && distance <= maxRawDistanceKm(countryInfo);
  };

  let lat = null;
  let lng = null;
  const hasExactCity = cityInfo && cityInfo.isStrategicArea !== true && cityInfo.isBorder !== true;

  if (hasExactCity && Number.isFinite(cityInfo?.lat) && Number.isFinite(cityInfo?.lng)) {
    lat = Number(cityInfo.lat);
    lng = Number(cityInfo.lng);
  } else if (canUseRawCoordinates()) {
    lat = Number(rawLat);
    lng = Number(rawLng);
  } else if (Number.isFinite(cityInfo?.lat) && Number.isFinite(cityInfo?.lng)) {
    lat = Number(cityInfo.lat);
    lng = Number(cityInfo.lng);
  } else if (Number.isFinite(strategicArea?.lat) && Number.isFinite(strategicArea?.lng)) {
    lat = Number(strategicArea.lat);
    lng = Number(strategicArea.lng);
  } else {
    lat = Number(countryInfo?.lat) || 20;
    lng = Number(countryInfo?.lng) || 0;
  }

  if (applyDirection && !hasExactCity && directionalHint) {
    const shifted = applyDirectionalOffset(lat, lng, directionalHint, countryInfo);
    lat = shifted.lat;
    lng = shifted.lng;
  }

  return { lat, lng };
}

function normalizeRoleText(value, maxLen = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\-\s]+/, "")
    .replace(/[,;:\-\s]+$/, "")
    .trim()
    .slice(0, maxLen);
}

function safeCountryFromFragment(value) {
  const info = extractCountry(expandCountryAbbreviations(value));
  const normalized = normalizeCountryInfo(info);
  if (isUnknownCountryInfo(normalized)) {
    return { name: "", code: "" };
  }
  return {
    name: normalized.name,
    code: normalized.code
  };
}

function splitIntoSentences(text) {
  return String(text || "")
    .split(/[\.\n!?]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function inferActionFromText(text) {
  const source = String(text || "");
  const directMatch = source.match(
    /\b(missile strike|missile attack|drone strike|drone attack|bombing|airstrike|shelling|troop deployment|troop movements?|raid|attack|strike|invasion|interception)\b/i
  );
  if (directMatch) {
    return normalizeRoleText(directMatch[1], 72);
  }

  const verbMatch = source.match(/\b(fires?|launch(?:es|ed)?|strikes?|bombs?|attacks?|invades?|deploys?|intercepts?)\b/i);
  if (verbMatch) {
    return normalizeRoleText(verbMatch[1], 72);
  }

  return "";
}

function findPrimarySubjectCountry(text, mentions = []) {
  const subjectSlice = String(text || "")
    .split(/\b(condemns?|protests?|reacts?\s+to|denounces?|sanctions?|retaliates?|intercepts?|fires?|launch(?:es|ed)?|strikes?|bombs?|attacks?|invades?|deploys?)\b/i)[0]
    .trim();
  if (subjectSlice) {
    const subjectCountry = safeCountryFromFragment(subjectSlice);
    if (subjectCountry.name) {
      return subjectCountry;
    }
  }
  const firstMention = mentions[0];
  if (firstMention && firstMention.name && firstMention.code !== "XX") {
    return {
      name: firstMention.name,
      code: String(firstMention.code || "").toUpperCase()
    };
  }
  return { name: "", code: "" };
}

function inferActorFromComplement(complement, subjectCountryName = "") {
  const text = String(complement || "").trim();
  if (!text) return { name: "", code: "" };

  const orgActor = text.match(/\b(NATO|OTAN|HAMAS|HEZBOLLAH|HOUTHIS?|IDF)\b/i);
  if (orgActor) {
    return { name: normalizeRoleText(orgActor[1], 80).toUpperCase(), code: "" };
  }

  const byOrFrom = text.match(/\b(?:from|by)\s+([a-zA-Z][a-zA-Z\s\-\(\)]{1,80})/i);
  if (byOrFrom) {
    const candidate = safeCountryFromFragment(byOrFrom[1]);
    if (candidate.name) return candidate;
    return { name: normalizeRoleText(byOrFrom[1], 80), code: "" };
  }

  const leadingEntity = text.match(/^\s*([a-zA-Z][a-zA-Z\s\-\(\)]{1,80})\s+following\b/i);
  if (leadingEntity) {
    const candidate = safeCountryFromFragment(leadingEntity[1]);
    if (candidate.name) return candidate;
  }

  const attackOwner = text.match(/\b([a-zA-Z][a-zA-Z\s\-\(\)]{1,80})\s+(?:missile|drone|rocket|troop|bombing|strike|attack|offensive)\b/i);
  if (attackOwner) {
    const candidate = safeCountryFromFragment(attackOwner[1]);
    if (candidate.name) return candidate;
    const fallbackName = normalizeRoleText(attackOwner[1], 80);
    if (fallbackName && normalizeLocationLabel(fallbackName) !== normalizeLocationLabel(subjectCountryName)) {
      return { name: fallbackName, code: "" };
    }
  }

  const fallback = safeCountryFromFragment(text);
  if (fallback.name && fallback.name !== subjectCountryName) {
    return fallback;
  }

  return { name: "", code: "" };
}

function inferTargetLocationFromComplement(complement, subjectCountryName = "") {
  const text = String(complement || "").trim();
  if (!text) {
    return { target: "", locationOfEvent: "" };
  }

  const normalized = text.toLowerCase();
  const locationMatch = text.match(/\b(?:on|in|at|near|against|of)\s+([a-zA-Z0-9][a-zA-Z0-9\s\-\(\)]{1,120})/i);
  let location = locationMatch ? normalizeRoleText(locationMatch[1], 140) : "";

  if (/its\s+(soil|territory)/i.test(text) && subjectCountryName) {
    location = subjectCountryName;
  }
  if (/its\s+border/i.test(text) && subjectCountryName) {
    location = `${subjectCountryName} border`;
  }

  const rawTarget = normalizeRoleText(location || "", 110);
  const targetCountry = safeCountryFromFragment(location || text);
  const shouldKeepRawTarget =
    /\b(base|border|city|province|district|territory|soil|kharkiv|gaza|donetsk|aleppo|front)\b/i.test(rawTarget);
  const target = shouldKeepRawTarget ? rawTarget : targetCountry.name || rawTarget;

  if (!location && target) {
    location = target;
  }
  if (!location && normalized.includes("border") && subjectCountryName) {
    location = `${subjectCountryName} border`;
  }

  return {
    target,
    locationOfEvent: normalizeRoleText(location, 140)
  };
}

function validateRoleInversion(eventRoles, articleText, subjectCountry = { name: "", code: "" }) {
  const roles = { ...(eventRoles || {}) };
  const text = String(articleText || "");
  if (!OBSERVER_VERB_PATTERN.test(text)) {
    return roles;
  }

  const subjectName = normalizeRoleText(subjectCountry?.name || "");
  if (!subjectName) {
    return roles;
  }

  if (normalizeLocationLabel(roles.actor) === normalizeLocationLabel(subjectName)) {
    const segments = text.split(OBSERVER_VERB_PATTERN);
    const complement = segments.length >= 3 ? segments[2] : text;
    const inferredActor = inferActorFromComplement(complement, subjectName);
    if (inferredActor.name && normalizeLocationLabel(inferredActor.name) !== normalizeLocationLabel(subjectName)) {
      roles.actor = inferredActor.name;
      roles.actorCode = inferredActor.code;
      if (!roles.target) {
        roles.target = subjectName;
        roles.targetCode = String(subjectCountry.code || "");
      }
      if (!roles.validationNotes) {
        roles.validationNotes = "actor_adjusted_from_observer_verb";
      }
    }
  }

  if (/\bintercepts?\b/i.test(text) && /\blaunched\s+from\b/i.test(text)) {
    const fromMatch = text.match(/\blaunched\s+from\s+([a-zA-Z][a-zA-Z\s\-\(\)]{1,80})/i);
    if (fromMatch) {
      const inferredActor = safeCountryFromFragment(fromMatch[1]);
      if (inferredActor.name) {
        roles.actor = inferredActor.name;
        roles.actorCode = inferredActor.code;
      }
      if (!roles.target) {
        roles.target = subjectName;
        roles.targetCode = String(subjectCountry.code || "");
      }
      if (!roles.locationOfEvent && roles.target) {
        roles.locationOfEvent = roles.target;
      }
      if (!roles.validationNotes) {
        roles.validationNotes = "actor_adjusted_from_launch_origin";
      }
    }
  }

  return roles;
}

function buildEventRoles(articleText, fallbackGeo = null, aiRoleSeed = null) {
  const text = String(articleText || "").replace(/\s+/g, " ").trim();
  const mentions = extractCountryMentions(text, 8);
  const subjectCountry = findPrimarySubjectCountry(text, mentions);

  const base = {
    actor: normalizeRoleText(aiRoleSeed?.actor || ""),
    actorCode: normalizeRoleText(aiRoleSeed?.actorCode || "", 8).toUpperCase(),
    actorAction: normalizeRoleText(aiRoleSeed?.actorAction || ""),
    target: normalizeRoleText(aiRoleSeed?.target || ""),
    targetCode: normalizeRoleText(aiRoleSeed?.targetCode || "", 8).toUpperCase(),
    locationOfEvent: normalizeRoleText(aiRoleSeed?.locationOfEvent || ""),
    context: normalizeRoleText(aiRoleSeed?.context || "", 220),
    placementBasis: "unknown",
    validationNotes: ""
  };

  const sentences = splitIntoSentences(text);
  const observerSentence = sentences.find((sentence) => OBSERVER_VERB_PATTERN.test(sentence)) || "";
  const actionSentence =
    sentences.find((sentence) => ACTOR_ACTION_VERB_PATTERN.test(sentence) && !OBSERVER_VERB_PATTERN.test(sentence)) ||
    sentences.find((sentence) => ATTACK_NOUN_PATTERN.test(sentence)) ||
    sentences[0] ||
    "";

  if (observerSentence && !base.context) {
    base.context = normalizeRoleText(observerSentence, 220);
  }

  if (!base.actorAction) {
    base.actorAction = inferActionFromText(actionSentence || observerSentence || text);
  }

  const observerMatch = text.match(
    /\b([a-zA-Z][a-zA-Z\s\-\(\)]{1,90})\s+(condemns?|protests?|reacts?\s+to|denounces?|sanctions?|retaliates?|intercepts?)\s+(.+)/i
  );

  if (observerMatch) {
    const subject = safeCountryFromFragment(observerMatch[1]);
    const complement = observerMatch[3];

    if (!base.target && subject.name) {
      base.target = subject.name;
      base.targetCode = subject.code;
    }

    if (!base.actor) {
      const inferredActor = inferActorFromComplement(complement, subject.name);
      if (inferredActor.name) {
        base.actor = inferredActor.name;
        base.actorCode = inferredActor.code;
      }
    }

    const inferredTarget = inferTargetLocationFromComplement(complement, subject.name);
    if (!base.target && inferredTarget.target) {
      base.target = inferredTarget.target;
      const targetCountry = safeCountryFromFragment(base.target);
      const keepDetailedTarget =
        /\b(base|border|city|province|district|territory|soil|front)\b/i.test(base.target) && base.target.length >= 8;
      if (targetCountry.name && !keepDetailedTarget) {
        base.target = targetCountry.name;
        base.targetCode = targetCountry.code;
      } else if (!base.targetCode && targetCountry.name) {
        base.targetCode = targetCountry.code;
      }
    }
    if (!base.locationOfEvent && inferredTarget.locationOfEvent) {
      base.locationOfEvent = inferredTarget.locationOfEvent;
    }
  }

  const launchedFromMatch = text.match(
    /\b([a-zA-Z][a-zA-Z\s\-\(\)]{1,90})\s+intercepts?.*launched\s+from\s+([a-zA-Z][a-zA-Z\s\-\(\)]{1,90})/i
  );
  if (launchedFromMatch) {
    const targetCountry = safeCountryFromFragment(launchedFromMatch[1]);
    const actorCountry = safeCountryFromFragment(launchedFromMatch[2]);
    if (actorCountry.name) {
      base.actor = actorCountry.name;
      base.actorCode = actorCountry.code;
    }
    if (targetCountry.name) {
      base.target = targetCountry.name;
      base.targetCode = targetCountry.code;
      base.locationOfEvent = targetCountry.name;
    }
    base.actorAction = "drone launch";
  }

  const retaliationMatch = text.match(
    /\b([a-zA-Z][a-zA-Z\s\-\(\)]{1,90})\s+retaliates?.*after\s+([a-zA-Z][a-zA-Z\s\-\(\)]{1,90})\s+(bombing|strike|attack|shelling)\s+of\s+([a-zA-Z][a-zA-Z\s\-\(\)]{1,120})/i
  );
  if (retaliationMatch) {
    const actorCountry = safeCountryFromFragment(retaliationMatch[2]);
    if (actorCountry.name) {
      base.actor = actorCountry.name;
      base.actorCode = actorCountry.code;
    }
    base.actorAction = normalizeRoleText(retaliationMatch[3], 72);
    const targetName = normalizeRoleText(retaliationMatch[4], 90);
    if (targetName) {
      base.target = targetName;
      const targetCountry = safeCountryFromFragment(targetName);
      if (targetCountry.name) {
        base.target = targetCountry.name;
        base.targetCode = targetCountry.code;
      }
      base.locationOfEvent = targetName;
    }
  }

  const directActionMatch = text.match(
    /\b([a-zA-Z][a-zA-Z\s\-\(\)]{1,90})\s+(fires?|launch(?:es|ed)?|strikes?|bombs?|attacks?|invades?|deploys?)\s+(.+)/i
  );
  if (directActionMatch) {
    if (!base.actor) {
      const actorCountry = safeCountryFromFragment(directActionMatch[1]);
      if (actorCountry.name) {
        base.actor = actorCountry.name;
        base.actorCode = actorCountry.code;
      }
    }
    if (!base.actorAction) {
      base.actorAction = normalizeRoleText(directActionMatch[2], 72);
    }
    if (!base.target || !base.locationOfEvent) {
      const complementInfo = inferTargetLocationFromComplement(directActionMatch[3], base.target || "");
      if (!base.target && complementInfo.target) {
        base.target = complementInfo.target;
      }
      if (!base.locationOfEvent && complementInfo.locationOfEvent) {
        base.locationOfEvent = complementInfo.locationOfEvent;
      }
      if (base.target && !base.targetCode) {
        const targetCountry = safeCountryFromFragment(base.target);
        if (targetCountry.name) {
          base.target = targetCountry.name;
          base.targetCode = targetCountry.code;
        }
      }
    }
  }

  if (!base.actor && subjectCountry.name && ATTACK_NOUN_PATTERN.test(text)) {
    base.actor = subjectCountry.name;
    base.actorCode = subjectCountry.code;
  }

  if (!base.target && fallbackGeo?.countryInfo && !isUnknownCountryInfo(fallbackGeo.countryInfo)) {
    base.target = fallbackGeo.countryInfo.name;
    base.targetCode = fallbackGeo.countryInfo.code;
  }

  if (!base.locationOfEvent) {
    if (base.target) {
      base.locationOfEvent = base.target;
    } else if (fallbackGeo?.cityInfo?.name) {
      base.locationOfEvent = fallbackGeo.cityInfo.name;
    } else if (!isUnknownCountryInfo(fallbackGeo?.countryInfo)) {
      base.locationOfEvent = fallbackGeo.countryInfo.name;
    } else if (fallbackGeo?.strategicArea?.name) {
      base.locationOfEvent = fallbackGeo.strategicArea.name;
    }
  }

  const validated = validateRoleInversion(base, text, subjectCountry);
  return {
    actor: normalizeRoleText(validated.actor, 90),
    actorCode: normalizeRoleText(validated.actorCode, 8).toUpperCase(),
    actorAction: normalizeRoleText(validated.actorAction || inferActionFromText(text), 80),
    target: normalizeRoleText(validated.target, 110),
    targetCode: normalizeRoleText(validated.targetCode, 8).toUpperCase(),
    locationOfEvent: normalizeRoleText(validated.locationOfEvent, 140),
    context: normalizeRoleText(validated.context, 220),
    placementBasis: "unknown",
    validationNotes: normalizeRoleText(validated.validationNotes, 120)
  };
}

function countryInfoFromHint(value) {
  const normalized = normalizeCountryInfo(extractCountry(expandCountryAbbreviations(value)));
  if (isUnknownCountryInfo(normalized)) {
    return null;
  }
  return normalized;
}

function isCountryMentionedInArticle(countryInfo, articleText) {
  if (isUnknownCountryInfo(countryInfo)) {
    return false;
  }

  const mentions = extractCountryMentions(expandCountryAbbreviations(articleText), 10);
  const expectedCode = String(countryInfo?.code || "").toUpperCase();
  const expectedName = normalizeLocationLabel(countryInfo?.name || "");

  return mentions.some((mention) => {
    const mentionCode = String(mention?.code || "").toUpperCase();
    const mentionName = normalizeLocationLabel(mention?.name || "");
    if (expectedCode && mentionCode && expectedCode === mentionCode) {
      return true;
    }
    return Boolean(expectedName && mentionName && expectedName === mentionName);
  });
}

function isDiplomaticPlacementContext(articleText, eventRoles = null) {
  const text = String(articleText || "");
  if (DIPLOMATIC_PLACEMENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const action = lower(eventRoles?.actorAction || "");
  return /(condemn|protest|react|denounc|sanction|warn|inform|announce|brief|statement|communique|talk|meeting|summit)/.test(
    action
  );
}

function inferSpeakerCountry(articleText, eventRoles = null, fallbackGeo = null) {
  const actorCountry = safeCountryFromFragment(eventRoles?.actor || "");
  if (actorCountry.name) {
    return actorCountry;
  }

  const text = String(articleText || "");
  const speakerMatch = text.match(
    /\b([a-zA-Z][a-zA-Z\s\-\(\)\.]{1,90})\s+(informs?|briefs?|tells?|warns?|announces?|states?|says?|said|notifies?|addresses?)\b/i
  );
  if (speakerMatch) {
    const speakerCountry = safeCountryFromFragment(speakerMatch[1]);
    if (speakerCountry.name) {
      return speakerCountry;
    }
  }

  const headingSlice = text.split(/[,:;\-]/)[0];
  const headingCountry = safeCountryFromFragment(headingSlice);
  if (headingCountry.name) {
    return headingCountry;
  }

  const fallbackCountry = normalizeCountryInfo(fallbackGeo?.countryInfo);
  if (!isUnknownCountryInfo(fallbackCountry)) {
    return {
      name: fallbackCountry.name,
      code: fallbackCountry.code
    };
  }

  return { name: "", code: "" };
}

function resolveGeoFromEventRoles(articleText, fallbackGeo, eventRoles) {
  const base = fallbackGeo || resolveGeoSignals(articleText);
  const text = String(articleText || "");
  const locationText = normalizeRoleText(eventRoles?.locationOfEvent || eventRoles?.target || "", 180);
  const actorCountryHint = safeCountryFromFragment(eventRoles?.actor || "");
  const targetCountryHint = safeCountryFromFragment(eventRoles?.target || locationText);
  const hasBaseCity = Number.isFinite(base?.cityInfo?.lat) && Number.isFinite(base?.cityInfo?.lng);
  const hasBaseArea = Number.isFinite(base?.strategicArea?.lat) && Number.isFinite(base?.strategicArea?.lng);

  const withPlacementBasis = (geo, basis) => ({
    countryInfo: geo?.countryInfo || normalizeCountryInfo({}),
    cityInfo: geo?.cityInfo || null,
    strategicArea: geo?.strategicArea || null,
    geoMeta: {
      ...(geo?.geoMeta || {}),
      placementBasis: basis
    }
  });

  if (locationText) {
    const initialCountry = targetCountryHint?.name ? countryInfoFromHint(targetCountryHint.name) : null;
    const roleGeo = resolveGeoSignals(locationText, initialCountry);
    const hasValidRoleGeo = hasConcreteGeoSignal(roleGeo.countryInfo, roleGeo.cityInfo, roleGeo.strategicArea, roleGeo.geoMeta);
    if (hasValidRoleGeo) {
      return withPlacementBasis(roleGeo, "location_of_event");
    }
  }

  if (isDiplomaticPlacementContext(text, eventRoles)) {
    const speakerCountry = inferSpeakerCountry(text, eventRoles, base);
    const speakerCountryInfo = countryInfoFromHint(speakerCountry.name);
    if (speakerCountryInfo) {
      return withPlacementBasis(
        {
          countryInfo: speakerCountryInfo,
          cityInfo: null,
          strategicArea: null,
          geoMeta: base.geoMeta
        },
        "speaker_country"
      );
    }
  }

  if (
    actorCountryHint.name &&
    targetCountryHint.name &&
    normalizeLocationLabel(actorCountryHint.name) !== normalizeLocationLabel(targetCountryHint.name)
  ) {
    const targetCountryInfo = countryInfoFromHint(targetCountryHint.name);
    if (targetCountryInfo) {
      return withPlacementBasis(
        {
          countryInfo: targetCountryInfo,
          cityInfo: null,
          strategicArea: null,
          geoMeta: base.geoMeta
        },
        "target_country"
      );
    }
  }

  const baseCountry = normalizeCountryInfo(base?.countryInfo);
  if (!hasBaseCity && !hasBaseArea && !isUnknownCountryInfo(baseCountry) && !isCountryMentionedInArticle(baseCountry, text)) {
    const textCountryInfo = countryInfoFromHint(text);
    if (textCountryInfo) {
      return withPlacementBasis(
        {
          countryInfo: textCountryInfo,
          cityInfo: null,
          strategicArea: null,
          geoMeta: base.geoMeta
        },
        "text_country_fallback"
      );
    }
    return withPlacementBasis(
      {
        countryInfo: normalizeCountryInfo({
          name: "Inconnu",
          code: "XX",
          region: "Global",
          lat: 20,
          lng: 0
        }),
        cityInfo: null,
        strategicArea: null,
        geoMeta: base.geoMeta
      },
      "unknown_center"
    );
  }

  if (!hasBaseCity && !hasBaseArea && isUnknownCountryInfo(baseCountry)) {
    return withPlacementBasis(
      {
        countryInfo: normalizeCountryInfo({
          name: "Inconnu",
          code: "XX",
          region: "Global",
          lat: 20,
          lng: 0
        }),
        cityInfo: null,
        strategicArea: null,
        geoMeta: base.geoMeta
      },
      "unknown_center"
    );
  }

  return withPlacementBasis(base, "geo_fallback");
}

function includesAny(text, keywords = []) {
  const normalized = lower(text);
  return keywords.some((keyword) => normalized.includes(lower(keyword)));
}

function isCivilSpaceEvent(articleText) {
  const text = String(articleText || "");
  if (!includesAny(text, CIVIL_SPACE_KEYWORDS)) {
    return false;
  }
  return !includesAny(text, MILITARY_SPACE_CONTEXT_KEYWORDS);
}

function detectAiEventType(articleText, aiCategory = "") {
  const text = String(articleText || "");
  if (TERRAIN_EVENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "terrain_event";
  }
  if (DIPLOMATIC_PATTERNS.some((pattern) => pattern.test(text)) || lower(aiCategory) === "diplomatie") {
    return "diplomatic";
  }
  if (ACTION_EDITORIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return "press_return";
  }
  return hasActionSignal(text) ? "terrain_event" : "press_return";
}

function hasConcreteGeoSignal(countryInfo, cityInfo, strategicArea, geoMeta = null) {
  if (Number.isFinite(cityInfo?.lat) && Number.isFinite(cityInfo?.lng)) {
    return true;
  }
  if (Number.isFinite(strategicArea?.lat) && Number.isFinite(strategicArea?.lng)) {
    return true;
  }
  if (geoMeta?.isBorder) {
    return true;
  }
  if (geoMeta?.directionalHint && !isUnknownCountryInfo(countryInfo)) {
    return true;
  }
  return !isUnknownCountryInfo(countryInfo);
}

function isActionableEvent(articleText, geoSignals = {}, aiCategory = "") {
  const text = String(articleText || "");
  if (!text.trim()) {
    return false;
  }

  if (ACTION_EDITORIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  if (isCivilSpaceEvent(text)) {
    return false;
  }

  const eventType = detectAiEventType(text, aiCategory);
  if (eventType !== "terrain_event") {
    return false;
  }

  return hasConcreteGeoSignal(geoSignals.countryInfo, geoSignals.cityInfo, geoSignals.strategicArea, geoSignals.geoMeta);
}

function normalizeEventStatusLabel(value) {
  const normalized = lower(value);
  if (normalized === "confirmed" || normalized === "confirme") return "CONFIRME";
  if (normalized === "false" || normalized === "faux") return "FAUX";
  if (normalized === "probable") return "PROBABLE";
  return "NON CONFIRME";
}

function computeVerificationAssessment(alert, relatedAlerts = []) {
  const alerts = [alert, ...(Array.isArray(relatedAlerts) ? relatedAlerts : [])].filter(Boolean);
  const sourceFamilies = new Set(alerts.map((item) => normalizeSourceFamily(item?.sourceName || "")).filter(Boolean));
  const independentSources = Math.max(1, sourceFamilies.size);
  const confidence = confidenceScoreValueLike(alert);
  const credibilityBase = /(reuters|ap |associated press|bbc|guardian|al jazeera|france 24|@)/i.test(
    String(alert?.sourceName || "")
  )
    ? 2
    : 0;
  const score = Math.max(0, Math.min(10, Math.round((confidence / 14 + independentSources * 1.5 + credibilityBase) * 10) / 10));

  let status = "NON CONFIRME";
  if (independentSources >= 3 && score >= 7) {
    status = "CONFIRME";
  } else if (independentSources >= 2 && score >= 5) {
    status = "PROBABLE";
  } else if (score <= 2.5) {
    status = "FAUX";
  }

  const justification = `Sources independantes: ${independentSources}, confiance calculee: ${score}/10.`;
  return {
    status: normalizeEventStatusLabel(status),
    score,
    independentSources,
    primarySourceCredibility: credibilityBase > 0 ? "source_reconnue" : "source_a_confirmer",
    justification
  };
}

function confidenceScoreValueLike(alert) {
  const score = Number(alert?.confidenceScore);
  if (Number.isFinite(score)) {
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  return 35;
}

function resolveTelegramCountryInfo(rawAlert, articleText) {
  const declaredCountry = String(rawAlert?.country || "").trim();
  const declaredRegion = String(rawAlert?.region || "").trim();
  const declaredLat = Number(rawAlert?.lat);
  const declaredLng = Number(rawAlert?.lng);

  let countryInfo = extractCountry(`${declaredCountry} ${articleText}`.trim());
  if (!countryInfo || countryInfo.code === "XX") {
    countryInfo = {
      name: declaredCountry || "Inconnu",
      code: "XX",
      region: declaredRegion || "Global",
      lat: Number.isFinite(declaredLat) ? declaredLat : 20,
      lng: Number.isFinite(declaredLng) ? declaredLng : 0
    };
    return normalizeCountryInfo(countryInfo);
  }

  if (declaredRegion) {
    countryInfo.region = declaredRegion;
  }
  if (Number.isFinite(declaredLat)) {
    countryInfo.lat = declaredLat;
  }
  if (Number.isFinite(declaredLng)) {
    countryInfo.lng = declaredLng;
  }
  return normalizeCountryInfo(countryInfo);
}

const TYPE_KEYWORDS = {
  geopolitique: [
    "war",
    "invasion",
    "ceasefire",
    "border",
    "military",
    "army",
    "troops",
    "missile",
    "strike",
    "sanction",
    "diplomatic",
    "summit",
    "meeting",
    "meet",
    "talks",
    "trump",
    "putin",
    "poutine",
    "macron",
    "zelensky",
    "zelenskyy",
    "government",
    "president",
    "minister",
    "protest",
    "election",
    "geopolit",
    "coup",
    "rebels",
    "battle",
    "offensive",
    "shelling",
    "siege",
    "hostage",
    "insurgent"
  ]
};

const ACTION_FOCUS_TYPES = new Set(["geopolitique"]);

const ACTION_SIGNAL_PATTERNS = [
  /\bwar\b/i,
  /\binvasion\b/i,
  /\bconflict\b/i,
  /\bmissile\b/i,
  /\bairstrike\b/i,
  /\bdrone strike\b/i,
  /\bartillery\b/i,
  /\brocket(s)?\b/i,
  /\bexplosion(s)?\b/i,
  /\battack(ed|s|ing)?\b/i,
  /\bretaliat(e|ion|ed|ing)\b/i,
  /\bescalat(e|ion|ed|ing)\b/i,
  /\bclash(es)?\b/i,
  /\bambush\b/i,
  /\bcasualt(y|ies)\b/i,
  /\bkilled\b/i,
  /\bdead\b/i,
  /\bwounded\b/i,
  /\bsoldier(s)?\b/i,
  /\btroop(s)?\b/i,
  /\bhostage(s)?\b/i,
  /\bceasefire\b/i,
  /\bsanction(s)?\b/i,
  /\bstate of emergency\b/i,
  /\bmartial law\b/i,
  /\b(meet|meeting|summit|talks?|bilateral)\b.*\b(trump|putin|poutine|macron|zelensky|zelenskyy|xi jinping|netanyahu|erdogan|khamenei)\b/i,
  /\b(trump|putin|poutine|macron|zelensky|zelenskyy|xi jinping|netanyahu|erdogan|khamenei)\b.*\b(meet|meeting|summit|talks?|bilateral)\b/i,
  /\bmilitary base\b/i,
  /\bbase (hit|struck|destroyed|attacked)\b/i,
  /\bcommand center\b/i,
  /\boffensive\b/i,
  /\bshelling\b/i,
  /\bsiege\b/i,
  /\binsurgent(s)?\b/i,
  /\brebel(s)?\b/i
];

const DIRECT_COMBAT_PATTERNS = [
  /\bmissile(s)?\b/i,
  /\bairstrike(s)?\b/i,
  /\bair raid(s)?\b/i,
  /\bdrone strike(s)?\b/i,
  /\bartillery\b/i,
  /\brocket fire\b/i,
  /\bshelling\b/i,
  /\bbattle(field)?\b/i,
  /\bmilitary base\b/i,
  /\bbase (hit|struck|destroyed|attacked)\b/i,
  /\b(soldier|troop|civilian)(s)? (killed|dead|wounded)\b/i,
  /\bcasualt(y|ies)\b/i,
  /\bdeath toll\b/i,
  /\bnuclear (explosion|blast|detonation|plant|reactor|facility)\b/i
];

const CONFIRM_WINDOW_HOURS = 6;
const MAX_CONFIRM_SCAN = 140;
const EVENT_CLUSTER_WINDOW_HOURS = 2;
const EVENT_CLUSTER_DISTANCE_KM = 50;
const MIN_EVENT_SIMILARITY = 0.65;
const MIN_EVENT_SIMILARITY_WITH_CASUALTY = 0.52;
const MIN_TITLE_SIMILARITY = 0.65;
const MIN_TITLE_SIMILARITY_WITH_CASUALTY = 0.48;
const MIN_TITLE_SHARED_TOKENS = 3;
const DUPLICATE_SCAN_HOURS = 8;
const MAX_DUPLICATE_SCAN = 120;
const DUPLICATE_TITLE_SIMILARITY = 0.82;
const DUPLICATE_TOKEN_SIMILARITY = 0.72;
const DEFAULT_MAX_EVENT_AGE_MINUTES_INSIGHT = 180;
const DEFAULT_MAX_EVENT_AGE_MINUTES_ACTION = 30;
const CLUSTER_AUDIT_LOG = readBooleanEnv("CLUSTER_AUDIT_LOG", false);

const ACTION_EDITORIAL_PATTERNS = [
  /\bthrowback\b/i,
  /\bflashback\b/i,
  /\banniversary\b/i,
  /\bdecades? ago\b/i,
  /\bin\s(19|20)\d{2}\b/i,
  /\bopinion\b/i,
  /\banalysis\b/i,
  /\bexplained\b/i,
  /\bthe story of\b/i,
  /\bhow [a-z0-9\s]{3,80} saved\b/i,
  /\beditorial\b/i,
  /\blong read\b/i,
  /\bmagazine\b/i,
  /\bcommentary\b/i,
  /\bretrospective\b/i
];

const DIPLOMATIC_PATTERNS = [
  /\bmeeting\b/i,
  /\bsummit\b/i,
  /\bjoint statement\b/i,
  /\bcommunique\b/i,
  /\bdeclaration\b/i,
  /\btalks?\b/i,
  /\bnegotiation\b/i,
  /\bceasefire proposal\b/i
];

const DIPLOMATIC_PLACEMENT_PATTERNS = [
  /\bcongress\b/i,
  /\bsenate\b/i,
  /\bparliament\b/i,
  /\blawmakers\b/i,
  /\blegislators\b/i,
  /\bbriefing\b/i,
  /\bbriefs?\b/i,
  /\binforms?\b/i,
  /\bannounces?\b/i,
  /\bstatement\b/i,
  /\bwarns?\b/i,
  /\bcondemns?\b/i,
  /\bdenounces?\b/i,
  /\bprotests?\b/i
];

const TERRAIN_EVENT_PATTERNS = [
  /\bstrike\b/i,
  /\bairstrike\b/i,
  /\bexplosion\b/i,
  /\bdetonation\b/i,
  /\bdrone\b/i,
  /\bmissile\b/i,
  /\bartillery\b/i,
  /\btroops?\b/i,
  /\bdeployment\b/i,
  /\braid\b/i,
  /\barrest(ed|ation)?\b/i,
  /\bkilled\b/i,
  /\bwounded\b/i,
  /\bborder clash\b/i,
  /\bfrontline\b/i
];

const CIVIL_SPACE_KEYWORDS = [
  "spacex",
  "falcon 9",
  "starship",
  "ariane",
  "ariane 6",
  "launch vehicle",
  "satellite launch",
  "iss",
  "international space station",
  "nasa",
  "esa",
  "jaxa",
  "civil rocket launch",
  "commercial launch",
  "space mission"
];

const MILITARY_SPACE_CONTEXT_KEYWORDS = [
  "icbm",
  "ballistic missile",
  "warhead",
  "military payload",
  "nuclear payload",
  "strategic forces",
  "defense ministry",
  "weapon test"
];

const DIRECTION_PATTERN_MAP = [
  { key: "north", regex: /\b(north|northern|nord|septentrional)\b/i },
  { key: "south", regex: /\b(south|southern|sud|meridional)\b/i },
  { key: "east", regex: /\b(east|eastern|est|oriental)\b/i },
  { key: "west", regex: /\b(west|western|ouest|occidental)\b/i }
];

const ACTOR_ACTION_VERB_PATTERN = /\b(fires?|launch(?:es|ed)?|strikes?|bombs?|attacks?|invades?|deploys?|bombing|shelling|raid(s)?|offensive)\b/i;
const OBSERVER_VERB_PATTERN =
  /\b(condemns?|protests?|reacts?\s+to|denounces?|sanctions?|retaliates?|intercepts?|was hit by|suffered)\b/i;
const ATTACK_NOUN_PATTERN =
  /\b(missile strike|missile attack|drone strike|drone attack|bombing|airstrike|strike|attack|shelling|offensive|troop movements?)\b/i;

const TOKEN_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "has",
  "had",
  "its",
  "their",
  "into",
  "amid",
  "after",
  "before",
  "during",
  "says",
  "said",
  "report",
  "reports",
  "reported",
  "breaking",
  "about",
  "against",
  "over",
  "under",
  "also",
  "more",
  "than",
  "into",
  "les",
  "des",
  "dans",
  "pour",
  "avec",
  "une",
  "sur",
  "apres",
  "depuis",
  "toujours",
  "live",
  "news",
  "update",
  "updates",
  "world",
  "today"
]);

function canonicalType(type) {
  const normalized = lower(type);
  if (normalized === "espace_civil" || normalized === "space_civil") {
    return "espace_civil";
  }
  if (normalized === "politique" || normalized === "militaire" || normalized === "geopolitique") {
    return "geopolitique";
  }
  return "autre";
}

function hasActionSignal(text) {
  return ACTION_SIGNAL_PATTERNS.some((pattern) => pattern.test(text || ""));
}

function hasDirectCombatSignal(text) {
  return DIRECT_COMBAT_PATTERNS.some((pattern) => pattern.test(text || ""));
}

function isConflictAlert(text) {
  return hasActionSignal(text);
}

function isActionableAlert(type, severity, text) {
  const normalizedType = canonicalType(type);
  const normalizedSeverity = lower(severity);

  if (!ACTION_FOCUS_TYPES.has(normalizedType) && normalizedType !== "espace_civil") {
    return false;
  }

  if (normalizedSeverity === "critical" || normalizedSeverity === "high") {
    return true;
  }

  return hasDirectCombatSignal(text) || hasActionSignal(text);
}

function lower(value) {
  return (value || "").toLowerCase();
}

function resolveMaxAgeMinutes(settings) {
  const mode = String(settings?.alertMode || "insight")
    .trim()
    .toLowerCase();

  const fallback = mode === "action" ? DEFAULT_MAX_EVENT_AGE_MINUTES_ACTION : DEFAULT_MAX_EVENT_AGE_MINUTES_INSIGHT;
  const envVar = mode === "action" ? process.env.MAX_EVENT_AGE_MINUTES_ACTION : process.env.MAX_EVENT_AGE_MINUTES_INSIGHT;
  const envValue = Number(envVar);

  if (Number.isFinite(envValue) && envValue >= 5 && envValue <= 24 * 60) {
    return envValue;
  }

  return fallback;
}

function parsePublishedAt(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function isEventTooOld(publishedAt, maxAgeMinutes) {
  if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
    return false;
  }

  const ageMs = Date.now() - publishedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return false;
  }

  return ageMs > maxAgeMinutes * 60 * 1000;
}

function inferSourceName(item, title) {
  const fallback = item?.feed?.sourceName || "Source inconnue";
  const isGoogleFeed = lower(fallback).includes("google news");

  if (isGoogleFeed) {
    const parts = String(title || "")
      .split(" - ")
      .map((part) => part.trim())
      .filter(Boolean);
    const candidate = parts.length > 1 ? parts[parts.length - 1] : "";
    if (candidate && candidate.length <= 80) {
      return candidate;
    }
  }

  const creator = [item?.creator, item?.author].find((value) => typeof value === "string" && value.trim());
  if (creator) {
    return creator.trim();
  }

  return fallback;
}

function toTokenSet(text) {
  const normalized = lower(text).replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token));
  return new Set(tokens);
}

function normalizeComparableTitle(title) {
  const raw = String(title || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!raw) {
    return "";
  }

  const parts = raw
    .split(" - ")
    .map((part) => part.trim())
    .filter(Boolean);

  // Remove short publisher-like tail segment ("... - Reuters", "... - CNN").
  if (parts.length >= 2) {
    const tail = lower(parts[parts.length - 1]);
    const tailWords = tail.split(/\s+/).filter(Boolean);
    const looksLikePublisherTail =
      tail.length <= 44 &&
      tailWords.length <= 6 &&
      !/(missile|strike|attack|war|drone|troop|killed|dead|wounded|explosion|raid|base|iran|israel|ukraine|russia)/.test(
        tail
      );

    if (looksLikePublisherTail) {
      parts.pop();
    }
  }

  return lower(parts.join(" - "))
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardSimilarity(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function tokenIntersectionCount(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  return intersection;
}

function getAlertCoordinates(alert) {
  const cityLat = Number(alert?.city?.lat);
  const cityLng = Number(alert?.city?.lng);
  if (Number.isFinite(cityLat) && Number.isFinite(cityLng)) {
    return { lat: cityLat, lng: cityLng };
  }

  const lng = Number(alert?.location?.coordinates?.[0]);
  const lat = Number(alert?.location?.coordinates?.[1]);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }

  const fallbackLat = Number(alert?.country?.lat);
  const fallbackLng = Number(alert?.country?.lng);
  if (Number.isFinite(fallbackLat) && Number.isFinite(fallbackLng)) {
    return { lat: fallbackLat, lng: fallbackLng };
  }

  return { lat: 20, lng: 0 };
}

function haversineDistanceKm(a, b) {
  const lat1 = Number(a?.lat);
  const lon1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lon2 = Number(b?.lng);
  if (![lat1, lon1, lat2, lon2].every((value) => Number.isFinite(value))) {
    return Number.POSITIVE_INFINITY;
  }

  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const aVal =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(p1) * Math.cos(p2);
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return R * c;
}

function eventTimestampMs(alert) {
  const ts = new Date(alert?.occurredAt || alert?.publishedAt || alert?.createdAt || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function eventSimilarityScore(baseEvent, candidateEvent) {
  const titleSimilarity = jaccardSimilarity(baseEvent?.titleTokens, candidateEvent?.titleTokens);
  const bodySimilarity = jaccardSimilarity(baseEvent?.tokens, candidateEvent?.tokens);
  const shared = tokenIntersectionCount(baseEvent?.titleTokens, candidateEvent?.titleTokens);
  const weighted = Math.max(titleSimilarity * 0.68 + bodySimilarity * 0.32, shared >= 3 ? titleSimilarity : 0);
  return Math.max(0, Math.min(1, Number(weighted.toFixed(4))));
}

function buildEventSignature(alertLike) {
  const title = String(alertLike?.title || "");
  const summary = String(alertLike?.summary || "");
  const normalizedTitle = normalizeComparableTitle(title);
  const fullText = `${title} ${summary}`.trim();

  return {
    incidentClass: classifyIncidentClass(fullText),
    tokens: toTokenSet(`${normalizedTitle} ${summary}`.trim()),
    titleTokens: toTokenSet(normalizedTitle),
    normalizedTitle,
    casualtyCount: extractCasualtyCount(fullText)
  };
}

function extractCasualtyCount(text) {
  const match = lower(text).match(/\b(\d{1,4})\s+(killed|dead|wounded|injured|casualties|morts?|blesses?)\b/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function classifyIncidentClass(text) {
  const content = lower(text);

  if (isCivilSpaceEvent(content)) {
    return "space-civil";
  }
  if (
    /nuclear (strike|explosion|blast|detonation)|atomic blast|atomic explosion|detonation nucleaire|explosion nucleaire/.test(
      content
    )
  ) {
    return "nuclear-attack";
  }
  if (/nuclear (weapon|warhead|test|arsenal|doctrine|enrichment|submarine)/.test(content)) {
    return "nuclear-armament";
  }
  if (/airstrike|air raid|aerial bombardment|drone strike|raid aerien|frappe aerienne/.test(content)) {
    return "air";
  }
  if (/missile|rocket|ballistic|hypersonic/.test(content)) {
    return "missile";
  }
  if (/military base|base (hit|struck|destroyed|attacked)|command center/.test(content)) {
    return "base";
  }
  if (/soldier|troop|civilian|killed|dead|wounded|casualt|death toll/.test(content)) {
    return "casualty";
  }
  if (/artillery|shelling|frontline|battlefield|offensive|clash/.test(content)) {
    return "battle";
  }

  return "conflict";
}

function isIncidentClassCompatible(baseClass, candidateClass) {
  if (!baseClass || !candidateClass) {
    return false;
  }
  if (baseClass === candidateClass) {
    return true;
  }
  return baseClass === "conflict" || candidateClass === "conflict";
}

function normalizeSourceFamily(sourceName) {
  const normalized = lower(sourceName)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(news|media|digital|online|edition|network|group|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || "unknown";
}

function severityRank(severity) {
  return (
    {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4
    }[lower(severity)] || 2
  );
}

function computeConfidenceScore(clusterAlerts, sourceFamilyCount) {
  const maxSeverity = clusterAlerts.reduce(
    (maxRank, alert) => Math.max(maxRank, severityRank(alert?.severity)),
    1
  );
  const hasDirectCombat = clusterAlerts.some((alert) =>
    hasDirectCombatSignal(`${alert?.title || ""} ${alert?.summary || ""}`)
  );

  let score = 16;
  score += Math.max(1, sourceFamilyCount) * 12;
  score += maxSeverity * 5;
  if (hasDirectCombat) {
    score += 8;
  }
  score += Math.min(3, Math.max(0, clusterAlerts.length - 1)) * 4;

  // Penalize single-source claims: severity can stay high, but certainty should remain lower
  // until at least one independent source corroborates the event.
  if (sourceFamilyCount <= 1) {
    score -= 22;
    if (maxSeverity >= 4 && hasDirectCombat) {
      score += 6;
    }
  } else if (sourceFamilyCount >= 3) {
    score += 6;
    if (sourceFamilyCount >= 4) {
      score += 4;
    }
  }

  return Math.max(15, Math.min(99, Math.round(score)));
}

function areLikelySameEvent(baseEvent, candidateEvent, baseAlert = null, candidateAlert = null) {
  const semanticScore = eventSimilarityScore(baseEvent, candidateEvent);

  if (!isIncidentClassCompatible(baseEvent.incidentClass, candidateEvent.incidentClass)) {
    return { match: false, score: semanticScore, reason: "incident_class_mismatch" };
  }

  if (baseAlert && candidateAlert) {
    const baseTs = eventTimestampMs(baseAlert);
    const candidateTs = eventTimestampMs(candidateAlert);
    if (baseTs > 0 && candidateTs > 0) {
      const diffHours = Math.abs(candidateTs - baseTs) / (1000 * 60 * 60);
      if (diffHours > EVENT_CLUSTER_WINDOW_HOURS) {
        return { match: false, score: semanticScore, reason: "outside_time_window" };
      }
    }

    const distanceKm = haversineDistanceKm(getAlertCoordinates(baseAlert), getAlertCoordinates(candidateAlert));
    if (Number.isFinite(distanceKm) && distanceKm > EVENT_CLUSTER_DISTANCE_KM) {
      return { match: false, score: semanticScore, reason: "outside_geo_radius" };
    }
  }

  const hasExactTitleMatch =
    Boolean(baseEvent?.normalizedTitle) &&
    Boolean(candidateEvent?.normalizedTitle) &&
    baseEvent.normalizedTitle === candidateEvent.normalizedTitle;
  if (hasExactTitleMatch) {
    return { match: true, score: 1, reason: "exact_title_match" };
  }

  const titleSimilarity = jaccardSimilarity(baseEvent.titleTokens, candidateEvent.titleTokens);
  const titleSharedTokens = tokenIntersectionCount(baseEvent.titleTokens, candidateEvent.titleTokens);
  const hasStrongTitleMatch = titleSimilarity >= MIN_TITLE_SIMILARITY && titleSharedTokens >= MIN_TITLE_SHARED_TOKENS;

  if (hasStrongTitleMatch && semanticScore >= MIN_EVENT_SIMILARITY) {
    return { match: true, score: semanticScore, reason: "strong_title_and_semantic" };
  }

  const similarity = jaccardSimilarity(baseEvent.tokens, candidateEvent.tokens);
  if (similarity >= MIN_EVENT_SIMILARITY) {
    return { match: true, score: semanticScore, reason: "semantic_match" };
  }

  const hasSameCasualtyCount =
    Number.isFinite(baseEvent.casualtyCount) &&
    Number.isFinite(candidateEvent.casualtyCount) &&
    baseEvent.casualtyCount === candidateEvent.casualtyCount;

  const casualtyMatch =
    hasSameCasualtyCount &&
    (similarity >= MIN_EVENT_SIMILARITY_WITH_CASUALTY ||
      (titleSimilarity >= MIN_TITLE_SIMILARITY_WITH_CASUALTY && titleSharedTokens >= 2));

  if (casualtyMatch) {
    return { match: true, score: semanticScore, reason: "casualty_match" };
  }

  return { match: false, score: semanticScore, reason: "semantic_below_threshold" };
}

function isLikelyDuplicateFromSameSource(incomingPayload, existingAlert) {
  const incomingFamily = normalizeSourceFamily(incomingPayload?.sourceName || "");
  const existingFamily = normalizeSourceFamily(existingAlert?.sourceName || "");
  if (
    !incomingFamily ||
    !existingFamily ||
    incomingFamily === "unknown" ||
    existingFamily === "unknown" ||
    incomingFamily !== existingFamily
  ) {
    return false;
  }

  const incomingEvent = buildEventSignature(incomingPayload);
  const existingEvent = buildEventSignature(existingAlert);

  if (incomingEvent.normalizedTitle && incomingEvent.normalizedTitle === existingEvent.normalizedTitle) {
    return true;
  }

  const titleSimilarity = jaccardSimilarity(incomingEvent.titleTokens, existingEvent.titleTokens);
  const titleSharedTokens = tokenIntersectionCount(incomingEvent.titleTokens, existingEvent.titleTokens);
  if (titleSimilarity >= DUPLICATE_TITLE_SIMILARITY && titleSharedTokens >= MIN_TITLE_SHARED_TOKENS) {
    return true;
  }

  const bodySimilarity = jaccardSimilarity(incomingEvent.tokens, existingEvent.tokens);
  return titleSimilarity >= 0.68 && bodySimilarity >= DUPLICATE_TOKEN_SIMILARITY;
}

async function findRecentDuplicateAlert(payload) {
  const referenceDate =
    payload?.publishedAt instanceof Date && !Number.isNaN(payload.publishedAt.getTime()) ? payload.publishedAt : new Date();
  const sinceDate = new Date(referenceDate.getTime() - DUPLICATE_SCAN_HOURS * 60 * 60 * 1000);

  const countryQuery =
    payload?.country?.code && payload.country.code !== "XX"
      ? { "country.code": payload.country.code }
      : { "country.name": payload?.country?.name || "Inconnu" };

  const candidates = await Alert.find({
    type: { $in: ["geopolitique", "espace_civil"] },
    ...countryQuery,
    $or: [{ publishedAt: { $gte: sinceDate } }, { createdAt: { $gte: sinceDate } }]
  })
    .sort({ publishedAt: -1, createdAt: -1, _id: -1 })
    .limit(MAX_DUPLICATE_SCAN)
    .lean();

  for (const candidate of candidates) {
    if (isLikelyDuplicateFromSameSource(payload, candidate)) {
      return candidate;
    }
  }

  return null;
}

async function enrichConfirmationForAlert(alertDoc) {
  const baseAlert = alertDoc.toObject ? alertDoc.toObject() : alertDoc;
  const baseEvent = buildEventSignature(baseAlert);

  const referenceDate = new Date(baseAlert?.publishedAt || baseAlert?.createdAt || new Date());
  const sinceDate = new Date(referenceDate.getTime() - CONFIRM_WINDOW_HOURS * 60 * 60 * 1000);

  const countryQuery =
    baseAlert?.country?.code && baseAlert.country.code !== "XX"
      ? { "country.code": baseAlert.country.code }
      : { "country.name": baseAlert?.country?.name || "Inconnu" };

  const candidates = await Alert.find({
    _id: { $ne: baseAlert._id },
    type: { $in: ["geopolitique", "espace_civil"] },
    ...countryQuery,
    publishedAt: { $gte: sinceDate }
  })
    .sort({ publishedAt: -1 })
    .limit(MAX_CONFIRM_SCAN)
    .lean();

  const cluster = [baseAlert];

  for (const candidate of candidates) {
    const candidateEvent = buildEventSignature(candidate);
    const decision = areLikelySameEvent(baseEvent, candidateEvent, baseAlert, candidate);

    if (CLUSTER_AUDIT_LOG) {
      console.log(
        "[cluster-audit]",
        JSON.stringify({
          anchorId: String(baseAlert?._id || ""),
          candidateId: String(candidate?._id || ""),
          match: decision.match,
          score: decision.score,
          reason: decision.reason
        })
      );
    }

    if (decision.match) {
      cluster.push(candidate);
    }
  }

  const sourceNames = Array.from(new Set(cluster.map((alert) => (alert?.sourceName || "").trim()).filter(Boolean)));
  const sourceFamilies = new Set(sourceNames.map((name) => normalizeSourceFamily(name)).filter(Boolean));

  const sourceCount = Math.max(1, sourceFamilies.size);
  const confirmed = sourceCount >= 2;
  const confidenceScore = computeConfidenceScore(cluster, sourceCount);
  const eventGroupId =
    cluster
      .map((alert) => String(alert?._id || ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))[0] || String(baseAlert._id);

  const clusterIds = cluster.map((alert) => alert._id);
  const updatePayload = {
    confirmed,
    confidenceScore,
    sourceCount,
    sourceNames,
    eventGroupId
  };

  await Alert.updateMany({ _id: { $in: clusterIds } }, { $set: updatePayload });
  const updatedAlerts = await Alert.find({ _id: { $in: clusterIds } }).lean();

  const shouldBroadcastClusterUpdate = updatedAlerts.length > 1 || confirmed || sourceCount > 1;
  if (shouldBroadcastClusterUpdate && updatedAlerts.length > 0) {
    streamService.sendEvent("alerts-confirmation-updated", { alerts: updatedAlerts });
  }

  const updatedBase = updatedAlerts.find((alert) => String(alert._id) === String(baseAlert._id));
  return updatedBase || { ...baseAlert, ...updatePayload };
}

async function findRelatedAlertsForAnchor(anchorAlert, options = {}) {
  if (!anchorAlert?._id) {
    return [];
  }

  const limit = Math.min(30, Math.max(2, Number(options?.limit) || 12));
  const anchorId = String(anchorAlert._id);
  const eventGroupId = String(anchorAlert.eventGroupId || "").trim();
  const anchorEvent = buildEventSignature(anchorAlert);

  const related = [];
  const seen = new Set();

  const pushUnique = (alert, similarityScore = null) => {
    const id = String(alert?._id || "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    const mapped = similarityScore === null ? alert : { ...alert, similarityScore };
    related.push(mapped);
  };

  if (eventGroupId) {
    const grouped = await Alert.find({
      type: { $in: ["geopolitique", "espace_civil"] },
      eventGroupId
    })
      .sort({ occurredAt: -1, publishedAt: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();
    grouped.forEach((candidate) => {
      const score = eventSimilarityScore(anchorEvent, buildEventSignature(candidate));
      pushUnique(candidate, score);
    });
  }

  if (related.length < limit) {
    const referenceDate = new Date(anchorAlert?.publishedAt || anchorAlert?.createdAt || new Date());
    const sinceDate = new Date(referenceDate.getTime() - CONFIRM_WINDOW_HOURS * 60 * 60 * 1000);
    const countryQuery =
      anchorAlert?.country?.code && anchorAlert.country.code !== "XX"
        ? { "country.code": anchorAlert.country.code }
        : { "country.name": anchorAlert?.country?.name || "Inconnu" };

    const candidates = await Alert.find({
      _id: { $ne: anchorAlert._id },
      type: { $in: ["geopolitique", "espace_civil"] },
      ...countryQuery,
      publishedAt: { $gte: sinceDate }
    })
      .sort({ occurredAt: -1, publishedAt: -1, createdAt: -1, _id: -1 })
      .limit(MAX_CONFIRM_SCAN)
      .lean();

    for (const candidate of candidates) {
      if (related.length >= limit) break;
      if (seen.has(String(candidate?._id || ""))) continue;
      const decision = areLikelySameEvent(anchorEvent, buildEventSignature(candidate), anchorAlert, candidate);
      if (decision.match) {
        pushUnique(candidate, decision.score);
      }
    }
  }

  const hasAnchor = seen.has(anchorId);
  if (!hasAnchor) {
    related.unshift({ ...anchorAlert, similarityScore: 1 });
  }

  return related.slice(0, limit);
}

function classifyType(text, fallbackType) {
  const content = lower(text);

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some((keyword) => content.includes(keyword))) {
      return type;
    }
  }

  return fallbackType || "geopolitique";
}

function isFallbackGeoCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return true;
  }
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  return Math.abs(lat - 20) < 0.0001 && Math.abs(lng) < 0.0001;
}

function classifySeverity(text) {
  const content = lower(text);

  if (
    /war|invasion|mass casualty|genocide|chemical|nuclear explosion|atomic blast|major attack|state of emergency|military base destroyed/.test(
      content
    )
  ) {
    return "critical";
  }

  if (
    /missile|airstrike|drone strike|artillery|shelling|bomb|base hit|base attacked|killed|dead|wounded|casualt|urgent|severe|high risk/.test(
      content
    )
  ) {
    return "high";
  }

  if (/warning|alert|threat|clash|protest|disruption|advisory/.test(content)) {
    return "medium";
  }

  return "low";
}

function normalizeArray(values) {
  return (values || [])
    .map((v) => (v || "").trim())
    .filter(Boolean)
    .map((v) => v.toLowerCase());
}

function matchesSettingsFilters(articleText, countryInfo, settings) {
  // Global coverage is the default: ingest all detected conflict signals.
  // Focused filters are applied only when users explicitly disable global coverage.
  if (settings?.globalCoverage !== false) {
    return true;
  }

  const keywords = normalizeArray(settings.keywordFilters);
  const countries = normalizeArray(settings.countryFilters);

  if (keywords.length > 0) {
    const text = lower(articleText);
    const hasKeyword = keywords.some((keyword) => text.includes(keyword));
    if (!hasKeyword) {
      return false;
    }
  }

  if (countries.length > 0) {
    const currentCountry = lower(countryInfo.name);
    const matchesCountry = countries.some((country) => currentCountry === country);
    if (!matchesCountry) {
      return false;
    }
  }

  return true;
}

async function fetchFeedItems(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).slice(0, 40).map((item) => ({ ...item, feed }));
  } catch (error) {
    console.warn(`[feeds] Echec ${feed.sourceName}: ${error.message}`);
    return [];
  }
}

function parseGdeltDate(seenDate) {
  const input = String(seenDate || "");
  const match = input.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildGdeltUrl(stream) {
  const params = new URLSearchParams({
    query: stream.query,
    mode: "ArtList",
    format: "json",
    sort: "DateDesc",
    maxrecords: String(stream.maxRecords || 40)
  });

  return `${GDELT_ENDPOINT}?${params.toString()}`;
}

async function fetchGdeltItems(stream) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(buildGdeltUrl(stream), {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Status code ${response.status}`);
    }

    const payload = await response.json();
    const articles = Array.isArray(payload.articles) ? payload.articles : [];

    return articles.slice(0, stream.maxRecords || 40).map((article) => {
      const seendate = parseGdeltDate(article.seendate);
      const snippet = [article.domain, article.sourcecountry, seendate].filter(Boolean).join(" | ");

      return {
        title: article.title || "",
        link: article.url || "",
        contentSnippet: snippet,
        isoDate: seendate,
        feed: {
          sourceName: stream.sourceName,
          fallbackType: "geopolitique"
        }
      };
    });
  } catch (error) {
    console.warn(`[feeds] Echec ${stream.sourceName}: ${error.message}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTelegramAlertPayloads(settings, maxAgeMinutes) {
  const backendBaseUrl = resolveTelegramBackendBaseUrl();
  if (!backendBaseUrl) {
    return [];
  }

  const now = Date.now();
  if (now < telegramSyncCooldownUntilMs) {
    const cacheAge = now - telegramSyncCacheAtMs;
    if (telegramSyncCache.length > 0 && cacheAge <= TELEGRAM_SYNC_CACHE_MAX_AGE_MS) {
      return telegramSyncCache;
    }
    return [];
  }

  if (telegramSyncCache.length > 0 && now - telegramSyncLastFetchAtMs < TELEGRAM_SYNC_MIN_INTERVAL_MS) {
    return telegramSyncCache;
  }

  const endpoint = `${backendBaseUrl}/api/alerts?source_type=telegram&limit=${resolveTelegramFetchLimit()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_SYNC_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfterRaw = response.headers.get("retry-after");
        let retryAfterSeconds = Number.parseInt(retryAfterRaw || "", 10);
        if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
          retryAfterSeconds = Math.ceil(TELEGRAM_SYNC_MIN_INTERVAL_MS / 1000);
        }
        telegramSyncCooldownUntilMs = Date.now() + Math.max(retryAfterSeconds, 15) * 1000;
      }
      throw new Error(`Status code ${response.status}`);
    }

    const payload = await response.json();
    const telegramAlerts = Array.isArray(payload?.alerts) ? payload.alerts : [];

    const mapped = [];
    const normalizeAiList = (value) => {
      if (Array.isArray(value)) {
        return value.map((item) => String(item || "").trim()).filter(Boolean);
      }
      const raw = String(value || "").trim();
      if (!raw) {
        return [];
      }
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item || "").trim()).filter(Boolean);
        }
      } catch (_) {
        // Ignore JSON parse errors and fallback to CSV split.
      }
      return raw
        .split(/[,\n;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    };

    for (const rawAlert of telegramAlerts) {
      const title = String(rawAlert?.title || "").trim();
      if (!title) {
        continue;
      }

      const summary = String(rawAlert?.original_text || rawAlert?.summary || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2800);

      const articleText = `${title} ${summary}`.trim();
      const telegramCountryInfo = resolveTelegramCountryInfo(rawAlert, articleText);
      const fallbackGeo = resolveGeoSignals(articleText, telegramCountryInfo);
      const aiRoleSeed = {
        actor: String(rawAlert?.event_actor || rawAlert?.ai_actor || rawAlert?.actor || "").trim(),
        actorCode: String(rawAlert?.event_actor_code || rawAlert?.ai_actor_code || "").trim().toUpperCase(),
        actorAction: String(rawAlert?.event_actor_action || rawAlert?.ai_actor_action || "").trim(),
        target: String(rawAlert?.event_target || rawAlert?.ai_target || rawAlert?.target || "").trim(),
        targetCode: String(rawAlert?.event_target_code || rawAlert?.ai_target_code || "").trim().toUpperCase(),
        locationOfEvent: String(rawAlert?.event_location || rawAlert?.location_of_event || "").trim(),
        context: String(rawAlert?.event_context || rawAlert?.context || "").trim()
      };
      const eventRoles = buildEventRoles(articleText, fallbackGeo, aiRoleSeed);
      const roleGeo = resolveGeoFromEventRoles(articleText, fallbackGeo, eventRoles);
      const { countryInfo, cityInfo, strategicArea, geoMeta } = roleGeo;

      if (!matchesSettingsFilters(articleText, countryInfo, settings)) {
        continue;
      }

      const parsedPublishedAt = parsePublishedAt(rawAlert?.timestamp);
      if (parsedPublishedAt && isEventTooOld(parsedPublishedAt, maxAgeMinutes)) {
        continue;
      }
      const publishedAt = parsedPublishedAt || new Date();

      const civilSpace = isCivilSpaceEvent(articleText);
      if (civilSpace && settings?.includeSpaceCivil !== true) {
        continue;
      }

      const canonicalAlertType = civilSpace ? "espace_civil" : canonicalType(String(rawAlert?.type || "geopolitique"));
      if (canonicalAlertType !== "geopolitique" && canonicalAlertType !== "espace_civil") {
        continue;
      }

      const aiCategoryNormalized = String(rawAlert?.ai_category || rawAlert?.aiCategory || "").trim().toLowerCase();
      const aiEventTypeRaw = String(rawAlert?.ai_event_type || rawAlert?.aiEventType || "").trim().toLowerCase();
      const aiEventType =
        aiEventTypeRaw === "terrain_event" || aiEventTypeRaw === "press_return" || aiEventTypeRaw === "diplomatic"
          ? aiEventTypeRaw
          : detectAiEventType(articleText, aiCategoryNormalized);
      const severity = normalizeTelegramSeverity(rawAlert?.severity, articleText);
      const actionable =
        aiEventType === "terrain_event" &&
        isActionableEvent(articleText, { countryInfo, cityInfo, strategicArea, geoMeta }, aiCategoryNormalized);

      if (String(settings?.alertMode || "insight").trim().toLowerCase() === "action" && !actionable) {
        continue;
      }

      const sourceName = normalizeTelegramSourceName(rawAlert?.source_channel);
      const sourceUrl = buildTelegramSourceUrl(rawAlert, sourceName, backendBaseUrl);
      const rawLat = Number(rawAlert?.lat);
      const rawLng = Number(rawAlert?.lng);
      const marker = computeMarkerCoordinates({
        cityInfo,
        strategicArea,
        countryInfo,
        rawLat,
        rawLng,
        allowRawOverride: (geoMeta?.placementBasis || "") === "geo_fallback",
        applyDirection: true,
        directionalHint: geoMeta?.directionalHint || ""
      });
      eventRoles.placementBasis = geoMeta?.placementBasis || "geo_fallback";

      mapped.push({
        title,
        summary,
        sourceName,
        sourceUrl,
        publishedAt,
        occurredAt: parsePublishedAt(rawAlert?.timestamp) || null,
        occurredAtSource: "telegram",
        type: canonicalAlertType,
        incidentClass: civilSpace ? "space-civil" : classifyIncidentClass(articleText),
        severity,
        actionable,
        aiEventType,
        spaceCivil: civilSpace,
        confirmed: false,
        confidenceScore: clampConfidence(rawAlert?.confidence),
        sourceCount: 1,
        sourceNames: [sourceName],
        aiAnalyzed: Boolean(rawAlert?.ai_analyzed ?? rawAlert?.aiAnalyzed),
        aiCategory: aiCategoryNormalized,
        aiSubcategories: normalizeAiList(rawAlert?.ai_subcategories ?? rawAlert?.aiSubcategories),
        aiSeverity: String(rawAlert?.ai_severity || rawAlert?.aiSeverity || "").trim().toLowerCase(),
        aiSeverityScore: Math.max(
          0,
          Math.min(1, Number.parseFloat(rawAlert?.ai_severity_score ?? rawAlert?.aiSeverityScore) || 0)
        ),
        aiCountries: normalizeAiList(rawAlert?.ai_countries ?? rawAlert?.aiCountries),
        aiActors: normalizeAiList(rawAlert?.ai_actors ?? rawAlert?.aiActors),
        aiSummary: String(rawAlert?.ai_summary || rawAlert?.aiSummary || "").trim(),
        aiReliabilityScore: Math.max(
          0,
          Math.min(1, Number.parseFloat(rawAlert?.ai_reliability_score ?? rawAlert?.aiReliabilityScore) || 0)
        ),
        aiIsConflictRelated: Boolean(rawAlert?.ai_is_conflict_related ?? rawAlert?.aiIsConflictRelated),
        country: {
          name: countryInfo.name,
          code: countryInfo.code,
          region: countryInfo.region
        },
        city: {
          name: cityInfo?.name || "",
          lat: Number.isFinite(cityInfo?.lat) ? cityInfo.lat : null,
          lng: Number.isFinite(cityInfo?.lng) ? cityInfo.lng : null
        },
        locationMeta: {
          strategicArea: geoMeta?.strategicArea || "",
          directionalHint: geoMeta?.directionalHint || "",
          isBorder: Boolean(geoMeta?.isBorder),
          borderCountries: Array.isArray(geoMeta?.borderCountries) ? geoMeta.borderCountries : [],
          placementBasis: geoMeta?.placementBasis || "geo_fallback"
        },
        eventRoles,
        location: {
          type: "Point",
          coordinates: [marker.lng, marker.lat]
        }
      });
    }

    telegramSyncCache = mapped;
    telegramSyncCacheAtMs = Date.now();
    telegramSyncLastFetchAtMs = Date.now();
    telegramSyncCooldownUntilMs = 0;
    return mapped;
  } catch (error) {
    const cacheAge = Date.now() - telegramSyncCacheAtMs;
    if (telegramSyncCache.length > 0 && cacheAge <= TELEGRAM_SYNC_CACHE_MAX_AGE_MS) {
      console.warn(`[telegram-sync] Echec ${error.message} | cache utilisee (${telegramSyncCache.length})`);
      return telegramSyncCache;
    }
    console.warn(`[telegram-sync] Echec ${error.message}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function persistAlertPayload(payload, reason, newAlerts) {
  try {
    const duplicate = await findRecentDuplicateAlert(payload);
    if (duplicate) {
      return;
    }

    const created = await Alert.create(payload);
    const enrichedAlert = await enrichConfirmationForAlert(created);
    newAlerts.push(enrichedAlert);

    streamService.sendEvent("new-alert", {
      reason,
      alert: enrichedAlert
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return;
    }
    console.warn(`[feeds] Insertion ignoree: ${error.message}`);
  }
}

async function detectAndStoreAlerts(settings, reason = "scheduled") {
  const maxAgeMinutes = resolveMaxAgeMinutes(settings);
  const gdeltPromise = ENABLE_GDELT
    ? Promise.all(GDELT_STREAMS.map((stream) => fetchGdeltItems(stream)))
    : Promise.resolve([]);

  const [feedItemsGroups, gdeltGroups, telegramPayloads] = await Promise.all([
    Promise.all(FEEDS.map((feed) => fetchFeedItems(feed))),
    gdeltPromise,
    fetchTelegramAlertPayloads(settings, maxAgeMinutes)
  ]);
  const feedItems = [...feedItemsGroups.flat(), ...gdeltGroups.flat()];

  const newAlerts = [];

  for (const item of feedItems) {
    const title = (item.title || "").trim();
    const sourceUrl = (item.link || "").trim();
    if (!title || !sourceUrl) {
      continue;
    }

    const summary = (item.contentSnippet || item.content || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const articleText = `${title} ${summary}`;
    const fallbackGeo = resolveGeoSignals(articleText);
    const eventRoles = buildEventRoles(articleText, fallbackGeo);
    const roleGeo = resolveGeoFromEventRoles(articleText, fallbackGeo, eventRoles);
    const { countryInfo, cityInfo, strategicArea, geoMeta } = roleGeo;

    if (!matchesSettingsFilters(articleText, countryInfo, settings)) {
      continue;
    }

    const isSpaceCivil = isCivilSpaceEvent(articleText);
    if (isSpaceCivil && settings?.includeSpaceCivil !== true) {
      continue;
    }

    const type = classifyType(articleText, item.feed.fallbackType);
    const canonicalAlertType = isSpaceCivil ? "espace_civil" : canonicalType(type);
    if (canonicalAlertType !== "geopolitique" && canonicalAlertType !== "espace_civil") {
      continue;
    }
    if (!isConflictAlert(articleText) && !isSpaceCivil) {
      continue;
    }
    const severity = classifySeverity(articleText);
    const aiEventType = detectAiEventType(articleText);
    const actionable = isActionableEvent(articleText, { countryInfo, cityInfo, strategicArea, geoMeta });

    if (String(settings?.alertMode || "insight").trim().toLowerCase() === "action" && !actionable) {
      continue;
    }

    const parsedPublishedAt = parsePublishedAt(item.isoDate || item.pubDate);
    if (parsedPublishedAt && isEventTooOld(parsedPublishedAt, maxAgeMinutes)) {
      continue;
    }
    const publishedAt = parsedPublishedAt || new Date();

    const sourceName = inferSourceName(item, title);
    const marker = computeMarkerCoordinates({
      cityInfo,
      strategicArea,
      countryInfo,
      applyDirection: true,
      directionalHint: geoMeta?.directionalHint || ""
    });
    eventRoles.placementBasis = geoMeta?.placementBasis || "geo_fallback";

    const inferredEventTime = inferOccurredAt(articleText, publishedAt);

    const payload = {
      title,
      summary,
      sourceName,
      sourceUrl,
      publishedAt,
      occurredAt: inferredEventTime.occurredAt || null,
      occurredAtSource: inferredEventTime.occurredAtSource || "unknown",
      type: canonicalAlertType,
      incidentClass: isSpaceCivil ? "space-civil" : classifyIncidentClass(articleText),
      severity,
      actionable,
      aiEventType,
      spaceCivil: isSpaceCivil,
      confirmed: false,
      confidenceScore: 35,
      sourceCount: 1,
      sourceNames: [sourceName],
      country: {
        name: countryInfo.name,
        code: countryInfo.code,
        region: countryInfo.region
      },
      city: {
        name: cityInfo?.name || "",
        lat: Number.isFinite(cityInfo?.lat) ? cityInfo.lat : null,
        lng: Number.isFinite(cityInfo?.lng) ? cityInfo.lng : null
      },
      locationMeta: {
        strategicArea: geoMeta?.strategicArea || "",
        directionalHint: geoMeta?.directionalHint || "",
        isBorder: Boolean(geoMeta?.isBorder),
        borderCountries: Array.isArray(geoMeta?.borderCountries) ? geoMeta.borderCountries : [],
        placementBasis: geoMeta?.placementBasis || "geo_fallback"
      },
      eventRoles,
      location: {
        type: "Point",
        coordinates: [marker.lng, marker.lat]
      }
    };

    await persistAlertPayload(payload, reason, newAlerts);
  }

  for (const telegramPayload of telegramPayloads) {
    await persistAlertPayload(telegramPayload, `${reason}-telegram`, newAlerts);
  }

  if (newAlerts.length > 0) {
    streamService.sendEvent("batch-summary", {
      reason,
      count: newAlerts.length,
      at: new Date().toISOString()
    });
  }

  return newAlerts;
}

async function repairRecentGeolocation(limit = 800) {
  const scopedLimit = Math.min(2000, Math.max(100, Number(limit) || 800));
  const candidates = await Alert.find({
    type: { $in: ["geopolitique", "espace_civil"] },
    $or: [
      { "country.code": "XX" },
      { "country.name": { $in: ["Inconnu", ""] } },
      { "location.coordinates": [0, 20] },
      { "location.coordinates.0": { $exists: false } },
      { "location.coordinates.1": { $exists: false } }
    ]
  })
    .sort({ createdAt: -1 })
    .limit(scopedLimit)
    .lean();

  if (!candidates.length) {
    return { scanned: 0, updated: 0 };
  }

  let updated = 0;

  for (const alert of candidates) {
    const articleText = `${alert?.title || ""} ${alert?.summary || ""} ${alert?.country?.name || ""}`.trim();
    if (!articleText) {
      continue;
    }

    const { countryInfo, cityInfo, strategicArea, geoMeta } = resolveGeoSignals(articleText);

    if (isUnknownCountryInfo(countryInfo) && !strategicArea) {
      continue;
    }

    const marker = computeMarkerCoordinates({
      cityInfo,
      strategicArea,
      countryInfo,
      applyDirection: true,
      directionalHint: geoMeta?.directionalHint || ""
    });

    const nextCountry = {
      name: countryInfo.name,
      code: countryInfo.code,
      region: countryInfo.region
    };
    const nextCity = {
      name: cityInfo?.name || "",
      lat: Number.isFinite(cityInfo?.lat) ? cityInfo.lat : null,
      lng: Number.isFinite(cityInfo?.lng) ? cityInfo.lng : null
    };
    const nextCoords = [marker.lng, marker.lat];

    const currentCountryName = String(alert?.country?.name || "");
    const currentCountryCode = String(alert?.country?.code ?? "").trim().toUpperCase();
    const currentRegion = String(alert?.country?.region || "Global");
    const currentCoords = Array.isArray(alert?.location?.coordinates) ? alert.location.coordinates : [];
    const currentCityName = String(alert?.city?.name || "");

    const shouldUpdate =
      currentCountryCode !== String(nextCountry.code || "").toUpperCase() ||
      currentCountryName !== nextCountry.name ||
      currentRegion !== nextCountry.region ||
      currentCityName !== nextCity.name ||
      isFallbackGeoCoordinates(currentCoords) ||
      Number(currentCoords?.[0]) !== nextCoords[0] ||
      Number(currentCoords?.[1]) !== nextCoords[1];

    if (!shouldUpdate) {
      continue;
    }

    await Alert.updateOne(
      { _id: alert._id },
      {
        $set: {
          country: nextCountry,
          city: nextCity,
          locationMeta: {
            strategicArea: geoMeta?.strategicArea || "",
            directionalHint: geoMeta?.directionalHint || "",
            isBorder: Boolean(geoMeta?.isBorder),
            borderCountries: Array.isArray(geoMeta?.borderCountries) ? geoMeta.borderCountries : []
          },
          location: { type: "Point", coordinates: nextCoords }
        }
      }
    );
    updated += 1;
  }

  return { scanned: candidates.length, updated };
}

let timer = null;
let running = false;
let telegramSyncLastFetchAtMs = 0;
let telegramSyncCooldownUntilMs = 0;
let telegramSyncCache = [];
let telegramSyncCacheAtMs = 0;
let aiQueueStatusCache = null;
let aiQueueStatusAtMs = 0;

async function runDetection(reason = "scheduled", options = {}) {
  if (running) {
    return [];
  }

  running = true;
  try {
    const settings = await Settings.getSingleton();
    const shouldSkipBecausePaused = settings.paused && !options.force;
    if (shouldSkipBecausePaused) {
      return [];
    }

    return await detectAndStoreAlerts(settings, reason);
  } finally {
    running = false;
  }
}

async function getAiQueueStatus(force = false) {
  if (!force && aiQueueStatusCache && Date.now() - aiQueueStatusAtMs < AI_QUEUE_STATUS_CACHE_MS) {
    return aiQueueStatusCache;
  }

  const backendBaseUrl = resolveTelegramBackendBaseUrl();
  if (!backendBaseUrl) {
    const fallback = {
      provider: "none",
      ready: false,
      queue_length: 0,
      queue_capacity: 0,
      processed_last_minute: 0,
      rate_limit_per_minute: Number(process.env.AI_RATE_LIMIT_PER_MINUTE) || DEFAULT_AI_RATE_LIMIT_PER_MINUTE,
      accepted_requests: 0,
      rejected_requests: 0,
      total_requests: 0,
      rejected_by_reason: {},
      rejection_breakdown: [],
      saturation_pct: 0,
      source: "local-fallback",
      updatedAt: new Date().toISOString()
    };
    aiQueueStatusCache = fallback;
    aiQueueStatusAtMs = Date.now();
    return fallback;
  }

  try {
    const response = await fetch(`${backendBaseUrl}/api/ai/health`, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Status code ${response.status}`);
    }
    const payload = await response.json();
    const acceptedRequests = Math.max(0, Number(payload?.accepted_requests || 0));
    const rejectedRequests = Math.max(0, Number(payload?.rejected_requests || 0));
    const totalRequests = Math.max(0, Number(payload?.total_requests || acceptedRequests + rejectedRequests));
    const rejectedByReason =
      payload?.rejected_by_reason && typeof payload.rejected_by_reason === "object" && !Array.isArray(payload.rejected_by_reason)
        ? payload.rejected_by_reason
        : {};
    const rejectionBreakdown = Array.isArray(payload?.rejection_breakdown)
      ? payload.rejection_breakdown
          .map((item) => ({
            reason: String(item?.reason || "").trim(),
            count: Math.max(0, Number(item?.count || 0)),
            pct_of_rejected: Math.max(0, Number(item?.pct_of_rejected || 0)),
            pct_of_total: Math.max(0, Number(item?.pct_of_total || 0))
          }))
          .filter((item) => item.reason && item.count > 0)
      : [];

    const mapped = {
      provider: payload?.provider || "groq",
      ready: Boolean(payload?.ready),
      queue_length: Number(payload?.queue_length || 0),
      queue_capacity: Number(payload?.queue_capacity || 0),
      processed_last_minute: Number(payload?.processed_last_minute || 0),
      rate_limit_per_minute: Number(payload?.rate_limit_per_minute || DEFAULT_AI_RATE_LIMIT_PER_MINUTE),
      accepted_requests: acceptedRequests,
      rejected_requests: rejectedRequests,
      total_requests: totalRequests,
      rejected_by_reason: rejectedByReason,
      rejection_breakdown: rejectionBreakdown,
      saturation_pct: Number(payload?.saturation_pct || 0),
      source: "telegram-backend",
      updatedAt: new Date().toISOString()
    };
    aiQueueStatusCache = mapped;
    aiQueueStatusAtMs = Date.now();
    return mapped;
  } catch (error) {
    const fallback = {
      provider: "unknown",
      ready: false,
      queue_length: 0,
      queue_capacity: 0,
      processed_last_minute: 0,
      rate_limit_per_minute: Number(process.env.AI_RATE_LIMIT_PER_MINUTE) || DEFAULT_AI_RATE_LIMIT_PER_MINUTE,
      accepted_requests: 0,
      rejected_requests: 0,
      total_requests: 0,
      rejected_by_reason: {},
      rejection_breakdown: [],
      saturation_pct: 0,
      source: "error",
      error: error.message,
      updatedAt: new Date().toISOString()
    };
    aiQueueStatusCache = fallback;
    aiQueueStatusAtMs = Date.now();
    return fallback;
  }
}

async function verifyAlertById(alertId, options = {}) {
  const normalizedId = String(alertId || "").trim();
  if (!normalizedId) {
    return null;
  }

  const existingAlert = await Alert.findById(normalizedId);
  if (!existingAlert) {
    return null;
  }

  const before = {
    confirmed: Boolean(existingAlert.confirmed),
    confidenceScore: Number.isFinite(Number(existingAlert.confidenceScore))
      ? Number(existingAlert.confidenceScore)
      : 0,
    sourceCount: Math.max(1, Number(existingAlert.sourceCount) || 1),
    sourceNames: Array.isArray(existingAlert.sourceNames) ? existingAlert.sourceNames.filter(Boolean) : [],
    eventGroupId: String(existingAlert.eventGroupId || "")
  };

  let inserted = 0;
  if (options.forceDetection !== false) {
    const newlyDetected = await runDetection("verification-manual", { force: true });
    inserted = Array.isArray(newlyDetected) ? newlyDetected.length : 0;
  }

  const latestAlert = await Alert.findById(normalizedId);
  if (!latestAlert) {
    return null;
  }

  const verifiedAlert = await enrichConfirmationForAlert(latestAlert);
  const eventGroupId = String(verifiedAlert?.eventGroupId || "").trim();
  const relatedAlerts = await findRelatedAlertsForAnchor(verifiedAlert || latestAlert, { limit: 20 });
  const verificationAssessment = computeVerificationAssessment(verifiedAlert || latestAlert, relatedAlerts);

  const verifiedAt = new Date().toISOString();

  if (verifiedAlert) {
    streamService.sendEvent("alert-updated", { alert: verifiedAlert });
  }
  streamService.sendEvent("verification-complete", {
    alertId: normalizedId,
    confirmed: Boolean(verifiedAlert?.confirmed),
    confidenceScore: Number(verifiedAlert?.confidenceScore || 0),
    sourceCount: Math.max(1, Number(verifiedAlert?.sourceCount || 1)),
    verificationStatus: verificationAssessment.status,
    verificationScore: verificationAssessment.score,
    verificationJustification: verificationAssessment.justification,
    inserted,
    eventGroupId: eventGroupId || normalizedId,
    verifiedAt
  });

  return {
    alert: verifiedAlert,
    relatedAlerts,
    verification: verificationAssessment,
    before,
    inserted,
    eventGroupId: eventGroupId || normalizedId,
    verifiedAt
  };
}

async function scheduleNextCycle() {
  const settings = await Settings.getSingleton();
  const intervalSeconds = Math.max(30, settings.pollIntervalSeconds || 300);

  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(async () => {
    await runDetection("scheduled");
    await scheduleNextCycle();
  }, intervalSeconds * 1000);
}

async function startScheduler() {
  const settings = await Settings.getSingleton();
  const envInterval = Number(process.env.POLL_INTERVAL_SECONDS);
  if (Number.isFinite(envInterval) && envInterval >= 30 && envInterval <= 3600) {
    // Seed initial interval from .env without overriding explicit user preferences.
    if (settings.pollIntervalSeconds === 300) {
      settings.pollIntervalSeconds = envInterval;
      await settings.save();
    }
  }

  await runDetection("startup");
  try {
    const repaired = await repairRecentGeolocation(Number(process.env.GEO_REPAIR_LIMIT) || 800);
    if (repaired.updated > 0) {
      console.log(`[geo-repair] scanned=${repaired.scanned} updated=${repaired.updated}`);
    }
  } catch (error) {
    console.warn(`[geo-repair] Echec ${error.message}`);
  }
  await scheduleNextCycle();
}

async function reschedule() {
  await scheduleNextCycle();
}

function getRuntimeState() {
  return {
    running,
    hasTimer: Boolean(timer)
  };
}

module.exports = {
  runDetection,
  verifyAlertById,
  findRelatedAlertsForAnchor,
  getAiQueueStatus,
  buildEventRoles,
  resolveGeoFromEventRoles,
  startScheduler,
  reschedule,
  getRuntimeState
};
