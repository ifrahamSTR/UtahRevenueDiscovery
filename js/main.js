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

  // How many of a region's $90k+ listings are 1-2 BR vs. 3-4 BR vs. 5+ BR --
  // lets a reader tell at a glance whether a region's revenue cluster is
  // carried only by large properties or has strong small/mid-size performers
  // too, without opening the region. Bucket boundaries are inclusive on both
  // ends (0-2 / 3-4 / 5+) so every listing lands in exactly one bucket.
  function bedroomMix(listings) {
    let sm = 0, md = 0, lg = 0;
    listings.forEach((l) => {
      const bd = l.bd || 0;
      if (bd <= 2) sm++;
      else if (bd <= 4) md++;
      else lg++;
    });
    return { sm, md, lg, total: sm + md + lg };
  }

  function bedroomMixHtml(mix) {
    if (!mix.total) return "";
    const pct = (n) => (n / mix.total) * 100;
    const seg = (cls, n) => (n ? '<span class="region-card__bdmix-seg ' + cls + '" style="width:' + pct(n).toFixed(2) + '%"></span>' : "");
    const item = (cls, label, n) =>
      '<div class="region-card__bdmix-item"><i class="region-card__bdmix-dot ' + cls + '"></i>' +
      '<span>' + label + "</span><strong>" + fmtNumber(n) + "</strong></div>";
    return (
      '<div class="region-card__bdmix">' +
      '<div class="region-card__bdmix-label">$90k+ listings by bedroom count</div>' +
      '<div class="region-card__bdmix-bar">' +
      seg("region-card__bdmix-seg--sm", mix.sm) +
      seg("region-card__bdmix-seg--md", mix.md) +
      seg("region-card__bdmix-seg--lg", mix.lg) +
      "</div>" +
      '<div class="region-card__bdmix-items">' +
      item("region-card__bdmix-dot--sm", "1&ndash;2 BR", mix.sm) +
      item("region-card__bdmix-dot--md", "3&ndash;4 BR", mix.md) +
      item("region-card__bdmix-dot--lg", "5+ BR", mix.lg) +
      "</div>" +
      "</div>"
    );
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
      const bdMix = bedroomMix(above);
      return { r, n: inRegion.length, nAbove: above.length, rate: inRegion.length ? above.length / inRegion.length : 0, medAdr, tier, bdMix };
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
          bedroomMixHtml(c.bdMix) +
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
