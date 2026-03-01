const countries = require("world-countries");

function normalizeCountryName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const byCode = new Map();
const byName = new Map();

countries.forEach((country) => {
  const code = String(country.cca2 || "").toUpperCase();
  if (code) {
    byCode.set(code, country);
  }

  const names = new Set([country?.name?.common, country?.name?.official, ...(country.altSpellings || [])]);
  names.forEach((name) => {
    const key = normalizeCountryName(name);
    if (key) {
      byName.set(key, country);
    }
  });
});

function getCountryRecord({ code, name } = {}) {
  const codeKey = String(code || "").toUpperCase().trim();
  if (codeKey && byCode.has(codeKey)) {
    return byCode.get(codeKey);
  }

  const nameKey = normalizeCountryName(name);
  if (nameKey && byName.has(nameKey)) {
    return byName.get(nameKey);
  }

  return null;
}

function getCountryProfile(input = {}) {
  const country = getCountryRecord(input);
  if (!country) {
    return null;
  }

  const capital = Array.isArray(country.capital) && country.capital.length > 0 ? country.capital[0] : "";

  return {
    name: country?.name?.common || input?.name || "Inconnu",
    code: country?.cca2 || String(input?.code || "XX").toUpperCase(),
    flag: country?.flag || "🏳️",
    capital: capital || "Non disponible",
    region: country?.region || "Global",
    subregion: country?.subregion || "",
    population: Number.isFinite(country?.population) ? country.population : null,
    leader: null
  };
}

module.exports = {
  getCountryProfile
};
