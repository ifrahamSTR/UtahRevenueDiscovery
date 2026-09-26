# Utah STR Revenue Discovery

A statewide geographic discovery tool built from AirDNA/USPPD Utah data
(pulled via Snowflake). It is **not** a buy-box or market-selection report —
see the Charlotte project (`../../../../7AugBuyBox/Charlotte/webpage`) for that kind
of deliverable, or the sibling Idaho project (`../../Idaho/webpage`) for the
first trial of this same discovery-tool approach. This site exists to make
geographic concentrations of strong-revenue Utah listings visually
discoverable, so an analyst can decide where deeper market research is worth
doing. The map does not pre-select markets, pre-define clusters, or rank
anything — every read is left to the person looking at it.

This is the second state built on the Idaho site's architecture (see
"Reusing this for another state" in the Idaho README, and its
"Region discovery"/data-pipeline design) — same code, same method, entirely
new data, entirely new region-discovery result and regulatory research.

## Running locally

Plain HTML/CSS/JS, no build step, no framework. From this directory:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/index.html`. It will not work from `file://`
because of the `fetch()` call in `js/main.js`.

## Structure

Identical to the Idaho site's structure for the page files (see that
project's README for full detail) — `index.html` (statewide shell),
`region.html` (one regional-page template, copied verbatim into every
`regions/<slug>/`), `js/config.js` (state-specific constants), `js/util.js`,
`js/map.js`, `js/charts.js`, `js/main.js` (statewide bootstrap),
`js/region.js` (regional bootstrap), `data/listings.json` +
`data/regions.json` (generated, don't hand-edit), `data/regulations.json` +
`data/featured_listings.json` (hand-curated, keyed by region slug — never
touched by any generator script).

The data pipeline is split into four independently runnable scripts (Utah
diverges from Idaho here — see "Region discovery" below for why):

- `scripts/build_listings.py` — raw CSV → `data/listings.json`, with `region`
  left unset. Re-run this whenever there's a fresh CSV export; it never
  touches region boundaries.
- `scripts/propose_regions.py` — raw CSV → a **fresh AI-proposed**
  `data/regions.json`. Run this rarely: a fresh CSV export, or an explicit
  "throw out my edits and start over." **Re-running this discards any manual
  boundary edits made in the region editor.**
- `scripts/assign_regions.py` — `data/regions.json` + `data/listings.json` →
  rewrites `listings.json`'s `region` field only, using whatever
  `regions.json` currently contains. Safe to re-run any time, including after
  every manual boundary edit — this is what the region editor's Save button
  calls. Needs no CSV/Snowflake access.
- `scripts/generate_map_data.py` — thin orchestrator that runs all three
  above in sequence, for the "I have a fresh CSV, give me a full fresh
  pipeline" case.
- `scripts/generate_region_pages.py` — region-page generator (unchanged
  role), plus `scripts/verify_regions.py` — a regression-gate script; see
  "Region discovery" and "Editing region boundaries" below.
- `scripts/lib/geo.py` — the one shared implementation of "project lat/lng to
  a real metric CRS" and "which region does this point belong to," used by
  every script above and mirrored in `js/region-editor.js` for live in-browser
  recompute.

## Region discovery

DBSCAN clustering is unchanged from the original Idaho-derived method (same
rationale, same re-tuning for Utah's tighter geography):

- `DBSCAN_EPS_KM = 8`, `DBSCAN_MIN_SAMPLES = 4`
- `MERGE_KM = 25` (vs. Idaho's 30)
- `REGION_BUFFER_KM = 15` (unchanged)

This is the smallest eps/merge pair that (a) keeps Park City separate from
Salt Lake City and (b) still unifies the St. George/Hurricane/Ivins/Santa
Clara/Washington sprawl into one "St. George & Washington County" region.
Produced **12 regions**, not a forced count — see `REGION_LABELS` in
`scripts/propose_regions.py` for the resulting city→region-name mapping:
Park City, St. George & Washington County, Moab, Salt Lake City, Zion
National Park (Springdale), Provo & Orem, Bear Lake (Utah side), Orderville &
the Bryce Canyon Corridor, Kanab, Duck Creek Village, Brian Head, and Ogden
Valley.

**Boundary computation was reworked from Idaho's approach** — an independent
convex hull + flat buffer per cluster (Idaho's method, and Utah's original
method) does not guarantee non-overlapping regions, and in practice produced
8 overlapping pairs here (every geographically-adjacent pair, basically).
`scripts/propose_regions.py` instead: projects everything into one shared
metric CRS (UTM 12N — a Voronoi diagram needs consistent relative distances
across every cluster centroid at once, which per-cluster local projections
don't provide), builds a Voronoi diagram over the merged clusters' centroids
(`shapely.ops.voronoi_diagram` — guarantees non-overlap by construction),
intersects each cell with that cluster's own buffered convex hull (keeps
boundaries tight to real data instead of claiming empty land near a far-off
centroid — gaps between distant clusters are expected and fine), simplifies
each polygon to ~10-15 vertices (down from 68-80 — otherwise unusable for
manual dragging), then runs a deterministic cleanup pass (bigger region wins
any residual sliver) since simplification and on-disk coordinate rounding can
each reintroduce a rounding-grid-scale sliver overlap. Every listing in the
full dataset (not just the $90k+ seed points used for clustering) is then
assigned to whichever final polygon contains it, with a 40km nearest-region
fallback for anything in a gap — beyond that, `region` stays `null`
(statewide-only), same as before, just far less often (93.3% of listings get
a region now, vs. 84.5% under the old method).

Run `python3 scripts/verify_regions.py` after any regeneration or edit to
confirm the partition is still valid: polygon validity, pairwise non-overlap,
vertex-count sanity, and assignment-coverage / stored-vs-computed drift.

## Editing region boundaries

`admin/region-editor.html` is a **local-only analyst tool**, not part of the
public site — it has no effect on the live GitHub Pages deployment by itself.
`propose_regions.py`'s output is a starting point; drag its polygons'
vertices there to visually refine market boundaries, with listing counts and
every region stat recomputed live as you edit. Run it via:

```
python3 scripts/region_editor_server.py
```

then open `http://localhost:8000/admin/region-editor.html`. Clicking Save
writes `data/regions.json`, re-runs `assign_regions.py` in-process to refresh
`data/listings.json`, and regenerates every `regions/<slug>/index.html` —
after that, the edit is a normal set of file changes ready for
`git add`/`commit`/`push`. See the tool's own in-page help for the rest of
the editing workflow (create/split/merge/delete).

## Data notes

- Source: `Snowflake/Utah/Iqbal_Idaho_2026-09-17-0204.csv` — the filename is
  an inherited naming-template artifact from the extraction tooling (it says
  "Idaho"); the data itself is confirmed Utah (`STATE_NAME == "Utah"`,
  11,494 raw rows). Entire home/apt listings with 20+ reviews and 230+ active
  listing nights (LTM), already filtered upstream; 108 further excluded here
  per the CSV's own `EXCLUDE` QC flag — 11,386 in the working dataset.
- `LOCATION_TYPE` has **five** categories in Utah's data (Idaho only had
  three): `Destination/Resort - Mountains/Lake`, `Mid-Size City`,
  `Small City/Rural`, plus `Large City - Suburban` and `Large City - Urban`
  (Salt Lake City's metro is large/dense enough that AirDNA splits it out) —
  `js/config.js`'s `locationTypeOrder` and the script's
  `LOCATION_TYPE_DISPLAY` both reflect this; don't assume every state matches
  Idaho's three-category set.
- `REVENUE_LTM` (actual) and `REVENUE_POTENTIAL_LTM` (AirDNA's optimized-
  calendar modeled ceiling) are both carried through and are switchable live
  on the map — never silently conflated. Every listing at/above $90k on
  actual is also at/above $90k on potential; a further ~170 listings clear
  potential without yet clearing actual (surfaced via the map's "highlight
  potential-only upside" toggle, off by default).
- Statewide pattern check before reusing Idaho's Findings-section narrative
  copy: ADR correlates with actual revenue at r=0.89 (occupancy r=0.02, even
  more lopsided than Idaho's own 0.85/0.07); $90k+ listings run ~2.5x the
  bedrooms/accommodates of the rest of the market; the hot-tub revenue lift
  holds even controlling for bedroom count (12.7%→44.0% hit rate on 5BR+
  homes, 1.0%→6.9% on smaller ones). One notable **difference from Idaho**:
  Cabin does *not* out-convert House here (House 10.8% hit rate vs. Cabin
  9.4%; both well ahead of Condo/Apartment/Townhouse) — the Findings copy was
  corrected for this rather than copied verbatim from the Idaho site.
- STR regulatory research (`data/regulations.json`) was gathered per-region,
  combining Orderville + Kanab + Duck Creek Village into a single "Kane
  County corridor" research pass (all three sit in or near the same rural
  county) to avoid redundant county-level research across three small
  regions — 10 research passes cover the 12 regions. Unlike Idaho (which has
  a single sweeping state preemption law, HB 583), **Utah's regulatory
  picture is genuinely more fragmented and locally variable** — check each
  region's own Regulations section rather than assuming a shared statewide
  rule; this is real signal, not a research gap.

## Reusing this for a third state

See the Idaho project's own README ("Reusing this for another state") for
the general steps. This Utah build is itself a worked example of following
those steps into a state with meaningfully different geography (denser
urban/resort corridors, a 5-category `LOCATION_TYPE`, no single dominant
state-preemption law) — re-verify every tuning constant and every hand-written
narrative claim against the new state's own data rather than assuming either
prior state's numbers transfer.
