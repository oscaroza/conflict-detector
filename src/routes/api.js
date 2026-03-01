const express = require("express");
const Alert = require("../models/Alert");
const Settings = require("../models/Settings");
const streamService = require("../services/streamService");
const feedService = require("../services/feedService");

const router = express.Router();

function buildAlertQuery(queryParams) {
  const query = {};

  if (queryParams.type) {
    query.type = queryParams.type;
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
  if (queryParams.region) {
    query["country.region"] = queryParams.region;
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
        .sort({ createdAt: -1 })
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

router.get("/alerts/:id", async (req, res, next) => {
  try {
    const alert = await Alert.findById(req.params.id).lean();
    if (!alert) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }
    return res.json(alert);
  } catch (error) {
    return next(error);
  }
});

router.patch("/alerts/:id/read", async (req, res, next) => {
  try {
    const read = req.body.read === true || req.body.read === "true";
    const updated = await Alert.findByIdAndUpdate(
      req.params.id,
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
    const deleted = await Alert.findByIdAndDelete(req.params.id).lean();
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
    const countries = await Alert.distinct("country.name", { "country.name": { $ne: "Inconnu" } });
    countries.sort((a, b) => a.localeCompare(b));
    res.json(countries);
  } catch (error) {
    next(error);
  }
});

router.get("/regions", async (req, res, next) => {
  try {
    const regions = await Alert.distinct("country.region", { "country.region": { $ne: "Global" } });
    regions.sort((a, b) => a.localeCompare(b));
    res.json(regions);
  } catch (error) {
    next(error);
  }
});

router.get("/stats", async (req, res, next) => {
  try {
    const [byType, byCountry, bySeverity, unread] = await Promise.all([
      Alert.aggregate([
        { $group: { _id: "$type", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Alert.aggregate([
        { $group: { _id: "$country.name", count: { $sum: 1 } } },
        { $match: { _id: { $ne: "Inconnu" } } },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),
      Alert.aggregate([
        { $group: { _id: "$severity", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Alert.countDocuments({ read: false })
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

router.patch("/settings", async (req, res, next) => {
  try {
    const settings = await Settings.getSingleton();

    if (typeof req.body.paused === "boolean") {
      settings.paused = req.body.paused;
    }

    if (req.body.pollIntervalSeconds !== undefined) {
      const interval = Number(req.body.pollIntervalSeconds);
      if (!Number.isNaN(interval)) {
        settings.pollIntervalSeconds = Math.min(3600, Math.max(60, interval));
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
      pollIntervalSeconds: settings.pollIntervalSeconds
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
