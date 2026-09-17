/**
 * Statewide "Findings" charts. Everything here is derived client-side from
 * the same listings array the map uses (one source of truth) and evaluated
 * at CONFIG.defaultThreshold -- a fixed reference point for this narrative,
 * independent of the map's live threshold slider.
 */
const CHART_PALETTE = {
  above: "#1fa35c",
  below: "#8b98a6",
  seriesAll: "#5598e7",
  seriesQualify: "#1fa35c",
  grid: "#e4e9ec",
  text: "#485a55",
};

Chart.defaults.font.family = '"Inter","Segoe UI",system-ui,sans-serif';
Chart.defaults.color = CHART_PALETTE.text;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 8;
Chart.defaults.plugins.legend.labels.boxHeight = 8;

function baseGrid() {
  return { color: CHART_PALETTE.grid, drawTicks: false };
}

function bucket(l) {
  return propertyTypeBucket(l.pt);
}

function computeFindings(listings) {
  const T = CONFIG.defaultThreshold;
  const above = listings.filter((l) => l.revA >= T);
  const below = listings.filter((l) => l.revA < T);
  const potAbove = listings.filter((l) => l.revP >= T);
  const upsideOnly = listings.filter((l) => l.revA < T && l.revP >= T);

  const medAbove = {
    adr: medianOf(above.map((l) => l.adr)),
    occ: medianOf(above.map((l) => l.occ)),
    bd: medianOf(above.map((l) => l.bd)),
    acc: medianOf(above.map((l) => l.acc)),
  };
  const medBelow = {
    adr: medianOf(below.map((l) => l.adr)),
    occ: medianOf(below.map((l) => l.occ)),
    bd: medianOf(below.map((l) => l.bd)),
    acc: medianOf(below.map((l) => l.acc)),
  };

  const adrCorr = pearsonCorr(listings.map((l) => l.adr), listings.map((l) => l.revA));
  const occCorr = pearsonCorr(listings.map((l) => l.occ), listings.map((l) => l.revA));

  return { T, above, below, potAbove, upsideOnly, medAbove, medBelow, adrCorr, occCorr };
}

// ---------------------------------------------------------------------------
// KPI stat tiles
// ---------------------------------------------------------------------------
function renderKpiTiles(listings, findings) {
  const host = document.getElementById("kpi-tiles");
  if (!host) return;
  const n = listings.length;
  const tiles = [
    { label: "Listings in the working dataset", value: fmtNumber(n) },
    { label: "≥ " + fmtCurrencyCompact(findings.T) + " actual LTM revenue", value: fmtNumber(findings.above.length) + " (" + fmtPct(findings.above.length / n, 1) + ")" },
    { label: "≥ " + fmtCurrencyCompact(findings.T) + " potential LTM revenue", value: fmtNumber(findings.potAbove.length) + " (" + fmtPct(findings.potAbove.length / n, 1) + ")" },
    { label: "Below actual, but potential clears the bar", value: fmtNumber(findings.upsideOnly.length) },
  ];
  host.innerHTML = tiles
    .map((t) => '<div class="kpi-tile"><div class="kpi-tile__value">' + t.value + '</div><div class="kpi-tile__label">' + t.label + "</div></div>")
    .join("");
}

// ---------------------------------------------------------------------------
// Revenue distribution histogram (Actual / Potential toggle)
// ---------------------------------------------------------------------------
let REVENUE_CHART = null;
function histogramFor(listings, field, threshold, binCount) {
  const values = listings.map((l) => l[field]).filter((v) => v != null);
  const max = Math.max(...values);
  const binSize = Math.ceil(max / binCount / 1000) * 1000;
  const bins = new Array(Math.ceil(max / binSize) + 1).fill(0);
  values.forEach((v) => { bins[Math.floor(v / binSize)]++; });
  const labels = bins.map((_, i) => "$" + Math.round((i * binSize) / 1000) + "k");
  const colors = bins.map((_, i) => (i * binSize >= threshold ? CHART_PALETTE.above : CHART_PALETTE.below));
  return { labels, bins, colors, binSize };
}

function renderRevenueChart(listings, findings, field) {
  const ctx = document.getElementById("chart-revenue-distribution");
  if (!ctx) return;
  const { labels, bins, colors } = histogramFor(listings, field, findings.T, 24);
  if (REVENUE_CHART) REVENUE_CHART.destroy();
  REVENUE_CHART = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: bins, backgroundColor: colors, borderRadius: 3, maxBarThickness: 18, categoryPercentage: 0.9, barPercentage: 0.95 }] },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (items) => items[0].label + " bin", label: (item) => fmtNumber(item.raw) + " listings" } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { grid: baseGrid(), title: { display: true, text: "Listings" } },
      },
    },
  });
  const label = document.getElementById("chart-revenue-distribution-caption");
  if (label) {
    const fieldLabel = field === "revA" ? "actual" : "potential";
    label.textContent =
      "LTM " + fieldLabel + " revenue across all " + fmtNumber(listings.length) + " listings. Green bars are at or above " + fmtCurrency(findings.T) + ".";
  }
}

function initRevenueDistribution(listings, findings) {
  renderRevenueChart(listings, findings, "revA");
  document.querySelectorAll("#revenue-metric-toggle [data-field]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#revenue-metric-toggle [data-field]").forEach((b) => b.classList.remove("metric-toggle__btn--active"));
      btn.classList.add("metric-toggle__btn--active");
      renderRevenueChart(listings, findings, btn.dataset.field);
    });
  });
}

// ---------------------------------------------------------------------------
// Index-ratio chart: what separates $90k+ listings, on one comparable axis
// ---------------------------------------------------------------------------
function renderIndexChart(findings) {
  const ctx = document.getElementById("chart-index-ratio");
  if (!ctx) return;
  const rows = [
    { label: "ADR", ratio: findings.medAbove.adr / findings.medBelow.adr },
    { label: "Bedrooms", ratio: findings.medAbove.bd / findings.medBelow.bd },
    { label: "Sleeps (accommodates)", ratio: findings.medAbove.acc / findings.medBelow.acc },
    { label: "Occupancy", ratio: findings.medAbove.occ / findings.medBelow.occ },
  ];
  new Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{ data: rows.map((r) => r.ratio), backgroundColor: CHART_PALETTE.above, borderRadius: 4, maxBarThickness: 24 }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => item.raw.toFixed(2) + "× the below-threshold median" } },
        datalabels: undefined,
      },
      scales: {
        x: { grid: baseGrid(), title: { display: true, text: "× median of listings below " + fmtCurrencyCompact(findings.T) }, suggestedMax: 4 },
        y: { grid: { display: false } },
      },
    },
    plugins: [
      {
        id: "ratioLabels",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          ctx.font = "600 12px Inter, sans-serif";
          ctx.fillStyle = CHART_PALETTE.text;
          ctx.textBaseline = "middle";
          meta.data.forEach((bar, i) => {
            const val = rows[i].ratio;
            ctx.fillText(val.toFixed(1) + "×", bar.x + 6, bar.y);
          });
          ctx.restore();
        },
      },
    ],
  });
  const refLine = document.getElementById("chart-index-ratio-caption");
  if (refLine) {
    refLine.innerHTML =
      "Median values for listings ≥ " + fmtCurrency(findings.T) + " actual revenue, expressed as a multiple of the median for listings below it. " +
      "ADR: " + fmtCurrency(findings.medBelow.adr) + " &rarr; " + fmtCurrency(findings.medAbove.adr) +
      " &middot; Occupancy: " + fmtPct(findings.medBelow.occ, 0) + " &rarr; " + fmtPct(findings.medAbove.occ, 0) +
      " &middot; Pearson r with revenue &mdash; ADR " + findings.adrCorr.toFixed(2) + ", occupancy " + findings.occCorr.toFixed(2) + ".";
  }
}

// ---------------------------------------------------------------------------
// Property type / location type share comparison (All vs Qualifying)
// ---------------------------------------------------------------------------
function shareChart(canvasId, categories, listings, findings, keyFn) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const n = listings.length;
  const nAbove = findings.above.length;
  const allShares = categories.map((c) => listings.filter((l) => keyFn(l) === c).length / n);
  const aboveShares = categories.map((c) => findings.above.filter((l) => keyFn(l) === c).length / nAbove);
  new Chart(ctx, {
    type: "bar",
    data: {
      labels: categories,
      datasets: [
        { label: "All listings", data: allShares.map((v) => v * 100), backgroundColor: CHART_PALETTE.seriesAll, borderRadius: 3, maxBarThickness: 20 },
        { label: "≥ " + fmtCurrencyCompact(findings.T) + " listings", data: aboveShares.map((v) => v * 100), backgroundColor: CHART_PALETTE.seriesQualify, borderRadius: 3, maxBarThickness: 20 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: (item) => item.dataset.label + ": " + item.raw.toFixed(1) + "%" } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: baseGrid(), title: { display: true, text: "Share of group" }, ticks: { callback: (v) => v + "%" } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Hot tub, controlled for size
// ---------------------------------------------------------------------------
function renderHotTubChart(listings) {
  const ctx = document.getElementById("chart-hottub");
  if (!ctx) return;
  const T = CONFIG.defaultThreshold;
  const bands = [
    { label: "Under 5 bd", pred: (l) => l.bd < 5 },
    { label: "5+ bd", pred: (l) => l.bd >= 5 },
  ];
  const withTub = bands.map((b) => {
    const g = listings.filter((l) => b.pred(l) && l.tub);
    return g.length ? g.filter((l) => l.revA >= T).length / g.length : 0;
  });
  const withoutTub = bands.map((b) => {
    const g = listings.filter((l) => b.pred(l) && !l.tub);
    return g.length ? g.filter((l) => l.revA >= T).length / g.length : 0;
  });
  new Chart(ctx, {
    type: "bar",
    data: {
      labels: bands.map((b) => b.label),
      datasets: [
        { label: "No hot tub", data: withoutTub.map((v) => v * 100), backgroundColor: CHART_PALETTE.below, borderRadius: 3, maxBarThickness: 28 },
        { label: "Has hot tub", data: withTub.map((v) => v * 100), backgroundColor: CHART_PALETTE.above, borderRadius: 3, maxBarThickness: 28 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: (item) => item.dataset.label + ": " + item.raw.toFixed(1) + "% reach ≥ " + fmtCurrencyCompact(T) } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: baseGrid(), title: { display: true, text: "Share reaching ≥ " + fmtCurrencyCompact(T) }, ticks: { callback: (v) => v + "%" } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function initFindings(listings) {
  const findings = computeFindings(listings);
  const intro = document.getElementById("findings-intro");
  if (intro) {
    intro.innerHTML =
      "These are supporting observations to help interpret the map &mdash; not a ranking, and not a recommendation. " +
      "Every statistic below is computed directly from the same " + fmtNumber(listings.length) +
      "-listing working dataset, at a fixed " + fmtCurrency(findings.T) + " reference threshold.";
  }
  renderKpiTiles(listings, findings);
  initRevenueDistribution(listings, findings);
  renderIndexChart(findings);
  shareChart("chart-property-type", CONFIG.propertyTypeOrder, listings, findings, bucket);
  shareChart("chart-location-type", CONFIG.locationTypeOrder, listings, findings, (l) => l.loc);
  renderHotTubChart(listings);
}
