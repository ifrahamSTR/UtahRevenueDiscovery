"""
Generate regions/<slug>/index.html for every region in data/regions.json,
and remove any regions/<slug>/ directory left over from a region that no
longer exists (a rename, merge, split, or delete in the region editor).

Every regional page is a byte-identical copy of region.html -- there is no
per-region templating to maintain. js/region.js figures out which region a
page is by reading the URL path (the <slug> directory segment), fetches the
same data/listings.json and data/regions.json the statewide page uses,
filters client-side, and reuses map.js/charts.js as-is. See region.html and
js/region.js for the actual logic; this script only handles file placement
and the "N regions" URL structure (regions/<slug>/ with a real index.html,
not a query-string route) so each region gets a clean, shareable link.

Run after scripts/generate_map_data.py or scripts/propose_regions.py (which
produce data/regions.json), or after a region-editor Save (which calls
generate() in-process -- see scripts/region_editor_server.py):
  python3 scripts/generate_region_pages.py

Note: data/regulations.json and data/featured_listings.json are hand-curated
and keyed by the same slugs, but this script never touches them -- a
rename/merge/split/delete leaves their keys stale; update those by hand.
"""
import json
import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = REPO_ROOT / "region.html"
REGIONS_JSON = REPO_ROOT / "data" / "regions.json"
OUT_DIR = REPO_ROOT / "regions"


def generate(regions_json=REGIONS_JSON, template=TEMPLATE, out_dir=OUT_DIR):
    regions = json.loads(Path(regions_json).read_text())["regions"]
    current_slugs = {r["id"] for r in regions}
    out_dir = Path(out_dir)
    out_dir.mkdir(exist_ok=True)

    removed = []
    for existing in out_dir.iterdir():
        if existing.is_dir() and existing.name not in current_slugs:
            shutil.rmtree(existing)
            removed.append(existing.name)

    for r in regions:
        dest_dir = out_dir / r["id"]
        dest_dir.mkdir(exist_ok=True)
        shutil.copyfile(template, dest_dir / "index.html")

    return {"written": [r["id"] for r in regions], "removed": removed}


def main():
    result = generate()
    print(f"Wrote {len(result['written'])} region pages under {OUT_DIR}/<slug>/index.html")
    for slug in result["written"]:
        print(f"  regions/{slug}/")
    if result["removed"]:
        print(f"Removed {len(result['removed'])} orphaned region director" + ("y" if len(result["removed"]) == 1 else "ies") + ":")
        for slug in result["removed"]:
            print(f"  regions/{slug}/  <-- also check data/regulations.json and data/featured_listings.json for a stale \"{slug}\" key")


if __name__ == "__main__":
    main()
