"""
  swift · free-feed macro terminal · @negvol

  python start.py                 first run asks for a free FRED API key, then serves the app
  python start.py --port 9000     pick a port (default: first free from 8777)
  python start.py --reset-key     enter a new FRED key
  python start.py --no-browser    don't open a browser tab

Hosted mode (cloud, see README "Hosting"): on when the PORT env var is set, or with --public.
  env PORT            port to listen on (set by Render, Koyeb, HF Spaces, ...)
  env FRED_API_KEY    the FRED key (no prompt in hosted mode)
  env SWIFT_PASSWORD  optional: put the whole site behind a login (any username, this password)
  env SWIFT_RATE      optional: API requests per minute per visitor (default 240)
In hosted mode the server listens on 0.0.0.0, layouts are saved only in each visitor's browser,
and /healthz answers without a password for uptime pingers.

Stdlib only, no installs. The FRED key is used server-side and never reaches the page.
"""
from __future__ import annotations

import base64
import collections
import hmac
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import time
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
CONF = {"hosted": False, "password": "", "rate": 240}
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
    if (env.get("FRED_API_KEY") or os.environ.get("FRED_API_KEY")) and not reset:
        return
    if CONF["hosted"]:
        sys.exit("  FRED_API_KEY is not set. Add it as an environment variable on your host.")
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
    hits: dict = {}
    hits_lock = threading.Lock()

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

        def _gate(self, path) -> bool:
            """Password + per-visitor rate limit. False means the request was already answered."""
            if path == "/healthz":
                return True
            pw = CONF["password"]
            if pw:
                auth = self.headers.get("Authorization", "")
                ok = False
                if auth.startswith("Basic "):
                    try:
                        ok = hmac.compare_digest(base64.b64decode(auth[6:]).decode().partition(":")[2].encode(),
                                                 pw.encode())
                    except Exception:
                        ok = False
                if not ok:
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", 'Basic realm="swift"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return False
            if path.startswith("/api/"):
                fwd = self.headers.get("X-Forwarded-For", "") if CONF["hosted"] else ""
                ip = fwd.split(",")[0].strip() or self.client_address[0]
                now = time.time()
                with hits_lock:
                    dq = hits.setdefault(ip, collections.deque())
                    while dq and dq[0] < now - 60:
                        dq.popleft()
                    dq.append(now)
                    over = len(dq) > CONF["rate"]
                if over:
                    self._json({"error": "rate limit: slow down"}, 429)
                    return False
            return True

        def do_GET(self):
            u = up.urlsplit(self.path)
            if not self._gate(u.path):
                return
            if u.path == "/healthz":
                return self._json({"ok": True, "app": "swift @negvol"})
            if not u.path.startswith("/api/"):
                return super().do_GET()
            q = up.parse_qs(u.query)
            try:
                if u.path == "/api/config":
                    return self._json({"hosted": CONF["hosted"]})
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
                    if CONF["hosted"]:
                        return self._json(None)
                    f = LAYOUTS / "layout.json"
                    return self._json(json.loads(f.read_text(encoding="utf-8")) if f.exists() else None)
                return self._json({"error": "no such endpoint"}, 404)
            except Exception as e:
                traceback.print_exc()
                return self._json({"error": str(e)[:300]}, 502)

        def do_POST(self):
            if not self._gate(self.path):
                return
            if self.path != "/api/layout" or CONF["hosted"]:
                return self._json({"error": "no such endpoint"}, 404)
            body = self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 5_000_000))
            json.loads(body)
            (LAYOUTS / "layout.json").write_bytes(body)
            return self._json({"ok": True})

    return Handler


def main():
    args = sys.argv[1:]
    port = int(args[args.index("--port") + 1]) if "--port" in args else None
    CONF["hosted"] = bool(os.environ.get("PORT")) or "--public" in args
    CONF["password"] = os.environ.get("SWIFT_PASSWORD", "")
    CONF["rate"] = int(os.environ.get("SWIFT_RATE", "240"))
    if os.environ.get("PORT"):
        port = int(os.environ["PORT"])
    print(BANNER, flush=True)
    try:
        ensure_key("--reset-key" in args)
    except (KeyboardInterrupt, EOFError):
        sys.exit("\n  cancelled")
    port = port or free_port(8777)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    bind = "0.0.0.0" if CONF["hosted"] else "127.0.0.1"
    with socketserver.ThreadingTCPServer((bind, port), make_handler()) as srv:
        url = f"http://127.0.0.1:{port}/"
        if CONF["hosted"]:
            lock = "password on" if CONF["password"] else "NO PASSWORD: anyone with the URL can use it"
            print(f"  Swift hosted mode: listening on {bind}:{port} ({lock})", flush=True)
        else:
            print(f"  Swift is running  ->  {url}")
        print("  Ctrl-C to stop.  First load fetches ~40 feeds, give it a few seconds.\n")
        if "--no-browser" not in args and not CONF["hosted"]:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped")


if __name__ == "__main__":
    main()
