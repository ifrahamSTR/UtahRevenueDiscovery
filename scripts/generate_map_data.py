"""
Generate webpage/data/listings.json AND data/regions.json from a raw AirDNA/
USPPD state export CSV.

Purpose-built for the Idaho STR Revenue Discovery site, but deliberately
state-agnostic in its *method*: point INPUT_CSV at another state's export
(same AirDNA/USPPD column schema) and re-run. Region NAMES come from a small
Idaho-specific city->label lookup (REGION_LABELS) with a generic fallback for
any city not in that table, so a new state still produces usable (if blander)
region names out of the box -- hand-tune REGION_LABELS afterward for that
state's own recognizable place names.

Region discovery method (see full rationale in README.md):
  1. DBSCAN (haversine metric) over listings >= REGION_THRESHOLD actual
     revenue -- i.e. "where do strong performers sit close together",
     not "where are there lots of listings" (that would just re-discover
     Boise). eps/min_samples are tuned, not derived from a formula --
     re-tune per state by inspecting cluster sizes/locations.
  2. Any two resulting clusters whose centroids sit within MERGE_KM of each
     other are unioned -- DBSCAN can split one obviously-contiguous area
     (e.g. McCall/Donnelly/Cascade along Hwy 55) into adjacent sub-clusters
     purely because of a gap in *high-revenue* points, even though the
     broader area reads as one place.
  3. Each final region's boundary is the convex hull of its seed (>=
     threshold) points, buffered by REGION_BUFFER_KM -- this is what makes
     "region" membership include the full surrounding market context (all
     revenue levels), not just the seed points that defined the region's
     existence.
  4. Every listing in the full dataset is assigned to at most one region
     (whichever buffered hull contains it); most listings fall in no
     region at all, and stay statewide-only.

This does NOT compute tiers, medians, or correlations for the listings
themselves -- that stays client-side (js/charts.js, js/map.js), one source
of truth for "what counts as $90k+" including the live threshold slider.
Region-level *regulatory* content (jurisdictions, permit rules, sources) is
hand-curated separately in data/regulations.json, keyed by region id -- this
script never touches that file, so re-running it to tweak clustering never
clobbers researched regulatory content.

Run from the repo root:  python3 scripts/generate_map_data.py
Do not hand-edit data/listings.json or data/regions.json -- regenerate them
from here instead.
"""
import json
import math
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import MultiPoint
from sklearn.cluster import DBSCAN

warnings.filterwarnings("ignore", category=UserWarning)

REPO_ROOT = Path(__file__).resolve().parent.parent
INPUT_CSV = REPO_ROOT.parent.parent / "Snowflake" / "Utah" / "Iqbal_Idaho_2026-09-17-0204.csv"
LISTINGS_OUT = REPO_ROOT / "data" / "listings.json"
REGIONS_OUT = REPO_ROOT / "data" / "regions.json"

EARTH_R_KM = 6371.0088

# ---------------------------------------------------------------------------
# Region-discovery tuning. Re-tuned for Utah: its urban/resort corridors sit
# closer together than Idaho's (Park City-to-Salt Lake City is ~30km), so a
# looser eps/merge chains genuinely distinct markets into one blob (verified
# by inspecting cluster city composition at several eps/merge values -- see
# README). eps=8/merge=25 is the smallest pair that (a) keeps Park City
# separate from Salt Lake City and (b) still unifies the St. George/Hurricane
# metro into one region.
# ---------------------------------------------------------------------------
REGION_REVENUE_THRESHOLD = 90000  # matches js/config.js CONFIG.defaultThreshold
DBSCAN_EPS_KM = 8
DBSCAN_MIN_SAMPLES = 4
MERGE_KM = 25  # union clusters whose centroids are closer than this
REGION_BUFFER_KM = 15  # grows each region's hull to capture surrounding market
MIN_REGION_SEED_SIZE = 4  # DBSCAN's own min_samples already enforces this

# Utah-specific: dominant-city -> (slug, display name). A cluster is named
# by whichever of its own cities has the most seed listings; any city not
# listed here falls back to f"{city} Area" (see region_label_for).
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


PROPERTY_TYPE_DISPLAY = {"Condominium (condo)": "Condo"}
LOCATION_TYPE_DISPLAY = {
    "Destination/Resort - Mountains/Lake": "Destination/Resort",
    "Mid-Size City": "Mid-Size City",
    "Small City/Rural": "Small City/Rural",
    "Large City - Suburban": "Large City (Suburban)",
    "Large City - Urban": "Large City (Urban)",
}


def clean_str(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = str(v).strip()
    return s if s else None


def clean_num(v, round_to=None):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    f = float(v)
    if round_to is not None:
        f = round(f, round_to)
        if round_to == 0:
            f = int(f)
    return f


def clean_bool(v):
    if pd.isna(v):
        return None
    return bool(v)


def best_url(row):
    for col, src in (
        ("AIRBNB_LISTING_URL", "airbnb"),
        ("VRBO_LISTING_URL", "vrbo"),
        ("BOOKING_LISTING_URL", "booking"),
    ):
        u = clean_str(row.get(col))
        if u:
            return u, src
    return None, None


def build_listing(row, region_by_index, idx):
    url, url_src = best_url(row)
    ptype = clean_str(row.get("PROPERTY_TYPE")) or "Other"
    ptype = PROPERTY_TYPE_DISPLAY.get(ptype, ptype)
    loc = clean_str(row.get("LOCATION_TYPE")) or "Unclassified"
    loc = LOCATION_TYPE_DISPLAY.get(loc, loc)

    return {
        "id": clean_str(row.get("STATIC_COMBINED_PROPERTY_ID")),
        "t": clean_str(row.get("TITLE")) or "Untitled listing",
        "lat": clean_num(row.get("LATITUDE"), 5),
        "lng": clean_num(row.get("LONGITUDE"), 5),
        "city": clean_str(row.get("CITY_NAME")) or "Unknown",
        "mkt": clean_str(row.get("AIRDNA_MARKET")) or "Unclassified",
        "sub": clean_str(row.get("AIRDNA_SUBMARKET")) or "Unclassified",
        "loc": loc,
        "pt": ptype,
        "bd": clean_num(row.get("BEDROOMS"), 0),
        "ba": clean_num(row.get("BATHROOMS"), 1),
        "acc": clean_num(row.get("ACCOMMODATES"), 0),
        "adr": clean_num(row.get("AVERAGE_DAILY_RATE_LTM"), 0),
        "occ": clean_num(row.get("OCCUPANCY_RATE_LTM"), 3),
        "revA": clean_num(row.get("REVENUE_LTM"), 0),
        "revP": clean_num(row.get("REVENUE_POTENTIAL_LTM"), 0),
        "nights": clean_num(row.get("ACTIVE_LISTING_NIGHTS_LTM"), 0),
        "reviews": clean_num(row.get("REVIEWS_COUNT"), 0),
        "rating": clean_num(row.get("RATING_OVERALL"), 0),
        "sh": clean_bool(row.get("SUPERHOST")),
        "tub": clean_bool(row.get("HAS_HOTTUB")) or False,
        "pool": clean_bool(row.get("HAS_POOL")) or False,
        "park": clean_bool(row.get("HAS_PARKING")) or False,
        "air": clean_bool(row.get("HAS_AIRCON")) or False,
        "gym": clean_bool(row.get("HAS_GYM")) or False,
        "pets": clean_bool(row.get("HAS_PETS_ALLOWED")) or False,
        "kitchen": clean_bool(row.get("HAS_KITCHEN")) or False,
        "instant": clean_bool(row.get("INSTANT_BOOK")) or False,
        "url": url,
        "urlSrc": url_src,
        "img": clean_str(row.get("IMG_COVER")),
        "region": region_by_index.get(idx),
    }


def to_xy(lat, lon, lat0):
    x = lon * 111.320 * np.cos(np.radians(lat0))
    y = lat * 110.574
    return x, y


def to_lonlat(x, y, lat0):
    lon = x / (111.320 * np.cos(np.radians(lat0)))
    lat = y / 110.574
    return lon, lat


def discover_regions(df):
    """Returns (region_by_df_index: dict, regions: list[dict])."""
    hi = df[df["REVENUE_LTM"] >= REGION_REVENUE_THRESHOLD].copy()
    coords = np.radians(hi[["LATITUDE", "LONGITUDE"]].values)
    eps = DBSCAN_EPS_KM / EARTH_R_KM
    db = DBSCAN(eps=eps, min_samples=DBSCAN_MIN_SAMPLES, metric="haversine").fit(coords)
    hi["cluster"] = db.labels_
    hi = hi[hi["cluster"] != -1].copy()

    # Iteratively merge clusters whose centroids are within MERGE_KM.
    def centroids(labels_series):
        return {c: (g["LATITUDE"].mean(), g["LONGITUDE"].mean()) for c, g in hi.groupby(labels_series)}

    def haversine_km(p1, p2):
        lat1, lon1 = np.radians(p1)
        lat2, lon2 = np.radians(p2)
        dlat, dlon = lat2 - lat1, lon2 - lon1
        a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
        return 2 * EARTH_R_KM * np.arcsin(np.sqrt(a))

    changed = True
    while changed:
        changed = False
        cents = centroids(hi["cluster"])
        labels = sorted(cents.keys())
        for i, a in enumerate(labels):
            for b in labels[i + 1:]:
                if a not in cents or b not in cents:
                    continue
                if haversine_km(cents[a], cents[b]) < MERGE_KM:
                    hi.loc[hi["cluster"] == b, "cluster"] = a
                    changed = True
                    break
            if changed:
                break

    sizes = hi["cluster"].value_counts()
    remap = {old: i for i, (old, _) in enumerate(sizes.items())}
    hi["region_final"] = hi["cluster"].map(remap)

    region_by_index = {}
    regions = []
    used_slugs = set()
    for rid in sorted(remap.values()):
        g = hi[hi["region_final"] == rid]
        top_city = g["CITY_NAME"].value_counts().idxmax()
        slug, name = region_label_for(top_city)
        while slug in used_slugs:  # collision guard for state-agnostic reuse
            slug += "-2"
        used_slugs.add(slug)

        lat0 = g["LATITUDE"].mean()
        xs, ys = to_xy(g["LATITUDE"].values, g["LONGITUDE"].values, lat0)
        hull = MultiPoint(list(zip(xs, ys))).convex_hull
        buffered = hull.buffer(REGION_BUFFER_KM)
        poly = buffered if buffered.geom_type == "Polygon" else buffered.convex_hull
        polygon_latlng = [[round(la, 4), round(lo, 4)] for lo, la in (to_lonlat(x, y, lat0) for x, y in poly.exterior.coords)]

        allx, ally = to_xy(df["LATITUDE"].values, df["LONGITUDE"].values, lat0)
        mask = shapely.contains_xy(buffered, allx, ally)
        for idx in df.index[mask]:
            if idx not in region_by_index:
                region_by_index[idx] = slug

        regions.append({
            "id": slug,
            "name": name,
            "centroid": [round(g["LATITUDE"].mean(), 4), round(g["LONGITUDE"].mean(), 4)],
            "polygon": polygon_latlng,
            "nSeed90k": int(len(g)),
            "citiesInSeed": g["CITY_NAME"].value_counts().to_dict(),
        })

    return region_by_index, regions


def main():
    df = pd.read_csv(INPUT_CSV, low_memory=False)
    n_raw = len(df)
    df = df[df["EXCLUDE"] != True].copy()  # noqa: E712
    df = df[df["LATITUDE"].notna() & df["LONGITUDE"].notna()].copy().reset_index(drop=True)

    region_by_index, regions = discover_regions(df)

    listings = [build_listing(row, region_by_index, idx) for idx, row in df.iterrows()]
    listings = [l for l in listings if l["lat"] is not None and l["lng"] is not None]

    lats = [l["lat"] for l in listings]
    lngs = [l["lng"] for l in listings]

    payload = {
        "generatedFrom": INPUT_CSV.name,
        "state": "Utah",
        "n": len(listings),
        "nRawRows": n_raw,
        "nExcludedByQcFlag": n_raw - len(df) if n_raw >= len(df) else 0,
        "bounds": {
            "south": round(min(lats), 4),
            "north": round(max(lats), 4),
            "west": round(min(lngs), 4),
            "east": round(max(lngs), 4),
        },
        "listings": listings,
    }
    LISTINGS_OUT.parent.mkdir(parents=True, exist_ok=True)
    LISTINGS_OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {LISTINGS_OUT} -- {len(listings)} listings ({LISTINGS_OUT.stat().st_size / 1024:.0f} KB)")

    n_regioned = sum(1 for l in listings if l["region"])
    regions_payload = {
        "generatedFrom": INPUT_CSV.name,
        "method": {
            "revenueThreshold": REGION_REVENUE_THRESHOLD,
            "dbscanEpsKm": DBSCAN_EPS_KM,
            "dbscanMinSamples": DBSCAN_MIN_SAMPLES,
            "mergeKm": MERGE_KM,
            "bufferKm": REGION_BUFFER_KM,
        },
        "n": len(regions),
        "regions": regions,
    }
    REGIONS_OUT.write_text(json.dumps(regions_payload, indent=2))
    print(f"Wrote {REGIONS_OUT} -- {len(regions)} regions, {n_regioned}/{len(listings)} listings assigned to a region")
    for r in regions:
        print(f"  {r['id']:35s} n_seed={r['nSeed90k']:>3d}  centroid={r['centroid']}")


if __name__ == "__main__":
    main()
