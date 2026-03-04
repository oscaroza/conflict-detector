const DEFAULT_TIMEOUT_MS = 9000;

const EQUIPMENT_CATALOG = [
  {
    key: "charles-de-gaulle",
    names: ["charles de gaulle", "fs charles de gaulle"],
    wiki: "French_aircraft_carrier_Charles_de_Gaulle",
    type: "Porte-avions",
    originCountry: "France",
    userCountries: ["France"],
    specs: {
      speed: "~27 noeuds",
      range: "Propulsion nucleaire",
      armament: "Aster/Mistral + groupe aeronaval",
      introduced: "2001",
      status: "En service"
    }
  },
  {
    key: "f-16",
    names: ["f-16", "f16", "f-16 fighting falcon"],
    wiki: "General_Dynamics_F-16_Fighting_Falcon",
    type: "Avion de combat multirole",
    originCountry: "Etats-Unis",
    userCountries: ["Etats-Unis", "Ukraine", "Pologne", "Turquie", "Pays-Bas", "Belgique"],
    specs: {
      speed: "Mach 2.0",
      range: "~4 200 km (ferry)",
      armament: "Missiles air-air/air-sol + canon 20 mm",
      introduced: "1978",
      status: "En service"
    }
  },
  {
    key: "t-90",
    names: ["t-90", "t90", "t-90m"],
    wiki: "T-90",
    type: "Char de combat principal",
    originCountry: "Russie",
    userCountries: ["Russie", "Inde", "Algerie", "Irak", "Azerbaidjan"],
    specs: {
      speed: "~60 km/h",
      range: "~550 km",
      armament: "Canon 125 mm + mitrailleuses",
      introduced: "1992",
      status: "En service"
    }
  },
  {
    key: "patriot",
    names: ["patriot", "mim-104 patriot"],
    wiki: "MIM-104_Patriot",
    type: "Systeme de defense aerienne",
    originCountry: "Etats-Unis",
    userCountries: ["Etats-Unis", "Allemagne", "Pologne", "Japon", "Arabie saoudite", "Ukraine"],
    specs: {
      speed: "Intercepteur supersonique",
      range: "Jusqu'a ~160 km (selon missile)",
      armament: "Missiles PAC-2/PAC-3",
      introduced: "1984",
      status: "En service"
    }
  },
  {
    key: "himars",
    names: ["himars", "m142 himars"],
    wiki: "M142_HIMARS",
    type: "Lance-roquettes multiple",
    originCountry: "Etats-Unis",
    userCountries: ["Etats-Unis", "Ukraine", "Pologne", "Roumanie", "Australie"],
    specs: {
      speed: "~85 km/h",
      range: "70-300+ km selon roquette/missile",
      armament: "GMLRS/ATACMS/PrSM",
      introduced: "2005",
      status: "En service"
    }
  }
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lookupEquipment(name) {
  const query = normalizeText(name);
  if (!query) return null;

  return (
    EQUIPMENT_CATALOG.find((entry) =>
      entry.names.some((alias) => {
        const normalizedAlias = normalizeText(alias);
        return query === normalizedAlias || query.includes(normalizedAlias) || normalizedAlias.includes(query);
      })
    ) || null
  );
}

async function fetchWikipediaSummary(title) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const endpoint = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(normalizedTitle)}`;
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return {
      title: String(payload?.title || "").trim(),
      extract: String(payload?.extract || "").trim(),
      image: payload?.thumbnail?.source || "",
      pageUrl: payload?.content_urls?.desktop?.page || ""
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildFallbackSpecs(baseType) {
  return {
    speed: "Donnee non disponible",
    range: "Donnee non disponible",
    armament: baseType.includes("defense") ? "Interception / defense" : "Donnee non disponible",
    introduced: "Donnee non disponible",
    status: "En service (a confirmer)"
  };
}

async function getEquipmentProfile(rawName) {
  const name = String(rawName || "").trim();
  if (!name) {
    return null;
  }

  const matched = lookupEquipment(name);
  const wikiTarget = matched?.wiki || name.replace(/\s+/g, "_");
  const wiki = await fetchWikipediaSummary(wikiTarget);

  const type = matched?.type || "Equipement militaire";
  const specs = matched?.specs || buildFallbackSpecs(type.toLowerCase());

  return {
    key: matched?.key || normalizeText(name).replace(/\s+/g, "-"),
    name: wiki?.title || name,
    type,
    originCountry: matched?.originCountry || "Donnee non disponible",
    userCountries: matched?.userCountries || [],
    status: specs.status || "Donnee non disponible",
    imageUrl: wiki?.image || "",
    summary:
      wiki?.extract ||
      "Profil partiel: informations automatiques. Les caracteristiques peuvent varier selon la version de l'equipement.",
    wikiUrl: wiki?.pageUrl || "",
    specs: {
      speed: specs.speed || "Donnee non disponible",
      range: specs.range || "Donnee non disponible",
      armament: specs.armament || "Donnee non disponible",
      introduced: specs.introduced || "Donnee non disponible"
    }
  };
}

module.exports = {
  getEquipmentProfile
};
