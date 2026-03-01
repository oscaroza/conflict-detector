const countries = require("world-countries");

const IGNORED_SHORT_NAMES = new Set([
  "US",
  "UK",
  "EU",
  "UAE",
  "DRC",
  "ROC",
  "CAR",
  "CHAD"
]);

function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ");
}

function buildPatterns() {
  const entries = [];

  for (const country of countries) {
    const names = new Set();
    names.add(country.name.common);
    if (country.name.official) {
      names.add(country.name.official);
    }

    for (const alt of country.altSpellings || []) {
      names.add(alt);
    }

    for (const rawName of names) {
      if (!rawName) {
        continue;
      }
      const name = rawName.trim();
      if (!name || name.length < 4 || IGNORED_SHORT_NAMES.has(name.toUpperCase())) {
        continue;
      }

      entries.push({
        rawName: name,
        normalizedName: normalizeText(name),
        country: {
          name: country.name.common,
          code: country.cca2 || "XX",
          region: country.region || "Global",
          lat: Array.isArray(country.latlng) ? country.latlng[0] : 20,
          lng: Array.isArray(country.latlng) ? country.latlng[1] : 0
        }
      });
    }
  }

  return entries.sort((a, b) => b.normalizedName.length - a.normalizedName.length);
}

const COUNTRY_PATTERNS = buildPatterns();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCountry(text) {
  const normalized = normalizeText(text);

  for (const pattern of COUNTRY_PATTERNS) {
    const regex = new RegExp(`\\b${escapeRegExp(pattern.normalizedName)}\\b`, "i");
    if (regex.test(normalized)) {
      return pattern.country;
    }
  }

  return {
    name: "Inconnu",
    code: "XX",
    region: "Global",
    lat: 20,
    lng: 0
  };
}

module.exports = { extractCountry };
