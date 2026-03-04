const express = require("express");
const Alert = require("../models/Alert");
const Settings = require("../models/Settings");
const streamService = require("../services/streamService");
const feedService = require("../services/feedService");
const voiceService = require("../services/voiceService");
const { getCountryConnectivity } = require("../services/connectivityService");
const { getEquipmentProfile } = require("../services/equipmentProfileService");
const { getCountryProfile } = require("../utils/countryProfile");

const router = express.Router();

const CONFLICT_TYPES = ["geopolitique", "politique", "militaire", "espace_civil"];
const TYPE_FILTER_GROUPS = {
  geopolitique: ["geopolitique", "politique", "militaire"],
  politique: ["geopolitique", "politique", "militaire"],
  militaire: ["geopolitique", "politique", "militaire"],
  espace_civil: ["espace_civil"]
};

const ACTION_TYPES = ["geopolitique", "politique", "militaire"];

function buildAlertQuery(queryParams) {
  // Always scope API results to geopolitical conflict alerts.
  const query = {
    deletedAt: null,
    type: { $in: CONFLICT_TYPES }
  };

  const includeSpaceCivil =
    String(queryParams.includeSpaceCivil || "")
      .trim()
      .toLowerCase() === "true";
  if (!includeSpaceCivil) {
    query.spaceCivil = { $ne: true };
  }

  const normalizedType = String(queryParams.type || "").trim().toLowerCase();
  if (normalizedType && TYPE_FILTER_GROUPS[normalizedType]) {
    const selectedTypes = TYPE_FILTER_GROUPS[normalizedType].slice();
    if (includeSpaceCivil && normalizedType !== "espace_civil") {
      selectedTypes.push("espace_civil");
    }
    query.type = { $in: Array.from(new Set(selectedTypes)) };
  } else if (includeSpaceCivil) {
    query.type = { $in: CONFLICT_TYPES };
  }
  if (queryParams.country) {
    query["country.name"] = queryParams.country;
  }
  if (queryParams.severity) {
    query.severity = queryParams.severity;
  }
  if (queryParams.read === "true") {
    query.read = true;
  }
  if (queryParams.read === "false") {
    query.read = false;
  }
  if (queryParams.confirmed === "true") {
    query.confirmed = true;
  }
  if (queryParams.confirmed === "false") {
    query.$and = (query.$and || []).concat([{ $or: [{ confirmed: false }, { confirmed: { $exists: false } }] }]);
  }
  if (queryParams.region) {
    query["country.region"] = queryParams.region;
  }

  const mode = String(queryParams.mode || "").trim().toLowerCase();
  if (mode === "action") {
    query.type = { $in: ACTION_TYPES };
    query.actionable = true;
    query.$and = (query.$and || []).concat([
      {
        $or: [{ aiEventType: "terrain_event" }, { aiEventType: "" }, { aiEventType: { $exists: false } }]
      }
    ]);
  }

  return query;
}

router.get("/alerts", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const query = buildAlertQuery(req.query);

    const [alerts, total] = await Promise.all([
      Alert.find(query)
        .sort({ occurredAt: -1, publishedAt: -1, createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Alert.countDocuments(query)
    ]);

    res.json({
      page,
      limit,
      total,
      alerts
    });
  } catch (error) {
    next(error);
  }
});

router.get("/alerts/:id/related", async (req, res, next) => {
  try {
    const limit = Math.min(30, Math.max(2, Number(req.query.limit) || 12));
    const anchorAlert = await Alert.findOne({ _id: req.params.id, deletedAt: null }).lean();

    if (!anchorAlert) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    const eventGroupId = String(anchorAlert.eventGroupId || "").trim();
    const relatedAlerts = await feedService.findRelatedAlertsForAnchor(anchorAlert, { limit });

    return res.json({
      anchorId: String(anchorAlert._id),
      eventGroupId: eventGroupId || String(anchorAlert._id),
      count: relatedAlerts.length,
      alerts: relatedAlerts
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/alerts/:id", async (req, res, next) => {
  try {
    const alert = await Alert.findOne({ _id: req.params.id, deletedAt: null }).lean();
    if (!alert) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }
    return res.json(alert);
  } catch (error) {
    return next(error);
  }
});

router.post("/alerts/:id/verify", async (req, res, next) => {
  try {
    const alert = await Alert.findOne({ _id: req.params.id, deletedAt: null }).lean();
    if (!alert) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    const result = await feedService.verifyAlertById(req.params.id, { forceDetection: true });
    if (!result || !result.alert) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.patch("/alerts/:id/read", async (req, res, next) => {
  try {
    const read = req.body.read === true || req.body.read === "true";
    const updated = await Alert.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null },
      { read },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    streamService.sendEvent("alert-updated", { alert: updated });
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
});

router.delete("/alerts/:id", async (req, res, next) => {
  try {
    const deleted = await Alert.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null },
      { deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!deleted) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    streamService.sendEvent("alert-deleted", { id: req.params.id });
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/countries", async (req, res, next) => {
  try {
    const countries = await Alert.distinct("country.name", { deletedAt: null, "country.name": { $ne: "Inconnu" } });
    countries.sort((a, b) => a.localeCompare(b));
    res.json(countries);
  } catch (error) {
    next(error);
  }
});

router.get("/regions", async (req, res, next) => {
  try {
    const regions = await Alert.distinct("country.region", { deletedAt: null, "country.region": { $ne: "Global" } });
    regions.sort((a, b) => a.localeCompare(b));
    res.json(regions);
  } catch (error) {
    next(error);
  }
});

router.get("/country-profile", (req, res) => {
  const code = String(req.query.code || "").trim().toUpperCase();
  const name = String(req.query.name || "").trim();

  if (!code && !name) {
    return res.status(400).json({ error: "Parametre code ou name requis" });
  }

  const profile = getCountryProfile({ code, name });
  if (!profile) {
    return res.status(404).json({ error: "Profil pays introuvable" });
  }

  return res.json(profile);
});

router.get("/country-connectivity", async (req, res, next) => {
  try {
    const code = String(req.query.code || "").trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ error: "Parametre code requis (ISO2)." });
    }

    const connectivity = await getCountryConnectivity(code);
    return res.json(connectivity);
  } catch (error) {
    return next(error);
  }
});

router.get("/equipment-profile", async (req, res, next) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Parametre name requis." });
    }

    const profile = await getEquipmentProfile(name);
    if (!profile) {
      return res.status(404).json({ error: "Equipement introuvable" });
    }
    return res.json(profile);
  } catch (error) {
    return next(error);
  }
});

router.get("/ai/queue-status", async (req, res, next) => {
  try {
    const payload = await feedService.getAiQueueStatus();
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

router.get("/stats", async (req, res, next) => {
  try {
    const query = buildAlertQuery(req.query);
    const unreadQuery = { ...query, read: false };

    const [byType, byCountry, bySeverity, unread] = await Promise.all([
      Alert.aggregate([
        { $match: query },
        { $group: { _id: "$type", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Alert.aggregate([
        { $match: query },
        { $group: { _id: "$country.name", count: { $sum: 1 } } },
        { $match: { _id: { $ne: "Inconnu" } } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),
      Alert.aggregate([
        { $match: query },
        { $group: { _id: "$severity", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Alert.countDocuments(unreadQuery)
    ]);

    res.json({ byType, byCountry, bySeverity, unread });
  } catch (error) {
    next(error);
  }
});

router.get("/settings", async (req, res, next) => {
  try {
    const settings = await Settings.getSingleton();
    res.json(settings.toObject());
  } catch (error) {
    next(error);
  }
});

router.get("/voice/status", (req, res) => {
  res.json(voiceService.getVoiceStatus());
});

router.post("/voice/speak", async (req, res, next) => {
  try {
    const text = String(req.body?.text || "");
    const audio = await voiceService.synthesize(text);
    res.setHeader("Content-Type", audio.contentType || "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio.buffer);
  } catch (error) {
    next(error);
  }
});

router.patch("/settings", async (req, res, next) => {
  try {
    const settings = await Settings.getSingleton();

    if (typeof req.body.paused === "boolean") {
      settings.paused = req.body.paused;
    }

    if (req.body.pollIntervalSeconds !== undefined) {
      const interval = Number(req.body.pollIntervalSeconds);
      if (!Number.isNaN(interval)) {
        settings.pollIntervalSeconds = Math.min(3600, Math.max(30, interval));
      }
    }

    if (typeof req.body.soundEnabled === "boolean") {
      settings.soundEnabled = req.body.soundEnabled;
    }

    if (typeof req.body.voiceEnabled === "boolean") {
      settings.voiceEnabled = req.body.voiceEnabled;
    }

    if (typeof req.body.globalCoverage === "boolean") {
      settings.globalCoverage = req.body.globalCoverage;
    }

    if (typeof req.body.includeSpaceCivil === "boolean") {
      settings.includeSpaceCivil = req.body.includeSpaceCivil;
    }

    if (typeof req.body.alertMode === "string") {
      const mode = req.body.alertMode.trim().toLowerCase();
      if (mode === "insight" || mode === "action") {
        settings.alertMode = mode;
      }
    }

    if (Array.isArray(req.body.keywordFilters)) {
      settings.keywordFilters = req.body.keywordFilters
        .map((v) => `${v}`.trim())
        .filter(Boolean);
    }

    if (Array.isArray(req.body.countryFilters)) {
      settings.countryFilters = req.body.countryFilters
        .map((v) => `${v}`.trim())
        .filter(Boolean);
    }

    await settings.save();
    await feedService.reschedule();

    streamService.sendEvent("settings-updated", {
      paused: settings.paused,
      pollIntervalSeconds: settings.pollIntervalSeconds,
      soundEnabled: settings.soundEnabled,
      voiceEnabled: settings.voiceEnabled,
      globalCoverage: settings.globalCoverage,
      includeSpaceCivil: settings.includeSpaceCivil,
      alertMode: settings.alertMode
    });

    res.json(settings.toObject());
  } catch (error) {
    next(error);
  }
});

router.post("/detect/now", async (req, res, next) => {
  try {
    const alerts = await feedService.runDetection("manual", { force: true });
    res.json({
      inserted: alerts.length,
      runtime: feedService.getRuntimeState()
    });
  } catch (error) {
    next(error);
  }
});

router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  streamService.addClient(res);

  req.on("close", () => {
    streamService.removeClient(res);
  });
});

module.exports = router;
