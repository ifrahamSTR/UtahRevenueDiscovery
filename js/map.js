/**
 * The Idaho revenue-discovery map. Plain Leaflet + canvas rendering (no
 * clustering library) -- at ~5.7k points canvas circleMarkers redraw fast
 * enough that clustering would only cost the point-level detail this site
 * exists to preserve. See README.md for the full design rationale.
 *
 * Everything here reads MAP_STATE.listings (set once by initMap) and a
 * FILTERS object that the sidebar controls mutate; every control change
 * calls applyFilters(), which re-derives the working set and redraws
 * whichever view mode (points / heat-all / heat-qualifying) is active.
 */
let MAP = null;
let POINTS_LAYER = null;
let HEAT_LAYER = null;
let INSPECT_CIRCLE = null;
let INSPECT_MARKER = null;
let TILE_LAYERS = [];
let ALL_LISTINGS = [];
let FILTERED = [];
let VIEW_MODE = "points"; // 'points' | 'heatAll' | 'heatQualify'
let INSPECT_ACTIVE = false;
let INSPECT_RADIUS = CONFIG.defaultRadiusKm;
let INSPECT_CENTER = null;
let REGION_LAYER = null;

function defaultRangeFilters() {
  const r = CONFIG.ranges;
  return {
    bedrooms: { lo: r.bedrooms.min, hi: r.bedrooms.max },
    accommodates: { lo: r.accommodates.min, hi: r.accommodates.max },
    adr: { lo: r.adr.min, hi: r.adr.max },
    occupancy: { lo: r.occupancy.min, hi: r.occupancy.max },
  };
}

// Every boolean amenity/host flag in the dataset, exposed as an "only show
// listings that have this" toggle -- default off (unchecked = not filtered).
const AMENITY_TOGGLES = [
  { field: "tub", filterKey: "hotTubOnly", label: "Hot tub" },
  { field: "pool", filterKey: "poolOnly", label: "Pool" },
  { field: "park", filterKey: "parkingOnly", label: "Parking" },
  { field: "air", filterKey: "airconOnly", label: "Air conditioning" },
  { field: "gym", filterKey: "gymOnly", label: "Gym" },
  { field: "pets", filterKey: "petsOnly", label: "Pets allowed" },
  { field: "kitchen", filterKey: "kitchenOnly", label: "Kitchen" },
  { field: "instant", filterKey: "instantOnly", label: "Instant Book" },
  { field: "sh", filterKey: "superhostOnly", label: "Superhost" },
];
function defaultAmenityFilters() {
  const o = {};
  AMENITY_TOGGLES.forEach((a) => { o[a.filterKey] = false; });
  return o;
}

const FILTERS = {
  metric: "revA", // 'revA' | 'revP'
  threshold: CONFIG.defaultThreshold,
  showUpside: false,
  ranges: defaultRangeFilters(),
  propertyTypes: new Set(CONFIG.propertyTypeOrder),
  locationTypes: new Set(CONFIG.locationTypeOrder),
  market: "all",
  ...defaultAmenityFilters(),
};

function propertyTypeBucket(pt) {
  const known = CONFIG.propertyTypeOrder.slice(0, -1); // all but "Other"
  return known.indexOf(pt) !== -1 ? pt : "Other";
}

function valueFor(listing) {
  return FILTERS.metric === "revA" ? listing.revA : listing.revP;
}
function qualifies(listing) {
  const v = valueFor(listing);
  return v != null && v >= FILTERS.threshold;
}
function isUpside(listing) {
  if (FILTERS.metric !== "revA") return false;
  return listing.revA < FILTERS.threshold && listing.revP >= FILTERS.threshold;
}

function inRange(value, range, rangeDef) {
  if (value < range.lo) return false;
  const atCeiling = range.hi >= rangeDef.max;
  if (rangeDef.unboundedAtMax && atCeiling) return true;
  return value <= range.hi;
}

function matchesFilters(listing) {
  const R = CONFIG.ranges;
  if (!inRange(listing.bd, FILTERS.ranges.bedrooms, R.bedrooms)) return false;
  if (!inRange(listing.acc, FILTERS.ranges.accommodates, R.accommodates)) return false;
  if (!inRange(listing.adr, FILTERS.ranges.adr, R.adr)) return false;
  if (!inRange(listing.occ * 100, FILTERS.ranges.occupancy, R.occupancy)) return false;
  if (!FILTERS.propertyTypes.has(propertyTypeBucket(listing.pt))) return false;
  if (!FILTERS.locationTypes.has(listing.loc)) return false;
  if (FILTERS.market !== "all" && listing.mkt !== FILTERS.market) return false;
  for (let i = 0; i < AMENITY_TOGGLES.length; i++) {
    const a = AMENITY_TOGGLES[i];
    if (FILTERS[a.filterKey] && !listing[a.field]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Zoom-scaled marker sizing. Both layers grow together while zooming so the
// relative hierarchy (green dominates, gray recedes) holds at every scale.
// ---------------------------------------------------------------------------
function belowRadius(zoom) {
  return Math.min(5, Math.max(1.8, 1.6 + (zoom - 6) * 0.32));
}
function aboveBaseRadius(zoom) {
  return Math.min(15, Math.max(5.5, 5.5 + (zoom - 6) * 0.85));
}
function aboveExtraRadius(zoom) {
  return Math.min(11, Math.max(3.5, 3.5 + (zoom - 6) * 0.6));
}
function magnitudeNorm(listing) {
  const v = valueFor(listing);
  const span = Math.max(1, MAP_STATE.maxValue - FILTERS.threshold);
  return Math.max(0, Math.min(1, (v - FILTERS.threshold) / span));
}
function upsideRadius(zoom) {
  return Math.min(9, Math.max(3.5, 3.5 + (zoom - 6) * 0.5));
}

const MAP_STATE = { maxValue: 400000 };

// ---------------------------------------------------------------------------
// Popup card
// ---------------------------------------------------------------------------
function urlLabel(src) {
  if (src === "airbnb") return "View on Airbnb";
  if (src === "vrbo") return "View on Vrbo";
  if (src === "booking") return "View on Booking.com";
  return "View listing";
}

function amenityChips(l) {
  const chips = [];
  if (l.sh) chips.push("Superhost");
  if (l.tub) chips.push("Hot tub");
  if (l.pool) chips.push("Pool");
  if (l.park) chips.push("Parking");
  if (l.instant) chips.push("Instant Book");
  if (!chips.length) return "";
  return (
    '<div class="popup-chips">' +
    chips.map((c) => '<span class="popup-chip">' + c + "</span>").join("") +
    "</div>"
  );
}

function popupHtml(l) {
  const qual = qualifies(l);
  const upside = isUpside(l);
  const badge = qual
    ? '<span class="popup-badge popup-badge--above">&ge; ' + fmtCurrencyCompact(FILTERS.threshold) + "</span>"
    : upside
    ? '<span class="popup-badge popup-badge--upside">Potential upside</span>'
    : "";
  const img = l.img
    ? '<div class="popup-media"><img src="' + escapeHtml(l.img) + '" alt="" loading="lazy" /></div>'
    : "";
  const metrics =
    '<div class="popup-metrics">' +
    '<div class="popup-metric"><span class="popup-metric__label">Actual revenue</span><span class="popup-metric__value' +
    (FILTERS.metric === "revA" ? " popup-metric__value--active" : "") +
    '">' + fmtCurrency(l.revA) + "</span></div>" +
    '<div class="popup-metric"><span class="popup-metric__label">Potential revenue</span><span class="popup-metric__value' +
    (FILTERS.metric === "revP" ? " popup-metric__value--active" : "") +
    '">' + fmtCurrency(l.revP) + "</span></div>" +
    '<div class="popup-metric"><span class="popup-metric__label">ADR</span><span class="popup-metric__value">' + fmtCurrency(l.adr) + "</span></div>" +
    '<div class="popup-metric"><span class="popup-metric__label">Occupancy</span><span class="popup-metric__value">' + fmtPct(l.occ) + "</span></div>" +
    "</div>";
  const specs =
    l.bd + " bd · " + l.ba + " ba · sleeps " + l.acc + " · " + escapeHtml(l.pt);
  const geo = escapeHtml(l.city) + " · " + escapeHtml(l.mkt) + " (" + escapeHtml(l.loc) + ")";
  const meta =
    '<p class="popup-meta">' +
    fmtNumber(l.reviews) + " reviews · rating " + fmtNumber(l.rating) + "/100 · " +
    fmtNumber(l.nights) + " active nights/yr" +
    "</p>";
  const link = l.url
    ? '<a class="popup-link" href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener">' + urlLabel(l.urlSrc) + " &#8599;</a>"
    : "";

  return (
    '<div class="popup-card">' +
    img +
    '<div class="popup-body">' +
    badge +
    "<h5>" + escapeHtml(l.t) + "</h5>" +
    '<p class="popup-specs">' + specs + "</p>" +
    '<p class="popup-geo">' + geo + "</p>" +
    metrics +
    amenityChips(l) +
    meta +
    link +
    "</div></div>"
  );
}

function tooltipHtml(l) {
  return (
    "<strong>" + escapeHtml(l.t.length > 46 ? l.t.slice(0, 44) + "…" : l.t) + "</strong><br>" +
    escapeHtml(l.city) + " · " + fmtCurrency(valueFor(l)) +
    (FILTERS.metric === "revA" ? " actual" : " potential")
  );
}

// ---------------------------------------------------------------------------
// Property detail modal -- clicking a marker never navigates straight to
// Airbnb; it opens this card first, with "View on Airbnb" as an explicit
// button inside it. Reuses popupHtml()'s markup (same card, just presented
// bigger/centered instead of pinned to a map popup bubble).
// ---------------------------------------------------------------------------
function openPropertyModal(l) {
  const modal = document.getElementById("property-modal");
  const body = document.getElementById("property-modal-body");
  if (!modal || !body) return;
  body.innerHTML = popupHtml(l);
  modal.classList.add("property-modal--open");
  modal.setAttribute("aria-hidden", "false");
}
function closePropertyModal() {
  const modal = document.getElementById("property-modal");
  if (!modal) return;
  modal.classList.remove("property-modal--open");
  modal.setAttribute("aria-hidden", "true");
}
window.closePropertyModal = closePropertyModal;

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function makeMarker(l, radius, fill, stroke, weight, fillOpacity) {
  const m = L.circleMarker([l.lat, l.lng], {
    radius,
    color: stroke,
    weight,
    fillColor: fill,
    fillOpacity,
    opacity: weight > 0 ? 0.9 : 0,
  });
  m.bindTooltip(tooltipHtml(l), { sticky: true, direction: "top", offset: [0, -4] });
  m.on("click", () => openPropertyModal(l));
  return m;
}

function drawPoints() {
  if (!POINTS_LAYER) return;
  POINTS_LAYER.clearLayers();
  const zoom = MAP.getZoom();
  const belowR = belowRadius(zoom);
  const upR = upsideRadius(zoom);
  const baseR = aboveBaseRadius(zoom);
  const extraR = aboveExtraRadius(zoom);

  const below = [];
  const upsideList = [];
  const above = [];
  FILTERED.forEach((l) => {
    if (qualifies(l)) above.push(l);
    else if (FILTERS.showUpside && isUpside(l)) upsideList.push(l);
    else below.push(l);
  });

  below.forEach((l) => {
    POINTS_LAYER.addLayer(makeMarker(l, belowR, CONFIG.colors.below, CONFIG.colors.belowStroke, 0, 0.45));
  });
  upsideList.forEach((l) => {
    POINTS_LAYER.addLayer(makeMarker(l, upR, CONFIG.colors.upside, CONFIG.colors.upsideStroke, 1.3, 0.85));
  });
  above.forEach((l) => {
    const r = baseR + extraR * Math.sqrt(magnitudeNorm(l));
    POINTS_LAYER.addLayer(
      L.circleMarker([l.lat, l.lng], {
        radius: r + 4,
        color: "transparent",
        weight: 0,
        fillColor: CONFIG.colors.above,
        fillOpacity: 0.16,
        interactive: false,
      })
    );
    POINTS_LAYER.addLayer(makeMarker(l, r, CONFIG.colors.above, CONFIG.colors.aboveStroke, 1.4, 0.92));
  });
}

function rescalePointsForZoom() {
  if (VIEW_MODE !== "points") return;
  drawPoints();
}

function buildHeatPoints(qualifyOnly) {
  const src = qualifyOnly ? FILTERED.filter(qualifies) : FILTERED;
  return src.map((l) => [l.lat, l.lng, 1]);
}

function clearHeat() {
  if (HEAT_LAYER) {
    MAP.removeLayer(HEAT_LAYER);
    HEAT_LAYER = null;
  }
}

function setViewMode(mode) {
  VIEW_MODE = mode;
  clearHeat();
  if (mode === "points") {
    if (!MAP.hasLayer(POINTS_LAYER)) POINTS_LAYER.addTo(MAP);
    drawPoints();
    return;
  }
  if (MAP.hasLayer(POINTS_LAYER)) MAP.removeLayer(POINTS_LAYER);
  const pts = buildHeatPoints(mode === "heatQualify");
  HEAT_LAYER = L.heatLayer(pts, {
    radius: mode === "heatQualify" ? 30 : 20,
    blur: mode === "heatQualify" ? 24 : 18,
    maxZoom: 11,
    max: mode === "heatQualify" ? 0.35 : 0.9,
    minOpacity: 0.25,
    gradient:
      mode === "heatQualify"
        ? { 0.2: "#dff3e6", 0.5: "#7fd19d", 0.8: "#1fa35c", 1.0: "#0d5c33" }
        : { 0.2: "#eef2f5", 0.4: "#c7d0d8", 0.7: "#8b98a6", 1.0: "#4b5763" },
  }).addTo(MAP);
}

// ---------------------------------------------------------------------------
// Legend + stat readout (reacts to filters, always visible)
// ---------------------------------------------------------------------------
function renderLegend() {
  const host = document.getElementById("map-legend");
  if (!host) return;
  const n = FILTERED.length;
  const qualifyingN = FILTERED.filter(qualifies).length;
  const pct = n ? qualifyingN / n : 0;
  const upsideN = FILTERS.showUpside ? FILTERED.filter(isUpside).length : 0;
  const metricLabel = FILTERS.metric === "revA" ? "actual LTM revenue" : "potential LTM revenue";

  let html = "";
  html += '<div class="legend-row"><span class="legend-swatch legend-swatch--above"></span>';
  html += "&ge; " + fmtCurrencyCompact(FILTERS.threshold) + " (" + metricLabel + ")</div>";
  html += '<div class="legend-row"><span class="legend-swatch legend-swatch--below"></span>Below threshold</div>';
  if (FILTERS.showUpside) {
    html += '<div class="legend-row"><span class="legend-swatch legend-swatch--upside"></span>Below actual, but potential clears the bar</div>';
  }
  html += '<p class="legend-note">Dot size scales with revenue above the threshold — a bigger green dot is a stronger outlier, not just a pass/fail.</p>';
  host.innerHTML = html;

  const stat = document.getElementById("map-stat-readout");
  if (stat) {
    stat.innerHTML =
      '<div class="map-stat"><strong>' + fmtNumber(n) + "</strong><span>listings shown</span></div>" +
      '<div class="map-stat map-stat--above"><strong>' + fmtNumber(qualifyingN) + "</strong><span>&ge; " + fmtCurrencyCompact(FILTERS.threshold) + " (" + fmtPct(pct, 1) + ")</span></div>" +
      (FILTERS.showUpside
        ? '<div class="map-stat map-stat--upside"><strong>' + fmtNumber(upsideN) + "</strong><span>potential-only upside</span></div>"
        : "");
  }
}

// ---------------------------------------------------------------------------
// Inspect-area tool
// ---------------------------------------------------------------------------
function clearInspect() {
  if (INSPECT_CIRCLE) { MAP.removeLayer(INSPECT_CIRCLE); INSPECT_CIRCLE = null; }
  if (INSPECT_MARKER) { MAP.removeLayer(INSPECT_MARKER); INSPECT_MARKER = null; }
  INSPECT_CENTER = null;
  const panel = document.getElementById("inspect-results");
  if (panel) panel.innerHTML = '<p class="inspect-empty">Click anywhere on the map to summarize the listings within the radius.</p>';
}

function drawInspectCircle(latlng) {
  if (INSPECT_CIRCLE) MAP.removeLayer(INSPECT_CIRCLE);
  if (INSPECT_MARKER) MAP.removeLayer(INSPECT_MARKER);
  INSPECT_CIRCLE = L.circle(latlng, {
    radius: INSPECT_RADIUS * 1000,
    color: CONFIG.colors.selection,
    weight: 1.5,
    fillColor: CONFIG.colors.selection,
    fillOpacity: 0.06,
    dashArray: "5 4",
  }).addTo(MAP);
  INSPECT_MARKER = L.circleMarker(latlng, { radius: 4, color: CONFIG.colors.selection, weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(MAP);
}

function runInspect(latlng) {
  INSPECT_CENTER = latlng;
  drawInspectCircle(latlng);
  const nearby = FILTERED.filter((l) => distanceKm(latlng.lat, latlng.lng, l.lat, l.lng) <= INSPECT_RADIUS);
  renderInspectResults(nearby);
}

function compareRow(label, localVal, stateVal, fmt) {
  return (
    '<div class="inspect-compare-row"><span class="inspect-compare-row__label">' + label + "</span>" +
    '<span class="inspect-compare-row__local">' + fmt(localVal) + "</span>" +
    '<span class="inspect-compare-row__state">' + fmt(stateVal) + " state</span></div>"
  );
}

function topCounts(items, keyFn, limit) {
  const counts = {};
  items.forEach((l) => { const k = keyFn(l); counts[k] = (counts[k] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function renderInspectResults(nearby) {
  const panel = document.getElementById("inspect-results");
  if (!panel) return;
  const n = nearby.length;
  if (!n) {
    panel.innerHTML = '<p class="inspect-empty">No listings from the current filter set fall within ' + INSPECT_RADIUS + " km of that point.</p>";
    return;
  }
  const T = FILTERS.threshold;
  const T2 = CONFIG.secondaryReferenceThreshold;
  const qual = nearby.filter(qualifies);
  const qual2 = nearby.filter((l) => l.revA >= T2);
  const localRate = qual.length / n;
  const statewideN = FILTERED.length;
  const statewideQual = FILTERED.filter(qualifies).length;
  const statewideRate = statewideN ? statewideQual / statewideN : 0;
  const idx = statewideRate > 0 ? localRate / statewideRate : null;

  const localVals = { revA: nearby.map((l) => l.revA), revP: nearby.map((l) => l.revP), adr: nearby.map((l) => l.adr), occ: nearby.map((l) => l.occ), bd: nearby.map((l) => l.bd), acc: nearby.map((l) => l.acc) };
  const stateVals = { revA: FILTERED.map((l) => l.revA), revP: FILTERED.map((l) => l.revP), adr: FILTERED.map((l) => l.adr), occ: FILTERED.map((l) => l.occ), bd: FILTERED.map((l) => l.bd), acc: FILTERED.map((l) => l.acc) };

  const types = topCounts(nearby, (l) => propertyTypeBucket(l.pt), 4);
  const markets = topCounts(nearby, (l) => l.mkt, 3);
  const cities = topCounts(nearby, (l) => l.city, 4);

  const amenityRates = AMENITY_TOGGLES.filter((a) => ["tub", "pool", "sh", "instant"].includes(a.field)).map((a) => {
    const c = nearby.filter((l) => l[a.field]).length;
    return { label: a.label, pct: c / n };
  });

  let html = "";

  html += '<div class="inspect-stat-row">';
  html += '<div class="inspect-stat"><strong>' + fmtNumber(n) + "</strong><span>listings within " + INSPECT_RADIUS + " km</span></div>";
  html += '<div class="inspect-stat inspect-stat--above"><strong>' + fmtNumber(qual.length) + "</strong><span>&ge; " + fmtCurrencyCompact(T) + " (" + fmtPct(localRate, 1) + ")</span></div>";
  html += '<div class="inspect-stat inspect-stat--above2"><strong>' + fmtNumber(qual2.length) + "</strong><span>&ge; " + fmtCurrencyCompact(T2) + " (" + fmtPct(qual2.length / n, 1) + ")</span></div>";
  html += "</div>";

  html += '<p class="inspect-line">Local hit rate is ';
  if (idx != null) {
    html += "<strong>" + idx.toFixed(1) + "&times;</strong> the statewide rate (" + fmtPct(statewideRate, 1) + ") — ";
    html += idx >= 1.5 ? "meaningfully denser here than the state as a whole." : idx <= 0.6 ? "thinner here than the state as a whole." : "close to the statewide baseline.";
  } else {
    html += "not comparable (no qualifying listings statewide under current filters).";
  }
  html += "</p>";

  html += '<div class="inspect-compare-table">';
  html += compareRow("Median actual rev.", medianOf(localVals.revA), medianOf(stateVals.revA), fmtCurrency);
  html += compareRow("Median potential rev.", medianOf(localVals.revP), medianOf(stateVals.revP), fmtCurrency);
  html += compareRow("Median ADR", medianOf(localVals.adr), medianOf(stateVals.adr), fmtCurrency);
  html += compareRow("Median occupancy", medianOf(localVals.occ), medianOf(stateVals.occ), (v) => fmtPct(v, 0));
  html += compareRow("Median bedrooms", medianOf(localVals.bd), medianOf(stateVals.bd), (v) => v.toFixed(1));
  html += compareRow("Median sleeps", medianOf(localVals.acc), medianOf(stateVals.acc), (v) => v.toFixed(1));
  html += "</div>";

  html += '<div class="inspect-chip-group"><span class="inspect-chip-group__label">Property types</span><div class="inspect-chip-row">';
  types.forEach(([k, v]) => { html += '<span class="inspect-chip">' + escapeHtml(k) + " (" + v + ")</span>"; });
  html += "</div></div>";

  html += '<div class="inspect-chip-group"><span class="inspect-chip-group__label">Amenities here</span><div class="inspect-chip-row">';
  amenityRates.forEach((a) => { html += '<span class="inspect-chip">' + escapeHtml(a.label) + " " + fmtPct(a.pct, 0) + "</span>"; });
  html += "</div></div>";

  html += '<div class="inspect-chip-group"><span class="inspect-chip-group__label">AirDNA markets</span><div class="inspect-chip-row">';
  markets.forEach(([k, v]) => { html += '<span class="inspect-chip">' + escapeHtml(k) + " (" + v + ")</span>"; });
  html += "</div></div>";

  html += '<div class="inspect-chip-group"><span class="inspect-chip-group__label">Cities</span><div class="inspect-chip-row">';
  cities.forEach(([k, v]) => { html += '<span class="inspect-chip">' + escapeHtml(k) + " (" + v + ")</span>"; });
  html += "</div></div>";

  const strongest = nearby.slice().sort((a, b) => valueFor(b) - valueFor(a)).slice(0, 10);
  html += '<div class="inspect-list-title">Strongest listings in range</div><ul class="inspect-list">';
  strongest.forEach((l) => {
    html += '<li class="inspect-list__item" data-id="' + escapeHtml(l.id) + '"><span class="inspect-list__title">' + escapeHtml(l.t.length > 38 ? l.t.slice(0, 36) + "…" : l.t) + '</span><span class="inspect-list__value">' + fmtCurrency(valueFor(l)) + "</span></li>";
  });
  if (nearby.length > 10) html += '<li class="inspect-list__more">+' + (nearby.length - 10) + " more within range</li>";
  html += "</ul>";

  panel.innerHTML = html;

  panel.querySelectorAll(".inspect-list__item").forEach((row) => {
    row.addEventListener("click", () => {
      const l = FILTERED.find((x) => x.id === row.dataset.id) || ALL_LISTINGS.find((x) => x.id === row.dataset.id);
      if (!l) return;
      MAP.setView([l.lat, l.lng], Math.max(MAP.getZoom(), 13), { animate: true });
      openPropertyModal(l);
    });
  });
}

function toggleInspectMode(active) {
  INSPECT_ACTIVE = active;
  const container = MAP.getContainer();
  container.classList.toggle("map-canvas--inspecting", active);
  if (!active) clearInspect();
}

// ---------------------------------------------------------------------------
// Basemap + custom controls
// ---------------------------------------------------------------------------
function setBasemap(key) {
  const def = CONFIG.basemaps[key];
  if (!def) return;
  TILE_LAYERS.forEach((l) => MAP.removeLayer(l));
  TILE_LAYERS = def.layers.map((layerDef) =>
    L.tileLayer(layerDef.url, { attribution: def.attribution, maxZoom: layerDef.maxZoom }).addTo(MAP)
  );
  TILE_LAYERS.forEach((l) => l.bringToBack());
}

function buildLayerControl(opts) {
  opts = opts || {};
  const Control = L.Control.extend({
    onAdd: function () {
      const div = L.DomUtil.create("div", "map-widget map-widget--layers");
      div.innerHTML =
        '<div class="map-widget__group" data-role="viewmode">' +
        '<button class="map-widget__btn map-widget__btn--active" data-mode="points">Points</button>' +
        '<button class="map-widget__btn" data-mode="heatAll">Heat: all</button>' +
        '<button class="map-widget__btn" data-mode="heatQualify">Heat: qualifying</button>' +
        "</div>" +
        '<div class="map-widget__group" data-role="basemap">' +
        '<button class="map-widget__btn map-widget__btn--active" data-basemap="light">Light</button>' +
        '<button class="map-widget__btn" data-basemap="terrain">Terrain</button>' +
        "</div>" +
        (opts.hasRegions
          ? '<div class="map-widget__group" data-role="regions"><button class="map-widget__btn map-widget__btn--active" data-regions="on">Regions shown</button></div>'
          : "");
      L.DomEvent.disableClickPropagation(div);
      div.querySelectorAll("[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          div.querySelectorAll("[data-mode]").forEach((b) => b.classList.remove("map-widget__btn--active"));
          btn.classList.add("map-widget__btn--active");
          setViewMode(btn.dataset.mode);
        });
      });
      div.querySelectorAll("[data-basemap]").forEach((btn) => {
        btn.addEventListener("click", () => {
          div.querySelectorAll("[data-basemap]").forEach((b) => b.classList.remove("map-widget__btn--active"));
          btn.classList.add("map-widget__btn--active");
          setBasemap(btn.dataset.basemap);
        });
      });
      const regionsBtn = div.querySelector("[data-regions]");
      if (regionsBtn) {
        regionsBtn.addEventListener("click", () => {
          const showing = toggleRegionOverlay();
          regionsBtn.classList.toggle("map-widget__btn--active", showing);
          regionsBtn.textContent = showing ? "Regions shown" : "Regions hidden";
        });
      }
      return div;
    },
  });
  MAP.addControl(new Control({ position: "topright" }));
}

// ---------------------------------------------------------------------------
// Region overlay (statewide map only) -- dashed boundary + label per
// discovered region, clickable through to that region's dedicated page.
// ---------------------------------------------------------------------------
function drawRegionOverlays(regions, opts) {
  if (!MAP || !regions || !regions.length) return;
  opts = opts || {};
  const linkBase = opts.linkBase || "regions/";
  if (REGION_LAYER) MAP.removeLayer(REGION_LAYER);
  REGION_LAYER = L.layerGroup();
  regions.forEach((r) => {
    const latlngs = r.polygon.map((p) => [p[0], p[1]]);
    const poly = L.polygon(latlngs, {
      color: CONFIG.colors.regionStroke,
      weight: 1.5,
      dashArray: "6 5",
      fillColor: CONFIG.colors.regionStroke,
      fillOpacity: 0.05,
    });
    poly.bindTooltip(r.name + " — explore this region →", { sticky: true, className: "region-tooltip" });
    poly.on("click", () => { window.location.href = linkBase + r.id + "/"; });
    REGION_LAYER.addLayer(poly);

    const label = L.marker(r.centroid, {
      icon: L.divIcon({ className: "region-label", html: "<span>" + escapeHtml(r.name) + "</span>", iconSize: [1, 1] }),
    });
    label.on("click", () => { window.location.href = linkBase + r.id + "/"; });
    REGION_LAYER.addLayer(label);
  });
  REGION_LAYER.addTo(MAP);
}
function toggleRegionOverlay() {
  if (!REGION_LAYER) return false;
  if (MAP.hasLayer(REGION_LAYER)) { MAP.removeLayer(REGION_LAYER); return false; }
  MAP.addLayer(REGION_LAYER);
  return true;
}

function buildInspectControl() {
  const Control = L.Control.extend({
    onAdd: function () {
      const div = L.DomUtil.create("div", "map-widget map-widget--inspect");
      div.innerHTML =
        '<label class="map-widget__toggle"><input type="checkbox" id="inspect-toggle" /> Inspect area</label>' +
        '<div class="map-widget__radius" id="inspect-radius-wrap" hidden>' +
        '<input type="range" id="inspect-radius" min="' + CONFIG.radiusMinKm + '" max="' + CONFIG.radiusMaxKm + '" step="' + CONFIG.radiusStepKm + '" value="' + INSPECT_RADIUS + '" />' +
        '<span id="inspect-radius-label">' + INSPECT_RADIUS + " km</span></div>";
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  MAP.addControl(new Control({ position: "topleft" }));

  window.setTimeout(() => {
    const toggle = document.getElementById("inspect-toggle");
    const wrap = document.getElementById("inspect-radius-wrap");
    const radius = document.getElementById("inspect-radius");
    const label = document.getElementById("inspect-radius-label");
    if (toggle) {
      toggle.addEventListener("change", () => {
        wrap.hidden = !toggle.checked;
        toggleInspectMode(toggle.checked);
      });
    }
    if (radius) {
      radius.addEventListener("input", () => {
        INSPECT_RADIUS = parseFloat(radius.value);
        label.textContent = INSPECT_RADIUS + " km";
        if (INSPECT_CENTER) runInspect(INSPECT_CENTER);
      });
    }
  }, 0);
}

// ---------------------------------------------------------------------------
// Filter sidebar
// ---------------------------------------------------------------------------
function propertyTypeCounts() {
  const counts = {};
  ALL_LISTINGS.forEach((l) => {
    const b = propertyTypeBucket(l.pt);
    counts[b] = (counts[b] || 0) + 1;
  });
  return counts;
}
function marketCounts() {
  const counts = {};
  ALL_LISTINGS.forEach((l) => { counts[l.mkt] = (counts[l.mkt] || 0) + 1; });
  return counts;
}

// ---------------------------------------------------------------------------
// Dual-handle range sliders (bedrooms, sleeps, ADR, occupancy). Two native
// <input type=range> stacked on the same track -- only the thumb is
// clickable (CSS pointer-events trick in styles.css), so both handles stay
// independently draggable without a slider library.
// ---------------------------------------------------------------------------
function formatRangeValue(v, rangeDef) {
  if (rangeDef.unit === "currency") return fmtCurrency(v);
  if (rangeDef.unit === "pct") return Math.round(v) + "%";
  return Math.round(v) + (rangeDef.unit === "bd" ? " bd" : rangeDef.unit === "sleeps" ? " sleeps" : "");
}
function formatRangeLabel(range, rangeDef) {
  const atFloor = range.lo <= rangeDef.min;
  const atCeiling = range.hi >= rangeDef.max;
  if (atFloor && atCeiling) return "Any";
  const loStr = formatRangeValue(range.lo, rangeDef);
  const hiStr = formatRangeValue(range.hi, rangeDef) + (atCeiling && rangeDef.unboundedAtMax ? "+" : "");
  if (atFloor) return "Up to " + hiStr;
  return loStr + "–" + hiStr;
}
function rangeFillStyle(range, rangeDef) {
  const span = rangeDef.max - rangeDef.min;
  const pctLo = ((range.lo - rangeDef.min) / span) * 100;
  const pctHi = ((range.hi - rangeDef.min) / span) * 100;
  return "left:" + pctLo.toFixed(2) + "%;right:" + (100 - pctHi).toFixed(2) + "%;";
}
function rangeFilterHtml(key, label, rangeDef) {
  const range = FILTERS.ranges[key];
  return (
    '<div class="range-filter" data-range-key="' + key + '">' +
    '<div class="range-filter__head"><label>' + label + '</label><span class="range-filter__value" data-range-label>' +
    escapeHtml(formatRangeLabel(range, rangeDef)) + "</span></div>" +
    '<div class="range-slider">' +
    '<div class="range-slider__track"></div>' +
    '<div class="range-slider__fill" data-range-fill style="' + rangeFillStyle(range, rangeDef) + '"></div>' +
    '<input type="range" class="range-slider__input" data-range-min min="' + rangeDef.min + '" max="' + rangeDef.max + '" step="' + rangeDef.step + '" value="' + range.lo + '">' +
    '<input type="range" class="range-slider__input" data-range-max min="' + rangeDef.min + '" max="' + rangeDef.max + '" step="' + rangeDef.step + '" value="' + range.hi + '">' +
    "</div></div>"
  );
}
function wireRangeFilter(host, key, rangeDef) {
  const wrap = host.querySelector('[data-range-key="' + key + '"]');
  if (!wrap) return;
  const minInput = wrap.querySelector("[data-range-min]");
  const maxInput = wrap.querySelector("[data-range-max]");
  const label = wrap.querySelector("[data-range-label]");
  const fill = wrap.querySelector("[data-range-fill]");

  function update(source) {
    let lo = parseFloat(minInput.value);
    let hi = parseFloat(maxInput.value);
    if (lo > hi) {
      if (source === "max") { lo = hi; minInput.value = lo; }
      else { hi = lo; maxInput.value = hi; }
    }
    const range = { lo, hi };
    FILTERS.ranges[key] = range;
    label.textContent = formatRangeLabel(range, rangeDef);
    fill.setAttribute("style", rangeFillStyle(range, rangeDef));
    applyFilters();
  }
  minInput.addEventListener("input", () => update("min"));
  maxInput.addEventListener("input", () => update("max"));
}

function renderFilters() {
  const host = document.getElementById("map-filters");
  if (!host) return;
  const ptCounts = propertyTypeCounts();
  const mktCounts = marketCounts();
  const marketsSorted = Object.entries(mktCounts).sort((a, b) => b[1] - a[1]);

  let html = "";

  html += '<div class="filter-block">';
  html += "<h4>Revenue metric</h4>";
  html += '<div class="metric-toggle">';
  html += '<button class="metric-toggle__btn metric-toggle__btn--active" data-metric="revA">Actual (LTM)</button>';
  html += '<button class="metric-toggle__btn" data-metric="revP">Potential (LTM)</button>';
  html += "</div>";
  html += '<div class="threshold-control">';
  html += '<label for="threshold-slider">Threshold: <strong id="threshold-value">' + fmtCurrency(FILTERS.threshold) + "</strong></label>";
  html += '<input type="range" id="threshold-slider" min="' + CONFIG.thresholdMin + '" max="' + CONFIG.thresholdMax + '" step="' + CONFIG.thresholdStep + '" value="' + FILTERS.threshold + '" />';
  html += "</div>";
  html += '<label class="filter-row" id="upside-row"><input type="checkbox" id="upside-toggle" /> Highlight potential-only upside</label>';
  html += "</div>";

  html += '<details class="filter-block filter-block--collapsible" open><summary>Property size</summary>';
  html += rangeFilterHtml("bedrooms", "Bedrooms", CONFIG.ranges.bedrooms);
  html += rangeFilterHtml("accommodates", "Sleeps", CONFIG.ranges.accommodates);
  html += '<div class="filter-group" data-filter-group="propertyType">';
  CONFIG.propertyTypeOrder.forEach((pt) => {
    const c = ptCounts[pt] || 0;
    html += '<label class="filter-row"><input type="checkbox" checked data-pt="' + pt + '"> ' + pt + ' <span class="filter-count">(' + c + ")</span></label>";
  });
  html += "</div></details>";

  html += '<details class="filter-block filter-block--collapsible" open><summary>Performance</summary>';
  html += rangeFilterHtml("adr", "ADR", CONFIG.ranges.adr);
  html += rangeFilterHtml("occupancy", "Occupancy", CONFIG.ranges.occupancy);
  html += "</details>";

  html += '<details class="filter-block filter-block--collapsible" open><summary>Location</summary>';
  html += '<div class="filter-group" data-filter-group="locationType">';
  CONFIG.locationTypeOrder.forEach((loc) => {
    const c = ALL_LISTINGS.filter((l) => l.loc === loc).length;
    html += '<label class="filter-row"><input type="checkbox" checked data-loc="' + loc + '"> ' + loc + ' <span class="filter-count">(' + c + ")</span></label>";
  });
  html += "</div>";
  html += '<div class="filter-subrow"><label>AirDNA market</label><select id="market-select"><option value="all">All markets</option>';
  marketsSorted.forEach(([mkt, c]) => { html += '<option value="' + escapeHtml(mkt) + '">' + escapeHtml(mkt) + " (" + c + ")</option>"; });
  html += "</select></div></details>";

  html += '<details class="filter-block filter-block--collapsible"><summary>Amenities &amp; host</summary>';
  html += '<div class="filter-group" data-filter-group="amenities">';
  AMENITY_TOGGLES.forEach((a) => {
    const c = ALL_LISTINGS.filter((l) => l[a.field]).length;
    html += '<label class="filter-row"><input type="checkbox" data-amenity="' + a.filterKey + '"> ' + a.label + ' <span class="filter-count">(' + c + ")</span></label>";
  });
  html += "</div></details>";

  html += '<button class="btn btn--reset" id="reset-filters">Reset filters</button>';

  host.innerHTML = html;
  wireFilterEvents(host);
}

function wireFilterEvents(host) {
  host.querySelectorAll("[data-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      host.querySelectorAll("[data-metric]").forEach((b) => b.classList.remove("metric-toggle__btn--active"));
      btn.classList.add("metric-toggle__btn--active");
      FILTERS.metric = btn.dataset.metric;
      document.getElementById("upside-row").style.display = FILTERS.metric === "revA" ? "" : "none";
      applyFilters();
    });
  });
  const slider = document.getElementById("threshold-slider");
  if (slider) {
    slider.addEventListener("input", () => {
      FILTERS.threshold = parseInt(slider.value, 10);
      document.getElementById("threshold-value").textContent = fmtCurrency(FILTERS.threshold);
      applyFilters();
    });
  }
  const upside = document.getElementById("upside-toggle");
  if (upside) upside.addEventListener("change", () => { FILTERS.showUpside = upside.checked; applyFilters(); });

  wireRangeFilter(host, "bedrooms", CONFIG.ranges.bedrooms);
  wireRangeFilter(host, "accommodates", CONFIG.ranges.accommodates);
  wireRangeFilter(host, "adr", CONFIG.ranges.adr);
  wireRangeFilter(host, "occupancy", CONFIG.ranges.occupancy);

  host.querySelectorAll("[data-pt]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) FILTERS.propertyTypes.add(cb.dataset.pt);
      else FILTERS.propertyTypes.delete(cb.dataset.pt);
      applyFilters();
    });
  });
  host.querySelectorAll("[data-loc]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) FILTERS.locationTypes.add(cb.dataset.loc);
      else FILTERS.locationTypes.delete(cb.dataset.loc);
      applyFilters();
    });
  });
  const market = document.getElementById("market-select");
  if (market) market.addEventListener("change", () => { FILTERS.market = market.value; applyFilters(); });

  host.querySelectorAll("[data-amenity]").forEach((cb) => {
    cb.checked = FILTERS[cb.dataset.amenity];
    cb.addEventListener("change", () => {
      FILTERS[cb.dataset.amenity] = cb.checked;
      applyFilters();
    });
  });

  const reset = document.getElementById("reset-filters");
  if (reset) reset.addEventListener("click", () => resetFilters());
}

function resetFilters() {
  FILTERS.metric = "revA";
  FILTERS.threshold = CONFIG.defaultThreshold;
  FILTERS.showUpside = false;
  FILTERS.ranges = defaultRangeFilters();
  FILTERS.propertyTypes = new Set(CONFIG.propertyTypeOrder);
  FILTERS.locationTypes = new Set(CONFIG.locationTypeOrder);
  FILTERS.market = "all";
  Object.assign(FILTERS, defaultAmenityFilters());
  renderFilters();
  applyFilters();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
function applyFilters() {
  FILTERED = ALL_LISTINGS.filter(matchesFilters);
  renderLegend();
  if (VIEW_MODE === "points") drawPoints();
  else setViewMode(VIEW_MODE);
  if (INSPECT_ACTIVE && INSPECT_CENTER) runInspect(INSPECT_CENTER);
}

function initMap(listings, bounds, opts) {
  opts = opts || {};
  const container = document.getElementById("idaho-map");
  if (!container) return;
  ALL_LISTINGS = listings;
  MAP_STATE.maxValue = Math.max(...listings.map((l) => Math.max(l.revA, l.revP)));

  MAP = L.map(container, { renderer: L.canvas({ padding: 0.5 }), zoomControl: true, minZoom: 6, maxZoom: 17 });
  setBasemap("light");
  MAP.invalidateSize();
  MAP.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [24, 24] });
  L.control.scale({ imperial: true, metric: false, position: "bottomleft" }).addTo(MAP);

  POINTS_LAYER = L.layerGroup().addTo(MAP);

  buildLayerControl({ hasRegions: !!(opts.regions && opts.regions.length) });
  buildInspectControl();
  if (opts.regions && opts.regions.length) {
    drawRegionOverlays(opts.regions, { linkBase: opts.regionLinkBase });
  }

  MAP.on("zoomend", rescalePointsForZoom);
  MAP.on("click", (e) => { if (INSPECT_ACTIVE) runInspect(e.latlng); });

  renderFilters();
  applyFilters();
  clearInspect();

  window.setTimeout(() => {
    MAP.invalidateSize();
    MAP.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [24, 24] });
  }, 50);
}
