const countries = require("world-countries");

const IGNORED_SHORT_NAMES = new Set([
  "EU",
  "ROC",
  "CAR",
  "CHAD"
]);

const ALLOWED_SHORT_ALIASES = new Set(["usa", "uk", "uae", "eau", "drc", "rdc"]);

const COUNTRY_ALIAS_OVERRIDES = {
  AE: [
    "Emirats arabes unis",
    "Émirats arabes unis",
    "Emirats unis",
    "Emirat arabes unis",
    "Emirats arables unis",
    "Emirats arable unis",
    "Emirates arabes unis",
    "EAU",
    "UAE",
    "United Arab Emirats",
    "United Arab Emirate",
    "Unitedf Arab Emirates"
  ],
  US: ["Etats-Unis", "États-Unis", "Etats Unis", "États Unis", "USA", "United States of America"],
  GB: ["Royaume-Uni", "Royaume Uni", "Great Britain", "Britain", "UK"],
  RU: ["Russie"],
  UA: ["Ukraine"],
  IR: ["Iran", "Republique islamique d iran", "République islamique d'Iran"],
  IL: ["Israel", "Israël"],
  PS: ["Palestine", "Bande de Gaza", "Cisjordanie"],
  CD: ["RDC", "DRC", "RD Congo", "DR Congo", "République démocratique du Congo", "Republique democratique du Congo"],
  KR: ["Corée du Sud", "Coree du Sud", "South Korea", "Republic of Korea"],
  KP: ["Corée du Nord", "Coree du Nord", "North Korea", "DPRK"],
  SY: ["Syrie"],
  IQ: ["Irak"],
  YE: ["Yemen", "Yémen"]
};

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactToken(value) {
  return String(value || "").replace(/\s+/g, "");
}

function getCountryNames(country) {
  const names = new Set();
  const code = String(country?.cca2 || "").toUpperCase();

  names.add(country?.name?.common);
  names.add(country?.name?.official);

  for (const alt of country?.altSpellings || []) {
    names.add(alt);
  }

  const fra = country?.translations?.fra;
  names.add(fra?.common);
  names.add(fra?.official);

  const eng = country?.translations?.eng;
  names.add(eng?.common);
  names.add(eng?.official);

  for (const alias of COUNTRY_ALIAS_OVERRIDES[code] || []) {
    names.add(alias);
  }

  return Array.from(names).filter(Boolean);
}

function buildPatterns() {
  const entries = [];
  const seen = new Set();

  for (const country of countries) {
    const code = String(country?.cca2 || "XX").toUpperCase();
    const names = getCountryNames(country);

    for (const rawName of names) {
      if (!rawName) {
        continue;
      }
      const name = rawName.trim();
      const normalizedName = normalizeText(name);
      if (!name || !normalizedName) {
        continue;
      }

      const compact = compactToken(normalizedName);
      const isVeryShortAlias = compact.length <= 3;
      if (isVeryShortAlias && !ALLOWED_SHORT_ALIASES.has(compact)) {
        continue;
      }
      if (IGNORED_SHORT_NAMES.has(name.toUpperCase())) {
        continue;
      }

      const dedupeKey = `${code}:${normalizedName}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const regex = new RegExp(`\\b${escapeRegExp(normalizedName)}\\b`, "i");
      const tokens = normalizedName
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 3);

      entries.push({
        rawName: name,
        normalizedName,
        regex,
        tokens,
        country: {
          name: country.name.common,
          code,
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
  if (!normalized) {
    return {
      name: "Inconnu",
      code: "XX",
      region: "Global",
      lat: 20,
      lng: 0
    };
  }

  for (const pattern of COUNTRY_PATTERNS) {
    if (pattern.regex.test(normalized)) {
      return pattern.country;
    }
  }

  // Fallback fuzzy matching for small typos ("unitedf arab emirates", etc.).
  const textTokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  let best = null;
  for (const pattern of COUNTRY_PATTERNS) {
    if (!pattern.tokens || pattern.tokens.length < 2) {
      continue;
    }

    let hits = 0;
    for (const patternToken of pattern.tokens) {
      const matched = textTokens.some((textToken) => {
        if (textToken === patternToken) {
          return true;
        }
        if (textToken.length >= 5 && patternToken.length >= 5) {
          const left = textToken.slice(0, 5);
          const right = patternToken.slice(0, 5);
          return left === right;
        }
        return false;
      });
      if (matched) {
        hits += 1;
      }
    }

    const coverage = hits / pattern.tokens.length;
    if (hits >= 2 && coverage >= 0.66) {
      const score = coverage * 10 + Math.min(6, hits);
      if (!best || score > best.score) {
        best = { score, country: pattern.country };
      }
    }
  }

  if (best?.country) {
    return best.country;
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
