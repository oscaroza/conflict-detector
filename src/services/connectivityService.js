const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 9000;

const cache = new Map();

function normalizeCode(value) {
  const code = String(value || "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function median(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function toPercent(current, baseline) {
  const value = Number(current);
  const normal = Number(baseline);
  if (!Number.isFinite(value) || !Number.isFinite(normal) || normal <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, (value / normal) * 100));
}

function connectivityStatus(percent) {
  const ratio = Number(percent);
  if (!Number.isFinite(ratio)) return "Données indisponibles";
  if (ratio >= 75) return "NORMAL";
  if (ratio >= 45) return "DEGRADE";
  if (ratio >= 20) return "COUPURE PARTIELLE";
  return "COUPURE TOTALE";
}

function parseSeries(payload) {
  const candidates = [
    payload?.data,
    payload?.result,
    payload?.results,
    payload?.signals,
    payload?.series
  ].find((value) => Array.isArray(value) && value.length > 0);

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const first = candidates[0];
  if (Array.isArray(first)) {
    return candidates;
  }
  if (Array.isArray(first?.values)) {
    return first.values;
  }
  if (Array.isArray(first?.points)) {
    return first.points;
  }
  return [];
}

function extractPointValue(point) {
  if (Array.isArray(point)) {
    const timestamp = Number(point[0]);
    const value = Number(point[1]);
    return {
      timestamp: Number.isFinite(timestamp) ? timestamp * 1000 : Date.now(),
      value: Number.isFinite(value) ? value : null
    };
  }

  if (point && typeof point === "object") {
    const ts = Number(point.timestamp || point.ts || point.time);
    const value = Number(point.value ?? point.signal ?? point.v);
    return {
      timestamp: Number.isFinite(ts) ? (ts > 10_000_000_000 ? ts : ts * 1000) : Date.now(),
      value: Number.isFinite(value) ? value : null
    };
  }

  return { timestamp: Date.now(), value: null };
}

async function fetchIodaConnectivity(code) {
  const nowSec = Math.floor(Date.now() / 1000);
  const from = nowSec - 6 * 60 * 60;
  const url = new URL("https://api.ioda.caida.org/v2/signals/raw");
  url.searchParams.set("from", String(from));
  url.searchParams.set("until", String(nowSec));
  url.searchParams.set("datasource", "ping-slash24");
  url.searchParams.set("entityType", "country");
  url.searchParams.set("entityCode", code);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Status code ${response.status}`);
    }
    const payload = await response.json();
    const series = parseSeries(payload).map(extractPointValue).filter((point) => Number.isFinite(point.value));
    if (!series.length) {
      return null;
    }

    const latest = series[series.length - 1];
    const history = series.slice(Math.max(0, series.length - 24), Math.max(0, series.length - 1));
    const baseline = median(history.map((item) => item.value)) ?? latest.value;
    const percent = toPercent(latest.value, baseline);

    return {
      code,
      source: "IODA",
      valuePercent: percent,
      status: connectivityStatus(percent),
      updatedAt: new Date(latest.timestamp).toISOString(),
      baseline: Number.isFinite(baseline) ? baseline : null,
      current: Number.isFinite(latest.value) ? latest.value : null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getCountryConnectivity(code) {
  const normalized = normalizeCode(code);
  if (!normalized) {
    return {
      code: "",
      source: "IODA",
      valuePercent: null,
      status: "Données indisponibles",
      updatedAt: new Date().toISOString(),
      baseline: null,
      current: null
    };
  }

  const cached = cache.get(normalized);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.payload;
  }

  try {
    const payload = await fetchIodaConnectivity(normalized);
    if (!payload) {
      throw new Error("No data");
    }
    cache.set(normalized, { at: Date.now(), payload });
    return payload;
  } catch (_) {
    const fallback = {
      code: normalized,
      source: "IODA",
      valuePercent: null,
      status: "Données indisponibles",
      updatedAt: new Date().toISOString(),
      baseline: null,
      current: null
    };
    cache.set(normalized, { at: Date.now(), payload: fallback });
    return fallback;
  }
}

module.exports = {
  getCountryConnectivity
};
