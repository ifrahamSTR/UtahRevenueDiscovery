"""
Generate regions/<slug>/index.html for every region in data/regions.json.

Every regional page is a byte-identical copy of region.html -- there is no
per-region templating to maintain. js/region.js figures out which region a
page is by reading the URL path (the <slug> directory segment), fetches the
same data/listings.json and data/regions.json the statewide page uses,
filters client-side, and reuses map.js/charts.js as-is. See region.html and
js/region.js for the actual logic; this script only handles file placement
and the "N regions" URL structure (regions/<slug>/ with a real index.html,
not a query-string route) so each region gets a clean, shareable link.

Run after scripts/generate_map_data.py (which produces data/regions.json):
  python3 scripts/generate_region_pages.py
"""
import json
import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = REPO_ROOT / "region.html"
REGIONS_JSON = REPO_ROOT / "data" / "regions.json"
OUT_DIR = REPO_ROOT / "regions"


def main():
    regions = json.loads(REGIONS_JSON.read_text())["regions"]
    OUT_DIR.mkdir(exist_ok=True)
    for r in regions:
        dest_dir = OUT_DIR / r["id"]
        dest_dir.mkdir(exist_ok=True)
        shutil.copyfile(TEMPLATE, dest_dir / "index.html")
    print(f"Wrote {len(regions)} region pages under {OUT_DIR}/<slug>/index.html")
    for r in regions:
        print(f"  regions/{r['id']}/  ({r['name']})")


if __name__ == "__main__":
    main()
