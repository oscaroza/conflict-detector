const state = {
  alerts: [],
  settings: null,
  map: null,
  markersLayer: null,
  countryLayer: null,
  countryCentroids: new Map(),
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
  alertsList: document.getElementById("alertsList"),
  alertDetails: document.getElementById("alertDetails"),
  unreadCounter: document.getElementById("unreadCounter"),
  totalAlertsCount: document.getElementById("totalAlertsCount"),
  unreadAlertsCount: document.getElementById("unreadAlertsCount"),
  criticalAlertsCount: document.getElementById("criticalAlertsCount"),
  detectionStatus: document.getElementById("detectionStatus"),
  togglePauseBtn: document.getElementById("togglePauseBtn"),
  toggleLeftPanelBtn: document.getElementById("toggleLeftPanelBtn"),
  toggleRightPanelBtn: document.getElementById("toggleRightPanelBtn"),
  alertModeSelect: document.getElementById("alertModeSelect"),
  intervalSelect: document.getElementById("intervalSelect"),
  refreshNowBtn: document.getElementById("refreshNowBtn"),
  searchInput: document.getElementById("searchInput"),
  typeFilter: document.getElementById("typeFilter"),
  countryFilter: document.getElementById("countryFilter"),
  regionFilter: document.getElementById("regionFilter"),
  severityFilter: document.getElementById("severityFilter"),
  readFilter: document.getElementById("readFilter"),
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
  if (normalized === "politique" || normalized === "militaire") {
    return "geopolitique";
  }
  return normalized || "autre";
}

function typeLabel(value) {
  return {
    geopolitique: "Geopolitique",
    sport: "Sport",
    economie: "Economie",
    technologie: "Technologie",
    humanitaire: "Humanitaire",
    cyber: "Cyber",
    autre: "Autre",
    politique: "Geopolitique",
    militaire: "Geopolitique"
  }[String(value || "").toLowerCase()] || capitalize(String(value || "autre"));
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

function updateColumnToggleButtons() {
  const hideLeft = refs.workspaceGrid.classList.contains("hide-left");
  const hideRight = refs.workspaceGrid.classList.contains("hide-right");
  refs.toggleLeftPanelBtn.textContent = hideLeft ? "Feed OFF" : "Feed ON";
  refs.toggleRightPanelBtn.textContent = hideRight ? "Widgets OFF" : "Widgets ON";
}

function bindColumnToggles() {
  refs.toggleLeftPanelBtn.addEventListener("click", () => {
    refs.workspaceGrid.classList.toggle("hide-left");
    updateColumnToggleButtons();
    refreshLayout();
  });

  refs.toggleRightPanelBtn.addEventListener("click", () => {
    refs.workspaceGrid.classList.toggle("hide-right");
    updateColumnToggleButtons();
    refreshLayout();
  });

  updateColumnToggleButtons();
}

function getCurrentFilters() {
  return {
    type: refs.typeFilter.value,
    country: refs.countryFilter.value,
    region: refs.regionFilter.value,
    severity: refs.severityFilter.value,
    read: refs.readFilter.value
  };
}

function matchesCurrentFilters(alert) {
  const filters = getCurrentFilters();

  if (filters.type && canonicalType(alert.type) !== filters.type) return false;
  if (filters.country && alert.country?.name !== filters.country) return false;
  if (filters.region && alert.country?.region !== filters.region) return false;
  if (filters.severity && alert.severity !== filters.severity) return false;
  if (filters.read === "true" && !alert.read) return false;
  if (filters.read === "false" && alert.read) return false;

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
  return state.alerts.filter((alert) => matchesSearch(alert));
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

function createMarker(alert) {
  const latLng = getAlertLatLng(alert);
  const isUnread = !alert.read;

  const marker = L.marker(latLng, {
    icon: L.divIcon({
      className: "",
      html: `<div class="${isUnread ? "pulse-marker" : "calm-marker"}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    })
  });

  marker.bindPopup(`
    <strong>${escapeHtml(alert.title)}</strong><br>
    ${escapeHtml(alert.country?.name || "Inconnu")} | ${escapeHtml(typeLabel(alert.type))}
  `);

  marker.on("click", () => {
    state.selectedAlertId = alert._id;
    renderAlertDetails(alert);
  });

  return marker;
}

function renderMapMarkers() {
  const visibleAlerts = getVisibleAlerts();
  state.markersLayer.clearLayers();

  visibleAlerts.slice(0, 220).forEach((alert) => {
    const marker = createMarker(alert);
    state.markersLayer.addLayer(marker);
  });

  if (refs.mapOverlayMetric) {
    refs.mapOverlayMetric.textContent = `${visibleAlerts.length} alertes visibles`;
  }
}

function renderAlertDetails(alert) {
  toggleFold("detailFold", true);
  refs.alertDetails.classList.remove("empty-state");
  refs.alertDetails.innerHTML = `
    <h3 class="mb-2">${escapeHtml(alert.title)}</h3>
    <div class="detail-meta mb-2">
      <span class="meta-chip">${escapeHtml(typeLabel(alert.type))}</span>
      <span class="meta-chip severity-${escapeHtml(alert.severity)}">${escapeHtml(severityLabel(alert.severity))}</span>
      <span class="meta-chip">${escapeHtml(alert.country?.name || "Inconnu")}</span>
      <span class="meta-chip">${escapeHtml(alert.country?.region || "Global")}</span>
    </div>
    <p class="mb-2"><strong>Résumé:</strong> ${escapeHtml(alert.summary || "Résumé non disponible")}</p>
    <p class="mb-2"><strong>Source:</strong> ${escapeHtml(alert.sourceName || "Inconnue")}</p>
    <p class="mb-2"><strong>Horodatage:</strong> ${escapeHtml(formatDate(alert.publishedAt || alert.createdAt))}</p>
    <a href="${escapeHtml(alert.sourceUrl)}" class="btn btn-sm btn-outline-warning" target="_blank" rel="noopener noreferrer">
      Ouvrir l'article officiel
    </a>
  `;
}

function renderTicker() {
  const source = getVisibleAlerts().slice(-10);
  if (source.length === 0) {
    refs.latestTickerContent.textContent = "Aucune alerte pour cette vue.";
    return;
  }

  const singleTrack = source
    .map(
      (alert) =>
        `<span class="ticker-item"><span class="dot"></span><span>${escapeHtml(alert.title)}</span><span>${escapeHtml(
          formatShortDate(alert.publishedAt || alert.createdAt)
        )}</span></span>`
    )
    .join("");

  refs.latestTickerContent.innerHTML = `${singleTrack}${singleTrack}`;
}

function renderAlertsList() {
  const visibleAlerts = getVisibleAlerts();

  if (visibleAlerts.length === 0) {
    refs.alertsList.innerHTML = '<p class="text-secondary small">Aucune alerte pour ces filtres.</p>';
    refs.unreadCounter.textContent = "0 non lues";
    return;
  }

  refs.alertsList.innerHTML = visibleAlerts
    .map((alert) => {
      const isSelected = alert._id === state.selectedAlertId;
      return `
        <article class="alert-item ${alert.read ? "" : "unread"} ${isSelected ? "border-warning" : ""}" data-alert-id="${alert._id}">
          <p class="alert-title">${escapeHtml(alert.title)}</p>
          <div class="alert-meta">
            <span class="meta-chip">${escapeHtml(typeLabel(alert.type))}</span>
            <span class="meta-chip severity-${escapeHtml(alert.severity)}">${escapeHtml(severityLabel(alert.severity))}</span>
            <span class="meta-chip">${escapeHtml(alert.country?.name || "Inconnu")}</span>
          </div>
          <p class="small text-secondary mb-2">${escapeHtml(formatDate(alert.publishedAt || alert.createdAt))} | ${escapeHtml(
        alert.sourceName
      )}</p>
          <div class="alert-actions">
            <button class="btn btn-outline-light" data-action="toggle-read" data-id="${alert._id}" data-read="${alert.read}">
              ${alert.read ? "Marquer non lu" : "Marquer lu"}
            </button>
            <button class="btn btn-outline-danger" data-action="delete" data-id="${alert._id}">Supprimer</button>
          </div>
        </article>
      `;
    })
    .join("");

  const unreadCount = visibleAlerts.filter((alert) => !alert.read).length;
  refs.unreadCounter.textContent = `${unreadCount} non lues`;
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
  const countryName = getFeatureCountryName(feature);
  const selectedCountry = refs.countryFilter.value;
  const isSelected = selectedCountry && selectedCountry === countryName;

  return {
    weight: isSelected ? 1.3 : 0.55,
    color: isSelected ? "#ffd24a" : "rgba(150,178,215,0.36)",
    fillOpacity: isSelected ? 0.19 : 0.04,
    fillColor: isSelected ? "#ffd24a" : "#8aa4cc"
  };
}

function getFeatureCountryName(feature) {
  const props = feature.properties || {};
  return props.ADMIN || props.NAME || props.name || props.country || props.SOVEREIGNT || props.BRK_NAME || "Inconnu";
}

async function loadAlerts() {
  const filters = getCurrentFilters();
  const query = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== "") {
      query.set(key, value);
    }
  });

  const mode = state.settings?.alertMode || "insight";
  if (mode === "action") {
    query.set("mode", "action");
  }

  const payload = await api(`/api/alerts?${query.toString()}&limit=120`);
  // API returns newest first; reverse to display notifications in arrival order (oldest -> newest).
  state.alerts = [...payload.alerts].reverse();

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

async function loadSettings() {
  state.settings = await api("/api/settings");
  applySettingsToControls();
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

async function setReadState(id, read) {
  await api(`/api/alerts/${id}/read`, {
    method: "PATCH",
    body: JSON.stringify({ read })
  });

  await Promise.all([loadAlerts(), loadStats()]);
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
  [refs.typeFilter, refs.countryFilter, refs.regionFilter, refs.severityFilter, refs.readFilter].forEach((el) => {
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
    refs.readFilter.value = "";
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

      if (action === "toggle-read") {
        const currentRead = actionButton.dataset.read === "true";
        setReadState(id, !currentRead).catch((error) => showToast("Erreur", error.message));
      }

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

    if (!alert.read) {
      setReadState(alert._id, true).catch((error) => showToast("Erreur", error.message));
    }
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
}

async function loadStats() {
  const mode = state.settings?.alertMode === "action" ? "action" : "";
  const stats = await api(mode ? `/api/stats?mode=${mode}` : "/api/stats");

  const total = stats.byType.reduce((acc, item) => acc + item.count, 0);
  const critical = (stats.bySeverity.find((item) => item._id === "critical") || {}).count || 0;

  refs.totalAlertsCount.textContent = String(total);
  refs.unreadAlertsCount.textContent = String(stats.unread || 0);
  refs.criticalAlertsCount.textContent = String(critical);

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

      layer.on("click", () => {
        const hasOption = Array.from(refs.countryFilter.options).some((opt) => opt.value === countryName);
        if (!hasOption) {
          const opt = document.createElement("option");
          opt.value = countryName;
          opt.textContent = countryName;
          refs.countryFilter.appendChild(opt);
        }

        refs.countryFilter.value = countryName;
        loadAlerts().catch((error) => showToast("Erreur", error.message));
        state.countryLayer.setStyle(styleCountryFeature);

        const countryAlerts = state.alerts.filter((alert) => alert.country?.name === countryName);
        if (countryAlerts.length > 0) {
          showToast(`Pays sélectionné: ${countryName}`, `${countryAlerts.length} alerte(s) dans cette vue.`);
        } else {
          showToast(`Pays sélectionné: ${countryName}`, "Aucune alerte dans la vue filtrée.");
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
      const alreadyExists = state.alerts.some((existing) => existing._id === alert._id);

      if (!alreadyExists && matchesCurrentFilters(alert)) {
        state.alerts.push(alert);
      }

      renderAlertsList();
      renderMapMarkers();
      renderTicker();
      renderKeywordsWidget();
      renderTensionChart();
      loadCountryOptions().catch(() => {});
      loadRegionOptions().catch(() => {});
      loadStats().catch(() => {});

      playNotificationSound(alert.severity);
      speakAlertMessage(alert);
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
    state.alerts = state.alerts.map((alert) => (alert._id === payload.alert._id ? payload.alert : alert));
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

  state.eventSource.addEventListener("settings-updated", (event) => {
    const payload = JSON.parse(event.data);
    if (state.settings) {
      state.settings.paused = payload.paused;
      state.settings.pollIntervalSeconds = payload.pollIntervalSeconds;
      if (payload.alertMode) {
        state.settings.alertMode = payload.alertMode;
        refs.alertModeSelect.value = payload.alertMode;
      }
      updateDetectionStatus();
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
  refreshLayout();
}

bootstrap().catch((error) => {
  console.error(error);
  showToast("Erreur de démarrage", error.message);
});
