"""
Assign every listing in data/listings.json to a region, using whatever
data/regions.json currently contains -- freshly proposed by
scripts/propose_regions.py, or hand-edited in admin/region-editor.html. This
is the ONLY thing that writes listings.json's `region` field, and it never
touches polygon geometry itself, so it's always safe to re-run: after a fresh
CSV import, after a propose_regions.py run, or after every single manual
boundary edit.

Uses the one canonical scripts/lib/geo.py:assign_point_to_region() rule
(point-in-polygon, with a distance-capped nearest-region fallback for gaps).

Run from the repo root:  python3 scripts/assign_regions.py
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


def assign(regions_path=REGIONS_PATH, listings_path=LISTINGS_PATH):
    regions = json.loads(regions_path.read_text())["regions"]
    listings_payload = json.loads(listings_path.read_text())
    listings = listings_payload["listings"]

    polys = region_polygons_utm(regions)
    centroids = region_centroids_utm(regions)

    counts = {"contained": 0, "fallback": 0, "null": 0}
    for l in listings:
        if l.get("lat") is None or l.get("lng") is None:
            l["region"] = None
            counts["null"] += 1
            continue
        region_id = assign_point_to_region(l["lat"], l["lng"], polys, centroids)
        l["region"] = region_id
        if region_id is None:
            counts["null"] += 1
        else:
            x, y = latlng_to_utm_xy(l["lat"], l["lng"])
            pt = Point(x, y)
            if polys[region_id].contains(pt) or polys[region_id].touches(pt):
                counts["contained"] += 1
            else:
                counts["fallback"] += 1

    listings_path.write_text(json.dumps(listings_payload, separators=(",", ":")))
    n = len(listings)
    print(f"Wrote {listings_path} -- {n} listings re-assigned against {len(regions)} regions")
    print(f"  polygon-contained: {counts['contained']} ({counts['contained']/n*100:.1f}%)")
    print(f"  nearest-fallback:  {counts['fallback']} ({counts['fallback']/n*100:.1f}%)")
    print(f"  unassigned:        {counts['null']} ({counts['null']/n*100:.1f}%)")
    return listings_payload


if __name__ == "__main__":
    assign()
