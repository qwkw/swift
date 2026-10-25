"""
  swift · free-feed macro terminal · @negvol

  python start.py                 first run asks for a free FRED API key, then serves the app
  python start.py --port 9000     pick a port (default: first free from 8777)
  python start.py --reset-key     enter a new FRED key
  python start.py --no-browser    don't open a browser tab

Stdlib only, no installs. Binds to 127.0.0.1: the key stays on this machine and never reaches the page.
"""
from __future__ import annotations

import http.server
import json
import socket
import socketserver
import sys
import threading
import traceback
import urllib.parse as up
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass
if sys.version_info < (3, 9):
    sys.exit("swift needs Python 3.9 or newer")

ENV = HERE / ".env"
WEB = HERE / "web"
LAYOUTS = HERE / "layouts"
BANNER = r"""
   ____          _  __ _
  / ___|_      _(_)/ _| |_
  \___ \ \ /\ / / | |_| __|
   ___) \ V  V /| |  _| |_
  |____/ \_/\_/ |_|_|  \__|   free-feed macro terminal - @negvol
"""


# ── setup: FRED key ───────────────────────────────────────────────────────────
def read_env() -> dict:
    out = {}
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            k, sep, v = line.partition("=")
            if sep and not k.strip().startswith("#"):
                out[k.strip()] = v.strip()
    return out


def check_fred(key: str) -> bool:
    url = f"https://api.stlouisfed.org/fred/series?series_id=DGS10&api_key={up.quote(key)}&file_type=json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "swift/1.0"}), timeout=20) as r:
            return "seriess" in json.loads(r.read())
    except Exception:
        return False


def ensure_key(reset: bool):
    env = read_env()
    if env.get("FRED_API_KEY") and not reset:
        return
    print("  Swift needs one free API key, from FRED (St. Louis Fed).")
    print("  Get it in a minute at  https://fred.stlouisfed.org/docs/api/api_key.html\n")
    while True:
        key = input("  FRED API key: ").strip()
        if not key:
            print("  (empty - paste the 32-character key)")
            continue
        print("  checking...", end=" ", flush=True)
        if check_fred(key):
            print("ok")
            break
        print("FRED rejected it (or you're offline). Try again, or Ctrl-C to quit.")
    env["FRED_API_KEY"] = key
    ENV.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")
    print(f"  saved to {ENV.name} (git-ignored)\n")


def free_port(start: int) -> int:
    for p in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise SystemExit("no free port found")


# ── server ────────────────────────────────────────────────────────────────────
def make_handler():
    from swift import catalog, options, series, tables
    from swift.net import cached
    pool = ThreadPoolExecutor(16)
    LAYOUTS.mkdir(exist_ok=True)

    def one_series(sid):
        try:
            return series.fetch(sid)
        except Exception as e:
            return {"id": sid, "error": str(e)[:240], "points": []}

    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                          ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
                          ".json": "application/json", ".html": "text/html", ".svg": "image/svg+xml"}

        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(WEB), **k)

        def log_message(self, *a):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Powered-By", "swift @negvol")
            super().end_headers()

        def _json(self, obj, code=200):
            b = json.dumps(obj, separators=(",", ":"), default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            u = up.urlsplit(self.path)
            if not u.path.startswith("/api/"):
                return super().do_GET()
            q = up.parse_qs(u.query)
            try:
                if u.path == "/api/catalog":
                    return self._json(catalog.catalog())
                if u.path == "/api/series":
                    return self._json({r["id"]: r for r in pool.map(one_series, q.get("id", [])[:60])})
                if u.path == "/api/table":
                    return self._json(tables.fetch(q["id"][0]))
                if u.path == "/api/options":
                    return self._json(options.get_analysis(q["sym"][0], float(q.get("band", ["0.15"])[0]),
                                                           int(q.get("maxdte", ["90"])[0])))
                if u.path == "/api/curve":
                    return self._json(catalog.curve())
                if u.path == "/api/quotes":
                    syms = tuple(sorted(set(q.get("s", []))))[:40]
                    payload, meta = cached("q:" + ",".join(syms), 30, lambda: series.quotes(list(syms)), disk=False)
                    return self._json({"quotes": payload, **meta})
                if u.path == "/api/layout":
                    f = LAYOUTS / "layout.json"
                    return self._json(json.loads(f.read_text(encoding="utf-8")) if f.exists() else None)
                return self._json({"error": "no such endpoint"}, 404)
            except Exception as e:
                traceback.print_exc()
                return self._json({"error": str(e)[:300]}, 502)

        def do_POST(self):
            if self.path != "/api/layout":
                return self._json({"error": "no such endpoint"}, 404)
            body = self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 5_000_000))
            json.loads(body)
            (LAYOUTS / "layout.json").write_bytes(body)
            return self._json({"ok": True})

    return Handler


def main():
    args = sys.argv[1:]
    port = int(args[args.index("--port") + 1]) if "--port" in args else None
    print(BANNER)
    try:
        ensure_key("--reset-key" in args)
    except (KeyboardInterrupt, EOFError):
        sys.exit("\n  cancelled")
    port = port or free_port(8777)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), make_handler()) as srv:
        url = f"http://127.0.0.1:{port}/"
        print(f"  Swift is running  ->  {url}")
        print("  Ctrl-C to stop.  First load fetches ~40 feeds, give it a few seconds.\n")
        if "--no-browser" not in args:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped")


if __name__ == "__main__":
    main()
