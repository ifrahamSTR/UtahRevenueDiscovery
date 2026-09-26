"""
Full pipeline orchestrator for a fresh CSV export: builds data/listings.json,
proposes a fresh non-overlapping data/regions.json, then assigns every
listing to a region. This is a thin wrapper around three independently
runnable scripts -- run them individually instead when you only need one
step:

  scripts/build_listings.py    CSV -> listings.json (region left unset)
  scripts/propose_regions.py   CSV -> regions.json (a fresh AI proposal;
                                overwrites any hand-edited boundaries!)
  scripts/assign_regions.py    regions.json + listings.json -> listings.json's
                                region field only (safe to re-run any time,
                                including after a region-editor Save)

Region boundaries are meant to be refined afterward in
admin/region-editor.html -- re-running THIS script (or propose_regions.py
alone) discards any such edits and starts over from a fresh DBSCAN proposal.
Only do that intentionally.

Run from the repo root:  python3 scripts/generate_map_data.py
Do not hand-edit data/listings.json or data/regions.json -- regenerate them
from here (or the individual step scripts) instead.
"""
from build_listings import build as build_listings
from propose_regions import propose as propose_regions
from assign_regions import assign as assign_regions


def main():
    build_listings()
    propose_regions()
    assign_regions()


if __name__ == "__main__":
    main()
