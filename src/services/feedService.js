const Parser = require("rss-parser");
const Alert = require("../models/Alert");
const Settings = require("../models/Settings");
const { extractCountry } = require("../utils/countryMatcher");
const { extractCity } = require("../utils/cityMatcher");
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
    return countryInfo;
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
  return countryInfo;
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

const CONFIRM_WINDOW_HOURS = 18;
const MAX_CONFIRM_SCAN = 140;
const MIN_EVENT_SIMILARITY = 0.32;
const MIN_EVENT_SIMILARITY_WITH_CASUALTY = 0.22;
const MIN_TITLE_SIMILARITY = 0.58;
const MIN_TITLE_SIMILARITY_WITH_CASUALTY = 0.48;
const MIN_TITLE_SHARED_TOKENS = 3;
const DUPLICATE_SCAN_HOURS = 8;
const MAX_DUPLICATE_SCAN = 120;
const DUPLICATE_TITLE_SIMILARITY = 0.82;
const DUPLICATE_TOKEN_SIMILARITY = 0.72;
const DEFAULT_MAX_EVENT_AGE_MINUTES_INSIGHT = 180;
const DEFAULT_MAX_EVENT_AGE_MINUTES_ACTION = 30;

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

  if (!ACTION_FOCUS_TYPES.has(normalizedType)) {
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

  if (/nuclear (explosion|blast|detonation|plant|reactor|facility)|atomic blast|atomic explosion/.test(content)) {
    return "nuclear";
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

function areLikelySameEvent(baseEvent, candidateEvent) {
  const hasExactTitleMatch =
    Boolean(baseEvent?.normalizedTitle) &&
    Boolean(candidateEvent?.normalizedTitle) &&
    baseEvent.normalizedTitle === candidateEvent.normalizedTitle;
  if (hasExactTitleMatch) {
    return true;
  }

  const titleSimilarity = jaccardSimilarity(baseEvent.titleTokens, candidateEvent.titleTokens);
  const titleSharedTokens = tokenIntersectionCount(baseEvent.titleTokens, candidateEvent.titleTokens);
  const hasStrongTitleMatch = titleSimilarity >= MIN_TITLE_SIMILARITY && titleSharedTokens >= MIN_TITLE_SHARED_TOKENS;

  if (hasStrongTitleMatch && isIncidentClassCompatible(baseEvent.incidentClass, candidateEvent.incidentClass)) {
    return true;
  }

  if (!isIncidentClassCompatible(baseEvent.incidentClass, candidateEvent.incidentClass)) {
    return false;
  }

  const similarity = jaccardSimilarity(baseEvent.tokens, candidateEvent.tokens);
  if (similarity >= MIN_EVENT_SIMILARITY) {
    return true;
  }

  const hasSameCasualtyCount =
    Number.isFinite(baseEvent.casualtyCount) &&
    Number.isFinite(candidateEvent.casualtyCount) &&
    baseEvent.casualtyCount === candidateEvent.casualtyCount;

  return (
    hasSameCasualtyCount &&
    (similarity >= MIN_EVENT_SIMILARITY_WITH_CASUALTY ||
      (titleSimilarity >= MIN_TITLE_SIMILARITY_WITH_CASUALTY && titleSharedTokens >= 2))
  );
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
    type: "geopolitique",
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
    type: "geopolitique",
    ...countryQuery,
    publishedAt: { $gte: sinceDate }
  })
    .sort({ publishedAt: -1 })
    .limit(MAX_CONFIRM_SCAN)
    .lean();

  const cluster = [baseAlert];

  for (const candidate of candidates) {
    const candidateEvent = buildEventSignature(candidate);

    if (areLikelySameEvent(baseEvent, candidateEvent)) {
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

  const pushUnique = (alert) => {
    const id = String(alert?._id || "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    related.push(alert);
  };

  if (eventGroupId) {
    const grouped = await Alert.find({
      type: "geopolitique",
      eventGroupId
    })
      .sort({ occurredAt: -1, publishedAt: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();
    grouped.forEach(pushUnique);
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
      type: "geopolitique",
      ...countryQuery,
      publishedAt: { $gte: sinceDate }
    })
      .sort({ occurredAt: -1, publishedAt: -1, createdAt: -1, _id: -1 })
      .limit(MAX_CONFIRM_SCAN)
      .lean();

    for (const candidate of candidates) {
      if (related.length >= limit) break;
      if (seen.has(String(candidate?._id || ""))) continue;
      if (areLikelySameEvent(anchorEvent, buildEventSignature(candidate))) {
        pushUnique(candidate);
      }
    }
  }

  const hasAnchor = seen.has(anchorId);
  if (!hasAnchor) {
    related.unshift(anchorAlert);
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
      let countryInfo = resolveTelegramCountryInfo(rawAlert, articleText);
      const cityInfo = extractCity(articleText, countryInfo);

      if (cityInfo && (!countryInfo || countryInfo.code === "XX" || countryInfo.name === "Inconnu")) {
        countryInfo = {
          name: cityInfo.countryName,
          code: cityInfo.countryCode,
          region: cityInfo.region || "Global",
          lat: cityInfo.lat,
          lng: cityInfo.lng
        };
      }

      if (!matchesSettingsFilters(articleText, countryInfo, settings)) {
        continue;
      }

      const parsedPublishedAt = parsePublishedAt(rawAlert?.timestamp);
      if (parsedPublishedAt && isEventTooOld(parsedPublishedAt, maxAgeMinutes)) {
        continue;
      }
      const publishedAt = parsedPublishedAt || new Date();

      const canonicalAlertType = canonicalType(String(rawAlert?.type || "geopolitique"));
      if (canonicalAlertType !== "geopolitique") {
        continue;
      }

      const severity = normalizeTelegramSeverity(rawAlert?.severity, articleText);
      const actionable = isActionableAlert(canonicalAlertType, severity, articleText);
      const sourceName = normalizeTelegramSourceName(rawAlert?.source_channel);
      const sourceUrl = buildTelegramSourceUrl(rawAlert, sourceName, backendBaseUrl);

      const markerLat = Number.isFinite(cityInfo?.lat)
        ? cityInfo.lat
        : Number.isFinite(Number(rawAlert?.lat))
          ? Number(rawAlert?.lat)
          : countryInfo.lat || 20;
      const markerLng = Number.isFinite(cityInfo?.lng)
        ? cityInfo.lng
        : Number.isFinite(Number(rawAlert?.lng))
          ? Number(rawAlert?.lng)
          : countryInfo.lng || 0;

      mapped.push({
        title,
        summary,
        sourceName,
        sourceUrl,
        publishedAt,
        occurredAt: parsePublishedAt(rawAlert?.timestamp) || null,
        occurredAtSource: "telegram",
        type: canonicalAlertType,
        severity,
        actionable,
        confirmed: false,
        confidenceScore: clampConfidence(rawAlert?.confidence),
        sourceCount: 1,
        sourceNames: [sourceName],
        aiAnalyzed: Boolean(rawAlert?.ai_analyzed ?? rawAlert?.aiAnalyzed),
        aiCategory: String(rawAlert?.ai_category || rawAlert?.aiCategory || "").trim().toLowerCase(),
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
        location: {
          type: "Point",
          coordinates: [markerLng, markerLat]
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
    let countryInfo = extractCountry(articleText);
    const cityInfo = extractCity(articleText, countryInfo);
    if (cityInfo && (!countryInfo || countryInfo.code === "XX" || countryInfo.name === "Inconnu")) {
      countryInfo = {
        name: cityInfo.countryName,
        code: cityInfo.countryCode,
        region: cityInfo.region || "Global",
        lat: cityInfo.lat,
        lng: cityInfo.lng
      };
    }

    if (!matchesSettingsFilters(articleText, countryInfo, settings)) {
      continue;
    }

    const type = classifyType(articleText, item.feed.fallbackType);
    const canonicalAlertType = canonicalType(type);
    if (canonicalAlertType !== "geopolitique") {
      continue;
    }
    if (!isConflictAlert(articleText)) {
      continue;
    }
    const severity = classifySeverity(articleText);
    const actionable = isActionableAlert(canonicalAlertType, severity, articleText);
    const parsedPublishedAt = parsePublishedAt(item.isoDate || item.pubDate);
    if (parsedPublishedAt && isEventTooOld(parsedPublishedAt, maxAgeMinutes)) {
      continue;
    }
    const publishedAt = parsedPublishedAt || new Date();

    const sourceName = inferSourceName(item, title);
    const markerLat = Number.isFinite(cityInfo?.lat) ? cityInfo.lat : countryInfo.lat || 20;
    const markerLng = Number.isFinite(cityInfo?.lng) ? cityInfo.lng : countryInfo.lng || 0;

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
      severity,
      actionable,
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
      location: {
        type: "Point",
        coordinates: [markerLng, markerLat]
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
    type: "geopolitique",
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

    let countryInfo = extractCountry(articleText);
    const cityInfo = extractCity(articleText, countryInfo);

    if (cityInfo && (!countryInfo || countryInfo.code === "XX" || countryInfo.name === "Inconnu")) {
      countryInfo = {
        name: cityInfo.countryName,
        code: cityInfo.countryCode,
        region: cityInfo.region || "Global",
        lat: cityInfo.lat,
        lng: cityInfo.lng
      };
    }

    if (!countryInfo || countryInfo.code === "XX") {
      continue;
    }

    const markerLat = Number.isFinite(cityInfo?.lat) ? cityInfo.lat : countryInfo.lat || 20;
    const markerLng = Number.isFinite(cityInfo?.lng) ? cityInfo.lng : countryInfo.lng || 0;

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
    const nextCoords = [markerLng, markerLat];

    const currentCountryName = String(alert?.country?.name || "");
    const currentCountryCode = String(alert?.country?.code || "XX").toUpperCase();
    const currentRegion = String(alert?.country?.region || "Global");
    const currentCoords = Array.isArray(alert?.location?.coordinates) ? alert.location.coordinates : [];
    const currentCityName = String(alert?.city?.name || "");

    const shouldUpdate =
      currentCountryCode !== nextCountry.code ||
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

  const verifiedAt = new Date().toISOString();

  if (verifiedAlert) {
    streamService.sendEvent("alert-updated", { alert: verifiedAlert });
  }
  streamService.sendEvent("verification-complete", {
    alertId: normalizedId,
    confirmed: Boolean(verifiedAlert?.confirmed),
    confidenceScore: Number(verifiedAlert?.confidenceScore || 0),
    sourceCount: Math.max(1, Number(verifiedAlert?.sourceCount || 1)),
    inserted,
    eventGroupId: eventGroupId || normalizedId,
    verifiedAt
  });

  return {
    alert: verifiedAlert,
    relatedAlerts,
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
  startScheduler,
  reschedule,
  getRuntimeState
};
