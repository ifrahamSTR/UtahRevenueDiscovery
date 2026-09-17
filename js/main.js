/**
 * Bootstraps the statewide page: fetch listings.json + regions.json once,
 * hand the listings array to map.js and charts.js, render the region-grid
 * teaser cards, then wire up nav scrollspy.
 */
(function () {
  const mapEl = document.getElementById("idaho-map");
  if (mapEl) mapEl.innerHTML = '<div class="map-loading">Loading ' + CONFIG.stateName + ' listings…</div>';

  Promise.all([
    fetch(CONFIG.dataUrl).then((r) => r.json()),
    fetch("data/regions.json").then((r) => r.json()).catch(() => ({ regions: [] })),
  ])
    .then(([payload, regionsPayload]) => {
      const n = document.getElementById("dataset-n");
      if (n) n.textContent = fmtNumber(payload.n);
      if (mapEl) mapEl.innerHTML = "";
      initMap(payload.listings, payload.bounds, { regions: regionsPayload.regions, regionLinkBase: "regions/" });
      initFindings(payload.listings);
      renderRegionGrid(payload.listings, regionsPayload.regions);
    })
    .catch((err) => {
      console.error(err);
      if (mapEl) mapEl.innerHTML = '<p class="map-error">Could not load data/listings.json. Run <code>python3 scripts/generate_map_data.py</code>, then reload.</p>';
    });

  function renderRegionGrid(listings, regions) {
    const host = document.getElementById("region-grid");
    if (!host || !regions || !regions.length) return;
    const T = CONFIG.defaultThreshold;
    const cards = regions.map((r) => {
      const inRegion = listings.filter((l) => l.region === r.id);
      const above = inRegion.filter((l) => l.revA >= T);
      const medAdr = medianOf(inRegion.map((l) => l.adr));
      return { r, n: inRegion.length, nAbove: above.length, rate: inRegion.length ? above.length / inRegion.length : 0, medAdr };
    });
    cards.sort((a, b) => b.nAbove - a.nAbove);
    host.innerHTML = cards
      .map(
        (c) =>
          '<a class="region-card" href="regions/' + c.r.id + '/">' +
          '<div class="region-card__name">' + escapeHtml(c.r.name) + "</div>" +
          '<div class="region-card__stats">' +
          '<div class="region-card__stat"><strong>' + fmtNumber(c.n) + "</strong><span>listings</span></div>" +
          '<div class="region-card__stat region-card__stat--above"><strong>' + fmtNumber(c.nAbove) + "</strong><span>&ge; " + fmtCurrencyCompact(T) + "</span></div>" +
          '<div class="region-card__stat"><strong>' + fmtPct(c.rate, 1) + "</strong><span>hit rate</span></div>" +
          "</div>" +
          '<div class="region-card__cta">Explore this region &rarr;</div>' +
          "</a>"
      )
      .join("");
  }

  // Scrollspy
  const navLinks = Array.from(document.querySelectorAll(".site-nav a"));
  const sections = navLinks.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  const setActive = () => {
    let current = sections[0];
    const y = window.scrollY + 120;
    sections.forEach((s) => { if (s.offsetTop <= y) current = s; });
    navLinks.forEach((a) => a.classList.toggle("site-nav__link--active", a.getAttribute("href") === "#" + current.id));
  };
  window.addEventListener("scroll", debounce(setActive, 60));
  setActive();
})();
