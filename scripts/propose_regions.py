"""
Propose a non-overlapping set of Utah STR market regions -- writes
data/regions.json ONLY (never touches data/listings.json; run
scripts/assign_regions.py afterward to (re)assign listings to whatever this
produces). This is the "AI proposes" half of "AI proposes, analyst refines" --
run it rarely (fresh source data, or an explicit request for a brand-new
proposal), since re-running it overwrites any hand-edited boundaries from the
region editor.

Method:
  1. DBSCAN (haversine metric) over listings >= REGION_REVENUE_THRESHOLD
     actual revenue -- unchanged from the original approach, still tuned per
     the rationale in README.md (Park City must stay separate from Salt Lake
     City; St. George/Hurricane must stay unified).
  2. Merge cluster centroids within MERGE_KM of each other -- unchanged.
  3. Non-overlapping boundary (this is the actual fix): project every seed
     point into one shared metric CRS (UTM 12N -- see scripts/lib/geo.py),
     build a Voronoi diagram over the merged clusters' centroids (guarantees
     zero overlap by construction), then each region's polygon = that
     region's Voronoi cell INTERSECTED with its own buffered convex hull --
     this keeps boundaries tight to real data (no claiming empty land near a
     far-off centroid) while staying a strict subset of a non-overlapping
     partition.
  4. Simplify each polygon's vertex count so it's actually draggable by hand
     (today's convex-hull-only approach produced 68-80 vertices/region;
     target ~10-15).
  5. Simplification can nudge a vertex past where two cells used to meet
     exactly, so run one final deterministic cleanup pass on the *simplified*
     polygons: sort by nSeed90k descending, `difference()` any smaller region
     against a larger one it still touches.

Run from the repo root:  python3 scripts/propose_regions.py
Do not hand-edit data/regions.json -- regenerate it from here, or edit
boundaries visually in admin/region-editor.html instead.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from shapely.geometry import MultiPoint, Point
from shapely.ops import voronoi_diagram
from sklearn.cluster import DBSCAN

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.geo import EARTH_R_KM, haversine_km, latlng_to_utm_xy, utm_polygon_to_latlng_list  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
INPUT_CSV = REPO_ROOT.parent.parent.parent.parent / "Snowflake" / "Utah" / "Iqbal_Idaho_2026-09-17-0204.csv"
REGIONS_OUT = REPO_ROOT / "data" / "regions.json"

# ---------------------------------------------------------------------------
# Region-discovery tuning -- unchanged from the original DBSCAN approach; see
# README.md for the eps/merge search rationale (Park City-to-Salt Lake City
# is ~30km, so a looser eps/merge chains genuinely distinct markets together).
# ---------------------------------------------------------------------------
REGION_REVENUE_THRESHOLD = 90000  # matches js/config.js CONFIG.defaultThreshold
DBSCAN_EPS_KM = 8
DBSCAN_MIN_SAMPLES = 4
MERGE_KM = 25
REGION_BUFFER_KM = 15  # grows each region's hull to capture surrounding market
VORONOI_ENVELOPE_PAD_KM = 80  # how far past the outermost seed point the Voronoi envelope extends
SIMPLIFY_TARGET_VERTICES = 15
SIMPLIFY_MIN_VERTICES = 6  # don't oversimplify into a triangle
SIMPLIFY_TOLERANCES_M = [100, 200, 400, 800, 1600, 3200, 6400]
POLYGON_ROUND_TO = 5  # decimal places for on-disk [lat,lng] -- matches listings.json's own lat/lng precision (~1m)
# Two independently-rounded (to POLYGON_ROUND_TO) touching boundaries can leave a
# sliver on the order of (rounding grid spacing) x (shared edge length); at
# 5-decimal precision (~0.5m half-grid) even a long (~30km) shared edge tops out
# around 15,000 m². 20,000 m² (0.02 km²) comfortably absorbs that noise while
# still catching a genuine algorithmic overlap. Keep this in sync with the same
# constant in verify_regions.py.
OVERLAP_TOLERANCE_M2 = 20000.0

# Utah-specific: dominant-city -> (slug, display name). A cluster is named by
# whichever of its own cities has the most seed listings; any city not
# listed here falls back to f"{city} Area".
REGION_LABELS = {
    "Park City": ("park-city", "Park City"),
    "Heber City": ("park-city", "Park City"),
    "Coalville": ("park-city", "Park City"),
    "Midway": ("park-city", "Park City"),
    "Saint George": ("st-george", "St. George & Washington County"),
    "Hurricane": ("st-george", "St. George & Washington County"),
    "Ivins": ("st-george", "St. George & Washington County"),
    "Santa Clara": ("st-george", "St. George & Washington County"),
    "Washington": ("st-george", "St. George & Washington County"),
    "La Verkin": ("st-george", "St. George & Washington County"),
    "Virgin": ("st-george", "St. George & Washington County"),
    "Toquerville": ("st-george", "St. George & Washington County"),
    "Moab": ("moab", "Moab"),
    "Salt Lake City": ("salt-lake-city", "Salt Lake City"),
    "Draper": ("salt-lake-city", "Salt Lake City"),
    "Sandy": ("salt-lake-city", "Salt Lake City"),
    "South Jordan": ("salt-lake-city", "Salt Lake City"),
    "North Salt Lake": ("salt-lake-city", "Salt Lake City"),
    "Riverton": ("salt-lake-city", "Salt Lake City"),
    "Springdale": ("zion-springdale", "Zion National Park (Springdale)"),
    "Rockville": ("zion-springdale", "Zion National Park (Springdale)"),
    "Provo": ("provo-orem", "Provo & Orem"),
    "Orem": ("provo-orem", "Provo & Orem"),
    "Garden City": ("bear-lake-ut", "Bear Lake"),
    "Orderville": ("orderville", "Orderville & the Bryce Canyon Corridor"),
    "Glendale": ("orderville", "Orderville & the Bryce Canyon Corridor"),
    "Kanab": ("kanab", "Kanab"),
    "Duck Creek Village": ("duck-creek-village", "Duck Creek Village"),
    "Brian Head": ("brian-head", "Brian Head"),
    "Eden": ("ogden-valley", "Ogden Valley"),
    "Huntsville": ("ogden-valley", "Ogden Valley"),
}


def region_label_for(top_city):
    if top_city in REGION_LABELS:
        return REGION_LABELS[top_city]
    slug = top_city.lower().replace(" ", "-").replace("'", "")
    return slug + "-area", f"{top_city} Area"


def load_seed_df():
    df = pd.read_csv(INPUT_CSV, low_memory=False)
    df = df[df["EXCLUDE"] != True].copy()  # noqa: E712
    df = df[df["LATITUDE"].notna() & df["LONGITUDE"].notna()].copy().reset_index(drop=True)
    return df


def cluster_seed_points(df):
    """DBSCAN + centroid-merge, unchanged from the original approach. Returns
    the seed-only dataframe with a final `region_final` integer cluster id
    column (already merged, remapped by descending cluster size)."""
    hi = df[df["REVENUE_LTM"] >= REGION_REVENUE_THRESHOLD].copy()
    coords = np.radians(hi[["LATITUDE", "LONGITUDE"]].values)
    eps = DBSCAN_EPS_KM / EARTH_R_KM
    db = DBSCAN(eps=eps, min_samples=DBSCAN_MIN_SAMPLES, metric="haversine").fit(coords)
    hi["cluster"] = db.labels_
    hi = hi[hi["cluster"] != -1].copy()

    def centroids(labels_series):
        return {c: (g["LATITUDE"].mean(), g["LONGITUDE"].mean()) for c, g in hi.groupby(labels_series)}

    changed = True
    while changed:
        changed = False
        cents = centroids(hi["cluster"])
        labels = sorted(cents.keys())
        for i, a in enumerate(labels):
            for b in labels[i + 1:]:
                if a not in cents or b not in cents:
                    continue
                if haversine_km(*cents[a], *cents[b]) < MERGE_KM:
                    hi.loc[hi["cluster"] == b, "cluster"] = a
                    changed = True
                    break
            if changed:
                break

    sizes = hi["cluster"].value_counts()
    remap = {old: i for i, (old, _) in enumerate(sizes.items())}
    hi["region_final"] = hi["cluster"].map(remap)
    return hi


def simplify_to_target(poly, target=SIMPLIFY_TARGET_VERTICES, min_vertices=SIMPLIFY_MIN_VERTICES):
    """Try increasing tolerance until vertex count drops to ~target, without
    going below min_vertices. Returns the best candidate found."""
    best = poly
    for tol in SIMPLIFY_TOLERANCES_M:
        candidate = poly.simplify(tol, preserve_topology=True)
        if candidate.is_empty or candidate.geom_type != "Polygon":
            break
        n = len(candidate.exterior.coords) - 1
        if n < min_vertices:
            break
        best = candidate
        if n <= target:
            break
    return best


def discover_regions(df):
    hi = cluster_seed_points(df)

    used_slugs = set()
    cluster_info = []  # per-cluster: slug, name, seed rows, utm points, utm centroid
    for rid in sorted(hi["region_final"].unique()):
        g = hi[hi["region_final"] == rid]
        top_city = g["CITY_NAME"].value_counts().idxmax()
        slug, name = region_label_for(top_city)
        while slug in used_slugs:
            slug += "-2"
        used_slugs.add(slug)

        utm_pts = [latlng_to_utm_xy(lat, lng) for lat, lng in zip(g["LATITUDE"], g["LONGITUDE"])]
        centroid_x = sum(p[0] for p in utm_pts) / len(utm_pts)
        centroid_y = sum(p[1] for p in utm_pts) / len(utm_pts)
        cluster_info.append({
            "slug": slug,
            "name": name,
            "group": g,
            "utm_pts": utm_pts,
            "utm_centroid": (centroid_x, centroid_y),
            "n_seed": len(g),
            "cities_in_seed": g["CITY_NAME"].value_counts().to_dict(),
        })

    # One shared Voronoi diagram over every cluster's UTM centroid at once --
    # this is what guarantees non-overlap; an envelope generous enough that
    # no real region's buffered hull gets truncated by it.
    all_utm_pts = [pt for c in cluster_info for pt in c["utm_pts"]]
    all_x = [p[0] for p in all_utm_pts]
    all_y = [p[1] for p in all_utm_pts]
    pad = VORONOI_ENVELOPE_PAD_KM * 1000
    envelope = MultiPoint([(min(all_x) - pad, min(all_y) - pad), (max(all_x) + pad, max(all_y) + pad)]).envelope

    centroid_multipoint = MultiPoint([c["utm_centroid"] for c in cluster_info])
    voronoi_cells = list(voronoi_diagram(centroid_multipoint, envelope=envelope).geoms)

    for c in cluster_info:
        cx, cy = c["utm_centroid"]
        centroid_pt = Point(cx, cy)
        cell = next((v for v in voronoi_cells if v.contains(centroid_pt)), None)
        hull = MultiPoint(c["utm_pts"]).convex_hull
        buffered = hull.buffer(REGION_BUFFER_KM * 1000)
        final = buffered if cell is None else cell.intersection(buffered)
        if final.geom_type == "MultiPolygon":
            final = max(final.geoms, key=lambda g: g.area)
        c["polygon_utm"] = final

    # Simplify each region's polygon independently.
    for c in cluster_info:
        c["polygon_utm"] = simplify_to_target(c["polygon_utm"])

    # Deterministic overlap cleanup: simplification can re-introduce a sliver
    # overlap between neighbors that the Voronoi step had already resolved.
    # Bigger region (by seed count) wins any residual contested area, same
    # precedent the original code used for overlap resolution.
    #
    # This runs in full float64 UTM precision and gets overlap essentially to
    # zero (~1e-9 m² in practice). Rounding each region's vertices to on-disk
    # precision *independently* afterward can then reintroduce a sliver --
    # rounding two touching boundaries separately doesn't preserve the exact
    # point where they met -- but that's now a bounded rounding-grid artifact
    # (at most a couple thousand m² even for a long shared edge at 5-decimal
    # precision), not a real algorithmic overlap, and re-resolving after
    # rounding would just reintroduce the same class of error one level
    # smaller ad infinitum. OVERLAP_TOLERANCE_M2 (here and in
    # verify_regions.py) is set to comfortably absorb that noise while still
    # catching a genuine bug.
    cluster_info.sort(key=lambda c: c["n_seed"], reverse=True)

    def resolve_overlaps(max_passes=6):
        # cluster_info is sorted once, by n_seed descending, and never
        # reordered -- so i < j always means "region i has >= seed count of
        # region j" for the lifetime of this function, and it's always safe
        # to trim j against i (never the reverse). A single forward pass
        # isn't a fixed point, though: trimming j against i can nudge j's
        # shape into newly (barely) overlapping some k < j that was already
        # considered "settled" earlier in the same pass. Repeat full passes
        # until one makes zero changes.
        for _ in range(max_passes):
            changed = False
            for i in range(len(cluster_info)):
                for j in range(i + 1, len(cluster_info)):
                    a, b = cluster_info[i]["polygon_utm"], cluster_info[j]["polygon_utm"]
                    if a.intersection(b).area > OVERLAP_TOLERANCE_M2:
                        trimmed = b.difference(a)
                        if trimmed.geom_type == "MultiPolygon":
                            trimmed = max(trimmed.geoms, key=lambda g: g.area)
                        if not trimmed.is_empty and trimmed.geom_type == "Polygon":
                            cluster_info[j]["polygon_utm"] = trimmed
                            changed = True
            if not changed:
                break

    resolve_overlaps()

    regions = []
    for c in cluster_info:
        g = c["group"]
        regions.append({
            "id": c["slug"],
            "name": c["name"],
            "centroid": [round(g["LATITUDE"].mean(), 4), round(g["LONGITUDE"].mean(), 4)],
            "polygon": utm_polygon_to_latlng_list(c["polygon_utm"], round_to=POLYGON_ROUND_TO),
            "nSeed90k": int(c["n_seed"]),
            "citiesInSeed": c["cities_in_seed"],
        })
    regions.sort(key=lambda r: r["nSeed90k"], reverse=True)
    return regions


def propose(input_csv=INPUT_CSV, regions_out=REGIONS_OUT):
    df = load_seed_df()
    regions = discover_regions(df)

    payload = {
        "generatedFrom": Path(input_csv).name,
        "method": {
            "revenueThreshold": REGION_REVENUE_THRESHOLD,
            "dbscanEpsKm": DBSCAN_EPS_KM,
            "dbscanMinSamples": DBSCAN_MIN_SAMPLES,
            "mergeKm": MERGE_KM,
            "bufferKm": REGION_BUFFER_KM,
            "boundary": "voronoi(cluster centroids) ∩ buffered convex hull(seed points), simplified, then a final size-priority overlap cleanup pass",
        },
        "n": len(regions),
        "regions": regions,
    }
    regions_out.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {regions_out} -- {len(regions)} regions")
    for r in regions:
        print(f"  {r['id']:25s} n_seed={r['nSeed90k']:>3d}  vertices={len(r['polygon']):>3d}  centroid={r['centroid']}")
    return payload


if __name__ == "__main__":
    propose()
