/**
 * Bootstraps a regional page. One template (regions/<slug>/index.html, all
 * byte-identical copies of region.html -- see scripts/generate_region_pages.py)
 * serves every discovered region; this file figures out which region it's
 * looking at from the URL path, filters the same statewide listings.json
 * down to that region, and reuses map.js/charts.js exactly as the statewide
 * page does (initMap/initFindings take a listings array + don't care where
 * it came from) -- no per-region code, only per-region data.
 */
function currentRegionSlug() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("regions");
  if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
  return new URLSearchParams(window.location.search).get("r");
}

function boundsFor(listings, padDeg) {
  const lats = listings.map((l) => l.lat);
  const lngs = listings.map((l) => l.lng);
  return {
    south: Math.min(...lats) - padDeg,
    north: Math.max(...lats) + padDeg,
    west: Math.min(...lngs) - padDeg,
    east: Math.max(...lngs) + padDeg,
  };
}

// Same card shape as the Charlotte report's Section 5 (STR Regulations):
// one tier badge, one summary paragraph, three labeled dd-rows (Permit /
// Residency, Operating Limits, Investor Notes), a compact one-line source
// credit. See css/styles.css's "Ported verbatim ... regs-card" block.
function ddRow(label, items) {
  if (!items || !items.length) return "";
  return (
    '<div class="dd-row"><span class="dd-row__label">' + escapeHtml(label) + '</span>' +
    '<div class="dd-row__value"><ul>' + items.map((i) => "<li>" + i + "</li>").join("") + "</ul></div></div>"
  );
}

function renderRegulatory(reg) {
  const host = document.getElementById("regulatory-body");
  if (!host) return;
  if (!reg) {
    host.innerHTML = '<p class="reg-empty">Regulatory research for this region has not been published yet.</p>';
    return;
  }
  let html = '<div class="regs-card">';
  html += '<div class="regs-card__tier"><span class="regs-card__tier-dot"></span>' + escapeHtml(reg.tier || "Uncertain") + "</div>";
  html += '<span class="regs-card__verified">Verified ' + escapeHtml(reg.verifiedDate || "") + "</span>";
  html += '<p class="regs-card__summary">' + reg.summary + "</p>";
  html += '<div class="dd-rows">';
  html += ddRow("Permit / Residency", reg.permitResidency);
  html += ddRow("Operating Limits", reg.operatingLimits);
  html += ddRow("Investor Notes", reg.investorNotes);
  html += "</div>";
  if (reg.sources && reg.sources.length) {
    html += '<p class="regs-card__sources"><strong>Official sources:</strong> ';
    html += reg.sources.map((s) => '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.title) + "</a>").join(" &middot; ");
    html += "</p>";
  }
  html += "</div>";
  host.innerHTML = html;
}

// Data-grounded answer to "what does this cluster actually cover" -- counts
// real listing-level city attribution (AirDNA's own city field), not the
// region's hand-assigned display name. Reuses topCounts() from map.js.
function renderLocations(regionListings) {
  const host = document.getElementById("region-locations");
  if (!host) return;
  const cities = topCounts(regionListings, (l) => l.city || "Unknown", 8);
  if (!cities.length) { host.innerHTML = ""; return; }
  let html = '<span class="region-locations__label">Cities in this footprint:</span>';
  cities.forEach(([city, n]) => {
    html += '<span class="location-chip">' + escapeHtml(city) + ' <span class="location-chip__n">' + fmtNumber(n) + "</span></span>";
  });
  host.innerHTML = html;
}

function renderRegionSwitcher(regions, currentSlug) {
  const host = document.getElementById("region-switcher");
  if (!host) return;
  const select = document.createElement("select");
  select.id = "region-switcher-select";
  regions.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    if (r.id === currentSlug) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => { window.location.href = "../" + select.value + "/"; });
  host.innerHTML = "";
  host.appendChild(select);
}

(function () {
  const slug = currentRegionSlug();
  const mapEl = document.getElementById("idaho-map");
  if (mapEl) mapEl.innerHTML = '<div class="map-loading">Loading region…</div>';

  Promise.all([
    fetch("../../data/listings.json").then((r) => r.json()),
    fetch("../../data/regions.json").then((r) => r.json()),
    fetch("../../data/regulations.json").then((r) => r.json()).catch(() => ({})),
  ])
    .then(([listingsPayload, regionsPayload, regulations]) => {
      const regions = regionsPayload.regions || [];
      const region = regions.find((r) => r.id === slug);
      if (!region) {
        document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:sans-serif;"><h1>Region not found</h1><p><a href="../../index.html">Back to the statewide map</a></p></div>';
        return;
      }
      const regionListings = listingsPayload.listings.filter((l) => l.region === slug);
      const statewideN = listingsPayload.n;
      const T = CONFIG.defaultThreshold;
      const above = regionListings.filter((l) => l.revA >= T);

      document.title = region.name + " — " + CONFIG.stateName + " STR Revenue Discovery";
      const kicker = document.getElementById("region-kicker");
      if (kicker) kicker.textContent = "Regional deep dive · discovered, not assumed";
      const h1 = document.getElementById("region-title");
      if (h1) h1.textContent = region.name;
      const sub = document.getElementById("region-sub");
      if (sub) {
        sub.innerHTML =
          "A data-driven revenue region within " + CONFIG.stateName + "'s statewide discovery map &mdash; " + fmtNumber(regionListings.length) +
          " listings in this footprint, " + fmtNumber(above.length) + " (" + fmtPct(regionListings.length ? above.length / regionListings.length : 0, 1) +
          ") at or above " + fmtCurrency(T) + " actual LTM revenue, out of " + fmtNumber(statewideN) + " statewide. Not a buy box or market recommendation — an exploration of what's driving this pocket.";
      }

      if (mapEl) mapEl.innerHTML = "";
      initMap(regionListings, boundsFor(regionListings, 0.05));
      initFindings(regionListings);
      renderLocations(regionListings);
      renderRegulatory((regulations || {})[slug]);
      renderRegionSwitcher(regions, slug);
    })
    .catch((err) => {
      console.error(err);
      if (mapEl) mapEl.innerHTML = '<p class="map-error">Could not load region data.</p>';
    });
})();
