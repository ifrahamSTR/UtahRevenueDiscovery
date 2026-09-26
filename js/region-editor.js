/**
 * Local-only visual region editor. AI (scripts/propose_regions.py) proposes
 * the starting boundaries; this page lets an analyst drag/create/cut/merge/
 * delete them, with every listing's region membership and every stat
 * recomputed live in the browser. Save persists the result via a POST to
 * scripts/region_editor_server.py, which re-runs the same assignment rule
 * server-side (scripts/lib/geo.py) and regenerates the region pages -- this
 * file's assignPointToRegion() is a deliberate JS mirror of that Python
 * function; keep them in sync if the rule ever changes.
 *
 * Does NOT reuse js/map.js's initMap() -- that's tightly coupled to the
 * public filter sidebar and Inspect-area tool this editor doesn't want. It
 * DOES reuse js/util.js as-is and js/charts.js's initFindings() untouched,
 * by including the same canvas/container IDs region.html uses.
 */
(function () {
  "use strict";

  const FALLBACK_CAP_KM = 40; // must match scripts/lib/geo.py's DEFAULT_FALLBACK_CAP_KM
  const QUICK_DEBOUNCE_MS = 100;
  const FULL_DEBOUNCE_MS = 300;
  const OVERLAP_TOLERANCE_M2 = 20000; // must match scripts/propose_regions.py / verify_regions.py

  const COLOR_PALETTE = [
    "#1fa35c", "#2f6fb0", "#c2571a", "#8a4bbf", "#c02b6e", "#0d8a8a",
    "#b08900", "#4a5fd9", "#7a8a00", "#d94f4f", "#0f6e93", "#a35c1f",
  ];

  let MAP = null;
  let REGIONS = []; // [{id,name,centroid,polygon,nSeed90k,citiesInSeed,color,layer}]
  let LISTINGS = [];
  let POINTS_LAYER = null;
  let POINTS_RENDERER = null;
  let SELECTED_IDS = new Set();
  let QUICK_TIMER = null;
  let FULL_TIMER = null;
  let SUPPRESS_EDIT_EVENTS = false; // true while we're programmatically clipping a neighbor

  // ---------------------------------------------------------------------------
  // Coordinate conventions: this project's on-disk/Leaflet convention is
  // [lat,lng]; Turf.js wants [lng,lat] GeoJSON order. Convert at every boundary.
  // ---------------------------------------------------------------------------
  function toTurfPolygon(region) {
    const ring = region.polygon.map((p) => [p[1], p[0]]);
    return turf.polygon([ring]);
  }
  function toTurfLine(region) {
    const ring = region.polygon.map((p) => [p[1], p[0]]);
    return turf.lineString(ring);
  }
  function latLngsFromTurfPolygon(turfPoly) {
    // Largest-ring only, matching scripts/lib/geo.py's utm_polygon_to_latlng_list
    // resolving a MultiPolygon to its biggest part.
    let coords;
    if (turfPoly.geometry.type === "MultiPolygon") {
      let best = null, bestArea = -1;
      turfPoly.geometry.coordinates.forEach((rings) => {
        const candidate = turf.polygon(rings);
        const a = turf.area(candidate);
        if (a > bestArea) { bestArea = a; best = rings; }
      });
      coords = best[0];
    } else {
      coords = turfPoly.geometry.coordinates[0];
    }
    return coords.map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
  }

  function colorFor(index) {
    return COLOR_PALETTE[index % COLOR_PALETTE.length];
  }

  function slugify(name) {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "region";
  }
  function uniqueSlug(base, exceptId) {
    let slug = base, n = 2;
    const taken = () => REGIONS.some((r) => r.id === slug && r.id !== exceptId);
    while (taken()) { slug = base + "-" + n; n++; }
    return slug;
  }

  // ---------------------------------------------------------------------------
  // The one canonical "which region is this point in" rule -- mirrors
  // scripts/lib/geo.py:assign_point_to_region() exactly (see that file's
  // docstring for the written spec).
  // ---------------------------------------------------------------------------
  function assignPointToRegion(lat, lng) {
    const pt = turf.point([lng, lat]);
    const contained = [];
    for (const r of REGIONS) {
      if (turf.booleanPointInPolygon(pt, r._turfPoly, { ignoreBoundary: false })) contained.push(r);
    }
    if (contained.length === 1) return contained[0].id;
    if (contained.length > 1) {
      let best = contained[0], bestD = Infinity;
      contained.forEach((r) => {
        const d = turf.distance(pt, turf.point([r.centroid[1], r.centroid[0]]));
        if (d < bestD) { bestD = d; best = r; }
      });
      return best.id;
    }
    let bestId = null, bestKm = Infinity;
    for (const r of REGIONS) {
      const d = turf.pointToLineDistance(pt, r._turfLine, { units: "kilometers" });
      if (d < bestKm) { bestKm = d; bestId = r.id; }
    }
    return bestKm <= FALLBACK_CAP_KM ? bestId : null;
  }

  function refreshTurfCache(region) {
    region._turfPoly = toTurfPolygon(region);
    region._turfLine = toTurfLine(region);
  }

  // ---------------------------------------------------------------------------
  // Overlap auto-clip: when `edited` region's shape changes, any OTHER region
  // it now overlaps gets trimmed (edited region always wins the contested
  // area) -- see README's "Editing region boundaries" for the rationale.
  // ---------------------------------------------------------------------------
  function clipNeighborsAgainst(edited) {
    const notices = [];
    REGIONS.forEach((other) => {
      if (other.id === edited.id) return;
      const overlapArea = turf.area(edited._turfPoly) > 0 ? safeIntersectArea(edited._turfPoly, other._turfPoly) : 0;
      if (overlapArea <= OVERLAP_TOLERANCE_M2) return;
      const diff = turf.difference(turf.featureCollection([other._turfPoly, edited._turfPoly]));
      if (!diff) { notices.push(other.name + " was fully consumed by this edit and had to be removed."); removeRegionById(other.id, { skipRecompute: true }); return; }
      let resolved = diff;
      if (diff.geometry.type === "MultiPolygon" && diff.geometry.coordinates.length > 1) {
        notices.push(other.name + "'s edit split it into pieces -- kept the larger one.");
      }
      other.polygon = latLngsFromTurfPolygon(resolved);
      refreshTurfCache(other);
      SUPPRESS_EDIT_EVENTS = true;
      other.layer.setLatLngs(other.polygon.map((p) => [p[0], p[1]]));
      if (other.layer.pm) { other.layer.pm.disable(); other.layer.pm.enable(); }
      SUPPRESS_EDIT_EVENTS = false;
    });
    return notices;
  }
  function safeIntersectArea(a, b) {
    try {
      const inter = turf.intersect(turf.featureCollection([a, b]));
      return inter ? turf.area(inter) : 0;
    } catch (e) {
      return 0;
    }
  }

  function removeRegionById(id, opts) {
    const idx = REGIONS.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const [r] = REGIONS.splice(idx, 1);
    if (r.layer && MAP.hasLayer(r.layer)) MAP.removeLayer(r.layer);
    SELECTED_IDS.delete(id);
    if (!opts || !opts.skipRecompute) scheduleQuickUpdate();
  }

  // ---------------------------------------------------------------------------
  // Live recompute
  // ---------------------------------------------------------------------------
  function recomputeAssignments() {
    REGIONS.forEach(refreshTurfCache);
    const counts = {};
    REGIONS.forEach((r) => { counts[r.id] = { above: 0, total: 0 }; });
    let nullCount = 0;
    LISTINGS.forEach((l) => {
      if (l.lat == null || l.lng == null) { l.region = null; return; }
      const rid = assignPointToRegion(l.lat, l.lng);
      l.region = rid;
      if (rid == null) { nullCount++; return; }
      counts[rid].total++;
      if (l.revA >= CONFIG.defaultThreshold) counts[rid].above++;
    });
    return { counts, nullCount };
  }

  function redrawPoints() {
    if (!POINTS_LAYER) return;
    POINTS_LAYER.clearLayers();
    const colorById = {};
    REGIONS.forEach((r) => { colorById[r.id] = r.color; });
    LISTINGS.forEach((l) => {
      if (l.lat == null || l.lng == null) return;
      const color = l.region ? colorById[l.region] || "#999" : "#c7cdd2";
      POINTS_LAYER.addLayer(
        L.circleMarker([l.lat, l.lng], { renderer: POINTS_RENDERER, radius: 3, color: "transparent", weight: 0, fillColor: color, fillOpacity: l.region ? 0.75 : 0.35 })
      );
    });
  }

  function renderRegionList(counts, nullCount) {
    const host = document.getElementById("region-list");
    const badge = document.getElementById("region-count-badge");
    if (badge) badge.textContent = REGIONS.length + " regions";
    if (!host) return;
    const rows = REGIONS.slice().sort((a, b) => (counts[b.id].total - counts[a.id].total)).map((r) => {
      const c = counts[r.id];
      const rate = c.total ? fmtPct(c.above / c.total, 0) : "—";
      const selected = SELECTED_IDS.has(r.id) ? " region-row--selected" : "";
      return (
        '<div class="region-row' + selected + '" data-region-id="' + escapeHtml(r.id) + '">' +
        '<span class="region-row__swatch" style="background:' + r.color + '"></span>' +
        '<span class="region-row__name">' + escapeHtml(r.name) + "</span>" +
        '<span class="region-row__stat">' + fmtNumber(c.total) + " listings &middot; " + rate + " &ge; " + fmtCurrencyCompact(CONFIG.defaultThreshold) + "</span>" +
        "</div>"
      );
    });
    host.innerHTML = rows.join("") +
      '<div class="region-row region-row__unassigned">Unassigned (&gt;' + FALLBACK_CAP_KM + "km from any region): " + fmtNumber(nullCount) + "</div>";
    host.querySelectorAll("[data-region-id]").forEach((row) => {
      row.addEventListener("click", () => toggleSelect(row.dataset.regionId));
    });
  }

  function toggleSelect(id) {
    if (SELECTED_IDS.has(id)) SELECTED_IDS.delete(id);
    else SELECTED_IDS.add(id);
    document.getElementById("btn-merge").disabled = SELECTED_IDS.size < 2;
    document.getElementById("btn-delete").disabled = SELECTED_IDS.size < 1;
    const heading = document.getElementById("detail-heading");
    if (SELECTED_IDS.size === 1) {
      const r = REGIONS.find((x) => x.id === [...SELECTED_IDS][0]);
      if (heading && r) heading.textContent = r.name;
    } else if (heading) {
      heading.textContent = "Statewide summary";
    }
    scheduleQuickUpdate();
    scheduleFullUpdate();
  }

  function renderDetail() {
    const listings = SELECTED_IDS.size === 1
      ? LISTINGS.filter((l) => l.region === [...SELECTED_IDS][0])
      : LISTINGS;
    initFindings(listings);
  }

  function scheduleQuickUpdate() {
    clearTimeout(QUICK_TIMER);
    QUICK_TIMER = setTimeout(() => {
      const { counts, nullCount } = recomputeAssignments();
      redrawPoints();
      renderRegionList(counts, nullCount);
      setStatus("");
    }, QUICK_DEBOUNCE_MS);
  }
  function scheduleFullUpdate() {
    clearTimeout(FULL_TIMER);
    FULL_TIMER = setTimeout(renderDetail, FULL_DEBOUNCE_MS);
  }

  function setStatus(text, kind) {
    const el = document.getElementById("editor-status");
    if (!el) return;
    el.textContent = text;
    el.className = "editor-status" + (kind ? " editor-status--" + kind : "");
  }

  // ---------------------------------------------------------------------------
  // Region layer lifecycle
  // ---------------------------------------------------------------------------
  function addRegionLayer(region) {
    const layer = L.polygon(region.polygon.map((p) => [p[0], p[1]]), {
      color: region.color, weight: 2, fillColor: region.color, fillOpacity: 0.12,
    }).addTo(MAP);
    layer.bindTooltip(region.name, { sticky: true });
    region.layer = layer;
    layer._regionId = region.id;
    refreshTurfCache(region);

    layer.on("pm:edit", () => onRegionEdited(region));
    layer.on("pm:markerdragend", () => onRegionEdited(region));
    layer.on("pm:vertexadded", () => onRegionEdited(region));
    layer.on("pm:vertexremoved", () => onRegionEdited(region));
  }

  function onRegionEdited(region) {
    if (SUPPRESS_EDIT_EVENTS) return;
    region.polygon = layer_latlngs_to_polygon(region.layer);
    refreshTurfCache(region);
    const notices = clipNeighborsAgainst(region);
    if (notices.length) setStatus(notices.join(" "), "error");
    scheduleQuickUpdate();
    scheduleFullUpdate();
  }
  function layer_latlngs_to_polygon(layer) {
    const latlngs = layer.getLatLngs()[0];
    const ring = latlngs.map((ll) => [Math.round(ll.lat * 1e5) / 1e5, Math.round(ll.lng * 1e5) / 1e5]);
    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push(ring[0]);
    }
    return ring;
  }

  function newRegionFromLayer(layer) {
    const name = window.prompt("Name this new region:", "New Region");
    if (!name) { MAP.removeLayer(layer); return; }
    const id = uniqueSlug(slugify(name));
    const polygon = layer_latlngs_to_polygon(layer);
    const centroidLatLng = layer.getBounds().getCenter();
    const region = {
      id, name, centroid: [Math.round(centroidLatLng.lat * 1e4) / 1e4, Math.round(centroidLatLng.lng * 1e4) / 1e4],
      polygon, nSeed90k: 0, citiesInSeed: {}, color: colorFor(REGIONS.length), layer,
    };
    MAP.removeLayer(layer); // remove Geoman's own draw layer, replace with our tracked one
    addRegionLayer(region);
    REGIONS.push(region);
    const notices = clipNeighborsAgainst(region);
    if (notices.length) setStatus(notices.join(" "), "error");
    scheduleQuickUpdate();
    scheduleFullUpdate();
  }

  function mergeSelected() {
    const ids = [...SELECTED_IDS];
    if (ids.length < 2) return;
    const regionsToMerge = REGIONS.filter((r) => ids.includes(r.id));
    const name = window.prompt("Name for the merged region:", regionsToMerge[0].name);
    if (!name) return;
    const union = regionsToMerge.slice(1).reduce(
      (acc, r) => turf.union(turf.featureCollection([acc, r._turfPoly])) || acc,
      regionsToMerge[0]._turfPoly
    );
    const survivor = regionsToMerge.reduce((a, b) => (a.nSeed90k >= b.nSeed90k ? a : b));
    ids.forEach((id) => { if (id !== survivor.id) removeRegionById(id, { skipRecompute: true }); });
    survivor.name = name;
    survivor.polygon = latLngsFromTurfPolygon(union);
    survivor.nSeed90k = regionsToMerge.reduce((s, r) => s + r.nSeed90k, 0);
    survivor.citiesInSeed = regionsToMerge.reduce((acc, r) => {
      Object.entries(r.citiesInSeed || {}).forEach(([city, n]) => { acc[city] = (acc[city] || 0) + n; });
      return acc;
    }, {});
    refreshTurfCache(survivor);
    survivor.layer.setLatLngs(survivor.polygon.map((p) => [p[0], p[1]]));
    survivor.layer.setTooltipContent(survivor.name);
    SELECTED_IDS.clear();
    document.getElementById("btn-merge").disabled = true;
    document.getElementById("btn-delete").disabled = true;
    setStatus("Merged " + ids.length + " regions into \"" + name + "\". Remember: data/regulations.json and data/featured_listings.json are not auto-migrated -- update those keys by hand if needed.", "error");
    scheduleQuickUpdate();
    scheduleFullUpdate();
  }

  function deleteSelected() {
    const ids = [...SELECTED_IDS];
    if (!ids.length) return;
    if (!window.confirm("Delete " + ids.length + " region(s)? Their listings will be reassigned to the nearest remaining region.")) return;
    const names = ids.map((id) => (REGIONS.find((r) => r.id === id) || {}).name).filter(Boolean);
    ids.forEach((id) => removeRegionById(id, { skipRecompute: true }));
    setStatus("Deleted: " + names.join(", ") + ". data/regulations.json and data/featured_listings.json keys for these slugs are now orphaned -- remove by hand if needed.", "error");
    document.getElementById("btn-merge").disabled = true;
    document.getElementById("btn-delete").disabled = true;
    scheduleQuickUpdate();
    scheduleFullUpdate();
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  function saveRegions() {
    const payload = {
      generatedFrom: "region-editor",
      method: { editedInBrowser: true },
      n: REGIONS.length,
      regions: REGIONS.map((r) => ({
        id: r.id, name: r.name, centroid: r.centroid, polygon: r.polygon,
        nSeed90k: r.nSeed90k, citiesInSeed: r.citiesInSeed,
      })),
    };
    setStatus("Saving…", "busy");
    fetch("/__save_regions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) { setStatus("Save failed: " + (body.error || "unknown error"), "error"); return; }
        setStatus("Saved. " + (body.message || ""), "ok");
      })
      .catch((err) => setStatus("Save failed: " + err.message + " -- is region_editor_server.py running?", "error"));
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  function init(listingsPayload, regionsPayload) {
    LISTINGS = listingsPayload.listings;

    // Deliberately NOT setting a canvas default renderer here: Geoman's vertex-drag
    // preview manipulates the polygon's SVG path node directly and throws if region
    // layers are canvas-rendered. Canvas is used only for the listing dots below,
    // where it actually matters (thousands of circleMarkers).
    MAP = L.map("editor-map", { minZoom: 5, maxZoom: 17 });
    const def = CONFIG.basemaps.light;
    def.layers.forEach((layerDef) => L.tileLayer(layerDef.url, { attribution: def.attribution, maxZoom: layerDef.maxZoom }).addTo(MAP));
    MAP.fitBounds([[listingsPayload.bounds.south, listingsPayload.bounds.west], [listingsPayload.bounds.north, listingsPayload.bounds.east]], { padding: [16, 16] });

    POINTS_RENDERER = L.canvas({ padding: 0.5 });
    POINTS_LAYER = L.layerGroup().addTo(MAP);

    MAP.pm.addControls({
      position: "topright", drawMarker: false, drawCircleMarker: false, drawPolyline: false,
      drawRectangle: false, drawCircle: false, drawText: false, drawPolygon: true,
      editMode: true, dragMode: true, cutPolygon: true, removalMode: true, rotateMode: false,
    });

    REGIONS = regionsPayload.regions.map((r, i) => ({ ...r, color: colorFor(i), layer: null }));
    REGIONS.forEach(addRegionLayer);

    MAP.on("pm:create", (e) => { if (e.shape === "Polygon") newRegionFromLayer(e.layer); });
    MAP.on("pm:cut", (e) => {
      const region = REGIONS.find((r) => r.layer === e.layer || r.id === e.layer._regionId);
      if (region) { region.layer = e.layer; e.layer._regionId = region.id; onRegionEdited(region); }
    });
    MAP.on("pm:remove", (e) => {
      const region = REGIONS.find((r) => r.layer === e.layer);
      if (region) removeRegionById(region.id);
    });

    document.getElementById("btn-new-region").addEventListener("click", () => MAP.pm.enableDraw("Polygon"));
    document.getElementById("btn-merge").addEventListener("click", mergeSelected);
    document.getElementById("btn-delete").addEventListener("click", deleteSelected);
    document.getElementById("btn-save").addEventListener("click", saveRegions);

    scheduleQuickUpdate();
    scheduleFullUpdate();

    // Local-only tool, not the public site -- a debug hook is fine.
    window.__editor = {
      MAP, REGIONS, LISTINGS, recomputeAssignments, onRegionEdited, clipNeighborsAgainst,
      newRegionFromLayer, mergeSelected, deleteSelected, toggleSelect, refreshTurfCache,
      get SELECTED_IDS() { return SELECTED_IDS; },
    };
  }

  Promise.all([
    fetch("../data/listings.json").then((r) => r.json()),
    fetch("../data/regions.json").then((r) => r.json()),
  ]).then(([listingsPayload, regionsPayload]) => init(listingsPayload, regionsPayload))
    .catch((err) => setStatus("Failed to load data: " + err.message, "error"));
})();
