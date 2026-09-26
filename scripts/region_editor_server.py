"""
Local-only dev server for admin/region-editor.html. Serves the repo exactly
like `python3 -m http.server` (via http.server.SimpleHTTPRequestHandler, so
static file serving/MIME types are unchanged), plus one extra endpoint the
editor's Save button POSTs to:

  POST /__save_regions
    Body: the same JSON shape as data/regions.json ({"regions": [...], ...}).
    On success:
      1. Times-tamped backup of the current data/regions.json into
         data/backups/ (gitignored -- git history is the durable backup once
         you commit and push; these are just an undo net for a bad save).
      2. Writes the new data/regions.json.
      3. Runs scripts.assign_regions.assign() in-process to rewrite
         data/listings.json's `region` field against the new boundaries.
      4. Runs scripts.generate_region_pages.generate() in-process to
         regenerate regions/<slug>/index.html for every current region, and
         remove any directory for a region that no longer exists.
    Responds 200 with a JSON summary, or 400/500 with {"error": "..."} on
    failure (regions.json is NOT overwritten if it fails to parse/validate).

This never touches the live GitHub Pages site -- it only writes to your local
working copy. Commit and push the resulting file changes like any other edit.

Run from the repo root:  python3 scripts/region_editor_server.py [port]
Then open http://localhost:8000/admin/region-editor.html (or your port).
"""
import json
import shutil
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assign_regions  # noqa: E402
import generate_region_pages  # noqa: E402
import verify_regions  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
REGIONS_PATH = REPO_ROOT / "data" / "regions.json"
BACKUPS_DIR = REPO_ROOT / "data" / "backups"
DEFAULT_PORT = 8000


class EditorRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO_ROOT), **kwargs)

    def log_message(self, fmt, *args):
        # Quieter than the stdlib default (which logs every static asset);
        # still logs errors via send_error's own path.
        if "__save_regions" in (self.path or ""):
            super().log_message(fmt, *args)

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/__save_regions":
            self._send_json(404, {"error": "no such endpoint"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw)
        except Exception as e:
            self._send_json(400, {"error": "could not parse request body: " + str(e)})
            return

        if not isinstance(payload, dict) or not isinstance(payload.get("regions"), list) or not payload["regions"]:
            self._send_json(400, {"error": "expected {\"regions\": [...]} with at least one region"})
            return

        try:
            BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
            if REGIONS_PATH.exists():
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                shutil.copyfile(REGIONS_PATH, BACKUPS_DIR / f"regions.{stamp}.json")

            REGIONS_PATH.write_text(json.dumps(payload, indent=2))

            listings_payload = assign_regions.assign()
            page_result = generate_region_pages.generate()

            ok = True
            check_output = []
            try:
                # verify_regions.main() calls sys.exit(); run its checks directly instead.
                regions = payload["regions"]
                listings = listings_payload["listings"]
                polys = verify_regions.region_polygons_utm(regions)
                ok = (
                    verify_regions.check_validity(regions, polys)
                    and verify_regions.check_overlap(regions, polys)
                )
            except Exception as e:
                ok = False
                check_output.append(str(e))

            message = f"{len(payload['regions'])} regions, {listings_payload['n']} listings reassigned."
            if page_result["removed"]:
                message += f" Removed stale page(s) for: {', '.join(page_result['removed'])} -- check data/regulations.json and data/featured_listings.json for orphaned keys."
            if not ok:
                message += " WARNING: verify_regions flagged a problem (invalid polygon or residual overlap) -- check the server's terminal output."

            self._send_json(200, {"message": message, "verifyOk": ok})
        except Exception as e:
            self._send_json(500, {"error": str(e)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = ThreadingHTTPServer(("localhost", port), EditorRequestHandler)
    print(f"Serving {REPO_ROOT} at http://localhost:{port}/")
    print(f"Region editor: http://localhost:{port}/admin/region-editor.html")
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
