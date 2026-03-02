const state = {
  alerts: [],
  tickerAlerts: [],
  settings: null,
  map: null,
  markersLayer: null,
  countryLegendLayer: null,
  mapMode: "2d",
  globe: null,
  countryGeoFeaturesByKey: new Map(),
  countryLayer: null,
  countryCentroids: new Map(),
  countryCentroidsByKey: new Map(),
  countryCentroidsByCode: new Map(),
  countryStatusLevels: new Map(),
  countryProfileCache: new Map(),
  selectedCountryKey: null,
  selectedAlertId: null,
  voice: {
    provider: "none",
    remoteAvailable: false,
    fallback: "system"
  },
  charts: {
    type: null,
    country: null,
    tension: null
  },
  eventSource: null,
  smartDigestEnabled: true,
  browserNotifications: {
    supported: false,
    enabled: false,
    permission: "default"
  }
};

const refs = {
  workspaceGrid: document.getElementById("workspaceGrid"),
  intelOverlay: document.getElementById("intelOverlay"),
  leftPanel: document.getElementById("leftPanel"),
  leftFiltersShell: document.getElementById("leftFiltersShell"),
  toggleFiltersSidebarBtn: document.getElementById("toggleFiltersSidebarBtn"),
  alertsList: document.getElementById("alertsList"),
  alertDetails: document.getElementById("alertDetails"),
  totalAlertsCount: document.getElementById("totalAlertsCount"),
  criticalAlertsCount: document.getElementById("criticalAlertsCount"),
  defconCard: document.getElementById("defconCard"),
  defconValue: document.getElementById("defconValue"),
  defconLabel: document.getElementById("defconLabel"),
  pizzaCard: document.getElementById("pizzaCard"),
  pizzaValue: document.getElementById("pizzaValue"),
  pizzaLabel: document.getElementById("pizzaLabel"),
  detectionStatus: document.getElementById("detectionStatus"),
  togglePauseBtn: document.getElementById("togglePauseBtn"),
  toggleRightPanelBtn: document.getElementById("toggleRightPanelBtn"),
  alertModeSelect: document.getElementById("alertModeSelect"),
  intervalSelect: document.getElementById("intervalSelect"),
  toggleCoverageBtn: document.getElementById("toggleCoverageBtn"),
  toggleSmartDigestBtn: document.getElementById("toggleSmartDigestBtn"),
  toggleSoundBtn: document.getElementById("toggleSoundBtn"),
  toggleVoiceBtn: document.getElementById("toggleVoiceBtn"),
  toggleBrowserNotifBtn: document.getElementById("toggleBrowserNotifBtn"),
  toggleMapModeBtn: document.getElementById("toggleMapModeBtn"),
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
  smartDigestCard: document.getElementById("smartDigestCard"),
  mapView: document.getElementById("map"),
  globeView: document.getElementById("globe"),
  marketsList: document.getElementById("marketsList"),
  keywordsList: document.getElementById("keywordsList"),
  alertFlash: document.getElementById("alertFlash"),
  toastHost: document.getElementById("toastHost"),
  bootOverlay: document.getElementById("bootOverlay"),
  bootCurrentTask: document.getElementById("bootCurrentTask"),
  bootProgressBar: document.getElementById("bootProgressBar"),
  bootProgressValue: document.getElementById("bootProgressValue"),
  bootChecklist: document.getElementById("bootChecklist"),
  bootRetryBtn: document.getElementById("bootRetryBtn"),
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
let globeResizeObserver = null;
let bootRetryBound = false;
let activeVoiceAudio = null;
let activeVoiceBlobUrl = null;
let activeVoiceMediaSource = null;
let activeVoiceFxNodes = [];
let lastVoiceFallbackNoticeAt = 0;
let mapSignalExpiryTimer = null;
const BROWSER_NOTIF_STORAGE_KEY = "cd_browser_notifications_enabled";
const SMART_DIGEST_STORAGE_KEY = "cd_smart_digest_enabled";
const MAP_SIGNAL_TTL_MINUTES = 30;
const MAP_SIGNAL_TTL_MS = MAP_SIGNAL_TTL_MINUTES * 60 * 1000;

const bootStageBlueprint = [
  { id: "ui", label: "Interface utilisateur" },
  { id: "map", label: "Moteur cartographique" },
  { id: "countries", label: "Contours des pays" },
  { id: "filters", label: "Filtres pays/régions" },
  { id: "settings", label: "Paramètres serveur" },
  { id: "voice", label: "Moteur vocal cloud" },
  { id: "alerts", label: "Récupération des alertes" },
  { id: "stats", label: "Widgets statistiques" },
  { id: "stream", label: "Flux live temps réel" },
  { id: "final", label: "Synchronisation finale" }
];

const bootState = {
  stages: bootStageBlueprint.map((stage) => ({ ...stage, status: "pending" }))
};

function isSoundEnabled() {
  // Backward compatible for old settings docs missing this field.
  return state.settings?.soundEnabled !== false;
}

function isVoiceEnabled() {
  // Backward compatible for old settings docs missing this field.
  return state.settings?.voiceEnabled !== false;
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

function updateVoiceToggleUI() {
  if (!refs.toggleVoiceBtn) return;
  const enabled = isVoiceEnabled();
  const engine = state.voice?.remoteAvailable ? "IA" : "SYS";
  refs.toggleVoiceBtn.textContent = enabled ? `Voix ${engine} ON` : `Voix ${engine} OFF`;
  refs.toggleVoiceBtn.title = state.voice?.remoteAvailable
    ? `Voix cloud active (${state.voice.provider || "provider"})`
    : "Voix locale navigateur (fallback)";
  refs.toggleVoiceBtn.classList.toggle("is-off", !enabled);
}

function updateCoverageToggleUI() {
  if (!refs.toggleCoverageBtn) return;
  const enabled = isGlobalCoverageEnabled();
  refs.toggleCoverageBtn.textContent = enabled ? "Global ON" : "Global OFF";
  refs.toggleCoverageBtn.classList.toggle("is-off", !enabled);
}

function getMapMode() {
  return state.mapMode === "3d" ? "3d" : "2d";
}

function getSeverityColorHex(severity) {
  const normalized = normalizeSeverity(severity);
  return (
    {
      critical: "#ff3341",
      high: "#ff6a3f",
      medium: "#ffd24a",
      low: "#35ef9f"
    }[normalized] || "#39d0ff"
  );
}

function getGlobeCountryVisual(status) {
  if (status === "critical") {
    return {
      cap: "rgba(255,51,65,0.36)",
      side: "rgba(255,51,65,0.16)",
      stroke: "rgba(255,96,108,0.82)",
      altitude: 0.022
    };
  }

  if (status === "tension") {
    return {
      cap: "rgba(255,210,74,0.3)",
      side: "rgba(255,210,74,0.14)",
      stroke: "rgba(255,219,108,0.78)",
      altitude: 0.016
    };
  }

  return {
    cap: "rgba(53,239,159,0.2)",
    side: "rgba(53,239,159,0.1)",
    stroke: "rgba(120,255,197,0.48)",
    altitude: 0.01
  };
}

function collectGlobeCountryPolygons(alerts) {
  if (!state.countryGeoFeaturesByKey.size) {
    return [];
  }

  const summaries = buildCountrySummaries(alerts).slice(0, 220);
  const polygons = [];
  const seen = new Set();

  summaries.forEach((summary) => {
    if (!summary?.key) return;

    let features = state.countryGeoFeaturesByKey.get(summary.key) || [];
    if (!features.length) {
      const fallbackKey = `name:${normalizeCountryAlias(normalizeCountryKey(summary?.country?.name || ""))}`;
      features = state.countryGeoFeaturesByKey.get(fallbackKey) || [];
    }

    features.forEach((feature, index) => {
      const featureBaseId =
        feature?.properties?.ISO_A3 ||
        feature?.properties?.ADM0_A3 ||
        feature?.properties?.ISO_A2 ||
        feature?.properties?.id ||
        summary.key;
      const featureId = `${summary.key}::${featureBaseId}::${index}`;
      if (seen.has(featureId)) {
        return;
      }
      seen.add(featureId);

      const nextProperties = {
        ...(feature.properties || {}),
        __countryStatus: summary.status,
        __alertCount: summary.alerts.length,
        __countryName: summary.country?.name || "Inconnu",
        __latestAt: summary.latestAt || 0
      };

      polygons.push({
        ...feature,
        properties: nextProperties
      });
    });
  });

  return polygons;
}

function focusGlobeCamera(transitionMs = 0) {
  if (!state.globe) return;

  try {
    state.globe.pointOfView(
      {
        lat: 27,
        lng: 15,
        alt: 1.62
      },
      transitionMs
    );
  } catch (error) {
    // Ignore camera errors if globe is not fully initialized yet.
  }
}

function updateMapModeUI() {
  const mode = getMapMode();
  const is3d = mode === "3d";
  const hasGlobeSupport = typeof window.Globe === "function";

  if (refs.mapView) {
    refs.mapView.classList.toggle("hidden-view", is3d);
  }
  if (refs.globeView) {
    refs.globeView.classList.toggle("hidden-view", !is3d);
    refs.globeView.setAttribute("aria-hidden", String(!is3d));
  }

  if (refs.toggleMapModeBtn) {
    refs.toggleMapModeBtn.disabled = !hasGlobeSupport;
    refs.toggleMapModeBtn.textContent = is3d ? "Vue 2D" : "Vue 3D";
    refs.toggleMapModeBtn.title = !hasGlobeSupport
      ? "Moteur 3D indisponible"
      : is3d
        ? "Revenir à la carte 2D Leaflet"
        : "Basculer vers le globe 3D";
  }
}

function resizeGlobeViewport() {
  if (!state.globe || !refs.globeView) return;
  const rect = refs.globeView.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);

  if (width > 8 && height > 8) {
    state.globe.width(width).height(height);

    if (typeof state.globe.renderer === "function") {
      const renderer = state.globe.renderer();
      if (renderer && typeof renderer.setPixelRatio === "function") {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      }
    }

    if (typeof state.globe.controls === "function") {
      state.globe.controls()?.update?.();
    }
  }
}

function initializeGlobe() {
  if (state.globe) {
    return true;
  }

  if (!refs.globeView || typeof window.Globe !== "function") {
    return false;
  }

  const globe = window.Globe()(refs.globeView)
    .backgroundColor("rgba(3,5,9,0.0)")
    .backgroundImageUrl("https://unpkg.com/three-globe/example/img/night-sky.png")
    .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-night.jpg")
    .bumpImageUrl("https://unpkg.com/three-globe/example/img/earth-topology.png")
    .showAtmosphere(true)
    .atmosphereColor("#4ea9ff")
    .atmosphereAltitude(0.22)
    .pointLat("lat")
    .pointLng("lng")
    .pointColor("color")
    .pointAltitude("altitude")
    .pointRadius("radius")
    .pointResolution(12)
    .pointsMerge(false)
    .pointLabel("label")
    .onPointClick((point) => {
      const alert = point?.alert;
      if (!alert) return;
      state.selectedAlertId = alert._id;
      renderAlertDetails(alert);
      renderAlertsList();
    })
    .polygonCapColor((feature) => {
      const status = feature?.properties?.__countryStatus || "normal";
      return getGlobeCountryVisual(status).cap;
    })
    .polygonSideColor((feature) => {
      const status = feature?.properties?.__countryStatus || "normal";
      return getGlobeCountryVisual(status).side;
    })
    .polygonStrokeColor((feature) => {
      const status = feature?.properties?.__countryStatus || "normal";
      return getGlobeCountryVisual(status).stroke;
    })
    .polygonAltitude((feature) => {
      const status = feature?.properties?.__countryStatus || "normal";
      return getGlobeCountryVisual(status).altitude;
    })
    .polygonLabel((feature) => {
      const countryName = escapeHtml(feature?.properties?.__countryName || getFeatureCountryName(feature));
      const alertCount = Number(feature?.properties?.__alertCount || 0);
      const status = feature?.properties?.__countryStatus || "normal";
      const statusText = status === "critical" ? "Critique" : status === "tension" ? "Tension" : "Normal";
      return `<div style="font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.35;">
        <strong>${countryName}</strong><br>Statut: ${statusText} | ${alertCount} alerte(s)
      </div>`;
    });

  if (typeof globe.controls === "function") {
    const controls = globe.controls();
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.56;
    controls.zoomSpeed = 0.82;
    controls.enablePan = false;
    controls.minDistance = 160;
    controls.maxDistance = 430;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.22;
  }

  if (typeof globe.globeMaterial === "function" && window.THREE) {
    const material = globe.globeMaterial();
    if (material) {
      material.color = new window.THREE.Color("#738299");
      material.emissive = new window.THREE.Color("#0f1723");
      material.emissiveIntensity = 0.5;
      material.shininess = 0.9;
    }
  }

  if (typeof globe.onGlobeReady === "function") {
    globe.onGlobeReady(() => {
      focusGlobeCamera(0);
      resizeGlobeViewport();
    });
  }

  state.globe = globe;
  resizeGlobeViewport();

  if (globeResizeObserver) {
    globeResizeObserver.disconnect();
  }
  if (typeof ResizeObserver !== "undefined" && refs.globeView) {
    globeResizeObserver = new ResizeObserver(() => {
      resizeGlobeViewport();
    });
    globeResizeObserver.observe(refs.globeView);
  }

  requestAnimationFrame(() => {
    resizeGlobeViewport();
    setTimeout(() => {
      resizeGlobeViewport();
      focusGlobeCamera(420);
    }, 140);
  });

  return true;
}

function renderGlobeMarkers(alerts) {
  if (!state.globe) return;
  const countrySummaries = buildCountrySummaries(alerts);
  const globeLegendItems = buildGlobeCountryLegendItems(countrySummaries);

  const points = sortAlertsByEventTimeDesc(alerts)
    .slice(0, 520)
    .map((alert) => {
      const [lat, lng] = getAlertLatLng(alert);
      if (!isValidLatLng(lat, lng)) {
        return null;
      }

      const severity = normalizeSeverity(alert?.severity);
      const signalVisual = getSignalVisual(detectIncidentSignal(alert));
      const pointColor = getSeverityColorHex(severity);
      const title = escapeHtml(alert?.title || "Alerte");
      const country = escapeHtml(alert?.country?.name || "Inconnu");
      const eventTime = escapeHtml(formatAlertEventTime(alert, { allowPublicationFallback: true }));

      return {
        lat,
        lng,
        color: pointColor,
        severity,
        altitude: severity === "critical" ? 0.038 : severity === "high" ? 0.03 : severity === "medium" ? 0.022 : 0.017,
        radius: severity === "critical" ? 0.34 : severity === "high" ? 0.27 : severity === "medium" ? 0.2 : 0.16,
        alert,
        label: `<div style="font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.35;">
          <strong>${title}</strong><br>${country} | ${escapeHtml(signalVisual.glyph)} ${escapeHtml(
          signalVisual.label
        )} | ${eventTime}
        </div>`
      };
    })
    .filter(Boolean);

  const rings = points
    .filter((point) => point.severity === "critical" || point.severity === "high")
    .slice(0, 130)
    .map((point) => ({
      lat: point.lat,
      lng: point.lng,
      color:
        point.severity === "critical"
          ? "rgba(255,51,65,0.7)"
          : point.severity === "high"
            ? "rgba(255,131,82,0.65)"
            : "rgba(255,210,74,0.6)",
      maxRadius: point.severity === "critical" ? 3.4 : 2.5,
      speed: point.severity === "critical" ? 1.12 : 0.92,
      period: point.severity === "critical" ? 1080 : 1320
    }));

  const polygons = collectGlobeCountryPolygons(alerts);

  state.globe
    .pointsData(points)
    .ringsData(rings)
    .ringLat("lat")
    .ringLng("lng")
    .ringColor("color")
    .ringMaxRadius("maxRadius")
    .ringPropagationSpeed("speed")
    .ringRepeatPeriod("period")
    .polygonsData(polygons);

  if (typeof state.globe.labelsData === "function") {
    state.globe
      .labelsData(globeLegendItems)
      .labelLat("lat")
      .labelLng("lng")
      .labelText((item) => item?.text || "")
      .labelColor((item) => item?.color || "#f4f8ff")
      .labelSize((item) => item?.size || 0.78)
      .labelDotRadius((item) => item?.dotRadius || 0.18)
      .labelAltitude((item) => item?.altitude || 0.023)
      .labelResolution(3);

    if (typeof state.globe.onLabelClick === "function") {
      state.globe.onLabelClick((item) => {
        if (!item?.summary) return;
        renderCountryDetails(item.summary).catch((error) => {
          showToast("Erreur profil pays", error.message);
        });
      });
    }
  }

  if (refs.mapOverlayMetric) {
    refs.mapOverlayMetric.textContent = `${points.length}/${alerts.length} points actifs | ${globeLegendItems.length} legendes pays | globe 3D`;
  }
}

function toggleMapMode() {
  const nextMode = getMapMode() === "2d" ? "3d" : "2d";

  if (nextMode === "3d") {
    const ready = initializeGlobe();
    if (!ready) {
      showToast("Vue 3D indisponible", "Chargement du moteur Globe impossible sur ce navigateur.");
      return;
    }
  }

  state.mapMode = nextMode;
  updateMapModeUI();
  renderMapMarkers();

  if (nextMode === "2d") {
    state.map?.invalidateSize?.();
  } else {
    requestAnimationFrame(() => {
      resizeGlobeViewport();
      setTimeout(() => {
        resizeGlobeViewport();
        focusGlobeCamera(420);
      }, 130);
    });
  }
}

function readSmartDigestPreference() {
  try {
    const value = window.localStorage.getItem(SMART_DIGEST_STORAGE_KEY);
    if (value === null) {
      return true;
    }
    return value !== "0";
  } catch (error) {
    return true;
  }
}

function writeSmartDigestPreference(enabled) {
  try {
    window.localStorage.setItem(SMART_DIGEST_STORAGE_KEY, enabled ? "1" : "0");
  } catch (error) {
    // Ignore localStorage failures.
  }
}

function updateSmartDigestToggleUI() {
  const enabled = state.smartDigestEnabled !== false;

  if (refs.toggleSmartDigestBtn) {
    refs.toggleSmartDigestBtn.textContent = enabled ? "Smart ON" : "Smart OFF";
    refs.toggleSmartDigestBtn.classList.toggle("is-off", !enabled);
    refs.toggleSmartDigestBtn.setAttribute("aria-pressed", String(enabled));
    refs.toggleSmartDigestBtn.title = enabled
      ? "Masquer le module Smart Digest"
      : "Afficher le module Smart Digest";
  }

  if (refs.smartDigestCard) {
    refs.smartDigestCard.hidden = !enabled;
    refs.smartDigestCard.classList.toggle("smart-digest-hidden", !enabled);
    refs.smartDigestCard.style.display = enabled ? "" : "none";
  }
}

function toggleSmartDigest() {
  const currentlyEnabled = state.smartDigestEnabled !== false;
  const nextEnabled = !currentlyEnabled;
  state.smartDigestEnabled = nextEnabled;
  writeSmartDigestPreference(nextEnabled);
  updateSmartDigestToggleUI();

  if (nextEnabled && refs.intelOverlay?.classList.contains("hidden")) {
    refs.intelOverlay.classList.remove("hidden");
    updateColumnToggleButtons();
  }

  refreshLayout();
  showToast("Smart Digest", nextEnabled ? "Smart Digest active." : "Smart Digest desactive.");
}

function browserNotificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
}

function readBrowserNotificationPreference() {
  try {
    return window.localStorage.getItem(BROWSER_NOTIF_STORAGE_KEY) === "1";
  } catch (error) {
    return false;
  }
}

function writeBrowserNotificationPreference(enabled) {
  try {
    window.localStorage.setItem(BROWSER_NOTIF_STORAGE_KEY, enabled ? "1" : "0");
  } catch (error) {
    // Ignore localStorage failures (private mode or blocked storage).
  }
}

function updateBrowserNotificationToggleUI() {
  if (!refs.toggleBrowserNotifBtn) return;

  const supported = Boolean(state.browserNotifications?.supported);
  const permission = state.browserNotifications?.permission || "default";
  const enabled = Boolean(state.browserNotifications?.enabled);

  if (!supported) {
    refs.toggleBrowserNotifBtn.textContent = "Notif N/A";
    refs.toggleBrowserNotifBtn.disabled = true;
    refs.toggleBrowserNotifBtn.classList.add("is-off");
    refs.toggleBrowserNotifBtn.title = "Notifications indisponibles (HTTPS requis).";
    return;
  }

  refs.toggleBrowserNotifBtn.disabled = false;

  if (permission === "denied") {
    refs.toggleBrowserNotifBtn.textContent = "Notif bloquees";
    refs.toggleBrowserNotifBtn.classList.add("is-off");
    refs.toggleBrowserNotifBtn.title = "Autorise les notifications dans les reglages Safari du site.";
    return;
  }

  refs.toggleBrowserNotifBtn.textContent = enabled ? "Notif Safari ON" : "Notif Safari OFF";
  refs.toggleBrowserNotifBtn.classList.toggle("is-off", !enabled);
  refs.toggleBrowserNotifBtn.title = enabled
    ? "Notifications systeme actives"
    : "Clique pour autoriser les notifications systeme Safari";
}

function syncBrowserNotificationState() {
  if (!browserNotificationsSupported()) {
    state.browserNotifications = {
      supported: false,
      permission: "unsupported",
      enabled: false
    };
    updateBrowserNotificationToggleUI();
    return;
  }

  const permission = Notification.permission || "default";
  const stored = readBrowserNotificationPreference();
  const enabled = permission === "granted" && stored;

  state.browserNotifications = {
    supported: true,
    permission,
    enabled
  };
  updateBrowserNotificationToggleUI();
}

async function requestBrowserNotificationPermission() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || Notification.permission || "default");
    };

    try {
      const maybePromise = Notification.requestPermission((value) => {
        finish(value);
      });

      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(finish).catch((error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      } else if (typeof maybePromise === "string") {
        finish(maybePromise);
      }
    } catch (error) {
      reject(error);
    }
  });
}

async function toggleBrowserNotifications() {
  if (!browserNotificationsSupported()) {
    showToast("Notifications", "Ce navigateur ne supporte pas les notifications systeme.");
    return;
  }

  const currentlyEnabled = Boolean(state.browserNotifications?.enabled);
  if (currentlyEnabled) {
    state.browserNotifications.enabled = false;
    writeBrowserNotificationPreference(false);
    updateBrowserNotificationToggleUI();
    showToast("Notifications", "Notifications Safari desactivees.");
    return;
  }

  let permission = Notification.permission || "default";
  if (permission !== "granted") {
    permission = await requestBrowserNotificationPermission();
  }

  state.browserNotifications.permission = permission;

  if (permission === "granted") {
    state.browserNotifications.enabled = true;
    writeBrowserNotificationPreference(true);
    updateBrowserNotificationToggleUI();
    showToast("Notifications", "Notifications Safari activees.");
    return;
  }

  state.browserNotifications.enabled = false;
  writeBrowserNotificationPreference(false);
  updateBrowserNotificationToggleUI();
  if (permission === "denied") {
    showToast("Notifications bloquees", "Autorise les notifications dans Safari pour ce site.");
  } else {
    showToast("Notifications", "Permission non accordee.");
  }
}

function pushBrowserNotification(alert) {
  if (!browserNotificationsSupported()) return;
  if (!state.browserNotifications?.enabled) return;
  if (Notification.permission !== "granted") return;

  const severity = normalizeSeverity(alert?.severity);
  const country = alert?.country?.name && alert.country.name !== "Inconnu" ? alert.country.name : "Zone inconnue";
  const source = String(alert?.sourceName || "source inconnue").trim();
  const title = `Alerte ${severityLabel(severity)} - ${country}`;
  const eventTime = formatAlertEventTime(alert, { allowPublicationFallback: true });
  const messageTitle = String(alert?.title || "Nouvel evenement detecte").replace(/\s+/g, " ").trim();
  const body = `${messageTitle.slice(0, 110)} | ${eventTime} | ${source.slice(0, 50)}`;
  const timestamp = getAlertEventTimestamp(alert) || Date.now();

  try {
    const notification = new Notification(title, {
      body,
      tag: `alert-${alert?._id || timestamp}`,
      renotify: severity === "critical",
      requireInteraction: severity === "critical",
      silent: true,
      timestamp
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
      if (alert?._id) {
        const match = state.alerts.find((item) => item._id === alert._id);
        if (match) {
          state.selectedAlertId = match._id;
          renderAlertDetails(match);
          renderAlertsList();
        }
      }
    };

    setTimeout(() => notification.close(), severity === "critical" ? 20000 : 10000);
  } catch (error) {
    console.warn("[notifications] creation impossible:", error.message);
  }
}

function refreshLayout() {
  setTimeout(() => {
    if (state.map) {
      state.map.invalidateSize();
    }

    resizeGlobeViewport();

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

function bootStatusLabel(status) {
  return (
    {
      pending: "En attente",
      loading: "En cours",
      done: "OK",
      failed: "Erreur"
    }[status] || "En attente"
  );
}

function bootCompletionPercent() {
  if (!bootState.stages.length) return 0;
  const completed = bootState.stages.filter((stage) => stage.status === "done" || stage.status === "failed").length;
  return Math.round((completed / bootState.stages.length) * 100);
}

function renderBootChecklist() {
  if (!refs.bootChecklist) return;
  refs.bootChecklist.innerHTML = bootState.stages
    .map(
      (stage) => `
      <div class="boot-step ${escapeHtml(stage.status)}" data-boot-stage="${escapeHtml(stage.id)}">
        <span class="boot-step-icon" aria-hidden="true"></span>
        <span class="boot-step-label">${escapeHtml(stage.label)}</span>
        <span class="boot-step-status">${escapeHtml(bootStatusLabel(stage.status))}</span>
      </div>
    `
    )
    .join("");
}

function setBootProgress(currentTask) {
  const percent = bootCompletionPercent();
  if (refs.bootProgressBar) {
    refs.bootProgressBar.style.width = `${percent}%`;
  }
  if (refs.bootProgressValue) {
    refs.bootProgressValue.textContent = `${percent}%`;
  }
  if (refs.bootCurrentTask && currentTask) {
    refs.bootCurrentTask.textContent = currentTask;
  }
  renderBootChecklist();
}

function beginBootOverlay() {
  if (!refs.bootOverlay) return;
  refs.bootOverlay.classList.remove("hidden");
  bootState.stages = bootStageBlueprint.map((stage) => ({ ...stage, status: "pending" }));
  setBootProgress("Démarrage du radar...");

  if (refs.bootRetryBtn && !bootRetryBound) {
    refs.bootRetryBtn.addEventListener("click", () => {
      window.location.reload();
    });
    bootRetryBound = true;
  }

  if (refs.bootRetryBtn) {
    refs.bootRetryBtn.hidden = true;
  }
}

function completeBootOverlay() {
  setBootProgress("Système opérationnel");
  if (refs.bootProgressBar) {
    refs.bootProgressBar.style.width = "100%";
  }
  if (refs.bootProgressValue) {
    refs.bootProgressValue.textContent = "100%";
  }

  if (refs.bootOverlay) {
    setTimeout(() => {
      refs.bootOverlay.classList.add("hidden");
    }, 360);
  }
}

function failBootOverlay(error) {
  if (refs.bootCurrentTask) {
    refs.bootCurrentTask.textContent = `Échec du démarrage: ${error?.message || "erreur inconnue"}`;
  }
  if (refs.bootRetryBtn) {
    refs.bootRetryBtn.hidden = false;
  }
  renderBootChecklist();
}

async function runBootStage(id, taskLabel, executor, options = {}) {
  const { required = true } = options;
  const stage = bootState.stages.find((item) => item.id === id);
  if (stage) {
    stage.status = "loading";
    setBootProgress(taskLabel);
  }

  try {
    const result = await executor();
    if (stage) {
      stage.status = "done";
      setBootProgress(taskLabel);
    }
    return result;
  } catch (error) {
    if (stage) {
      stage.status = "failed";
      setBootProgress(taskLabel);
    }

    if (required) {
      throw error;
    }
    return null;
  }
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
  const date = new Date(dateString || "");
  if (!Number.isFinite(date.getTime())) {
    return "Date inconnue";
  }
  return date.toLocaleString("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatShortDate(dateString) {
  const date = new Date(dateString || "");
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getAlertPublicationValue(alert) {
  return alert?.publishedAt || alert?.timestamp || alert?.createdAt || "";
}

function getAlertPublicationTimestamp(alert) {
  const publishedTs = new Date(getAlertPublicationValue(alert)).getTime();
  if (Number.isFinite(publishedTs) && publishedTs > 0) {
    return publishedTs;
  }
  return 0;
}

function getAlertEventTimestamp(alert) {
  const occurredTs = new Date(alert?.occurredAt || 0).getTime();
  if (Number.isFinite(occurredTs) && occurredTs > 0) {
    return occurredTs;
  }

  // User rule: if act time is unknown, sort by publication time.
  return getAlertPublicationTimestamp(alert);
}

function isActiveMapSignal(alert, nowMs = Date.now()) {
  const eventTs = getAlertEventTimestamp(alert);
  if (!Number.isFinite(eventTs) || eventTs <= 0) {
    return false;
  }

  const ageMs = nowMs - eventTs;
  if (!Number.isFinite(ageMs)) {
    return false;
  }

  if (ageMs < 0) {
    return true;
  }

  return ageMs <= MAP_SIGNAL_TTL_MS;
}

function filterActiveMapSignals(alerts, nowMs = Date.now()) {
  return (alerts || []).filter((alert) => isActiveMapSignal(alert, nowMs));
}

function sortAlertsByEventTimeDesc(alerts) {
  return [...(alerts || [])].sort((a, b) => {
    const eventDelta = getAlertEventTimestamp(b) - getAlertEventTimestamp(a);
    if (eventDelta !== 0) {
      return eventDelta;
    }

    const publicationDelta = getAlertPublicationTimestamp(b) - getAlertPublicationTimestamp(a);
    if (publicationDelta !== 0) {
      return publicationDelta;
    }

    const createdDelta = new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime();
    if (Number.isFinite(createdDelta) && createdDelta !== 0) {
      return createdDelta;
    }

    return String(b?._id || "").localeCompare(String(a?._id || ""));
  });
}

function scheduleMapSignalExpiryRefresh(alerts = []) {
  if (mapSignalExpiryTimer) {
    clearTimeout(mapSignalExpiryTimer);
    mapSignalExpiryTimer = null;
  }

  if (!Array.isArray(alerts) || alerts.length === 0) {
    return;
  }

  const now = Date.now();
  let nearestExpiryDelayMs = null;

  alerts.forEach((alert) => {
    const eventTs = getAlertEventTimestamp(alert);
    if (!Number.isFinite(eventTs) || eventTs <= 0) {
      return;
    }

    const remainingMs = eventTs + MAP_SIGNAL_TTL_MS - now;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return;
    }

    if (nearestExpiryDelayMs === null || remainingMs < nearestExpiryDelayMs) {
      nearestExpiryDelayMs = remainingMs;
    }
  });

  if (nearestExpiryDelayMs === null) {
    return;
  }

  const delayMs = Math.max(800, Math.min(nearestExpiryDelayMs + 150, 2 * 60 * 1000));
  mapSignalExpiryTimer = setTimeout(() => {
    renderMapMarkers();
  }, delayMs);
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

function detectSourceKind(alert) {
  const sourceName = String(alert?.sourceName || "").trim().toLowerCase();
  const sourceUrl = String(alert?.sourceUrl || "").trim().toLowerCase();

  if (
    sourceName.startsWith("@") ||
    sourceName.includes("telegram") ||
    sourceUrl.includes("t.me/") ||
    sourceUrl.includes("telegram.me/")
  ) {
    return "telegram";
  }

  return "media";
}

function sourceKindLabel(alert) {
  return detectSourceKind(alert) === "telegram" ? "Telegram" : "Media";
}

function sourceBadgeHtml(alert, extraClass = "") {
  const kind = detectSourceKind(alert);
  const className = kind === "telegram" ? "source-chip-telegram" : "source-chip-media";
  const label = sourceKindLabel(alert);
  return `<span class="meta-chip source-chip ${className} ${extraClass}">${escapeHtml(label)}</span>`;
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

function playMilitarySiren(context, startTime, options = {}) {
  const {
    duration = 0.9,
    lowFreq = 520,
    highFreq = 860,
    cycles = 2,
    gainLevel = 0.2
  } = options;

  const sirenOsc = context.createOscillator();
  const subOsc = context.createOscillator();
  const bandPass = context.createBiquadFilter();
  const shaper = context.createWaveShaper();
  const sirenGain = context.createGain();
  const compressor = context.createDynamicsCompressor();

  sirenOsc.type = "sawtooth";
  subOsc.type = "triangle";
  bandPass.type = "bandpass";
  bandPass.frequency.value = 1080;
  bandPass.Q.value = 1.15;
  shaper.curve = makeDistortionCurve(74);
  shaper.oversample = "4x";

  compressor.threshold.value = -22;
  compressor.knee.value = 8;
  compressor.ratio.value = 3.5;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.12;

  sirenGain.gain.setValueAtTime(0.0001, startTime);
  sirenGain.gain.exponentialRampToValueAtTime(gainLevel, startTime + 0.02);
  sirenGain.gain.setValueAtTime(gainLevel, startTime + Math.max(0.04, duration - 0.11));
  sirenGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  const safeCycles = Math.max(1, Math.round(cycles));
  const cycleDuration = duration / safeCycles;

  sirenOsc.frequency.setValueAtTime(lowFreq, startTime);
  subOsc.frequency.setValueAtTime(lowFreq * 0.52, startTime);

  for (let i = 0; i < safeCycles; i += 1) {
    const cycleStart = startTime + i * cycleDuration;
    const midPoint = cycleStart + cycleDuration / 2;
    const cycleEnd = cycleStart + cycleDuration;

    sirenOsc.frequency.linearRampToValueAtTime(highFreq, midPoint);
    sirenOsc.frequency.linearRampToValueAtTime(lowFreq, cycleEnd);

    subOsc.frequency.linearRampToValueAtTime(highFreq * 0.52, midPoint);
    subOsc.frequency.linearRampToValueAtTime(lowFreq * 0.52, cycleEnd);
  }

  sirenOsc.connect(bandPass);
  subOsc.connect(bandPass);
  bandPass.connect(shaper);
  shaper.connect(compressor);
  compressor.connect(sirenGain);
  sirenGain.connect(context.destination);

  sirenOsc.start(startTime);
  subOsc.start(startTime);
  sirenOsc.stop(startTime + duration + 0.02);
  subOsc.stop(startTime + duration + 0.02);

  const crackle = context.createBufferSource();
  crackle.buffer = createNoiseBuffer(context, duration);
  const crackleFilter = context.createBiquadFilter();
  const crackleGain = context.createGain();

  crackleFilter.type = "highpass";
  crackleFilter.frequency.value = 2200;
  crackleGain.gain.setValueAtTime(0.0001, startTime);
  crackleGain.gain.exponentialRampToValueAtTime(gainLevel * 0.18, startTime + 0.03);
  crackleGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  crackle.connect(crackleFilter);
  crackleFilter.connect(crackleGain);
  crackleGain.connect(context.destination);
  crackle.start(startTime);
  crackle.stop(startTime + duration + 0.02);
}

function playNotificationSound(severity = "medium") {
  ensureAudio();
  if (!audioContext) return;

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }

  const profile = {
    critical: {
      preamble: [960, 820],
      burstDuration: 0.13,
      gap: 0.06,
      gain: 0.28,
      noise: 0.085,
      sirenDuration: 1.08,
      sirenCycles: 3,
      sirenLow: 520,
      sirenHigh: 920
    },
    high: {
      preamble: [900],
      burstDuration: 0.12,
      gap: 0.06,
      gain: 0.24,
      noise: 0.072,
      sirenDuration: 0.86,
      sirenCycles: 2,
      sirenLow: 500,
      sirenHigh: 830
    },
    medium: {
      preamble: [860, 760],
      burstDuration: 0.11,
      duration: 0.11,
      gap: 0.05,
      gain: 0.2,
      noise: 0.06,
      sirenDuration: 0.52,
      sirenCycles: 1,
      sirenLow: 460,
      sirenHigh: 680
    },
    low: {
      preamble: [760],
      burstDuration: 0.1,
      gap: 0.05,
      gain: 0.16,
      noise: 0.045,
      sirenDuration: 0.32,
      sirenCycles: 1,
      sirenLow: 430,
      sirenHigh: 570
    }
  }[normalizeSeverity(severity)];

  const now = audioContext.currentTime + 0.02;

  profile.preamble.forEach((frequency, index) => {
    const start = now + index * (profile.burstDuration + profile.gap);
    playRadioBurst(audioContext, start, frequency, profile.burstDuration, profile.gain, profile.noise);
  });

  const sirenStart = now + profile.preamble.length * (profile.burstDuration + profile.gap);
  playMilitarySiren(audioContext, sirenStart, {
    duration: profile.sirenDuration,
    lowFreq: profile.sirenLow,
    highFreq: profile.sirenHigh,
    cycles: profile.sirenCycles,
    gainLevel: profile.gain
  });

  const postBurstStart = sirenStart + profile.sirenDuration + 0.02;
  playRadioBurst(
    audioContext,
    postBurstStart,
    profile.sirenHigh + 40,
    Math.max(0.085, profile.burstDuration - 0.01),
    profile.gain * 0.88,
    profile.noise * 0.75
  );
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
  const severity = normalizeSeverity(alert?.severity);
  const leadIn =
    severity === "critical" ? "Attention, attention. " : severity === "high" ? "Alerte prioritaire. " : "";
  const country = alert?.country?.name && alert.country.name !== "Inconnu" ? alert.country.name : "zone inconnue";
  const title = String(alert?.title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 105);

  if (title) {
    return `${leadIn}Nouvelle alerte ${severityVoiceLabel} concernant ${country}. ${title}.`;
  }
  return `${leadIn}Nouvelle alerte ${severityVoiceLabel} concernant ${country}.`;
}

function formatAlertEventTime(alert, options = {}) {
  const { allowPublicationFallback = false } = options;
  const occurred = formatShortDate(alert?.occurredAt);
  if (occurred) {
    return occurred;
  }

  if (allowPublicationFallback) {
    return formatShortDate(getAlertPublicationValue(alert)) || "Heure inconnue";
  }

  return "Acte inconnu";
}

function formatAlertEventDateLong(alert, options = {}) {
  const { allowPublicationFallback = false } = options;
  const occurred = formatDate(alert?.occurredAt);
  if (occurred !== "Date inconnue") {
    return occurred;
  }

  if (allowPublicationFallback) {
    return formatDate(getAlertPublicationValue(alert));
  }

  return "Heure acte inconnue";
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

function pickFallbackVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];

  return (
    voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith("en")) ||
    voices.find((voice) => voice.lang && voice.lang.toLowerCase().includes("en")) ||
    voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith("fr")) ||
    voices.find((voice) => voice.lang && voice.lang.toLowerCase().includes("fr")) ||
    null
  );
}

function stopVoicePlayback() {
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      console.warn("[speech] cancel impossible", error);
    }
  }

  if (activeVoiceAudio) {
    try {
      activeVoiceAudio.pause();
      activeVoiceAudio.currentTime = 0;
    } catch (error) {
      console.warn("[voice] pause audio impossible", error);
    }
    activeVoiceAudio = null;
  }

  if (activeVoiceFxNodes.length > 0) {
    activeVoiceFxNodes.forEach((node) => {
      try {
        node.disconnect();
      } catch (error) {
        // Ignore node disconnect errors.
      }
    });
    activeVoiceFxNodes = [];
  }

  if (activeVoiceMediaSource) {
    try {
      activeVoiceMediaSource.disconnect();
    } catch (error) {
      // Ignore media source disconnect errors.
    }
    activeVoiceMediaSource = null;
  }

  if (activeVoiceBlobUrl) {
    URL.revokeObjectURL(activeVoiceBlobUrl);
    activeVoiceBlobUrl = null;
  }
}

function connectMilitaryVoiceFx(audioElement, severity = "medium") {
  ensureAudio();
  if (!audioContext || !audioElement || typeof audioContext.createMediaElementSource !== "function") {
    return null;
  }

  const source = audioContext.createMediaElementSource(audioElement);
  const highPass = audioContext.createBiquadFilter();
  const bandPass = audioContext.createBiquadFilter();
  const shaper = audioContext.createWaveShaper();
  const compressor = audioContext.createDynamicsCompressor();
  const gain = audioContext.createGain();

  highPass.type = "highpass";
  highPass.frequency.value = 230;

  bandPass.type = "bandpass";
  bandPass.frequency.value = 1700;
  bandPass.Q.value = 1.3;

  shaper.curve = makeDistortionCurve(46);
  shaper.oversample = "4x";

  compressor.threshold.value = -22;
  compressor.knee.value = 8;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.1;

  const severityKey = normalizeSeverity(severity);
  gain.gain.value =
    severityKey === "critical" ? 1.2 : severityKey === "high" ? 1.08 : severityKey === "medium" ? 0.98 : 0.9;

  source.connect(highPass);
  highPass.connect(bandPass);
  bandPass.connect(shaper);
  shaper.connect(compressor);
  compressor.connect(gain);
  gain.connect(audioContext.destination);

  activeVoiceMediaSource = source;
  activeVoiceFxNodes = [highPass, bandPass, shaper, compressor, gain];
  return true;
}

function speakAlertMessageLocal(alert) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    return;
  }

  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(buildAlertVoiceMessage(alert));
  utterance.lang = "fr-FR";
  utterance.volume = 1;

  const voice = pickFallbackVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang || utterance.lang;
  }

  const severity = normalizeSeverity(alert?.severity);
  if (severity === "critical" || severity === "high") {
    utterance.rate = 0.84;
    utterance.pitch = 0.64;
  } else if (severity === "medium") {
    utterance.rate = 0.9;
    utterance.pitch = 0.72;
  } else {
    utterance.rate = 0.95;
    utterance.pitch = 0.8;
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

async function speakAlertMessageRemote(alert) {
  if (!state.voice?.remoteAvailable) {
    return false;
  }

  const text = buildAlertVoiceMessage(alert);
  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    let details = "";
    try {
      const payload = await response.json();
      details = payload?.error || "";
    } catch (error) {
      details = "";
    }
    throw new Error(details || `Erreur TTS HTTP ${response.status}`);
  }

  const audioBlob = await response.blob();
  if (!audioBlob?.size) {
    throw new Error("Audio TTS vide");
  }

  stopVoicePlayback();

  const audio = new Audio();
  const objectUrl = URL.createObjectURL(audioBlob);
  audio.src = objectUrl;
  audio.volume = 1;
  audio.preload = "auto";
  audio.playbackRate = 0.95;
  audio.preservesPitch = false;
  activeVoiceAudio = audio;
  activeVoiceBlobUrl = objectUrl;

  try {
    connectMilitaryVoiceFx(audio, alert?.severity);
  } catch (error) {
    console.warn("[voice] effet radio indisponible:", error.message);
  }

  const release = () => {
    if (activeVoiceAudio === audio) {
      activeVoiceAudio = null;
    }
    if (activeVoiceMediaSource) {
      try {
        activeVoiceMediaSource.disconnect();
      } catch (error) {
        // Ignore.
      }
      activeVoiceMediaSource = null;
    }
    if (activeVoiceFxNodes.length > 0) {
      activeVoiceFxNodes.forEach((node) => {
        try {
          node.disconnect();
        } catch (error) {
          // Ignore.
        }
      });
      activeVoiceFxNodes = [];
    }
    if (activeVoiceBlobUrl === objectUrl) {
      URL.revokeObjectURL(objectUrl);
      activeVoiceBlobUrl = null;
    }
  };

  audio.addEventListener("ended", release, { once: true });
  audio.addEventListener("error", release, { once: true });

  await audio.play();
  return true;
}

async function speakAlertMessage(alert) {
  if (!isVoiceEnabled()) return;

  if (state.voice?.remoteAvailable) {
    try {
      const playedRemote = await speakAlertMessageRemote(alert);
      if (playedRemote) {
        return;
      }
    } catch (error) {
      console.warn("[voice] fallback local:", error.message);
      const now = Date.now();
      if (now - lastVoiceFallbackNoticeAt > 90000) {
        showToast("Voix cloud indisponible", "Retour temporaire sur la voix locale.", "medium", 3200);
        lastVoiceFallbackNoticeAt = now;
      }
    }
  }

  speakAlertMessageLocal(alert);
}

function triggerAlertFlash(alert) {
  if (!refs.alertFlash) return;

  const severity = normalizeSeverity(alert?.severity);
  const theme = getSeverityTheme(severity);
  const eventTime = formatAlertEventTime(alert);

  refs.alertFlash.className = `alert-flash sev-${severity} show`;
  refs.alertFlash.innerHTML = `
    <div class="alert-flash-card">
      <p class="kicker">${escapeHtml(theme.popupTitle)}</p>
      <p class="headline">${escapeHtml(alert?.title || "Nouvelle alerte détectée")}</p>
      <p class="meta">${escapeHtml(alert?.country?.name || "Zone inconnue")} | ${escapeHtml(
    severityLabel(severity)
  )} | Acte: ${escapeHtml(eventTime)}</p>
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
    refs.toggleRightPanelBtn.textContent = hidden ? "Afficher panel" : "Masquer panel";
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

function updateFiltersSidebarToggleButton() {
  if (!refs.toggleFiltersSidebarBtn || !refs.leftPanel) return;
  const collapsed = refs.leftPanel.classList.contains("filters-collapsed");
  refs.toggleFiltersSidebarBtn.textContent = collapsed ? "Afficher filtres" : "Masquer filtres";
  refs.toggleFiltersSidebarBtn.setAttribute("aria-expanded", String(!collapsed));
}

function bindFiltersSidebarToggle() {
  if (!refs.leftPanel || !refs.toggleFiltersSidebarBtn) return;

  refs.toggleFiltersSidebarBtn.addEventListener("click", () => {
    refs.leftPanel.classList.toggle("filters-collapsed");
    updateFiltersSidebarToggleButton();
    refreshLayout();
  });

  updateFiltersSidebarToggleButton();
}

function applyPhoneLayoutDefaults() {
  if (!window.matchMedia("(max-width: 760px)").matches) {
    return;
  }

  if (refs.intelOverlay && !refs.intelOverlay.classList.contains("hidden")) {
    refs.intelOverlay.classList.add("hidden");
  }

  if (refs.leftPanel && !refs.leftPanel.classList.contains("filters-collapsed")) {
    refs.leftPanel.classList.add("filters-collapsed");
  }

  updateColumnToggleButtons();
  updateFiltersSidebarToggleButton();
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
  const cityLat = Number(alert?.city?.lat);
  const cityLng = Number(alert?.city?.lng);
  if (Number.isFinite(cityLat) && Number.isFinite(cityLng)) {
    return [cityLat, cityLng];
  }

  const hasLocationCoords =
    alert?.location &&
    alert.location.coordinates &&
    Number.isFinite(alert.location.coordinates[0]) &&
    Number.isFinite(alert.location.coordinates[1]);

  let locationLat = null;
  let locationLng = null;

  if (hasLocationCoords) {
    locationLat = Number(alert.location.coordinates[1]);
    locationLng = Number(alert.location.coordinates[0]);
    if (!isFallbackMarkerPoint(locationLat, locationLng)) {
      return [locationLat, locationLng];
    }
  }

  const countryCentroid = getCountryCentroid(alert?.country?.name, alert?.country?.code);
  if (countryCentroid) {
    return countryCentroid;
  }

  if (Number.isFinite(locationLat) && Number.isFinite(locationLng)) {
    return [locationLat, locationLng];
  }

  return [20, 0];
}

function normalizeCountryCode(value) {
  const code = String(value || "")
    .toUpperCase()
    .trim();
  if (!code || code === "XX" || code === "-99" || code === "--") {
    return "";
  }
  return code;
}

function isFallbackMarkerPoint(lat, lng) {
  return Math.abs(Number(lat) - 20) < 0.0001 && Math.abs(Number(lng)) < 0.0001;
}

function getCountryCentroid(countryName, countryCode) {
  const normalizedCode = normalizeCountryCode(countryCode);
  if (normalizedCode && state.countryCentroidsByCode.has(normalizedCode)) {
    return state.countryCentroidsByCode.get(normalizedCode);
  }

  const exactName = String(countryName || "").trim();
  if (exactName && state.countryCentroids.has(exactName)) {
    return state.countryCentroids.get(exactName);
  }

  const normalizedKey = normalizeCountryAlias(normalizeCountryKey(exactName));
  if (normalizedKey && state.countryCentroidsByKey.has(normalizedKey)) {
    return state.countryCentroidsByKey.get(normalizedKey);
  }

  return null;
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
  const activeMapSignals = filterActiveMapSignals(visibleAlerts);
  recomputeCountryStatusLevels();
  updateCountryHeadlineCounters();
  const countrySummaries = buildCountrySummaries(activeMapSignals);

  if (getMapMode() === "3d") {
    if (state.markersLayer) {
      state.markersLayer.clearLayers();
    }
    if (state.countryLegendLayer) {
      state.countryLegendLayer.clearLayers();
    }
    if (!state.globe) {
      initializeGlobe();
    }
    renderGlobeMarkers(activeMapSignals);
    scheduleMapSignalExpiryRefresh(activeMapSignals);
    return;
  }

  if (!state.markersLayer || !state.map) {
    return;
  }

  state.markersLayer.clearLayers();
  state.countryLegendLayer?.clearLayers();

  const zoom = Number(state.map?.getZoom?.() || 2);

  const renderedAlerts = selectAlertsForCurrentZoom(activeMapSignals);
  const countryLegends = sortCountrySummariesForLegend(countrySummaries).slice(0, getCountryLegendLimitForZoom(zoom));

  renderedAlerts.forEach((alert) => {
    const marker = createMarker(alert);
    state.markersLayer.addLayer(marker);
  });

  countryLegends.forEach((summary) => {
    const legendMarker = createCountryLegendMarker(summary);
    state.countryLegendLayer?.addLayer(legendMarker);
  });

  if (refs.mapOverlayMetric) {
    refs.mapOverlayMetric.textContent = `${renderedAlerts.length}/${activeMapSignals.length} points actifs | ${countryLegends.length} legendes pays | zoom ${zoom.toFixed(
      1
    )}`;
  }

  scheduleMapSignalExpiryRefresh(activeMapSignals);
}

function renderAlertDetails(alert) {
  ensureIntelOverlayVisible();
  const signalVisual = getSignalVisual(detectIncidentSignal(alert));
  const confidence = confidenceScoreValue(alert);
  const sourceCount = sourceCountValue(alert);
  const sourcesList = Array.isArray(alert?.sourceNames) && alert.sourceNames.length > 0 ? alert.sourceNames : [alert.sourceName];
  const sourceName = alert?.sourceName || "Inconnue";

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
      ${sourceBadgeHtml(alert)}
      ${alert.city?.name ? `<span class="meta-chip">${escapeHtml(alert.city.name)}</span>` : ""}
      <span class="meta-chip">${escapeHtml(alert.country?.name || "Inconnu")}</span>
      <span class="meta-chip">${escapeHtml(alert.country?.region || "Global")}</span>
    </div>
    <p class="mb-2"><strong>Résumé:</strong> ${escapeHtml(alert.summary || "Résumé non disponible")}</p>
    <p class="mb-2"><strong>Source:</strong> ${sourceBadgeHtml(alert, "source-chip-inline")} <span class="source-name-inline">${escapeHtml(
    sourceName
  )}</span></p>
    <p class="mb-2"><strong>Ville:</strong> ${escapeHtml(alert.city?.name || "Non précisée")}</p>
    <p class="mb-2"><strong>Validation:</strong> ${escapeHtml(confirmationLabel(alert))} | <strong>Confiance:</strong> ${confidence}% | <strong>Sources croisées:</strong> ${sourceCount}</p>
    <p class="mb-2"><strong>Sources cluster:</strong> ${escapeHtml(sourcesList.join(", "))}</p>
    <p class="mb-1"><strong>Heure de l'acte:</strong> ${escapeHtml(formatAlertEventDateLong(alert))}</p>
    <p class="mb-2"><strong>Heure publication:</strong> ${escapeHtml(formatDate(getAlertPublicationValue(alert)))}</p>
    <a href="${escapeHtml(alert.sourceUrl)}" class="btn btn-sm btn-outline-warning" target="_blank" rel="noopener noreferrer">
      Ouvrir l'article officiel
    </a>
  `;
}

function getTickerSourceAlerts() {
  const dedicated = sortAlertsByEventTimeDesc(
    (state.tickerAlerts || []).filter((alert) => canonicalType(alert?.type) === "geopolitique")
  );
  if (dedicated.length > 0) {
    return dedicated;
  }

  return sortAlertsByEventTimeDesc(
    (state.alerts || []).filter((alert) => canonicalType(alert?.type) === "geopolitique")
  );
}

function renderTicker() {
  const source = getTickerSourceAlerts().slice(0, 12);

  if (source.length === 0) {
    refs.latestTickerContent.classList.remove("is-scrolling");
    refs.latestTickerContent.classList.add("no-scroll");
    refs.latestTickerContent.style.removeProperty("--ticker-duration");
    refs.latestTickerContent.textContent = "Aucune alerte pour cette vue.";
    return;
  }

  const singleTrack = source
    .map(
      (alert) =>
        `<span class="ticker-item"><span class="dot"></span><span class="ticker-title">${escapeHtml(
          alert.title
        )}</span><span class="ticker-time">${escapeHtml(formatAlertEventTime(alert))}</span></span>`
    )
    .join("");

  // Start in static mode, then enable marquee only if content actually overflows.
  refs.latestTickerContent.classList.remove("is-scrolling");
  refs.latestTickerContent.classList.add("no-scroll");
  refs.latestTickerContent.style.removeProperty("--ticker-duration");
  refs.latestTickerContent.innerHTML = singleTrack;

  const viewportWidth = refs.latestTickerContent.parentElement?.clientWidth || 0;
  const baseTrackWidth = refs.latestTickerContent.scrollWidth || 0;
  const shouldScroll = source.length > 1 && baseTrackWidth > viewportWidth + 24;

  if (!shouldScroll) {
    return;
  }

  refs.latestTickerContent.innerHTML = `${singleTrack}<span class="ticker-divider" aria-hidden="true">•</span>${singleTrack}`;

  const fullTrackWidth = refs.latestTickerContent.scrollWidth || baseTrackWidth * 2;
  const halfTrackWidth = Math.max(1, Math.round(fullTrackWidth / 2));
  const speedPxPerSecond = 58;
  const durationSeconds = Math.max(16, Math.min(90, Math.round(halfTrackWidth / speedPxPerSecond)));

  refs.latestTickerContent.style.setProperty("--ticker-duration", `${durationSeconds}s`);
  refs.latestTickerContent.classList.remove("no-scroll");
  refs.latestTickerContent.classList.add("is-scrolling");
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
      const sourceName = alert?.sourceName || "Source inconnue";
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
            ${sourceBadgeHtml(alert)}
            ${alert.city?.name ? `<span class="meta-chip">${escapeHtml(alert.city.name)}</span>` : ""}
            <span class="meta-chip">${escapeHtml(alert.country?.name || "Inconnu")}</span>
          </div>
          <p class="small text-secondary mb-2">Acte: ${escapeHtml(formatAlertEventDateLong(alert))} | Pub: ${escapeHtml(
        formatDate(getAlertPublicationValue(alert))
      )} | Source: ${escapeHtml(sourceName)} | ${sourceCount} source(s)</p>
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
    const eventDate = new Date(alert?.occurredAt || getAlertPublicationValue(alert) || 0);
    if (!Number.isFinite(eventDate.getTime())) {
      return;
    }
    const key = eventDate.toISOString().slice(0, 10);
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

function getFeatureCountryCode(feature) {
  const props = feature?.properties || {};
  const raw =
    props.ISO_A2 ||
    props.ISO2 ||
    props.iso_a2 ||
    props.ISO_A2_EH ||
    props.ADM0_A3_US ||
    props.ADM0_A3 ||
    props.ISO_A3 ||
    props.iso_a3 ||
    props.id;

  const normalized = normalizeCountryCode(raw);
  if (!normalized) {
    return "";
  }

  // Keep only alpha-2 country codes for direct matching with alert.country.code.
  return normalized.length === 2 ? normalized : "";
}

function registerCountryFeature(key, feature) {
  if (!key || !feature) return;

  const bucket = state.countryGeoFeaturesByKey.get(key);
  if (bucket) {
    bucket.push(feature);
    return;
  }

  state.countryGeoFeaturesByKey.set(key, [feature]);
}

function normalizeLongitude(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  let lng = value;
  while (lng > 180) lng -= 360;
  while (lng < -180) lng += 360;
  return lng;
}

function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function unwrapRingLongitudes(ring) {
  const cleaned = ring
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (cleaned.length < 3) {
    return [];
  }

  const unwrapped = [[cleaned[0][0], cleaned[0][1]]];

  for (let i = 1; i < cleaned.length; i += 1) {
    let lng = cleaned[i][0];
    const lat = cleaned[i][1];
    const prevLng = unwrapped[unwrapped.length - 1][0];

    while (lng - prevLng > 180) lng -= 360;
    while (lng - prevLng < -180) lng += 360;

    unwrapped.push([lng, lat]);
  }

  const first = unwrapped[0];
  const last = unwrapped[unwrapped.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    unwrapped.push([first[0], first[1]]);
  }

  return unwrapped;
}

function computeRingMetrics(ring) {
  const points = unwrapRingLongitudes(ring);
  if (points.length < 4) {
    return null;
  }

  let doubleArea = 0;
  let cxTimes6A = 0;
  let cyTimes6A = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const cross = x1 * y2 - x2 * y1;
    doubleArea += cross;
    cxTimes6A += (x1 + x2) * cross;
    cyTimes6A += (y1 + y2) * cross;
  }

  const absArea = Math.abs(doubleArea) / 2;

  if (Math.abs(doubleArea) > 1e-9) {
    const lng = normalizeLongitude(cxTimes6A / (3 * doubleArea));
    const lat = cyTimes6A / (3 * doubleArea);
    if (isValidLatLng(lat, lng)) {
      return {
        area: absArea,
        center: [lat, lng]
      };
    }
  }

  const unique = points.slice(0, -1);
  const avgLng = normalizeLongitude(unique.reduce((sum, point) => sum + point[0], 0) / unique.length);
  const avgLat = unique.reduce((sum, point) => sum + point[1], 0) / unique.length;
  if (isValidLatLng(avgLat, avgLng)) {
    return {
      area: absArea,
      center: [avgLat, avgLng]
    };
  }

  return null;
}

function computeFeatureCenterFromGeometry(feature) {
  const geometry = feature?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    return null;
  }

  const polygons = [];
  if (geometry.type === "Polygon") {
    polygons.push(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach((poly) => polygons.push(poly));
  } else {
    return null;
  }

  let best = null;

  polygons.forEach((polygon) => {
    if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) {
      return;
    }

    const outerRing = polygon[0];
    const metrics = computeRingMetrics(outerRing);
    if (!metrics) {
      return;
    }

    if (!best || metrics.area > best.area) {
      best = metrics;
    }
  });

  return best?.center || null;
}

function deriveFeatureCenter(feature, layer) {
  const geometryCenter = computeFeatureCenterFromGeometry(feature);
  if (geometryCenter) {
    return geometryCenter;
  }

  if (layer && typeof layer.getCenter === "function") {
    const center = layer.getCenter();
    if (center && isValidLatLng(center.lat, center.lng)) {
      return [center.lat, center.lng];
    }
  }

  const boundsCenter = layer.getBounds().getCenter();
  return [boundsCenter.lat, boundsCenter.lng];
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
    "palestinian territories": "palestine",
    "united arab emirates": "united arab emirates",
    "turkiye": "turkey",
    "czechia": "czech republic",
    "dr congo": "democratic republic of the congo",
    "democratic republic of congo": "democratic republic of the congo",
    "congo kinshasa": "democratic republic of the congo",
    "republic of congo": "republic of the congo"
  };

  return aliases[key] || key;
}

function getSeverityRank(severity) {
  const normalized = normalizeSeverity(severity);
  if (normalized === "critical") return 4;
  if (normalized === "high") return 3;
  if (normalized === "medium") return 2;
  if (normalized === "low") return 1;
  return 0;
}

function getCountrySignalBaseWeight(severity) {
  const normalized = normalizeSeverity(severity);
  if (normalized === "critical") return 6.2;
  if (normalized === "high") return 4.1;
  if (normalized === "medium") return 2.3;
  if (normalized === "low") return 1.1;
  return 0.8;
}

function getCountrySignalTimeWeight(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 1;
  if (ageMs <= 2 * 60 * 60 * 1000) return 1.35; // <= 2h
  if (ageMs <= 6 * 60 * 60 * 1000) return 1.05; // <= 6h
  if (ageMs <= 24 * 60 * 60 * 1000) return 0.62; // <= 24h
  if (ageMs <= 48 * 60 * 60 * 1000) return 0.32; // <= 48h
  if (ageMs <= 96 * 60 * 60 * 1000) return 0.14; // <= 96h
  return 0; // too old, no longer contributes to current country status
}

function computeCountryAlertSignal(alert, nowTs) {
  if (canonicalType(alert?.type) !== "geopolitique") {
    return null;
  }

  const countryName = alert?.country?.name;
  if (!countryName || countryName === "Inconnu") {
    return null;
  }

  const countryKey = normalizeCountryAlias(normalizeCountryKey(countryName));
  if (!countryKey) {
    return null;
  }

  const eventTs = getAlertEventTimestamp(alert);
  if (!Number.isFinite(eventTs) || eventTs <= 0) {
    return null;
  }

  const ageMs = Math.max(0, nowTs - eventTs);
  const timeWeight = getCountrySignalTimeWeight(ageMs);
  if (timeWeight <= 0) {
    return null;
  }

  const severity = normalizeSeverity(alert?.severity);
  const severityRank = getSeverityRank(severity);
  const baseWeight = getCountrySignalBaseWeight(severity);
  const confidenceFactor = 0.75 + (confidenceScoreValue(alert) / 100) * 0.45;
  const sourceBonus = Math.max(0, Math.min(3, sourceCountValue(alert) - 1)) * 0.22;
  const confirmedBonus = alert?.confirmed ? 0.45 : 0;
  const score = baseWeight * timeWeight * confidenceFactor + sourceBonus + confirmedBonus;

  return {
    countryKey,
    severityRank,
    eventTs,
    score,
    hasRecentCritical: severity === "critical" && ageMs <= 24 * 60 * 60 * 1000,
    hasRecentHigh: severity === "high" && ageMs <= 12 * 60 * 60 * 1000,
    hasRecentMediumPlus:
      (severity === "medium" || severity === "high" || severity === "critical") && ageMs <= 24 * 60 * 60 * 1000
  };
}

function levelFromCountrySnapshot(snapshot) {
  if (!snapshot) {
    return 1;
  }

  // ACTIVE country: critical in last 24h, or dense recent high-risk cluster.
  if (snapshot.recentCritical >= 1) return 3;
  if (snapshot.weightedScore >= 9.5) return 3;
  if (snapshot.recentHigh >= 2) return 3;
  if (snapshot.recentHigh >= 1 && snapshot.weightedScore >= 7.2) return 3;

  // TENSION country: medium+ recency or enough weighted conflict signal.
  if (snapshot.recentMediumPlus >= 2) return 2;
  if (snapshot.weightedScore >= 3.2) return 2;
  if (snapshot.maxSeverityRank >= 2) return 2;

  return 1;
}

function recomputeCountryStatusLevels() {
  const snapshots = new Map();
  const nowTs = Date.now();

  state.alerts.forEach((alert) => {
    const signal = computeCountryAlertSignal(alert, nowTs);
    if (!signal) return;

    if (!snapshots.has(signal.countryKey)) {
      snapshots.set(signal.countryKey, {
        weightedScore: 0,
        maxSeverityRank: 0,
        recentCritical: 0,
        recentHigh: 0,
        recentMediumPlus: 0
      });
    }

    const snapshot = snapshots.get(signal.countryKey);
    snapshot.weightedScore += signal.score;
    snapshot.maxSeverityRank = Math.max(snapshot.maxSeverityRank, signal.severityRank);
    if (signal.hasRecentCritical) snapshot.recentCritical += 1;
    if (signal.hasRecentHigh) snapshot.recentHigh += 1;
    if (signal.hasRecentMediumPlus) snapshot.recentMediumPlus += 1;
  });

  const levels = new Map();
  snapshots.forEach((snapshot, countryKey) => {
    levels.set(countryKey, levelFromCountrySnapshot(snapshot));
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

  updateDefconIndicator(getVisibleAlerts(), activeCountries, tensionCountries);
  updatePentagonPizzaIndicator();
}

function computeDefconLevel(alerts, activeCountries, tensionCountries) {
  const now = Date.now();
  const recentWindowMs = 6 * 60 * 60 * 1000;

  let criticalAlerts = 0;
  let highAlerts = 0;
  let recentMajorAlerts = 0;

  (alerts || []).forEach((alert) => {
    const severity = normalizeSeverity(alert?.severity);
    const isMajor = severity === "critical" || severity === "high";

    if (severity === "critical") {
      criticalAlerts += 1;
    } else if (severity === "high") {
      highAlerts += 1;
    }

    if (isMajor) {
      const ts = getAlertEventTimestamp(alert);
      if (ts > 0 && now - ts <= recentWindowMs) {
        recentMajorAlerts += 1;
      }
    }
  });

  const severeAlerts = criticalAlerts + highAlerts;

  if (activeCountries >= 12 || criticalAlerts >= 28 || recentMajorAlerts >= 18) {
    return { level: 1, label: "Crise maximale" };
  }

  if (activeCountries >= 8 || criticalAlerts >= 16 || recentMajorAlerts >= 10) {
    return { level: 2, label: "Alerte extreme" };
  }

  if (activeCountries >= 4 || criticalAlerts >= 8 || severeAlerts >= 15 || recentMajorAlerts >= 6) {
    return { level: 3, label: "Tensions elevees" };
  }

  if (activeCountries >= 1 || tensionCountries >= 3 || severeAlerts >= 4) {
    return { level: 4, label: "Surveillance renforcee" };
  }

  return { level: 5, label: "Normal" };
}

function updateDefconIndicator(alerts, activeCountries, tensionCountries) {
  if (!refs.defconCard || !refs.defconValue || !refs.defconLabel) return;

  const { level, label } = computeDefconLevel(alerts, activeCountries, tensionCountries);
  refs.defconCard.dataset.defcon = String(level);
  refs.defconValue.textContent = `DEFCON ${level}`;
  refs.defconLabel.textContent = label;
}

function getPentagonPizzaAlertPool() {
  const pool = (state.tickerAlerts?.length ? state.tickerAlerts : state.alerts) || [];
  return pool.filter((alert) => canonicalType(alert?.type) === "geopolitique");
}

function computePentagonPizzaIndex(alerts) {
  const now = Date.now();
  const windowMs = 12 * 60 * 60 * 1000;
  let score = 8;

  const coreKeywords = [
    "pentagon",
    "arlington",
    "washington",
    "us military",
    "u.s. military",
    "defense department",
    "dod",
    "centcom"
  ];
  const strikeKeywords = ["strike", "attack", "missile", "rocket", "air raid", "drone", "bombing", "casualties"];

  (alerts || []).forEach((alert) => {
    const ts = getAlertEventTimestamp(alert);
    if (!Number.isFinite(ts) || ts <= 0) return;

    const age = now - ts;
    if (age > windowMs) return;

    const freshness = Math.max(0.2, 1 - age / windowMs);
    const severity = normalizeSeverity(alert?.severity);
    const baseWeight =
      severity === "critical" ? 12 : severity === "high" ? 8 : severity === "medium" ? 4 : severity === "low" ? 2 : 1;

    const text = normalizeText(`${alert?.title || ""} ${alert?.summary || ""} ${alert?.sourceName || ""}`);
    const inUs = normalizeText(alert?.country?.name || "") === "united states";
    const hasCore = coreKeywords.some((keyword) => text.includes(keyword));
    const hasStrike = strikeKeywords.some((keyword) => text.includes(keyword));

    score += baseWeight * freshness;
    if (inUs) score += 2.5 * freshness;
    if (hasCore) score += 9 * freshness;
    if (hasStrike) score += 4 * freshness;
  });

  const value = Math.max(0, Math.min(100, Math.round(score)));

  if (value >= 80) {
    return { value, level: "surge", label: "Saturation (proxy OSINT)" };
  }
  if (value >= 60) {
    return { value, level: "very-high", label: "Tres eleve (proxy OSINT)" };
  }
  if (value >= 40) {
    return { value, level: "high", label: "Eleve (proxy OSINT)" };
  }
  if (value >= 20) {
    return { value, level: "medium", label: "Moyen (proxy OSINT)" };
  }
  return { value, level: "calm", label: "Calme (proxy OSINT)" };
}

function updatePentagonPizzaIndicator() {
  if (!refs.pizzaCard || !refs.pizzaValue || !refs.pizzaLabel) return;
  const index = computePentagonPizzaIndex(getPentagonPizzaAlertPool());
  refs.pizzaCard.dataset.level = index.level;
  refs.pizzaValue.textContent = `${index.value}%`;
  refs.pizzaLabel.textContent = index.label;
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
  const centroid = getCountryCentroid(group?.country?.name, group?.country?.code);
  if (centroid) {
    return centroid;
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

function countryCodeToFlagEmoji(code) {
  const normalized = normalizeCountryCode(code);
  if (normalized.length !== 2) {
    return "🏳️";
  }

  try {
    return String.fromCodePoint(
      ...normalized.split("").map((char) => 127397 + char.charCodeAt(0))
    );
  } catch (error) {
    return "🏳️";
  }
}

function compactCountryName(name, maxLen = 26) {
  const raw = String(name || "Inconnu").trim();
  if (raw.length <= maxLen) {
    return raw;
  }
  return `${raw.slice(0, Math.max(8, maxLen - 1)).trim()}…`;
}

function getLegendStatusColor(status) {
  if (status === "critical") return "#ff6b76";
  if (status === "tension") return "#ffd874";
  return "#6dffc0";
}

function countryLegendPriority(summary) {
  const statusWeight = summary?.status === "critical" ? 3 : summary?.status === "tension" ? 2 : 1;
  const latestAt = Number(summary?.latestAt || 0);
  const countWeight = Number(summary?.alerts?.length || 0);
  return statusWeight * 1_000_000_000_000 + latestAt + countWeight * 1000;
}

function sortCountrySummariesForLegend(summaries) {
  return [...(summaries || [])].sort((a, b) => countryLegendPriority(b) - countryLegendPriority(a));
}

function getCountryLegendLimitForZoom(zoom) {
  if (!Number.isFinite(zoom)) return 14;
  if (zoom < 3) return 16;
  if (zoom < 4) return 20;
  if (zoom < 5) return 15;
  if (zoom < 6) return 10;
  return 7;
}

function buildGlobeCountryLegendItems(countrySummaries) {
  return sortCountrySummariesForLegend(countrySummaries)
    .slice(0, 22)
    .map((summary) => {
      const [lat, lng] = summary?.center || [null, null];
      if (!isValidLatLng(lat, lng)) {
        return null;
      }

      const countryName = summary?.country?.name || "Inconnu";
      const flag = countryCodeToFlagEmoji(summary?.country?.code);

      return {
        lat,
        lng,
        summary,
        text: `↗ ${flag} ${compactCountryName(countryName, 24)}`,
        color: getLegendStatusColor(summary?.status),
        size: summary?.status === "critical" ? 0.98 : summary?.status === "tension" ? 0.9 : 0.82,
        dotRadius: summary?.status === "critical" ? 0.22 : 0.17,
        altitude: summary?.status === "critical" ? 0.034 : 0.026
      };
    })
    .filter(Boolean);
}

function createCountryLegendMarker(summary) {
  const [lat, lng] = summary.center || [20, 0];
  const statusClass = countryStatusClass(summary.status);
  const countryName = summary?.country?.name || "Inconnu";
  const compactName = compactCountryName(countryName, 28);
  const flag = countryCodeToFlagEmoji(summary?.country?.code);

  const marker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="country-callout ${statusClass}" title="${escapeHtml(countryName)}"><span class="country-callout__arrow">➤</span><span class="country-callout__flag">${escapeHtml(flag)}</span><span class="country-callout__name">${escapeHtml(compactName)}</span></div>`,
      iconSize: [226, 30],
      iconAnchor: [8, 15]
    }),
    zIndexOffset: 460
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
          )}</span> - ${escapeHtml(alert.title)} ${sourceBadgeHtml(alert, "source-chip-inline")}</p>
          <p class="country-event-meta">Acte: ${escapeHtml(formatAlertEventDateLong(alert))} | Pub: ${escapeHtml(
            formatDate(getAlertPublicationValue(alert))
          )} | ${escapeHtml(alert.sourceName || "Source inconnue")}</p>
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

async function loadTickerAlerts() {
  const query = new URLSearchParams({
    type: "geopolitique",
    limit: "30"
  });

  const mode = state.settings?.alertMode || "insight";
  if (mode === "action") {
    query.set("mode", "action");
  }

  const payload = await api(`/api/alerts?${query.toString()}`);
  const next = sortAlertsByEventTimeDesc(payload?.alerts || []).slice(0, 30);
  state.tickerAlerts = next;

  renderTicker();
  updatePentagonPizzaIndicator();
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
  updateVoiceToggleUI();
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
    await loadTickerAlerts().catch(() => {});
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

async function loadVoiceStatus() {
  try {
    state.voice = await api("/api/voice/status");
  } catch (error) {
    console.warn("[voice] status indisponible:", error.message);
    state.voice = {
      provider: "none",
      remoteAvailable: false,
      fallback: "system"
    };
  }

  updateVoiceToggleUI();
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  applySettingsToControls();
  updateVoiceToggleUI();
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
    "Son alertes",
    nextSoundEnabled ? "Les effets sonores sont activés." : "Les effets sonores sont désactivés."
  );
}

async function toggleVoice() {
  if (!state.settings) return;

  const nextVoiceEnabled = !isVoiceEnabled();
  state.settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      voiceEnabled: nextVoiceEnabled
    })
  });

  updateVoiceToggleUI();
  if (!nextVoiceEnabled) {
    stopVoicePlayback();
  }
  showToast(
    "Voix alertes",
    nextVoiceEnabled ? "Les alertes vocales sont activées." : "Les alertes vocales sont désactivées."
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

  await Promise.all([loadAlerts(), loadStats(), loadTickerAlerts(), loadCountryOptions(), loadRegionOptions()]);
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

  await Promise.all([loadAlerts(), loadStats(), loadTickerAlerts()]);
}

async function runManualDetection() {
  refs.refreshNowBtn.disabled = true;
  try {
    const payload = await api("/api/detect/now", { method: "POST" });
    showToast("Analyse terminée", `${payload.inserted} nouvelle(s) alerte(s) détectée(s).`);
    await Promise.all([loadAlerts(), loadCountryOptions(), loadRegionOptions(), loadStats(), loadTickerAlerts()]);
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

  if (refs.toggleVoiceBtn) {
    refs.toggleVoiceBtn.addEventListener("click", () => {
      toggleVoice().catch((error) => showToast("Erreur", error.message));
    });
  }

  if (refs.toggleBrowserNotifBtn) {
    refs.toggleBrowserNotifBtn.addEventListener("click", () => {
      toggleBrowserNotifications().catch((error) => showToast("Erreur", error.message));
    });
  }

  if (refs.toggleMapModeBtn) {
    refs.toggleMapModeBtn.addEventListener("click", () => {
      toggleMapMode();
    });
  }

  if (refs.toggleCoverageBtn) {
    refs.toggleCoverageBtn.addEventListener("click", () => {
      toggleCoverage().catch((error) => showToast("Erreur", error.message));
    });
  }

  if (refs.toggleSmartDigestBtn) {
    refs.toggleSmartDigestBtn.addEventListener("click", () => {
      toggleSmartDigest();
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
  bindFiltersSidebarToggle();

  window.addEventListener("resize", () => {
    const isTabletViewport = window.matchMedia("(min-width: 761px) and (max-width: 1180px)").matches;
    if (isTabletViewport && refs.leftPanel?.classList.contains("filters-collapsed")) {
      refs.leftPanel.classList.remove("filters-collapsed");
      updateFiltersSidebarToggleButton();
    }

    if (layoutResizeTimer) {
      clearTimeout(layoutResizeTimer);
    }
    layoutResizeTimer = setTimeout(() => {
      refreshLayout();
    }, 150);
  });

  window.addEventListener("beforeunload", () => {
    stopVoicePlayback();
  });

  window.addEventListener("focus", () => {
    syncBrowserNotificationState();
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

  state.countryCentroids = new Map();
  state.countryCentroidsByKey = new Map();
  state.countryCentroidsByCode = new Map();
  state.countryGeoFeaturesByKey = new Map();

  state.countryLayer = L.geoJSON(geojson, {
    style: styleCountryFeature,
    onEachFeature: (feature, layer) => {
      const countryName = getFeatureCountryName(feature);
      const countryCode = getFeatureCountryCode(feature);
      const countryKey = normalizeCountryAlias(normalizeCountryKey(countryName));
      const centerPoint = deriveFeatureCenter(feature, layer);

      state.countryCentroids.set(countryName, centerPoint);
      if (countryKey && !state.countryCentroidsByKey.has(countryKey)) {
        state.countryCentroidsByKey.set(countryKey, centerPoint);
      }
      if (countryCode && !state.countryCentroidsByCode.has(countryCode)) {
        state.countryCentroidsByCode.set(countryCode, centerPoint);
      }

      if (countryCode) {
        registerCountryFeature(`code:${countryCode}`, feature);
      }
      if (countryKey) {
        registerCountryFeature(`name:${countryKey}`, feature);
      }

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
  state.countryLegendLayer = L.layerGroup().addTo(state.map);

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
      const tickerExists = state.tickerAlerts.some((existing) => existing._id === alert._id);

      if (!alreadyExists && matchesCurrentFilters(alert)) {
        state.alerts.push(alert);
        state.alerts = sortAlertsByEventTimeDesc(state.alerts);
      }

      if (!tickerExists) {
        state.tickerAlerts.push(alert);
        state.tickerAlerts = sortAlertsByEventTimeDesc(state.tickerAlerts).slice(0, 30);
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
      }
      if (isVoiceEnabled()) {
        speakAlertMessage(alert);
      }
      pushBrowserNotification(alert);
      triggerAlertFlash(alert);
      showToast(
        "Nouvelle alerte détectée",
        `${alert.country?.name || "Localisation inconnue"} | ${typeLabel(alert.type)} | Acte: ${formatAlertEventTime(alert)}`,
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
    state.tickerAlerts = sortAlertsByEventTimeDesc(
      state.tickerAlerts.map((alert) => (alert._id === payload.alert._id ? payload.alert : alert))
    );
    renderAlertsList();
    renderMapMarkers();
    renderTicker();
    renderKeywordsWidget();
  });

  state.eventSource.addEventListener("alert-deleted", (event) => {
    const payload = JSON.parse(event.data);
    state.alerts = state.alerts.filter((alert) => alert._id !== payload.id);
    state.tickerAlerts = state.tickerAlerts.filter((alert) => alert._id !== payload.id);
    renderAlertsList();
    renderMapMarkers();
    renderTicker();
    renderKeywordsWidget();
  });

  state.eventSource.addEventListener("alerts-confirmation-updated", () => {
    loadAlerts().catch(() => {});
    loadStats().catch(() => {});
    loadTickerAlerts().catch(() => {});
  });

  state.eventSource.addEventListener("settings-updated", (event) => {
    const payload = JSON.parse(event.data);
    if (state.settings) {
      state.settings.paused = payload.paused;
      state.settings.pollIntervalSeconds = payload.pollIntervalSeconds;
      if (typeof payload.soundEnabled === "boolean") {
        state.settings.soundEnabled = payload.soundEnabled;
      }
      if (typeof payload.voiceEnabled === "boolean") {
        state.settings.voiceEnabled = payload.voiceEnabled;
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
      updateVoiceToggleUI();
      updateCoverageToggleUI();
      scheduleAutoRefresh();
      loadTickerAlerts().catch(() => {});
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
  beginBootOverlay();

  await runBootStage("ui", "Préparation de l'interface...", async () => {
    state.smartDigestEnabled = readSmartDigestPreference();
    bindEvents();
    updateSmartDigestToggleUI();
    applyPhoneLayoutDefaults();
    initSpeechVoices();
    syncBrowserNotificationState();
  });

  await runBootStage("map", "Initialisation de la carte...", async () => {
    initializeMap();
    updateMapModeUI();
  });

  await runBootStage("countries", "Chargement des contours pays...", async () => {
    await loadCountryGeoJson();
  });

  await runBootStage(
    "filters",
    "Chargement des filtres pays/régions...",
    async () => {
      await Promise.all([loadCountryOptions(), loadRegionOptions()]);
    },
    { required: false }
  );

  await runBootStage("settings", "Synchronisation des paramètres...", async () => {
    await loadSettings();
  });

  await runBootStage(
    "voice",
    "Connexion moteur vocal cloud...",
    async () => {
      await loadVoiceStatus();
    },
    { required: false }
  );

  await runBootStage("alerts", "Récupération des alertes...", async () => {
    await loadAlerts();
  });

  await runBootStage(
    "stats",
    "Calcul des indicateurs et bandeau live...",
    async () => {
      await Promise.all([loadStats(), loadTickerAlerts()]);
    },
    { required: false }
  );

  await runBootStage("stream", "Connexion au flux live...", async () => {
    connectEventStream();
  });

  await runBootStage("final", "Finalisation de l'affichage...", async () => {
    scheduleAutoRefresh();
    refreshLayout();
  });

  completeBootOverlay();
}

bootstrap().catch((error) => {
  console.error(error);
  failBootOverlay(error);
  showToast("Erreur de démarrage", error.message);
});
