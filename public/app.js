const state = {
  alerts: [],
  settings: null,
  map: null,
  markersLayer: null,
  countryLayer: null,
  countryCentroids: new Map(),
  countryStatusLevels: new Map(),
  countryProfileCache: new Map(),
  selectedCountryKey: null,
  selectedAlertId: null,
  charts: {
    type: null,
    country: null,
    tension: null
  },
  eventSource: null
};

const refs = {
  workspaceGrid: document.getElementById("workspaceGrid"),
  intelOverlay: document.getElementById("intelOverlay"),
  alertsList: document.getElementById("alertsList"),
  alertDetails: document.getElementById("alertDetails"),
  totalAlertsCount: document.getElementById("totalAlertsCount"),
  criticalAlertsCount: document.getElementById("criticalAlertsCount"),
  detectionStatus: document.getElementById("detectionStatus"),
  togglePauseBtn: document.getElementById("togglePauseBtn"),
  toggleRightPanelBtn: document.getElementById("toggleRightPanelBtn"),
  alertModeSelect: document.getElementById("alertModeSelect"),
  intervalSelect: document.getElementById("intervalSelect"),
  toggleCoverageBtn: document.getElementById("toggleCoverageBtn"),
  toggleSoundBtn: document.getElementById("toggleSoundBtn"),
  refreshNowBtn: document.getElementById("refreshNowBtn"),
  searchInput: document.getElementById("searchInput"),
  typeFilter: document.getElementById("typeFilter"),
  countryFilter: document.getElementById("countryFilter"),
  regionFilter: document.getElementById("regionFilter"),
  severityFilter: document.getElementById("severityFilter"),
  confirmedFilter: document.getElementById("confirmedFilter"),
  resetFiltersBtn: document.getElementById("resetFiltersBtn"),
  keywordInput: document.getElementById("keywordInput"),
  settingsCountryFilter: document.getElementById("settingsCountryFilter"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  latestTickerContent: document.getElementById("latestTickerContent"),
  mapOverlayMetric: document.getElementById("mapOverlayMetric"),
  marketsList: document.getElementById("marketsList"),
  keywordsList: document.getElementById("keywordsList"),
  alertFlash: document.getElementById("alertFlash"),
  toastHost: document.getElementById("toastHost"),
  typeChart: document.getElementById("typeChart"),
  countryChart: document.getElementById("countryChart"),
  tensionChart: document.getElementById("tensionChart")
};

let audioContext = null;
let lastSseErrorAt = 0;
let flashTimer = null;
let speechVoicesInitialized = false;
let uiRefreshTimer = null;
let uiRefreshInFlight = false;
let uiRefreshTick = 0;
let layoutResizeTimer = null;

function isSoundEnabled() {
  // Backward compatible for old settings docs missing this field.
  return state.settings?.soundEnabled !== false;
}

function isGlobalCoverageEnabled() {
  // Backward compatible for old settings docs missing this field.
  return state.settings?.globalCoverage !== false;
}

function updateSoundToggleUI() {
  if (!refs.toggleSoundBtn) return;
  const enabled = isSoundEnabled();
  refs.toggleSoundBtn.textContent = enabled ? "Son ON" : "Son OFF";
  refs.toggleSoundBtn.classList.toggle("is-off", !enabled);
}

function updateCoverageToggleUI() {
  if (!refs.toggleCoverageBtn) return;
  const enabled = isGlobalCoverageEnabled();
  refs.toggleCoverageBtn.textContent = enabled ? "Global ON" : "Global OFF";
  refs.toggleCoverageBtn.classList.toggle("is-off", !enabled);
}

function refreshLayout() {
  setTimeout(() => {
    if (state.map) {
      state.map.invalidateSize();
    }

    Object.values(state.charts).forEach((chart) => {
      if (chart && typeof chart.resize === "function") {
        chart.resize();
      }
    });
  }, 260);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || `Erreur HTTP ${response.status}`);
  }

  return payload;
}

function formatDate(dateString) {
  if (!dateString) {
    return "Date inconnue";
  }
  const date = new Date(dateString);
  return date.toLocaleString("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatShortDate(dateString) {
  if (!dateString) return "";
  const date = new Date(dateString);
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getAlertEventTimestamp(alert) {
  const publishedTs = new Date(alert?.publishedAt || 0).getTime();
  if (Number.isFinite(publishedTs) && publishedTs > 0) {
    return publishedTs;
  }

  const createdTs = new Date(alert?.createdAt || 0).getTime();
  if (Number.isFinite(createdTs) && createdTs > 0) {
    return createdTs;
  }

  return 0;
}

function sortAlertsByEventTimeDesc(alerts) {
  return [...(alerts || [])].sort((a, b) => {
    const eventDelta = getAlertEventTimestamp(b) - getAlertEventTimestamp(a);
    if (eventDelta !== 0) {
      return eventDelta;
    }

    const createdDelta = new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime();
    if (Number.isFinite(createdDelta) && createdDelta !== 0) {
      return createdDelta;
    }

    return String(b?._id || "").localeCompare(String(a?._id || ""));
  });
}

function severityLabel(value) {
  return {
    low: "Faible",
    medium: "Moyenne",
    high: "Haute",
    critical: "Critique"
  }[value] || value;
}

function normalizeSeverity(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "medium";
}

function canonicalType(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "politique" || normalized === "militaire" || normalized === "geopolitique") {
    return "geopolitique";
  }
  return "autre";
}

function typeLabel(value) {
  return canonicalType(value) === "geopolitique" ? "Geopolitique" : "Autre";
}

function confirmationLabel(alert) {
  return alert?.confirmed ? "CONFIRMED" : "UNCONFIRMED";
}

function confidenceScoreValue(alert) {
  const raw = Number(alert?.confidenceScore);
  if (Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, Math.round(raw)));
  }
  return alert?.confirmed ? 70 : 35;
}

function sourceCountValue(alert) {
  const raw = Number(alert?.sourceCount);
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.round(raw);
  }
  return 1;
}

function capitalize(value) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getSeverityTheme(severity) {
  const normalized = normalizeSeverity(severity);
  return {
    critical: {
      tone: "critical",
      label: "CRISE CRITIQUE",
      popupTitle: "ALERTE DE CRISE"
    },
    high: {
      tone: "high",
      label: "MENACE ELEVEE",
      popupTitle: "ALERTE PRIORITAIRE"
    },
    medium: {
      tone: "medium",
      label: "VIGILANCE ACTIVE",
      popupTitle: "ALERTE OPERATIONNELLE"
    },
    low: {
      tone: "low",
      label: "SURVEILLANCE",
      popupTitle: "NOTIFICATION"
    }
  }[normalized];
}

function showToast(title, body, severityOrTimeout = "neutral", maybeTimeout = 5000) {
  const isLegacyTimeoutCall = typeof severityOrTimeout === "number";
  const severity =
    isLegacyTimeoutCall || severityOrTimeout === "neutral" ? "neutral" : normalizeSeverity(severityOrTimeout);
  const timeout = isLegacyTimeoutCall ? severityOrTimeout : maybeTimeout;
  const theme = severity === "neutral" ? null : getSeverityTheme(severity);

  const toast = document.createElement("article");
  toast.className = `custom-toast ${theme ? `sev-${theme.tone} blink-toast` : "sev-neutral"}`;
  toast.innerHTML = `
    ${theme ? `<p class="tone">${escapeHtml(theme.label)}</p>` : ""}
    <p class="title">${escapeHtml(title)}</p>
    <p class="body">${escapeHtml(body)}</p>
  `;

  refs.toastHost.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-8px)";
    setTimeout(() => toast.remove(), 220);
  }, timeout);
}

function ensureAudio() {
  if (!audioContext) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioContext = new AC();
  }
}

function makeDistortionCurve(amount = 90) {
  const k = typeof amount === "number" ? amount : 50;
  const nSamples = 44100;
  const curve = new Float32Array(nSamples);
  const deg = Math.PI / 180;

  for (let i = 0; i < nSamples; i += 1) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }

  return curve;
}

function createNoiseBuffer(context, duration = 0.14) {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * duration), context.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * 0.8;
  }

  return buffer;
}

function playRadioBurst(context, startTime, frequency, duration, gainLevel, noiseLevel) {
  const toneOsc = context.createOscillator();
  const bandPass = context.createBiquadFilter();
  const shaper = context.createWaveShaper();
  const toneGain = context.createGain();

  toneOsc.type = "square";
  toneOsc.frequency.setValueAtTime(frequency, startTime);
  bandPass.type = "bandpass";
  bandPass.frequency.value = 1400;
  bandPass.Q.value = 1.7;
  shaper.curve = makeDistortionCurve(110);
  shaper.oversample = "4x";

  toneGain.gain.setValueAtTime(0.0001, startTime);
  toneGain.gain.exponentialRampToValueAtTime(gainLevel, startTime + 0.016);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  toneOsc.connect(bandPass);
  bandPass.connect(shaper);
  shaper.connect(toneGain);
  toneGain.connect(context.destination);

  toneOsc.start(startTime);
  toneOsc.stop(startTime + duration + 0.01);

  const noiseSource = context.createBufferSource();
  noiseSource.buffer = createNoiseBuffer(context, duration);
  const noiseFilter = context.createBiquadFilter();
  const noiseGain = context.createGain();

  noiseFilter.type = "highpass";
  noiseFilter.frequency.value = 1800;
  noiseGain.gain.setValueAtTime(0.0001, startTime);
  noiseGain.gain.exponentialRampToValueAtTime(noiseLevel, startTime + 0.02);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(context.destination);

  noiseSource.start(startTime);
  noiseSource.stop(startTime + duration + 0.01);
}

function playNotificationSound(severity = "medium") {
  ensureAudio();
  if (!audioContext) return;

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }

  const profile = {
    critical: {
      tones: [780, 690, 780],
      duration: 0.14,
      gap: 0.06,
      gain: 0.26,
      noise: 0.08
    },
    high: {
      tones: [730, 820],
      duration: 0.13,
      gap: 0.06,
      gain: 0.22,
      noise: 0.06
    },
    medium: {
      tones: [660, 660],
      duration: 0.11,
      gap: 0.05,
      gain: 0.17,
      noise: 0.05
    },
    low: {
      tones: [590],
      duration: 0.1,
      gap: 0.05,
      gain: 0.14,
      noise: 0.04
    }
  }[normalizeSeverity(severity)];

  const now = audioContext.currentTime + 0.02;
  profile.tones.forEach((frequency, index) => {
    const start = now + index * (profile.duration + profile.gap);
    playRadioBurst(audioContext, start, frequency, profile.duration, profile.gain, profile.noise);
  });
}

function getAlertVoiceSeverityLabel(severity) {
  const normalized = normalizeSeverity(severity);
  if (normalized === "critical" || normalized === "high") {
    return "critique";
  }
  if (normalized === "medium") {
    return "moyenne";
  }
  return "petite";
}

function buildAlertVoiceMessage(alert) {
  const severityVoiceLabel = getAlertVoiceSeverityLabel(alert?.severity);
  const country = alert?.country?.name && alert.country.name !== "Inconnu" ? alert.country.name : "zone inconnue";
  const title = String(alert?.title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 105);

  if (title) {
    return `Nouvelle alerte ${severityVoiceLabel} concernant ${country}. ${title}.`;
  }
  return `Nouvelle alerte ${severityVoiceLabel} concernant ${country}.`;
}

function initSpeechVoices() {
  if (speechVoicesInitialized || !("speechSynthesis" in window)) return;
  speechVoicesInitialized = true;

  const warmupVoices = () => {
    try {
      window.speechSynthesis.getVoices();
    } catch (error) {
      console.warn("[speech] voix indisponibles", error);
    }
  };

  warmupVoices();
  if ("onvoiceschanged" in window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = warmupVoices;
  }
}

function pickFrenchVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];

  return (
    voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith("fr")) ||
    voices.find((voice) => voice.lang && voice.lang.toLowerCase().includes("fr")) ||
    null
  );
}

function speakAlertMessage(alert) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    return;
  }

  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(buildAlertVoiceMessage(alert));
  utterance.lang = "fr-FR";
  utterance.volume = 1;

  const voice = pickFrenchVoice();
  if (voice) {
    utterance.voice = voice;
  }

  const severity = normalizeSeverity(alert?.severity);
  if (severity === "critical" || severity === "high") {
    utterance.rate = 0.9;
    utterance.pitch = 0.82;
  } else if (severity === "medium") {
    utterance.rate = 0.95;
    utterance.pitch = 0.92;
  } else {
    utterance.rate = 1;
    utterance.pitch = 1;
  }

  synth.cancel();
  setTimeout(() => {
    try {
      synth.speak(utterance);
    } catch (error) {
      console.warn("[speech] lecture impossible", error);
    }
  }, 220);
}

function triggerAlertFlash(alert) {
  if (!refs.alertFlash) return;

  const severity = normalizeSeverity(alert?.severity);
  const theme = getSeverityTheme(severity);

  refs.alertFlash.className = `alert-flash sev-${severity} show`;
  refs.alertFlash.innerHTML = `
    <div class="alert-flash-card">
      <p class="kicker">${escapeHtml(theme.popupTitle)}</p>
      <p class="headline">${escapeHtml(alert?.title || "Nouvelle alerte détectée")}</p>
      <p class="meta">${escapeHtml(alert?.country?.name || "Zone inconnue")} | ${escapeHtml(
    severityLabel(severity)
  )}</p>
    </div>
  `;

  if (flashTimer) {
    clearTimeout(flashTimer);
  }

  flashTimer = setTimeout(() => {
    refs.alertFlash.classList.remove("show");
  }, severity === "critical" ? 6200 : 4800);
}

function updateFoldButton(button, isOpen) {
  if (!button) return;
  const openLabel = button.dataset.openLabel || "Masquer";
  const closeLabel = button.dataset.closeLabel || "Ouvrir";
  button.textContent = isOpen ? openLabel : closeLabel;
  button.setAttribute("aria-expanded", String(isOpen));
}

function setFoldState(content, isOpen) {
  if (!content) return;

  const card = content.closest(".fold-card");
  if (card) {
    card.classList.toggle("is-open", isOpen);
  }

  content.classList.toggle("open", isOpen);

  const toggleButton = document.querySelector(`.fold-toggle[data-target="${content.id}"]`);
  updateFoldButton(toggleButton, isOpen);
}

function closeFoldGroup(group, exceptId) {
  if (!group) return;

  document.querySelectorAll(`.fold-card[data-group="${group}"] .fold-content.open`).forEach((content) => {
    if (content.id !== exceptId) {
      setFoldState(content, false);
    }
  });
}

function toggleFold(targetId, forcedState = null) {
  const content = document.getElementById(targetId);
  if (!content) return;

  const currentlyOpen = content.classList.contains("open");
  const nextState = forcedState === null ? !currentlyOpen : forcedState;

  const group = content.closest(".fold-card")?.dataset.group;
  if (nextState) {
    closeFoldGroup(group, targetId);
  }

  setFoldState(content, nextState);
  refreshLayout();
}

function bindFoldToggles() {
  document.querySelectorAll(".fold-toggle").forEach((button) => {
    const targetId = button.dataset.target;
    const content = document.getElementById(targetId);
    if (!content) return;

    updateFoldButton(button, content.classList.contains("open"));

    button.addEventListener("click", () => {
      toggleFold(targetId);
    });
  });
}

function ensureIntelOverlayVisible() {
  if (!refs.intelOverlay) return;
  if (refs.intelOverlay.classList.contains("hidden")) {
    refs.intelOverlay.classList.remove("hidden");
    updateColumnToggleButtons();
    refreshLayout();
  }
}

function updateColumnToggleButtons() {
  const hidden = refs.intelOverlay?.classList.contains("hidden");
  if (refs.toggleRightPanelBtn) {
    refs.toggleRightPanelBtn.textContent = hidden ? "Afficher panel" : "Fermer panel";
  }
}

function bindColumnToggles() {
  if (refs.toggleRightPanelBtn && refs.intelOverlay) {
    refs.toggleRightPanelBtn.addEventListener("click", () => {
      refs.intelOverlay.classList.toggle("hidden");
      updateColumnToggleButtons();
      refreshLayout();
    });
  }

  updateColumnToggleButtons();
}

function getCurrentFilters() {
  return {
    type: refs.typeFilter.value,
    country: refs.countryFilter.value,
    region: refs.regionFilter.value,
    severity: refs.severityFilter.value,
    confirmed: refs.confirmedFilter.value
  };
}

function matchesCurrentFilters(alert) {
  const filters = getCurrentFilters();
  if (canonicalType(alert.type) !== "geopolitique") return false;

  if (filters.type && canonicalType(alert.type) !== filters.type) return false;
  if (filters.country && alert.country?.name !== filters.country) return false;
  if (filters.region && alert.country?.region !== filters.region) return false;
  if (filters.severity && alert.severity !== filters.severity) return false;
  if (filters.confirmed === "true" && !alert.confirmed) return false;
  if (filters.confirmed === "false" && alert.confirmed) return false;

  return true;
}

function matchesSearch(alert) {
  const term = normalizeText(refs.searchInput?.value || "");
  if (!term) return true;

  const haystack = normalizeText(
    `${alert.title || ""} ${alert.summary || ""} ${alert.sourceName || ""} ${alert.country?.name || ""} ${
      alert.type || ""
    } ${alert.severity || ""}`
  );

  return haystack.includes(term);
}

function getVisibleAlerts() {
  return state.alerts.filter((alert) => canonicalType(alert.type) === "geopolitique" && matchesSearch(alert));
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function detectIncidentSignal(alert) {
  const text = normalizeText(`${alert?.title || ""} ${alert?.summary || ""}`);

  const hasNuclearPlant = includesAny(text, [
    "nuclear power plant",
    "nuclear plant",
    "nuclear reactor",
    "power reactor",
    "centrale nucleaire",
    "central nucleaire",
    "reacteur nucleaire"
  ]);
  const hasExplosion = includesAny(text, [
    "explosion",
    "blast",
    "detonation",
    "detonated",
    "bombing",
    "bombardement",
    "strike",
    "attack",
    "attaque",
    "hit",
    "impact",
    "touche",
    "frappe"
  ]);

  if (hasNuclearPlant && hasExplosion) {
    return "nuclear-plant";
  }

  if (
    includesAny(text, [
      "nuclear explosion",
      "nuclear blast",
      "nuclear detonation",
      "atomic explosion",
      "atomic blast",
      "detonation nucleaire",
      "explosion nucleaire",
      "bombe atomique"
    ])
  ) {
    return "nuclear";
  }

  if (
    includesAny(text, ["missile", "rocket", "ballistic", "hypersonic"]) &&
    includesAny(text, ["hit", "strike", "impact", "touche", "frappe", "attack", "landed"])
  ) {
    return "missile";
  }

  if (
    includesAny(text, [
      "air raid",
      "airstrike",
      "aerial bombardment",
      "drone strike",
      "raid aerien",
      "frappe aerienne",
      "bombardement aerien"
    ])
  ) {
    return "air-raid";
  }

  if (
    includesAny(text, [
      "bomb",
      "bombing",
      "car bomb",
      "ied",
      "blast",
      "detonation",
      "grenade",
      "explosion"
    ])
  ) {
    return "bomb";
  }

  return "conflict";
}

function getSignalVisual(signal) {
  return (
    {
      "nuclear-plant": {
        label: "Explosion centrale nucleaire",
        glyph: "☢",
        className: "signal-nuclear-plant"
      },
      nuclear: {
        label: "Explosion nucleaire",
        glyph: "☢",
        className: "signal-nuclear"
      },
      missile: {
        label: "Frappe missile",
        glyph: "🚀",
        className: "signal-missile"
      },
      "air-raid": {
        label: "Raid aerien",
        glyph: "✈",
        className: "signal-air-raid"
      },
      bomb: {
        label: "Explosion / bombe",
        glyph: "💣",
        className: "signal-bomb"
      },
      conflict: {
        label: "Conflit geopolitique",
        glyph: "⚠",
        className: "signal-conflict"
      }
    }[signal] || {
      label: "Conflit geopolitique",
      glyph: "⚠",
      className: "signal-conflict"
    }
  );
}

function getAlertLatLng(alert) {
  if (
    alert.location &&
    alert.location.coordinates &&
    Number.isFinite(alert.location.coordinates[0]) &&
    Number.isFinite(alert.location.coordinates[1])
  ) {
    return [alert.location.coordinates[1], alert.location.coordinates[0]];
  }

  if (alert.country?.name && state.countryCentroids.has(alert.country.name)) {
    return state.countryCentroids.get(alert.country.name);
  }

  return [20, 0];
}

function getMarkerLimitForZoom(zoom) {
  if (!Number.isFinite(zoom)) return 80;
  if (zoom < 3) return 70;
  if (zoom < 4) return 130;
  if (zoom < 5) return 220;
  if (zoom < 6) return 320;
  return 460;
}

function selectAlertsForCurrentZoom(alerts) {
  const zoom = Number(state.map?.getZoom?.() || 2);
  const maxMarkers = getMarkerLimitForZoom(zoom);

  if (!state.map || zoom < 3.5) {
    return alerts.slice(0, maxMarkers);
  }

  const bounds = state.map.getBounds?.();
  if (!bounds) {
    return alerts.slice(0, maxMarkers);
  }

  const insideView = [];
  const outsideView = [];

  alerts.forEach((alert) => {
    const [lat, lng] = getAlertLatLng(alert);
    const point = L.latLng(lat, lng);
    if (bounds.contains(point)) {
      insideView.push(alert);
    } else {
      outsideView.push(alert);
    }
  });

  return insideView.concat(outsideView).slice(0, maxMarkers);
}

function createMarker(alert) {
  const latLng = getAlertLatLng(alert);
  const signal = detectIncidentSignal(alert);
  const signalVisual = getSignalVisual(signal);
  const severity = normalizeSeverity(alert.severity);
  const shouldPulse = severity === "critical" || severity === "high";
  const markerClasses = [
    "threat-marker",
    shouldPulse ? "is-unread" : "is-read",
    `sev-${severity}`,
    signalVisual.className
  ].join(" ");

  const marker = L.marker(latLng, {
    icon: L.divIcon({
      className: "",
      html: `<div class="${markerClasses}" title="${escapeHtml(signalVisual.label)}"><span class="threat-marker__glyph">${signalVisual.glyph}</span></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    })
  });

  marker.bindPopup(`
    <strong>${escapeHtml(alert.title)}</strong><br>
    ${escapeHtml(alert.city?.name ? `${alert.city.name}, ${alert.country?.name || "Inconnu"}` : alert.country?.name || "Inconnu")} | ${escapeHtml(typeLabel(alert.type))} | ${escapeHtml(signalVisual.label)}
  `);

  marker.on("click", () => {
    state.selectedAlertId = alert._id;
    renderAlertDetails(alert);
  });

  return marker;
}

function renderMapMarkers() {
  const visibleAlerts = getVisibleAlerts();
  recomputeCountryStatusLevels();
  updateCountryHeadlineCounters();
  state.markersLayer.clearLayers();

  const zoom = Number(state.map?.getZoom?.() || 2);

  if (zoom < 3.4) {
    const countrySummaries = buildCountrySummaries(visibleAlerts);
    const maxCountries = Math.max(45, getMarkerLimitForZoom(zoom));

    countrySummaries.slice(0, maxCountries).forEach((summary) => {
      const marker = createCountryMarker(summary);
      state.markersLayer.addLayer(marker);
    });

    if (refs.mapOverlayMetric) {
      refs.mapOverlayMetric.textContent = `${Math.min(countrySummaries.length, maxCountries)}/${
        countrySummaries.length
      } pays | ${visibleAlerts.length} alertes | zoom ${zoom.toFixed(1)}`;
    }
    return;
  }

  const renderedAlerts = selectAlertsForCurrentZoom(visibleAlerts);

  renderedAlerts.forEach((alert) => {
    const marker = createMarker(alert);
    state.markersLayer.addLayer(marker);
  });

  if (refs.mapOverlayMetric) {
    refs.mapOverlayMetric.textContent = `${renderedAlerts.length}/${visibleAlerts.length} alertes | zoom ${zoom.toFixed(
      1
    )}`;
  }
}

function renderAlertDetails(alert) {
  ensureIntelOverlayVisible();
  const signalVisual = getSignalVisual(detectIncidentSignal(alert));
  const confidence = confidenceScoreValue(alert);
  const sourceCount = sourceCountValue(alert);
  const sourcesList = Array.isArray(alert?.sourceNames) && alert.sourceNames.length > 0 ? alert.sourceNames : [alert.sourceName];

  state.selectedCountryKey = null;
  toggleFold("detailFold", true);
  refs.alertDetails.classList.remove("empty-state");
  refs.alertDetails.innerHTML = `
    <h3 class="mb-2">${escapeHtml(alert.title)}</h3>
    <div class="detail-meta mb-2">
      <span class="meta-chip">${escapeHtml(typeLabel(alert.type))}</span>
      <span class="meta-chip">${escapeHtml(signalVisual.label)}</span>
      <span class="meta-chip ${alert.confirmed ? "confirmed-chip" : "unconfirmed-chip"}">${escapeHtml(
    confirmationLabel(alert)
  )}</span>
      <span class="meta-chip confidence-chip">Confiance ${confidence}%</span>
      <span class="meta-chip severity-${escapeHtml(alert.severity)}">${escapeHtml(severityLabel(alert.severity))}</span>
      ${alert.city?.name ? `<span class="meta-chip">${escapeHtml(alert.city.name)}</span>` : ""}
      <span class="meta-chip">${escapeHtml(alert.country?.name || "Inconnu")}</span>
      <span class="meta-chip">${escapeHtml(alert.country?.region || "Global")}</span>
    </div>
    <p class="mb-2"><strong>Résumé:</strong> ${escapeHtml(alert.summary || "Résumé non disponible")}</p>
    <p class="mb-2"><strong>Source:</strong> ${escapeHtml(alert.sourceName || "Inconnue")}</p>
    <p class="mb-2"><strong>Ville:</strong> ${escapeHtml(alert.city?.name || "Non précisée")}</p>
    <p class="mb-2"><strong>Validation:</strong> ${escapeHtml(confirmationLabel(alert))} | <strong>Confiance:</strong> ${confidence}% | <strong>Sources croisées:</strong> ${sourceCount}</p>
    <p class="mb-2"><strong>Sources cluster:</strong> ${escapeHtml(sourcesList.join(", "))}</p>
    <p class="mb-2"><strong>Horodatage:</strong> ${escapeHtml(formatDate(alert.publishedAt || alert.createdAt))}</p>
    <a href="${escapeHtml(alert.sourceUrl)}" class="btn btn-sm btn-outline-warning" target="_blank" rel="noopener noreferrer">
      Ouvrir l'article officiel
    </a>
  `;
}

function renderTicker() {
  const source = state.alerts
    .filter((alert) => canonicalType(alert?.type) === "geopolitique")
    .sort((a, b) => {
      const aTime = new Date(a?.publishedAt || a?.createdAt || 0).getTime();
      const bTime = new Date(b?.publishedAt || b?.createdAt || 0).getTime();
      return bTime - aTime;
    })
    .slice(0, 12);

  if (source.length === 0) {
    refs.latestTickerContent.classList.add("no-scroll");
    refs.latestTickerContent.textContent = "Aucune alerte pour cette vue.";
    return;
  }

  const shouldScroll = source.length > 1;
  const singleTrack = source
    .map(
      (alert) =>
        `<span class="ticker-item"><span class="dot"></span><span class="ticker-title">${escapeHtml(
          alert.title
        )}</span><span class="ticker-time">${escapeHtml(formatShortDate(alert.publishedAt || alert.createdAt))}</span></span>`
    )
    .join("");

  refs.latestTickerContent.classList.toggle("no-scroll", !shouldScroll);
  refs.latestTickerContent.innerHTML = shouldScroll ? `${singleTrack}${singleTrack}` : singleTrack;
}

function renderAlertsList() {
  const visibleAlerts = getVisibleAlerts();

  if (visibleAlerts.length === 0) {
    refs.alertsList.innerHTML = '<p class="text-secondary small">Aucune alerte pour ces filtres.</p>';
    return;
  }

  refs.alertsList.innerHTML = visibleAlerts
    .map((alert) => {
      const isSelected = alert._id === state.selectedAlertId;
      const signalVisual = getSignalVisual(detectIncidentSignal(alert));
      const confidence = confidenceScoreValue(alert);
      const sourceCount = sourceCountValue(alert);
      return `
        <article class="alert-item ${isSelected ? "border-warning" : ""}" data-alert-id="${alert._id}">
          <p class="alert-title">${escapeHtml(alert.title)}</p>
          <div class="alert-meta">
            <span class="meta-chip">${escapeHtml(typeLabel(alert.type))}</span>
            <span class="meta-chip">${escapeHtml(signalVisual.label)}</span>
            <span class="meta-chip ${alert.confirmed ? "confirmed-chip" : "unconfirmed-chip"}">${escapeHtml(
        confirmationLabel(alert)
      )}</span>
            <span class="meta-chip confidence-chip">${confidence}%</span>
            <span class="meta-chip severity-${escapeHtml(alert.severity)}">${escapeHtml(severityLabel(alert.severity))}</span>
            ${alert.city?.name ? `<span class="meta-chip">${escapeHtml(alert.city.name)}</span>` : ""}
            <span class="meta-chip">${escapeHtml(alert.country?.name || "Inconnu")}</span>
          </div>
          <p class="small text-secondary mb-2">${escapeHtml(formatDate(alert.publishedAt || alert.createdAt))} | ${escapeHtml(
        alert.sourceName
      )} | ${sourceCount} source(s)</p>
          <div class="alert-actions">
            <button class="btn btn-outline-danger" data-action="delete" data-id="${alert._id}">Supprimer</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderKeywordsWidget() {
  const stopWords = new Set([
    "with",
    "from",
    "that",
    "this",
    "have",
    "about",
    "after",
    "before",
    "their",
    "under",
    "more",
    "than",
    "pour",
    "dans",
    "avec",
    "une",
    "des",
    "les",
    "sur",
    "sont",
    "plus",
    "apres",
    "before",
    "will",
    "iran",
    "israel",
    "says",
    "said"
  ]);

  const counts = new Map();

  state.alerts.slice(0, 220).forEach((alert) => {
    const text = normalizeText(`${alert.title || ""} ${alert.summary || ""}`);
    text
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !stopWords.has(token))
      .forEach((token) => {
        counts.set(token, (counts.get(token) || 0) + 1);
      });
  });

  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);

  if (top.length === 0) {
    refs.keywordsList.innerHTML = '<div class="market-row"><span>Aucun mot-clé</span><span class="value">0</span></div>';
    return;
  }

  refs.keywordsList.innerHTML = top
    .map(
      ([word, count], index) =>
        `<div class="keyword-row"><span><span class="rank">#${index + 1}</span> ${escapeHtml(word)}</span><span>${count} mentions</span></div>`
    )
    .join("");
}

function renderRiskMix(stats) {
  const bySeverity = new Map(stats.bySeverity.map((item) => [item._id, item.count]));
  const total =
    (bySeverity.get("critical") || 0) +
    (bySeverity.get("high") || 0) +
    (bySeverity.get("medium") || 0) +
    (bySeverity.get("low") || 0);

  const rows = [
    { label: "Critical Risk", key: "critical", tone: "severity-critical" },
    { label: "High Risk", key: "high", tone: "severity-high" },
    { label: "Medium Risk", key: "medium", tone: "severity-medium" },
    { label: "Low Risk", key: "low", tone: "severity-low" }
  ];

  refs.marketsList.innerHTML = rows
    .map((row) => {
      const value = bySeverity.get(row.key) || 0;
      const percent = total > 0 ? Math.round((value / total) * 100) : 0;
      return `<div class="market-row"><span class="${row.tone}">${row.label}</span><span class="value">${value} (${percent}%)</span></div>`;
    })
    .join("");
}

function renderTensionChart() {
  if (!refs.tensionChart) return;

  const today = new Date();
  const days = [];
  const counts = new Map();

  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(key);
    counts.set(key, 0);
  }

  const severityWeight = {
    low: 1,
    medium: 2,
    high: 4,
    critical: 7
  };

  state.alerts.forEach((alert) => {
    const key = new Date(alert.publishedAt || alert.createdAt).toISOString().slice(0, 10);
    if (counts.has(key)) {
      counts.set(key, counts.get(key) + (severityWeight[alert.severity] || 1));
    }
  });

  const labels = days.map((key) => {
    const d = new Date(`${key}T00:00:00`);
    return d.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit" });
  });
  const values = days.map((key) => counts.get(key));

  if (state.charts.tension) {
    state.charts.tension.destroy();
  }

  state.charts.tension = new Chart(refs.tensionChart.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Indice de tension",
          data: values,
          borderColor: "#35ef9f",
          backgroundColor: "rgba(53,239,159,0.14)",
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 2
        }
      ]
    },
    options: {
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: "#8e97a8" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: "#8e97a8" }, grid: { color: "rgba(255,255,255,0.06)" } }
      }
    }
  });
}

function renderCharts(stats) {
  const mergedTypeCounts = new Map();
  stats.byType.forEach((item) => {
    const key = canonicalType(item._id);
    mergedTypeCounts.set(key, (mergedTypeCounts.get(key) || 0) + item.count);
  });
  const mergedTypes = Array.from(mergedTypeCounts.entries()).sort((a, b) => b[1] - a[1]);
  const typeLabels = mergedTypes.map(([key]) => typeLabel(key));
  const typeValues = mergedTypes.map(([, count]) => count);

  if (state.charts.type) {
    state.charts.type.destroy();
  }

  state.charts.type = new Chart(refs.typeChart.getContext("2d"), {
    type: "bar",
    data: {
      labels: typeLabels,
      datasets: [
        {
          label: "Répartition",
          data: typeValues,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.1)",
          backgroundColor: ["#ff3341", "#ffd24a", "#35ef9f", "#39d0ff", "#8e97a8"]
        }
      ]
    },
    options: {
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: "#8e97a8" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: "#8e97a8" }, grid: { color: "rgba(255,255,255,0.06)" } }
      }
    }
  });

  if (state.charts.country) {
    state.charts.country.destroy();
  }

  const countryLabels = stats.byCountry.map((item) => item._id);
  const countryValues = stats.byCountry.map((item) => item.count);

  state.charts.country = new Chart(refs.countryChart.getContext("2d"), {
    type: "line",
    data: {
      labels: countryLabels,
      datasets: [
        {
          label: "Hotspots",
          data: countryValues,
          fill: true,
          tension: 0.35,
          borderColor: "#ff3341",
          backgroundColor: "rgba(255,51,65,0.18)",
          pointRadius: 2
        }
      ]
    },
    options: {
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: "#8e97a8" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: "#8e97a8" }, grid: { color: "rgba(255,255,255,0.06)" } }
      }
    }
  });
}

function styleCountryFeature(feature) {
  return {
    weight: 0.55,
    color: "rgba(150,178,215,0.36)",
    fillOpacity: 0.04,
    fillColor: "#8aa4cc"
  };
}

function getFeatureCountryName(feature) {
  const props = feature.properties || {};
  return props.ADMIN || props.NAME || props.name || props.country || props.SOVEREIGNT || props.BRK_NAME || "Inconnu";
}

function normalizeCountryKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeCountryAlias(key) {
  const aliases = {
    "united states of america": "united states",
    usa: "united states",
    us: "united states",
    "russian federation": "russia",
    "republic of korea": "south korea",
    "democratic people s republic of korea": "north korea",
    "iran islamic republic of": "iran",
    "syrian arab republic": "syria",
    "state of palestine": "palestine",
    "palestinian territories": "palestine"
  };

  return aliases[key] || key;
}

function severityToCountryLevel(severity) {
  const normalized = normalizeSeverity(severity);
  if (normalized === "critical" || normalized === "high") {
    return 3;
  }
  if (normalized === "medium" || normalized === "low") {
    return 2;
  }
  return 1;
}

function recomputeCountryStatusLevels() {
  const levels = new Map();

  state.alerts.forEach((alert) => {
    if (canonicalType(alert?.type) !== "geopolitique") {
      return;
    }

    const countryName = alert?.country?.name;
    if (!countryName || countryName === "Inconnu") {
      return;
    }

    const key = normalizeCountryAlias(normalizeCountryKey(countryName));
    if (!key) {
      return;
    }

    const previous = levels.get(key) || 1;
    levels.set(key, Math.max(previous, severityToCountryLevel(alert?.severity)));
  });

  state.countryStatusLevels = levels;
}

function updateCountryHeadlineCounters() {
  let activeCountries = 0;
  let tensionCountries = 0;

  state.countryStatusLevels.forEach((level) => {
    if (level >= 3) {
      activeCountries += 1;
      return;
    }

    if (level === 2) {
      tensionCountries += 1;
    }
  });

  refs.totalAlertsCount.textContent = String(activeCountries);
  refs.criticalAlertsCount.textContent = String(tensionCountries);
}

function getCountryStatus(countryName) {
  const key = normalizeCountryAlias(normalizeCountryKey(countryName));
  const level = state.countryStatusLevels.get(key) || 1;

  if (level >= 3) {
    return "critical";
  }
  if (level === 2) {
    return "tension";
  }
  return "normal";
}

function getCountryHoverStyle(countryName) {
  const status = getCountryStatus(countryName);

  if (status === "critical") {
    return {
      weight: 1.35,
      color: "#ff3341",
      fillOpacity: 0.28,
      fillColor: "#ff3341"
    };
  }

  if (status === "tension") {
    return {
      weight: 1.35,
      color: "#ffd24a",
      fillOpacity: 0.24,
      fillColor: "#ffd24a"
    };
  }

  return {
    weight: 1.35,
    color: "#35ef9f",
    fillOpacity: 0.2,
    fillColor: "#35ef9f"
  };
}

function countryStatusLabel(status) {
  return (
    {
      normal: "Normal",
      tension: "Tension",
      critical: "Critique"
    }[status] || "Normal"
  );
}

function countryStatusClass(status) {
  return (
    {
      normal: "status-normal",
      tension: "status-tension",
      critical: "status-critical"
    }[status] || "status-normal"
  );
}

function getCountryKeyFromAlert(alert) {
  const code = String(alert?.country?.code || "").toUpperCase().trim();
  if (code && code !== "XX") {
    return `code:${code}`;
  }

  const nameKey = normalizeCountryAlias(normalizeCountryKey(alert?.country?.name || ""));
  return nameKey ? `name:${nameKey}` : "";
}

function getCountryCenter(group) {
  const countryName = group?.country?.name;
  if (countryName && state.countryCentroids.has(countryName)) {
    return state.countryCentroids.get(countryName);
  }

  let latSum = 0;
  let lngSum = 0;
  let count = 0;

  group.alerts.slice(0, 40).forEach((alert) => {
    const [lat, lng] = getAlertLatLng(alert);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      latSum += lat;
      lngSum += lng;
      count += 1;
    }
  });

  if (count > 0) {
    return [latSum / count, lngSum / count];
  }

  return [20, 0];
}

function buildCountrySummaries(alerts) {
  const groups = new Map();

  alerts.forEach((alert) => {
    const countryKey = getCountryKeyFromAlert(alert);
    if (!countryKey) {
      return;
    }

    if (!groups.has(countryKey)) {
      groups.set(countryKey, {
        key: countryKey,
        country: {
          name: alert?.country?.name || "Inconnu",
          code: alert?.country?.code || "XX",
          region: alert?.country?.region || "Global"
        },
        alerts: []
      });
    }

    groups.get(countryKey).alerts.push(alert);
  });

  return Array.from(groups.values())
    .map((group) => {
      const sortedAlerts = sortAlertsByEventTimeDesc(group.alerts);
      const latest = sortedAlerts[0];
      const status = getCountryStatus(group.country.name);

      return {
        ...group,
        alerts: sortedAlerts,
        latestAt: getAlertEventTimestamp(latest),
        status,
        center: getCountryCenter({ ...group, alerts: sortedAlerts })
      };
    })
    .sort((a, b) => b.latestAt - a.latestAt);
}

function getCountryLabelCode(summary) {
  const code = String(summary?.country?.code || "").toUpperCase().trim();
  if (code && code !== "XX") {
    return code;
  }

  const fallback = String(summary?.country?.name || "?")
    .replace(/[^A-Za-z]/g, "")
    .slice(0, 2)
    .toUpperCase();

  return fallback || "??";
}

function createCountryMarker(summary) {
  const [lat, lng] = summary.center || [20, 0];
  const statusClass = countryStatusClass(summary.status);
  const labelCode = getCountryLabelCode(summary);

  const marker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="country-marker ${statusClass}"><span>${escapeHtml(labelCode)}</span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    })
  });

  marker.bindPopup(`
    <strong>${escapeHtml(summary.country.name || "Inconnu")}</strong><br>
    Statut: ${escapeHtml(countryStatusLabel(summary.status))} | ${summary.alerts.length} alertes
  `);

  marker.on("click", () => {
    renderCountryDetails(summary).catch((error) => {
      showToast("Erreur profil pays", error.message);
    });
  });

  return marker;
}

async function fetchCountryProfile(summary) {
  const code = String(summary?.country?.code || "").toUpperCase().trim();
  const cacheKey = code && code !== "XX" ? `code:${code}` : `name:${normalizeCountryKey(summary?.country?.name || "")}`;

  if (state.countryProfileCache.has(cacheKey)) {
    return state.countryProfileCache.get(cacheKey);
  }

  const params = new URLSearchParams();
  if (code && code !== "XX") {
    params.set("code", code);
  } else if (summary?.country?.name) {
    params.set("name", summary.country.name);
  }

  if (!params.toString()) {
    return null;
  }

  try {
    const profile = await api(`/api/country-profile?${params.toString()}`);
    state.countryProfileCache.set(cacheKey, profile);
    return profile;
  } catch (error) {
    return null;
  }
}

function formatPopulation(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "Non disponible";
  }
  return amount.toLocaleString("fr-FR");
}

async function renderCountryDetails(summary) {
  ensureIntelOverlayVisible();
  const key = summary?.key || `${summary?.country?.name || "country"}-${Date.now()}`;
  state.selectedCountryKey = key;
  state.selectedAlertId = null;

  const statusLabel = countryStatusLabel(summary.status);
  const statusClass = countryStatusClass(summary.status);

  toggleFold("detailFold", true);
  refs.alertDetails.classList.remove("empty-state");
  refs.alertDetails.innerHTML = `
    <h3 class="mb-2">${escapeHtml(summary.country.name || "Pays inconnu")}</h3>
    <div class="detail-meta mb-2">
      <span class="meta-chip ${statusClass}">${escapeHtml(statusLabel)}</span>
      <span class="meta-chip">${summary.alerts.length} alertes</span>
      <span class="meta-chip">${escapeHtml(summary.country.region || "Global")}</span>
    </div>
    <p class="mb-0 small text-secondary">Chargement du profil pays...</p>
  `;

  const profile = await fetchCountryProfile(summary);
  if (state.selectedCountryKey !== key) {
    return;
  }

  const latestAlerts = summary.alerts.slice(0, 5);
  const countryName = profile?.name || summary.country.name || "Inconnu";
  const flag = profile?.flag || "🏳️";
  const capital = profile?.capital || "Non disponible";
  const subregion = profile?.subregion || "";
  const population = formatPopulation(profile?.population);
  const leader = profile?.leader || "Non disponible";

  refs.alertDetails.innerHTML = `
    <h3 class="mb-2">${escapeHtml(countryName)} <span class="country-flag">${escapeHtml(flag)}</span></h3>
    <div class="detail-meta mb-2">
      <span class="meta-chip ${statusClass}">${escapeHtml(statusLabel)}</span>
      <span class="meta-chip">${latestAlerts.length} derniers événements</span>
      <span class="meta-chip">${escapeHtml(summary.country.code || "XX")}</span>
    </div>
    <p class="mb-1"><strong>Capitale:</strong> ${escapeHtml(capital)}</p>
    <p class="mb-1"><strong>Région:</strong> ${escapeHtml(summary.country.region || "Global")}${
      subregion ? ` / ${escapeHtml(subregion)}` : ""
    }</p>
    <p class="mb-1"><strong>Population:</strong> ${escapeHtml(population)}</p>
    <p class="mb-2"><strong>Président / dirigeant:</strong> ${escapeHtml(leader)}</p>
    <div class="country-events">
      <h4 class="country-events-title">Dernières alertes</h4>
      ${latestAlerts
        .map(
          (alert) => `
        <article class="country-event-item">
          <p class="country-event-title"><span class="severity-${escapeHtml(alert.severity)}">${escapeHtml(
            severityLabel(alert.severity)
          )}</span> - ${escapeHtml(alert.title)}</p>
          <p class="country-event-meta">${escapeHtml(formatDate(alert.publishedAt || alert.createdAt))} | ${escapeHtml(
            alert.sourceName || "Source inconnue"
          )}</p>
          <a href="${escapeHtml(alert.sourceUrl)}" target="_blank" rel="noopener noreferrer">Ouvrir la source</a>
        </article>
      `
        )
        .join("")}
    </div>
  `;
}

async function loadAlerts() {
  const filters = getCurrentFilters();
  const query = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== "") {
      query.set(key, value);
    }
  });

  if (!query.has("type")) {
    query.set("type", "geopolitique");
  }

  const mode = state.settings?.alertMode || "insight";
  if (mode === "action") {
    query.set("mode", "action");
  }

  const payload = await api(`/api/alerts?${query.toString()}&limit=120`);
  // Always render newest events on top based on event time.
  state.alerts = sortAlertsByEventTimeDesc(payload.alerts);

  if (state.countryLayer) {
    state.countryLayer.setStyle(styleCountryFeature);
  }

  if (state.selectedAlertId) {
    const selected = state.alerts.find((alert) => alert._id === state.selectedAlertId);
    if (selected) {
      renderAlertDetails(selected);
    } else {
      state.selectedAlertId = null;
      refs.alertDetails.classList.add("empty-state");
      refs.alertDetails.textContent = "Cliquez sur une alerte pour afficher le détail complet.";
    }
  }

  renderAlertsList();
  renderMapMarkers();
  renderTicker();
  renderKeywordsWidget();
  renderTensionChart();
}

async function loadCountryOptions() {
  const selectedCountry = refs.countryFilter.value;
  const selectedSettingsCountries = Array.from(refs.settingsCountryFilter.selectedOptions).map((opt) => opt.value);

  const countries = await api("/api/countries");

  refs.countryFilter.innerHTML = ["<option value=\"\">Tous</option>"]
    .concat(countries.map((country) => `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`))
    .join("");

  if (selectedCountry && countries.includes(selectedCountry)) {
    refs.countryFilter.value = selectedCountry;
  }

  refs.settingsCountryFilter.innerHTML = countries
    .map((country) => `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`)
    .join("");

  Array.from(refs.settingsCountryFilter.options).forEach((option) => {
    option.selected =
      selectedSettingsCountries.includes(option.value) ||
      (state.settings?.countryFilters || []).includes(option.value);
  });
}

async function loadRegionOptions() {
  const selectedRegion = refs.regionFilter.value;
  const regions = await api("/api/regions");

  refs.regionFilter.innerHTML = ["<option value=\"\">Toutes</option>"]
    .concat(regions.map((region) => `<option value="${escapeHtml(region)}">${escapeHtml(region)}</option>`))
    .join("");

  if (selectedRegion && regions.includes(selectedRegion)) {
    refs.regionFilter.value = selectedRegion;
  }
}

function applySettingsToControls() {
  if (!state.settings) return;

  const modeValue = state.settings.alertMode === "action" ? "action" : "insight";
  refs.alertModeSelect.value = modeValue;

  const intervalValue = String(state.settings.pollIntervalSeconds || 300);
  const hasOption = Array.from(refs.intervalSelect.options).some((opt) => opt.value === intervalValue);

  if (!hasOption) {
    const customOption = document.createElement("option");
    customOption.value = intervalValue;
    customOption.textContent = `${intervalValue} sec`;
    refs.intervalSelect.appendChild(customOption);
  }

  refs.intervalSelect.value = intervalValue;
  refs.keywordInput.value = (state.settings.keywordFilters || []).join(", ");
  updateSoundToggleUI();
  updateCoverageToggleUI();

  Array.from(refs.settingsCountryFilter.options).forEach((option) => {
    option.selected = (state.settings.countryFilters || []).includes(option.value);
  });

  updateDetectionStatus();
}

function updateDetectionStatus() {
  if (!state.settings) return;

  const paused = Boolean(state.settings.paused);
  const modeLabel = state.settings.alertMode === "action" ? "ACTION" : "VEILLE";
  refs.detectionStatus.textContent = paused ? `PAUSED | ${modeLabel}` : `LIVE | ${modeLabel}`;
  refs.detectionStatus.className = `status-pill ${paused ? "paused" : "live"}`;
  refs.togglePauseBtn.textContent = paused ? "Reprendre" : "Pause";
}

function getUiRefreshIntervalSeconds() {
  const candidate = Number(state.settings?.pollIntervalSeconds || refs.intervalSelect?.value || 300);
  if (!Number.isFinite(candidate)) {
    return 300;
  }
  return Math.max(30, candidate);
}

async function refreshDashboardCycle() {
  if (uiRefreshInFlight) return;
  uiRefreshInFlight = true;

  try {
    await Promise.all([loadAlerts(), loadStats()]);
    uiRefreshTick += 1;

    // Keep country/region filters up to date without overloading every cycle.
    if (uiRefreshTick % 4 === 0) {
      await Promise.all([loadCountryOptions(), loadRegionOptions()]);
    }
  } catch (error) {
    console.warn("[refresh] cycle error:", error.message);
  } finally {
    uiRefreshInFlight = false;
  }
}

function scheduleAutoRefresh() {
  const intervalMs = getUiRefreshIntervalSeconds() * 1000;

  if (uiRefreshTimer) {
    clearTimeout(uiRefreshTimer);
  }

  const tick = async () => {
    await refreshDashboardCycle();
    uiRefreshTimer = setTimeout(tick, getUiRefreshIntervalSeconds() * 1000);
  };

  uiRefreshTimer = setTimeout(tick, intervalMs);
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  applySettingsToControls();
  scheduleAutoRefresh();
}

async function saveSettings() {
  const keywordFilters = refs.keywordInput.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const countryFilters = Array.from(refs.settingsCountryFilter.selectedOptions).map((opt) => opt.value);

  state.settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      pollIntervalSeconds: Number(refs.intervalSelect.value),
      keywordFilters,
      countryFilters
    })
  });

  updateDetectionStatus();
  showToast("Préférences enregistrées", "Les filtres de détection ont été mis à jour.");
}

async function togglePause() {
  if (!state.settings) return;

  state.settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      paused: !state.settings.paused
    })
  });

  updateDetectionStatus();
  showToast(
    "Détection",
    state.settings.paused ? "La détection automatique est en pause." : "La détection automatique reprend."
  );
}

async function updateInterval() {
  if (!state.settings) return;

  state.settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      pollIntervalSeconds: Number(refs.intervalSelect.value)
    })
  });

  showToast("Fréquence mise à jour", `Nouvelle fréquence: ${state.settings.pollIntervalSeconds} sec.`);
  scheduleAutoRefresh();
}

async function toggleSound() {
  if (!state.settings) return;

  const nextSoundEnabled = !isSoundEnabled();
  state.settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      soundEnabled: nextSoundEnabled
    })
  });

  updateSoundToggleUI();
  showToast(
    "Audio alertes",
    nextSoundEnabled
      ? "Les alertes sonores et vocales sont activées."
      : "Les alertes sonores et vocales sont désactivées."
  );
}

async function toggleCoverage() {
  if (!state.settings) return;

  const nextCoverage = !isGlobalCoverageEnabled();
  state.settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      globalCoverage: nextCoverage
    })
  });

  updateCoverageToggleUI();
  showToast(
    "Couverture conflits",
    nextCoverage
      ? "Couverture globale active: ingestion de tous les conflits détectés."
      : "Mode focalisé actif: filtres mots-clés/pays appliqués à l'ingestion."
  );

  await Promise.all([loadAlerts(), loadStats(), loadCountryOptions(), loadRegionOptions()]);
}

async function updateAlertMode() {
  if (!state.settings) return;

  const nextMode = refs.alertModeSelect.value === "action" ? "action" : "insight";
  state.settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      alertMode: nextMode
    })
  });

  updateDetectionStatus();
  showToast(
    "Mode de surveillance",
    nextMode === "action"
      ? "Mode ACTION actif: priorité aux signaux critiques terrain."
      : "Mode VEILLE actif: flux article complet.",
    nextMode === "action" ? "high" : "neutral",
    4600
  );

  await Promise.all([loadAlerts(), loadStats()]);
}

async function runManualDetection() {
  refs.refreshNowBtn.disabled = true;
  try {
    const payload = await api("/api/detect/now", { method: "POST" });
    showToast("Analyse terminée", `${payload.inserted} nouvelle(s) alerte(s) détectée(s).`);
    await Promise.all([loadAlerts(), loadCountryOptions(), loadRegionOptions(), loadStats()]);
  } finally {
    refs.refreshNowBtn.disabled = false;
  }
}

async function deleteAlert(id) {
  await api(`/api/alerts/${id}`, { method: "DELETE" });

  if (state.selectedAlertId === id) {
    state.selectedAlertId = null;
    refs.alertDetails.classList.add("empty-state");
    refs.alertDetails.textContent = "Cliquez sur une alerte pour afficher le détail complet.";
  }

  await Promise.all([loadAlerts(), loadStats(), loadCountryOptions(), loadRegionOptions()]);
}

function bindQuickFilters() {
  const buttons = Array.from(document.querySelectorAll(".quick-filter"));

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      refs.severityFilter.value = button.dataset.quickSeverity || "";
      loadAlerts().catch((error) => showToast("Erreur", error.message));
    });
  });

  if (buttons[0]) {
    buttons[0].classList.add("active");
  }
}

function bindEvents() {
  [refs.typeFilter, refs.countryFilter, refs.regionFilter, refs.severityFilter, refs.confirmedFilter].forEach((el) => {
    el.addEventListener("change", () => {
      loadAlerts().catch((error) => showToast("Erreur", error.message));
    });
  });

  refs.searchInput.addEventListener("input", () => {
    renderAlertsList();
    renderMapMarkers();
    renderTicker();
    renderKeywordsWidget();
  });

  refs.resetFiltersBtn.addEventListener("click", () => {
    refs.typeFilter.value = "";
    refs.countryFilter.value = "";
    refs.regionFilter.value = "";
    refs.severityFilter.value = "";
    refs.confirmedFilter.value = "";
    refs.searchInput.value = "";

    document.querySelectorAll(".quick-filter").forEach((btn) => btn.classList.remove("active"));
    const first = document.querySelector('.quick-filter[data-quick-severity=""]');
    if (first) {
      first.classList.add("active");
    }

    loadAlerts().catch((error) => showToast("Erreur", error.message));
  });

  refs.saveSettingsBtn.addEventListener("click", () => {
    saveSettings().catch((error) => showToast("Erreur", error.message));
  });

  refs.togglePauseBtn.addEventListener("click", () => {
    togglePause().catch((error) => showToast("Erreur", error.message));
  });

  refs.intervalSelect.addEventListener("change", () => {
    updateInterval().catch((error) => showToast("Erreur", error.message));
  });

  if (refs.toggleSoundBtn) {
    refs.toggleSoundBtn.addEventListener("click", () => {
      toggleSound().catch((error) => showToast("Erreur", error.message));
    });
  }

  if (refs.toggleCoverageBtn) {
    refs.toggleCoverageBtn.addEventListener("click", () => {
      toggleCoverage().catch((error) => showToast("Erreur", error.message));
    });
  }

  refs.alertModeSelect.addEventListener("change", () => {
    updateAlertMode().catch((error) => showToast("Erreur", error.message));
  });

  refs.refreshNowBtn.addEventListener("click", () => {
    runManualDetection().catch((error) => showToast("Erreur", error.message));
  });

  refs.alertsList.addEventListener("click", (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (actionButton) {
      event.stopPropagation();
      const id = actionButton.dataset.id;
      const action = actionButton.dataset.action;

      if (action === "delete") {
        deleteAlert(id).catch((error) => showToast("Erreur", error.message));
      }

      return;
    }

    const card = event.target.closest("[data-alert-id]");
    if (!card) return;

    const alert = state.alerts.find((item) => item._id === card.dataset.alertId);
    if (!alert) return;

    state.selectedAlertId = alert._id;
    renderAlertDetails(alert);
    renderAlertsList();
  });

  document.body.addEventListener(
    "click",
    () => {
      initSpeechVoices();
      ensureAudio();
      if (audioContext?.state === "suspended") {
        audioContext.resume().catch(() => {});
      }
    },
    { once: true }
  );

  bindQuickFilters();
  bindFoldToggles();
  bindColumnToggles();

  window.addEventListener("resize", () => {
    if (layoutResizeTimer) {
      clearTimeout(layoutResizeTimer);
    }
    layoutResizeTimer = setTimeout(() => {
      refreshLayout();
    }, 150);
  });
}

async function loadStats() {
  const mode = state.settings?.alertMode === "action" ? "action" : "";
  const stats = await api(mode ? `/api/stats?mode=${mode}` : "/api/stats");

  renderCharts(stats);
  renderRiskMix(stats);
  renderKeywordsWidget();
  renderTensionChart();
}

async function loadCountryGeoJson() {
  const url = "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Impossible de charger la carte des pays");
  }

  const geojson = await response.json();

  if (state.countryLayer) {
    state.map.removeLayer(state.countryLayer);
  }

  state.countryLayer = L.geoJSON(geojson, {
    style: styleCountryFeature,
    onEachFeature: (feature, layer) => {
      const countryName = getFeatureCountryName(feature);
      const center = layer.getBounds().getCenter();
      state.countryCentroids.set(countryName, [center.lat, center.lng]);

      layer.on("mouseover", () => {
        layer.setStyle(getCountryHoverStyle(countryName));
      });

      layer.on("mouseout", () => {
        if (state.countryLayer && typeof state.countryLayer.resetStyle === "function") {
          state.countryLayer.resetStyle(layer);
        } else {
          layer.setStyle(styleCountryFeature(feature));
        }
      });
    }
  });

  state.countryLayer.addTo(state.map);
}

function initializeMap() {
  state.map = L.map("map", {
    worldCopyJump: true,
    zoomControl: true,
    minZoom: 2,
    maxZoom: 7
  }).setView([27, 11], 2.2);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(state.map);

  state.markersLayer = L.layerGroup().addTo(state.map);

  state.map.on("zoomend", () => {
    renderMapMarkers();
  });

  state.map.on("moveend", () => {
    renderMapMarkers();
  });
}

function connectEventStream() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource("/api/stream");

  state.eventSource.addEventListener("new-alert", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const alert = payload.alert;
      if (canonicalType(alert?.type) !== "geopolitique") {
        return;
      }
      const alreadyExists = state.alerts.some((existing) => existing._id === alert._id);

      if (!alreadyExists && matchesCurrentFilters(alert)) {
        state.alerts.push(alert);
        state.alerts = sortAlertsByEventTimeDesc(state.alerts);
      }

      renderAlertsList();
      renderMapMarkers();
      renderTicker();
      renderKeywordsWidget();
      renderTensionChart();
      loadCountryOptions().catch(() => {});
      loadRegionOptions().catch(() => {});
      loadStats().catch(() => {});

      if (isSoundEnabled()) {
        playNotificationSound(alert.severity);
        speakAlertMessage(alert);
      }
      triggerAlertFlash(alert);
      showToast(
        "Nouvelle alerte détectée",
        `${alert.country?.name || "Localisation inconnue"} | ${typeLabel(alert.type)}`,
        alert.severity,
        alert.severity === "critical" ? 6500 : 5200
      );
    } catch (error) {
      console.error(error);
    }
  });

  state.eventSource.addEventListener("alert-updated", (event) => {
    const payload = JSON.parse(event.data);
    state.alerts = sortAlertsByEventTimeDesc(
      state.alerts.map((alert) => (alert._id === payload.alert._id ? payload.alert : alert))
    );
    renderAlertsList();
    renderMapMarkers();
    renderTicker();
    renderKeywordsWidget();
  });

  state.eventSource.addEventListener("alert-deleted", (event) => {
    const payload = JSON.parse(event.data);
    state.alerts = state.alerts.filter((alert) => alert._id !== payload.id);
    renderAlertsList();
    renderMapMarkers();
    renderTicker();
    renderKeywordsWidget();
  });

  state.eventSource.addEventListener("alerts-confirmation-updated", () => {
    loadAlerts().catch(() => {});
    loadStats().catch(() => {});
  });

  state.eventSource.addEventListener("settings-updated", (event) => {
    const payload = JSON.parse(event.data);
    if (state.settings) {
      state.settings.paused = payload.paused;
      state.settings.pollIntervalSeconds = payload.pollIntervalSeconds;
      if (typeof payload.soundEnabled === "boolean") {
        state.settings.soundEnabled = payload.soundEnabled;
      }
      if (typeof payload.globalCoverage === "boolean") {
        state.settings.globalCoverage = payload.globalCoverage;
      }
      if (payload.alertMode) {
        state.settings.alertMode = payload.alertMode;
        refs.alertModeSelect.value = payload.alertMode;
      }
      updateDetectionStatus();
      updateSoundToggleUI();
      updateCoverageToggleUI();
      scheduleAutoRefresh();
    }
  });

  state.eventSource.onerror = () => {
    const now = Date.now();
    if (now - lastSseErrorAt > 15000) {
      showToast("Connexion temps réel", "Perte temporaire de connexion au flux SSE.");
      lastSseErrorAt = now;
    }
  };
}

async function bootstrap() {
  bindEvents();
  initSpeechVoices();
  initializeMap();

  await loadCountryGeoJson();
  await Promise.all([loadCountryOptions(), loadRegionOptions()]);
  await loadSettings();
  await Promise.all([loadAlerts(), loadStats()]);

  connectEventStream();
  scheduleAutoRefresh();
  refreshLayout();
}

bootstrap().catch((error) => {
  console.error(error);
  showToast("Erreur de démarrage", error.message);
});
