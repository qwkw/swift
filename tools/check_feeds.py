"""swift · @negvol
Fetch every catalogue series and table once; print status and freshness.
python tools/check_feeds.py [filter]   (exit 1 if anything fails)"""
import datetime as dt
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from swift import catalog, series, tables  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
flt = sys.argv[1] if len(sys.argv) > 1 else ""
cat = catalog.catalog()
ids = set()
for s in cat["series"]:
    ids.update(re.findall(r"\[([^\]]+)\]", s["id"]) if s["id"].startswith("=") else [s["id"]])
ids = sorted(i for i in ids if flt in i)
tids = [t["id"] for t in cat["tables"] if flt in t["id"]]
bad = []


def s1(i):
    t = time.time()
    try:
        r = series.fetch(i)
        p = r["points"]
        last = dt.datetime.fromtimestamp(p[-1][0] / 1000, dt.timezone.utc).strftime("%Y-%m-%d") if p else "-"
        ok = len(p) > 0
        return ok, f"{'ok ' if ok else 'EMPTY'} {i:55} n={len(p):6} last={last} v={p[-1][1] if p else ''} {time.time()-t:.1f}s"
    except Exception as e:
        return False, f"FAIL {i:55} {str(e)[:110]}"


def t1(i):
    try:
        r = tables.fetch(i)
        ok = len(r["rows"]) > 0
        return ok, f"{'ok ' if ok else 'EMPTY'} table {i:40} rows={len(r['rows'])}  {str(r['rows'][0])[:90] if r['rows'] else ''}"
    except Exception as e:
        return False, f"FAIL table {i:40} {str(e)[:110]}"


with ThreadPoolExecutor(10) as ex:
    for ok, line in list(ex.map(s1, ids)) + list(ex.map(t1, tids)):
        print(line, flush=True)
        if not ok:
            bad.append(line)
try:
    c = catalog.curve()
    print("ok  curve", c["curves"][0])
except Exception as e:
    bad.append(f"FAIL curve {e}")
    print(bad[-1])
print(f"\n{len(bad)} failing of {len(ids) + len(tids) + 1}")
sys.exit(1 if bad else 0)
