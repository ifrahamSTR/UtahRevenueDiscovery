# Utah STR Revenue Discovery

A statewide geographic discovery tool built from AirDNA/USPPD Utah data
(pulled via Snowflake). It is **not** a buy-box or market-selection report —
see the Charlotte project (`../../7AugBuyBox/Charlotte/webpage`) for that kind
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

Identical to the Idaho site's structure (see that project's README for full
detail on each file) — `index.html` (statewide shell), `region.html` (one
regional-page template, copied verbatim into every `regions/<slug>/`),
`js/config.js` (state-specific constants), `js/util.js`, `js/map.js`,
`js/charts.js`, `js/main.js` (statewide bootstrap), `js/region.js` (regional
bootstrap), `scripts/generate_map_data.py` (listings + region discovery),
`scripts/generate_region_pages.py` (region-page generator),
`data/listings.json` + `data/regions.json` (generated, don't hand-edit),
`data/regulations.json` (hand-curated STR regulatory research, keyed by
region slug — never touched by the generator scripts).

## Region discovery

Same DBSCAN-based method as Idaho (see that project's README for the full
rationale), **re-tuned for Utah's geography**: Utah's resort/urban corridors
sit much closer together than Idaho's (Park City to Salt Lake City is only
~30km), so Idaho's looser `eps=12km`/`merge=30km` chains genuinely distinct
markets into one blob here. Verified by inspecting cluster city composition
at several eps/merge values before settling on:

- `DBSCAN_EPS_KM = 8`, `DBSCAN_MIN_SAMPLES = 4`
- `MERGE_KM = 25` (vs. Idaho's 30)
- `REGION_BUFFER_KM = 15` (unchanged)

This is the smallest eps/merge pair that (a) keeps Park City separate from
Salt Lake City and (b) still unifies the St. George/Hurricane/Ivins/Santa
Clara/Washington sprawl into one "St. George & Washington County" region.
Produced **12 regions**, not a forced count — see `REGION_LABELS` in
`scripts/generate_map_data.py` for the resulting city→region-name mapping:
Park City, St. George & Washington County, Moab, Salt Lake City, Zion
National Park (Springdale), Provo & Orem, Bear Lake (Utah side), Orderville &
the Bryce Canyon Corridor, Kanab, Duck Creek Village, Brian Head, and Ogden
Valley.

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
