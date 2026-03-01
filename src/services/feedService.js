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
    sourceName: "Google News Geopolitics",
    url: "https://news.google.com/rss/search?q=geopolitics+OR+military+OR+ceasefire+when:2d&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
  },
  {
    sourceName: "Google News Conflict Signals",
    url: "https://news.google.com/rss/search?q=missile+OR+airstrike+OR+soldiers+killed+OR+battlefield+when:2d&hl=en-US&gl=US&ceid=US:en",
    fallbackType: "geopolitique"
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

const ACTION_FOCUS_TYPES = new Set(["geopolitique", "politique", "militaire"]);

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
  /\boffensive\b/i,
  /\bshelling\b/i,
  /\bsiege\b/i,
  /\binsurgent(s)?\b/i,
  /\brebel(s)?\b/i
];

function canonicalType(type) {
  const normalized = lower(type);
  if (normalized === "politique" || normalized === "militaire") {
    return "geopolitique";
  }
  return normalized || "autre";
}

function hasActionSignal(text) {
  return ACTION_SIGNAL_PATTERNS.some((pattern) => pattern.test(text || ""));
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

  return hasActionSignal(text);
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
    /war|invasion|mass casualty|genocide|chemical|nuclear|major attack|state of emergency/.test(
      content
    )
  ) {
    return "critical";
  }

  if (/missile|airstrike|bomb|killed|dead|urgent|severe|high risk/.test(content)) {
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

async function detectAndStoreAlerts(settings, reason = "scheduled") {
  const feedItemsGroups = await Promise.all(FEEDS.map((feed) => fetchFeedItems(feed)));
  const feedItems = feedItemsGroups.flat();

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
    const alertMode = lower(settings.alertMode || "insight");
    if (alertMode === "action" && !actionable) {
      continue;
    }
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
  const intervalSeconds = Math.max(60, settings.pollIntervalSeconds || 300);

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
  if (Number.isFinite(envInterval) && envInterval >= 60 && envInterval <= 3600) {
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
