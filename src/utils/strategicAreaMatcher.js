function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STRATEGIC_AREAS = [
  {
    name: "Mer Mediterranee",
    region: "Europe/Africa/Asia",
    lat: 34.5,
    lng: 18.0,
    aliases: [
      "mediterranean",
      "mediterranean sea",
      "eastern mediterranean",
      "mer mediterranee",
      "mediterranee",
      "mediterranee orientale",
      "sea mediterranean"
    ],
    polygon: [
      [30.0, -6.0],
      [46.0, -6.0],
      [46.0, 36.0],
      [30.0, 36.0]
    ]
  },
  {
    name: "Mer Rouge",
    region: "Africa/Asia",
    lat: 21.6,
    lng: 38.4,
    aliases: ["red sea", "mer rouge"],
    polygon: [
      [11.0, 32.0],
      [30.0, 32.0],
      [30.0, 44.0],
      [11.0, 44.0]
    ]
  },
  {
    name: "Mer Noire",
    region: "Europe/Asia",
    lat: 43.3,
    lng: 35.2,
    aliases: ["black sea", "mer noire"],
    polygon: [
      [40.0, 27.0],
      [47.0, 27.0],
      [47.0, 42.0],
      [40.0, 42.0]
    ]
  },
  {
    name: "Mer Baltique",
    region: "Europe",
    lat: 58.6,
    lng: 20.1,
    aliases: ["baltic sea", "mer baltique"],
    polygon: [
      [53.0, 9.0],
      [66.0, 9.0],
      [66.0, 31.0],
      [53.0, 31.0]
    ]
  },
  {
    name: "Golfe Persique",
    region: "Asia",
    lat: 26.5,
    lng: 52.6,
    aliases: ["persian gulf", "arabian gulf", "golfe persique"],
    polygon: [
      [23.0, 47.0],
      [31.0, 47.0],
      [31.0, 57.0],
      [23.0, 57.0]
    ]
  },
  {
    name: "Golfe d'Aden",
    region: "Africa/Asia",
    lat: 13.2,
    lng: 48.4,
    aliases: ["gulf of aden", "aden gulf", "golfe d aden", "golfe d'aden"],
    polygon: [
      [10.0, 43.0],
      [16.0, 43.0],
      [16.0, 52.0],
      [10.0, 52.0]
    ]
  },
  {
    name: "Golfe d'Oman",
    region: "Asia",
    lat: 24.4,
    lng: 58.5,
    aliases: ["gulf of oman", "oman gulf", "golfe d oman", "golfe d'oman"],
    polygon: [
      [21.0, 55.0],
      [27.0, 55.0],
      [27.0, 62.0],
      [21.0, 62.0]
    ]
  },
  {
    name: "Mer d'Arabie",
    region: "Asia",
    lat: 17.4,
    lng: 64.2,
    aliases: ["arabian sea", "mer d arabie", "mer d'arabie"],
    polygon: [
      [6.0, 52.0],
      [24.0, 52.0],
      [24.0, 72.0],
      [6.0, 72.0]
    ]
  },
  {
    name: "Detroit d'Ormuz",
    region: "Asia",
    lat: 26.6,
    lng: 56.3,
    aliases: ["strait of hormuz", "hormuz strait", "detroit d ormuz", "detroit d'ormuz"],
    polygon: [
      [25.0, 55.0],
      [27.5, 55.0],
      [27.5, 57.6],
      [25.0, 57.6]
    ]
  },
  {
    name: "Detroit de Bab-el-Mandeb",
    region: "Africa/Asia",
    lat: 12.6,
    lng: 43.3,
    aliases: ["bab el mandeb", "bab-al-mandab", "bab el-mandeb strait", "detroit de bab el mandeb"],
    polygon: [
      [11.0, 42.0],
      [14.0, 42.0],
      [14.0, 44.5],
      [11.0, 44.5]
    ]
  },
  {
    name: "Canal de Suez",
    region: "Africa/Asia",
    lat: 30.6,
    lng: 32.3,
    aliases: ["suez canal", "canal de suez"],
    polygon: [
      [29.0, 31.8],
      [31.8, 31.8],
      [31.8, 33.0],
      [29.0, 33.0]
    ]
  },
  {
    name: "Detroit de Taiwan",
    region: "Asia",
    lat: 24.1,
    lng: 119.5,
    aliases: ["taiwan strait", "detroit de taiwan"],
    polygon: [
      [21.0, 117.0],
      [27.0, 117.0],
      [27.0, 122.0],
      [21.0, 122.0]
    ]
  },
  {
    name: "Mer de Chine Meridionale",
    region: "Asia",
    lat: 13.8,
    lng: 114.2,
    aliases: ["south china sea", "mer de chine meridionale", "mer de chine du sud"],
    polygon: [
      [-2.0, 105.0],
      [24.0, 105.0],
      [24.0, 122.0],
      [-2.0, 122.0]
    ]
  },
  {
    name: "Mer de Chine Orientale",
    region: "Asia",
    lat: 28.1,
    lng: 125.0,
    aliases: ["east china sea", "mer de chine orientale"],
    polygon: [
      [23.0, 121.0],
      [33.0, 121.0],
      [33.0, 131.0],
      [23.0, 131.0]
    ]
  },
  {
    name: "Mer du Japon",
    region: "Asia",
    lat: 39.0,
    lng: 136.0,
    aliases: ["sea of japan", "mer du japon", "east sea"],
    polygon: [
      [33.0, 127.0],
      [46.0, 127.0],
      [46.0, 142.0],
      [33.0, 142.0]
    ]
  },
  {
    name: "Sahel",
    region: "Africa",
    lat: 15.2,
    lng: 2.5,
    aliases: ["sahel"]
  },
  {
    name: "Moyen-Orient",
    region: "Asia",
    lat: 29.6,
    lng: 40.0,
    aliases: ["middle east", "middle-east", "moyen orient", "moyen-orient", "near east"]
  },
  {
    name: "Levant",
    region: "Asia",
    lat: 33.7,
    lng: 36.4,
    aliases: ["levant"]
  },
  {
    name: "Corne de l'Afrique",
    region: "Africa",
    lat: 7.9,
    lng: 44.1,
    aliases: ["horn of africa", "corne de l afrique", "corne de l'afrique"]
  },
  {
    name: "Donbas",
    region: "Europe",
    lat: 48.1,
    lng: 37.8,
    aliases: ["donbas", "donbass"]
  }
];

const AREA_PATTERNS = STRATEGIC_AREAS.flatMap((area) => {
  const aliases = [area.name, ...(area.aliases || [])];
  return aliases.map((alias) => {
    const normalizedAlias = normalizeText(alias);
    return {
      area,
      normalizedAlias,
      regex: new RegExp(`\\b${escapeRegExp(normalizedAlias)}\\b`, "i")
    };
  });
})
  .filter((entry) => entry.normalizedAlias)
  .sort((a, b) => b.normalizedAlias.length - a.normalizedAlias.length);

function extractStrategicArea(text) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return null;
  }

  const matched = AREA_PATTERNS.find((pattern) => pattern.regex.test(normalizedText));
  if (!matched) {
    return null;
  }

  return {
    name: matched.area.name,
    region: matched.area.region || "Global",
    lat: matched.area.lat,
    lng: matched.area.lng,
    polygon: Array.isArray(matched.area.polygon) ? matched.area.polygon : []
  };
}

function listStrategicAreas() {
  return STRATEGIC_AREAS.map((area) => ({
    name: area.name,
    region: area.region,
    lat: area.lat,
    lng: area.lng,
    aliases: Array.isArray(area.aliases) ? area.aliases.slice() : [],
    polygon: Array.isArray(area.polygon) ? area.polygon.slice() : []
  }));
}

module.exports = { extractStrategicArea, listStrategicAreas };
