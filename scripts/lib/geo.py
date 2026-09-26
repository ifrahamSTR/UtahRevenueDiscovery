"""
Shared geometry helpers for the Utah region pipeline.

One canonical implementation of "project lat/lng to a real metric CRS" and
"which region does this point belong to" -- used by propose_regions.py,
assign_regions.py, verify_regions.py, and region_editor_server.py, so none of
them can silently disagree about the answer. js/region-editor.js re-implements
the same assign_point_to_region() rule in JS for live in-browser recompute;
keep the two in sync if this file's rule ever changes.

On-disk convention (data/regions.json, data/listings.json): coordinates are
always [lat, lng] pairs / lat + lng fields -- this is Leaflet's native order,
NOT GeoJSON's [lng, lat]. Every function here takes/returns that convention at
its boundary and only uses projected (x, y) internally.
"""
import math

from pyproj import Transformer
from shapely.geometry import Point, Polygon

EARTH_R_KM = 6371.0088

# UTM zone 12N covers all of Utah with low distortion -- the standard choice
# for Utah-wide GIS work (the state sits almost entirely within zone 12).
UTM_CRS = "EPSG:32612"
WGS84_CRS = "EPSG:4326"

_TO_UTM = Transformer.from_crs(WGS84_CRS, UTM_CRS, always_xy=True)
_TO_WGS84 = Transformer.from_crs(UTM_CRS, WGS84_CRS, always_xy=True)

# Nearest-region fallback distance cap (see assign_point_to_region): beyond
# this, a listing that falls in a gap between regions stays unassigned
# (region=None) rather than being forced into a market it isn't really part
# of. Matches the plan's stated ~40km.
DEFAULT_FALLBACK_CAP_KM = 40.0


def latlng_to_utm_xy(lat, lng):
    x, y = _TO_UTM.transform(lng, lat)
    return x, y


def utm_xy_to_latlng(x, y):
    lng, lat = _TO_WGS84.transform(x, y)
    return lat, lng


def polygon_latlng_to_utm(polygon_latlng):
    """[[lat,lng], ...] (this project's on-disk convention) -> shapely Polygon in UTM meters."""
    coords = [latlng_to_utm_xy(lat, lng) for lat, lng in polygon_latlng]
    return Polygon(coords)


def utm_polygon_to_latlng_list(poly, round_to=5):
    """shapely Polygon (or MultiPolygon -- resolved to its largest part) in UTM
    meters -> this project's on-disk [[lat,lng], ...] convention (exterior ring)."""
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    return [[round(lat, round_to), round(lng, round_to)] for lat, lng in (utm_xy_to_latlng(x, y) for x, y in poly.exterior.coords)]


def haversine_km(lat1, lng1, lat2, lng2):
    lat1, lng1, lat2, lng2 = map(math.radians, (lat1, lng1, lat2, lng2))
    dlat, dlng = lat2 - lat1, lng2 - lng1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_R_KM * math.asin(math.sqrt(a))


def region_polygons_utm(regions):
    """regions: list of {"id", "polygon": [[lat,lng],...], ...}. Returns {id: shapely Polygon (UTM)}."""
    return {r["id"]: polygon_latlng_to_utm(r["polygon"]) for r in regions}


def region_centroids_utm(regions):
    return {r["id"]: latlng_to_utm_xy(r["centroid"][0], r["centroid"][1]) for r in regions}


def assign_point_to_region(lat, lng, region_polys_utm, region_centroids_utm=None, fallback_cap_km=DEFAULT_FALLBACK_CAP_KM):
    """The one canonical "which region is this point in" rule:
      1. Inside exactly one region's polygon -> that region.
      2. Inside more than one (shouldn't happen once non-overlap holds, but
         defensive against a mid-edit transient overlap) -> nearest centroid.
      3. Inside none -> nearest region by distance-to-polygon, but only within
         fallback_cap_km; beyond that -> None (stays statewide-only).
    Returns a region id string, or None.
    """
    x, y = latlng_to_utm_xy(lat, lng)
    pt = Point(x, y)

    contained = [rid for rid, poly in region_polys_utm.items() if poly.contains(pt) or poly.touches(pt)]
    if len(contained) == 1:
        return contained[0]
    if len(contained) > 1:
        def dist_to_centroid(rid):
            cx, cy = region_centroids_utm[rid] if region_centroids_utm else region_polys_utm[rid].centroid.coords[0]
            return (cx - x) ** 2 + (cy - y) ** 2
        return min(contained, key=dist_to_centroid)

    best_rid, best_dist_m = None, None
    for rid, poly in region_polys_utm.items():
        d = poly.distance(pt)
        if best_dist_m is None or d < best_dist_m:
            best_dist_m, best_rid = d, rid
    if best_rid is not None and best_dist_m <= fallback_cap_km * 1000:
        return best_rid
    return None
