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
    fetch("data/regulations.json").then((r) => r.json()).catch(() => ({})),
  ])
    .then(([payload, regionsPayload, regulations]) => {
      const n = document.getElementById("dataset-n");
      if (n) n.textContent = fmtNumber(payload.n);
      if (mapEl) mapEl.innerHTML = "";
      initMap(payload.listings, payload.bounds, { regions: regionsPayload.regions });
      initFindings(payload.listings);
      renderRegionGrid(payload.listings, regionsPayload.regions, regulations || {});
    })
    .catch((err) => {
      console.error(err);
      if (mapEl) mapEl.innerHTML = '<p class="map-error">Could not load data/listings.json. Run <code>python3 scripts/generate_map_data.py</code>, then reload.</p>';
    });

  // Maps the three canonical regulation-tier labels (see data/regulations.json)
  // to a traffic-light color for the region-grid teaser cards only -- the
  // regs-card badge on each region's own page stays uniformly styled
  // (matching the Charlotte report's Section 5), this is a separate,
  // deliberately color-coded at-a-glance signal shown before opening a
  // region at all.
  function regionTierMeta(tier) {
    if (tier === "Investor-Friendly") return { cls: "region-card__tier--green", dot: "🟢" };
    if (tier === "Verify / Heavier Constraints") return { cls: "region-card__tier--yellow", dot: "🟡" };
    if (tier === "Avoid") return { cls: "region-card__tier--red", dot: "🔴" };
    return null;
  }

  function renderRegionGrid(listings, regions, regulations) {
    const host = document.getElementById("region-grid");
    if (!host || !regions || !regions.length) return;
    const T = CONFIG.defaultThreshold;
    const cards = regions.map((r) => {
      const inRegion = listings.filter((l) => l.region === r.id);
      const above = inRegion.filter((l) => l.revA >= T);
      const medAdr = medianOf(inRegion.map((l) => l.adr));
      const tier = (regulations[r.id] || {}).tier;
      return { r, n: inRegion.length, nAbove: above.length, rate: inRegion.length ? above.length / inRegion.length : 0, medAdr, tier };
    });
    cards.sort((a, b) => b.nAbove - a.nAbove);
    host.innerHTML = cards
      .map((c) => {
        const meta = regionTierMeta(c.tier);
        const tierBadge = meta
          ? '<div class="region-card__tier ' + meta.cls + '">' + meta.dot + " " + escapeHtml(c.tier) + "</div>"
          : "";
        return (
          '<a class="region-card" href="regions/' + c.r.id + '/">' +
          '<div class="region-card__name">' + escapeHtml(c.r.name) + "</div>" +
          tierBadge +
          '<div class="region-card__stats">' +
          '<div class="region-card__stat"><strong>' + fmtNumber(c.n) + "</strong><span>listings</span></div>" +
          '<div class="region-card__stat region-card__stat--above"><strong>' + fmtNumber(c.nAbove) + "</strong><span>&ge; " + fmtCurrencyCompact(T) + "</span></div>" +
          '<div class="region-card__stat"><strong>' + fmtPct(c.rate, 1) + "</strong><span>hit rate</span></div>" +
          "</div>" +
          '<div class="region-card__cta">Explore this region &rarr;</div>' +
          "</a>"
        );
      })
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
