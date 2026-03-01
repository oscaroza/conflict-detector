const Parser = require("rss-parser");
const Alert = require("../models/Alert");
const Settings = require("../models/Settings");
const { extractCountry } = require("../utils/countryMatcher");
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
    sourceName: "GDELT US-Iran Signals",
    query:
      "(US OR United States OR America) AND Iran AND (missile OR strike OR base attacked OR casualties OR military escalation OR retaliation)",
    maxRecords: 40
  }
];

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

function classifyType(text, fallbackType) {
  const content = lower(text);

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some((keyword) => content.includes(keyword))) {
      return type;
    }
  }

  return fallbackType || "geopolitique";
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
    return (parsed.items || []).slice(0, 20).map((item) => ({ ...item, feed }));
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

async function detectAndStoreAlerts(settings, reason = "scheduled") {
  const [feedItemsGroups, gdeltGroups] = await Promise.all([
    Promise.all(FEEDS.map((feed) => fetchFeedItems(feed))),
    Promise.all(GDELT_STREAMS.map((stream) => fetchGdeltItems(stream)))
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
    const countryInfo = extractCountry(articleText);

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
    const publishedAt = item.isoDate || item.pubDate ? new Date(item.isoDate || item.pubDate) : new Date();

    const payload = {
      title,
      summary,
      sourceName: item.feed.sourceName,
      sourceUrl,
      publishedAt,
      type: canonicalAlertType,
      severity,
      actionable,
      country: {
        name: countryInfo.name,
        code: countryInfo.code,
        region: countryInfo.region
      },
      location: {
        type: "Point",
        coordinates: [countryInfo.lng || 0, countryInfo.lat || 20]
      }
    };

    try {
      const created = await Alert.create(payload);
      const plainAlert = created.toObject();
      newAlerts.push(plainAlert);

      streamService.sendEvent("new-alert", {
        reason,
        alert: plainAlert
      });
    } catch (error) {
      if (error && error.code === 11000) {
        continue;
      }
      console.warn(`[feeds] Insertion ignoree: ${error.message}`);
    }
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

let timer = null;
let running = false;

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
  startScheduler,
  reschedule,
  getRuntimeState
};
