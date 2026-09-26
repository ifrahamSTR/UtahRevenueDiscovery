"""
Regression gate for data/regions.json + data/listings.json. Run after any
change to either file (a fresh propose_regions.py run, an assign_regions.py
run, or a region-editor Save) to confirm the core invariants still hold:

  1. Every region polygon is valid (no self-intersections).
  2. No two regions' polygons overlap (nonzero intersection area).
  3. Every polygon's vertex count is small enough to hand-edit.
  4. Listing assignment coverage: how many listings are polygon-contained,
     how many are nearest-fallback-assigned (within the cap), how many are
     left unassigned (region=None, statewide-only).
  5. listings.json's stored `region` field agrees with what
     lib.geo.assign_point_to_region would compute fresh right now -- this
     catches drift between an edited regions.json and a stale listings.json
     (i.e. "you edited boundaries but haven't re-run assign_regions.py yet").

Run from the repo root:  python3 scripts/verify_regions.py
Exit code 0 = all checks pass, 1 = at least one check failed -- safe to wire
into a pre-push check or the editor's Save handler.
"""
import json
import sys
from pathlib import Path

from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.geo import assign_point_to_region, latlng_to_utm_xy, region_centroids_utm, region_polygons_utm  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
REGIONS_PATH = REPO_ROOT / "data" / "regions.json"
LISTINGS_PATH = REPO_ROOT / "data" / "listings.json"

MAX_REASONABLE_VERTICES = 40  # soft ceiling for "still draggable by hand"
# Two independently-rounded (5-decimal, ~0.5m half-grid) touching boundaries can
# leave a rounding-grid sliver on the order of (grid spacing) x (shared edge
# length) -- up to ~15,000 m² even for a long (~30km) shared edge. 20,000 m²
# comfortably absorbs that noise while still catching a real algorithmic
# overlap. Keep in sync with the same constant in propose_regions.py.
OVERLAP_TOLERANCE_M2 = 20000.0


def check_validity(regions, polys):
    print("== Polygon validity ==")
    ok = True
    for r in regions:
        p = polys[r["id"]]
        if not p.is_valid:
            ok = False
            print(f"  INVALID: {r['id']}")
    print("  all valid" if ok else "  ^ fix before continuing")
    return ok


def check_overlap(regions, polys):
    print("\n== Pairwise overlap ==")
    ok = True
    ids = [r["id"] for r in regions]
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = polys[ids[i]], polys[ids[j]]
            if not a.is_valid or not b.is_valid:
                continue
            inter_area = a.intersection(b).area
            if inter_area > OVERLAP_TOLERANCE_M2:
                ok = False
                print(f"  OVERLAP: {ids[i]:22s} <-> {ids[j]:22s}  area={inter_area / 1e6:.3f} km²")
    if ok:
        print("  none -- clean partition")
    return ok


def check_vertex_counts(regions):
    print("\n== Vertex counts ==")
    ok = True
    for r in regions:
        n = len(r["polygon"])
        flagged = n > MAX_REASONABLE_VERTICES
        ok = ok and not flagged
        print(f"  {r['id']:25s} {n:4d} vertices" + ("  <-- consider simplifying" if flagged else ""))
    return ok


def check_assignment(regions, listings, polys):
    print("\n== Assignment coverage ==")
    centroids = region_centroids_utm(regions)
    contained_n = fallback_n = null_n = drift_n = 0
    checked = 0
    for l in listings:
        if l.get("lat") is None or l.get("lng") is None:
            continue
        checked += 1
        computed = assign_point_to_region(l["lat"], l["lng"], polys, centroids)
        stored = l.get("region")
        if computed is not None:
            x, y = latlng_to_utm_xy(l["lat"], l["lng"])
            pt = Point(x, y)
            if any(p.contains(pt) or p.touches(pt) for p in polys.values()):
                contained_n += 1
            else:
                fallback_n += 1
        else:
            null_n += 1
        if computed != stored:
            drift_n += 1

    def pct(n):
        return f"{n / checked * 100:5.1f}%" if checked else "  n/a"

    print(f"  polygon-contained:        {contained_n:6d} ({pct(contained_n)})")
    print(f"  nearest-fallback assigned: {fallback_n:6d} ({pct(fallback_n)})")
    print(f"  unassigned (null):        {null_n:6d} ({pct(null_n)})")
    print(f"  stored-vs-computed drift:  {drift_n:6d} ({pct(drift_n)})", end="")
    if drift_n:
        print("  <-- run scripts/assign_regions.py to refresh listings.json")
    else:
        print()
    return drift_n == 0


def main():
    regions_payload = json.loads(REGIONS_PATH.read_text())
    regions = regions_payload["regions"]
    listings_payload = json.loads(LISTINGS_PATH.read_text())
    listings = listings_payload["listings"]

    print(f"Loaded {len(regions)} regions, {len(listings)} listings.\n")

    polys = region_polygons_utm(regions)

    results = [
        check_validity(regions, polys),
        check_overlap(regions, polys),
        check_vertex_counts(regions),
        check_assignment(regions, listings, polys),
    ]

    print("\n" + ("PASS" if all(results) else "FAIL"))
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
