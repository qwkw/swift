"""swift · @negvol

HTTP fetch with per-host pacing, plus a memory+disk cache that serves stale on error.

Every upstream call in swift goes through get(). Pacing is per host because the
free feeds rate-limit per IP: Yahoo 429s bursts, GDELT's DOC API wants ~1 request
per 5 s, SEC asks for <= 10/s.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "cache"
CACHE_DIR.mkdir(exist_ok=True)

CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")
UA = "swift/1.0 (local market terminal)"

# host -> (min seconds between requests, max concurrent)
PACE = {
    "query1.finance.yahoo.com": (0.4, 2), "query2.finance.yahoo.com": (0.4, 2),
    "api.gdeltproject.org": (6.0, 1), "www.sec.gov": (0.15, 2),
    "nfs.faireconomy.media": (2.0, 1), "api.stlouisfed.org": (0.05, 6),
}
_locks: dict[str, threading.Semaphore] = {}
_last: dict[str, float] = {}
_meta = threading.Lock()


def us_tz(d, std_offset: int):
    """US local timezone for date d without tzdata: std_offset -5 (Eastern) or -8 (Pacific); DST from the
    2nd Sunday of March to the 1st Sunday of November."""
    import datetime as dt
    mar = dt.date(d.year, 3, 8 + (6 - dt.date(d.year, 3, 8).weekday()) % 7)
    nov = dt.date(d.year, 11, 1 + (6 - dt.date(d.year, 11, 1).weekday()) % 7)
    return dt.timezone(dt.timedelta(hours=std_offset + (1 if mar <= d < nov else 0)))


def env(name: str) -> str:
    v = os.environ.get(name)
    if v:
        return v
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            k, _, val = line.partition("=")
            if k.strip() == name:
                return val.strip()
    return ""


def _slot(host: str):
    gap, conc = PACE.get(host, (0.0, 6))
    with _meta:
        sem = _locks.setdefault(host, threading.Semaphore(conc))
    sem.acquire()
    with _meta:
        wait = _last.get(host, 0) + gap - time.time()
        _last[host] = max(time.time(), _last.get(host, 0) + gap)
    if wait > 0:
        time.sleep(wait)
    return sem


class FetchError(Exception):
    pass


def get(url: str, headers: dict | None = None, timeout: float = 30, data: bytes | None = None,
        retries: int = 1) -> bytes:
    host = urllib.parse.urlsplit(url).hostname or ""
    h = {"User-Agent": UA, "Accept-Encoding": "identity"}
    h.update(headers or {})
    if data is not None:
        h.setdefault("Content-Type", "application/json")
    err = None
    for attempt in range(retries + 1):
        sem = _slot(host)
        try:
            req = urllib.request.Request(url, headers=h, data=data)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            if body[:2] == bytes((0x1F, 0x8B)):  # some hosts gzip regardless of Accept-Encoding
                body = gzip.decompress(body)
            return body
        except urllib.error.HTTPError as e:
            err = FetchError(f"HTTP {e.code} from {host}")
            if e.code not in (429, 500, 502, 503, 504):
                break
            time.sleep(2 * (attempt + 1))
        except Exception as e:  # timeouts, DNS, resets
            err = FetchError(f"{type(e).__name__} from {host}: {str(e)[:80]}")
        finally:
            sem.release()
    raise err


def get_json(url: str, **kw):
    return json.loads(get(url, **kw))


def get_text(url: str, **kw) -> str:
    return get(url, **kw).decode("utf-8-sig", errors="replace")


_mem: dict[str, tuple[float, object]] = {}
_inflight: dict[str, threading.Lock] = {}


def cached(key: str, ttl: float, fn, disk: bool = True):
    """Return (payload, meta). meta = {asof, stale, error?}. Concurrent callers of the
    same key wait for one fetch. On failure, the last good payload is served as stale."""
    with _meta:
        lock = _inflight.setdefault(key, threading.Lock())
    with lock:
        now = time.time()
        hit = _mem.get(key)
        path = CACHE_DIR / (hashlib.sha1(key.encode()).hexdigest()[:20] + ".json")
        if hit is None and disk and path.exists():
            try:
                hit = tuple(json.loads(path.read_text(encoding="utf-8")))
                _mem[key] = hit
            except Exception:
                hit = None
        if hit and now - hit[0] < ttl:
            return hit[1], {"asof": hit[0], "stale": False}
        try:
            payload = fn()
        except Exception as e:
            if hit:
                return hit[1], {"asof": hit[0], "stale": True, "error": str(e)[:200]}
            raise
        _mem[key] = (now, payload)
        if disk:
            try:
                path.write_text(json.dumps([now, payload]), encoding="utf-8")
            except Exception:
                pass
        return payload, {"asof": now, "stale": False}
