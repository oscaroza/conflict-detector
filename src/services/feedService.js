const Parser = require("rss-parser");
const Alert = require("../models/Alert");
const Settings = require("../models/Settings");
const { extractCountry } = require("../utils/countryMatcher");
const streamService = require("./streamService");

const parser = new Parser({ timeout: 15000 });

const FEEDS = [
  {
    sourceName: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    fallbackType: "politique"
  },
  {
    sourceName: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    fallbackType: "politique"
  },
  {
    sourceName: "ReliefWeb",
    url: "https://reliefweb.int/updates?format=rss",
    fallbackType: "humanitaire"
  },
  {
    sourceName: "CISA Advisories",
    url: "https://www.cisa.gov/news-events/cybersecurity-advisories/all.xml",
    fallbackType: "cyber"
  },
  {
    sourceName: "NATO News",
    url: "https://www.nato.int/rss/news.xml",
    fallbackType: "militaire"
  }
];

const TYPE_KEYWORDS = {
  cyber: [
    "cyber",
    "malware",
    "ransomware",
    "hacker",
    "cyberattack",
    "cyber attack",
    "data breach"
  ],
  militaire: [
    "army",
    "military",
    "strike",
    "missile",
    "drone",
    "troops",
    "defense",
    "battle",
    "armed"
  ],
  humanitaire: [
    "humanitarian",
    "aid",
    "refugee",
    "famine",
    "displaced",
    "outbreak",
    "cholera",
    "earthquake",
    "flood"
  ],
  politique: [
    "election",
    "protest",
    "government",
    "sanction",
    "ceasefire",
    "tension",
    "diplomatic",
    "president",
    "minister"
  ]
};

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

  return fallbackType || "autre";
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
    const severity = classifySeverity(articleText);
    const publishedAt = item.isoDate || item.pubDate ? new Date(item.isoDate || item.pubDate) : new Date();

    const payload = {
      title,
      summary,
      sourceName: item.feed.sourceName,
      sourceUrl,
      publishedAt,
      type,
      severity,
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
