"""swift · @negvol — time-series adapters. A series id is "<source>:<arg>"; each adapter returns
{"name", "unit", "freq", "points": [[epoch_ms, value], ...]} sorted by time.

Daily data is stamped at 00:00 UTC of its calendar date so series from different
sources line up when the browser aligns them.
"""
from __future__ import annotations

import calendar
import csv
import datetime as dt
import io
import re
import urllib.parse as up

from .net import CHROME, FetchError, env, get, get_json, get_text

TTL = {  # seconds
    "fred": 1800, "yahoo": 300, "yahooi": 60, "cboe": 1800, "cftc": 6 * 3600, "nyfed": 1800,
    "tga": 3600, "ecb": 6 * 3600, "dbn": 6 * 3600, "wb": 24 * 3600, "binance": 300,
    "dvol": 600, "oni": 24 * 3600, "co2": 24 * 3600, "giss": 24 * 3600, "drought": 12 * 3600,
    "kp": 1800, "opt": 300, "wiki": 6 * 3600, "gdelt": 3600, "finra": 6 * 3600, "caiso": 300,
}


def ms(d: dt.date) -> int:
    return calendar.timegm(d.timetuple()) * 1000


def iso_ms(s: str) -> int:
    return ms(dt.date.fromisoformat(s[:10]))


def period_ms(p: str) -> int:
    """'2024', '2024-03', '2024-Q2', '2024-03-15', '2024M03', '2024-W05' -> ms."""
    p = p.strip()
    if m := re.fullmatch(r"(\d{4})-?Q([1-4])", p):
        return ms(dt.date(int(m[1]), 3 * int(m[2]) - 2, 1))
    if m := re.fullmatch(r"(\d{4})-?M?(\d{2})", p):
        return ms(dt.date(int(m[1]), int(m[2]), 1))
    if re.fullmatch(r"\d{4}", p):
        return ms(dt.date(int(p), 1, 1))
    if m := re.fullmatch(r"(\d{4})-W(\d{2})", p):
        return ms(dt.date.fromisocalendar(int(m[1]), int(m[2]), 1))
    return iso_ms(p)


def num(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def out(points, name="", unit="", freq=""):
    pts = sorted({t: v for t, v in points if v is not None}.items())
    return {"name": name, "unit": unit, "freq": freq, "points": [[t, v] for t, v in pts]}


# ── FRED ────────────────────────────────────────────────────────────────────
def fred(sid: str):
    key = env("FRED_API_KEY")
    if not key:
        raise FetchError("FRED_API_KEY missing — run start.py to set it")
    q = up.quote(sid)
    meta = get_json(f"https://api.stlouisfed.org/fred/series?series_id={q}&api_key={key}&file_type=json")["seriess"][0]
    obs = get_json(f"https://api.stlouisfed.org/fred/series/observations?series_id={q}&api_key={key}"
                   f"&file_type=json&observation_start=1990-01-01")["observations"]
    return out([(iso_ms(o["date"]), num(o["value"])) for o in obs], meta["title"], meta.get("units_short", ""),
               meta.get("frequency_short", ""))


# ── Yahoo chart API (Chrome UA: a bare/curl UA gets 429 from this IP) ────────
def _yahoo(sym: str, qs: str):
    err = None
    for host in ("query1", "query2"):
        try:
            d = get_json(f"https://{host}.finance.yahoo.com/v8/finance/chart/{up.quote(sym)}?{qs}",
                         headers={"User-Agent": CHROME})
            r = d["chart"]["result"][0]
            return r
        except Exception as e:
            err = e
    raise FetchError(f"yahoo {sym}: {err}")


def yahoo(sym: str):
    p1 = calendar.timegm(dt.date(2000, 1, 1).timetuple())
    r = _yahoo(sym, f"period1={p1}&period2=9999999999&interval=1d")
    off = r["meta"].get("gmtoffset", 0)
    closes = r["indicators"]["quote"][0].get("close") or []
    pts = []
    for t, c in zip(r.get("timestamp") or [], closes):
        d = dt.datetime.fromtimestamp(t + off, dt.timezone.utc).date()
        pts.append((ms(d), num(c)))
    m = r["meta"]
    return out(pts, m.get("shortName") or m.get("longName") or sym, m.get("currency", ""), "D")


def yahooi(sym: str):
    """Intraday 5-minute bars, last 5 days (true timestamps, not date-stamped)."""
    r = _yahoo(sym, "interval=5m&range=5d")
    closes = r["indicators"]["quote"][0].get("close") or []
    m = r["meta"]
    return out([(t * 1000, num(c)) for t, c in zip(r.get("timestamp") or [], closes)],
               (m.get("shortName") or sym) + " 5m", m.get("currency", ""), "5m")


def quotes(syms: list[str]):
    """Snapshot: last price, change vs previous close, intraday spark. Used by the ticker."""
    res = {}
    for s in syms:
        try:
            r = _yahoo(s, "interval=15m&range=1d")
            m = r["meta"]
            px = m.get("regularMarketPrice")
            prev = m.get("chartPreviousClose") or m.get("previousClose")
            spark = [c for c in (r["indicators"]["quote"][0].get("close") or []) if c is not None]
            res[s] = {"price": px, "prev": prev, "chg": (px / prev - 1) * 100 if px and prev else None,
                      "time": m.get("regularMarketTime"), "spark": spark[-60:], "name": m.get("shortName") or s}
        except Exception as e:
            res[s] = {"error": str(e)[:120]}
    return res


# ── Cboe index history CSVs (VIX, VIX9D, VIX3M, VIX6M, VVIX, SKEW, ...) ───────
def cboe(ix: str):
    if not re.fullmatch(r"[A-Z0-9]{2,8}", ix):
        raise FetchError("bad cboe index")
    txt = get_text(f"https://cdn.cboe.com/api/global/us_indices/daily_prices/{ix}_History.csv")
    rows = list(csv.reader(io.StringIO(txt)))
    head = [h.upper() for h in rows[0]]
    col = head.index("CLOSE") if "CLOSE" in head else len(head) - 1
    pts = []
    for r in rows[1:]:
        try:
            mth, day, yr = r[0].split("/")
            pts.append((ms(dt.date(int(yr), int(mth), int(day))), num(r[col])))
        except (ValueError, IndexError):
            pass
    return out(pts, f"Cboe {ix}", "index", "D")


# ── CFTC Commitments of Traders ──────────────────────────────────────────────
# id: cftc:<contract code>:<group>. group: nc (legacy non-commercial net), lev (TFF leveraged
# funds net), am (TFF asset managers net), dealer (TFF dealers net), oi (open interest).
CFTC_GROUPS = {
    "nc": ("6dca-aqww", "noncomm_positions_long_all", "noncomm_positions_short_all"),
    "comm": ("6dca-aqww", "comm_positions_long_all", "comm_positions_short_all"),
    "lev": ("gpe5-46if", "lev_money_positions_long", "lev_money_positions_short"),
    "am": ("gpe5-46if", "asset_mgr_positions_long", "asset_mgr_positions_short"),
    "dealer": ("gpe5-46if", "dealer_positions_long_all", "dealer_positions_short_all"),
}


def cftc(arg: str):
    code, _, grp = arg.partition(":")
    grp = grp or "nc"
    if not re.fullmatch(r"[0-9A-Z]{5,7}", code) or grp not in CFTC_GROUPS:
        raise FetchError("bad cftc id")
    ds, lo, sh = CFTC_GROUPS[grp]
    url = (f"https://publicreporting.cftc.gov/resource/{ds}.json?$limit=5000"
           f"&$where=cftc_contract_market_code='{code}'&$order=report_date_as_yyyy_mm_dd")
    rows = get_json(url)
    if not rows:
        raise FetchError(f"no CFTC rows for {code} in {ds}")
    name = rows[-1].get("market_and_exchange_names", code).split(" - ")[0].title()
    pts = [(iso_ms(r["report_date_as_yyyy_mm_dd"]), (num(r.get(lo)) or 0) - (num(r.get(sh)) or 0)) for r in rows
           if r.get(lo) is not None]
    label = {"nc": "non-commercial", "comm": "commercial", "lev": "leveraged funds", "am": "asset managers",
             "dealer": "dealers"}[grp]
    return out(pts, f"COT {name} · {label} net", "contracts", "W")


# ── NY Fed reference rates and reverse repo ──────────────────────────────────
def nyfed(which: str):
    if which in ("sofr", "bgcr", "tgcr"):
        url = f"https://markets.newyorkfed.org/api/rates/secured/{which}/search.json?startDate=2018-04-01"
    elif which in ("effr", "obfr"):
        url = f"https://markets.newyorkfed.org/api/rates/unsecured/{which}/search.json?startDate=2016-03-01"
    elif which == "rrp":
        start = (dt.date.today() - dt.timedelta(days=365 * 6)).isoformat()
        d = get_json(f"https://markets.newyorkfed.org/api/rp/reverserepo/propositions/search.json?startDate={start}")
        ops = d["repo"]["operations"]
        return out([(iso_ms(o["operationDate"]), (num(o.get("totalAmtAccepted")) or 0) / 1e9) for o in ops],
                   "Fed ON RRP accepted", "$bn", "D")
    else:
        raise FetchError("nyfed: sofr|bgcr|tgcr|effr|obfr|rrp")
    rows = get_json(url)["refRates"]
    return out([(iso_ms(r["effectiveDate"]), num(r.get("percentRate"))) for r in rows], which.upper(), "%", "D")


# ── Treasury General Account (Daily Treasury Statement) ──────────────────────
def tga(_: str = ""):
    url = ("https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance"
           "?filter=record_date:gte:2021-10-01,account_type:eq:Treasury General Account (TGA) Closing Balance"
           "&fields=record_date,open_today_bal,close_today_bal&page[size]=10000&sort=record_date")
    rows = get_json(url.replace(" ", "%20"))["data"]
    pts = []
    for r in rows:
        v = num(r.get("close_today_bal"))
        if v is None:
            v = num(r.get("open_today_bal"))
        pts.append((iso_ms(r["record_date"]), v / 1e3 if v is not None else None))
    return out(pts, "Treasury General Account (DTS)", "$bn", "D")


# ── ECB Data Portal (SDMX csv) — id ecb:FLOW/KEY ─────────────────────────────
def ecb(arg: str):
    flow, _, key = arg.partition("/")
    txt = get_text(f"https://data-api.ecb.europa.eu/service/data/{flow}/{key}?format=csvdata&startPeriod=1999")
    rd = csv.DictReader(io.StringIO(txt))
    pts, title = [], arg
    for r in rd:
        pts.append((period_ms(r["TIME_PERIOD"]), num(r["OBS_VALUE"])))
        title = r.get("TITLE") or title
    return out(pts, title, "", "")


# ── DBnomics (Eurostat, OECD, IMF, BIS, national CBs...) — id dbn:PROV/DS/SERIES ─
def dbn(arg: str):
    d = get_json(f"https://api.db.nomics.world/v22/series/{arg}?observations=1&format=json")
    docs = d["series"]["docs"]
    if not docs:
        raise FetchError("dbnomics: no such series")
    s = docs[0]
    return out([(period_ms(p), num(v)) for p, v in zip(s["period"], s["value"])],
               s.get("series_name") or arg, "", s.get("@frequency", ""))


# ── World Bank — id wb:COUNTRY/INDICATOR ─────────────────────────────────────
def wb(arg: str):
    c, _, ind = arg.partition("/")
    d = get_json(f"https://api.worldbank.org/v2/country/{c}/indicator/{ind}?format=json&per_page=200")
    rows = d[1] or []
    name = rows[0]["indicator"]["value"] + " · " + rows[0]["country"]["value"] if rows else arg
    return out([(ms(dt.date(int(r["date"]), 1, 1)), num(r["value"])) for r in rows], name, "", "A")


# ── Crypto: Binance daily klines, Deribit DVOL ───────────────────────────────
def binance(sym: str):
    sym = sym.upper()
    rows = get_json(f"https://api.binance.com/api/v3/klines?symbol={sym}&interval=1d&limit=1000")
    return out([(ms(dt.datetime.fromtimestamp(r[0] / 1000, dt.timezone.utc).date()), num(r[4])) for r in rows],
               f"{sym} (Binance)", sym[-4:], "D")


def dvol(ccy: str):
    ccy = ccy.upper()
    end = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    pts, start = [], end - 1000 * 86400 * 1000
    d = get_json(f"https://www.deribit.com/api/v2/public/get_volatility_index_data?currency={ccy}"
                 f"&resolution=1D&start_timestamp={start}&end_timestamp={end}")
    for r in d["result"]["data"]:
        pts.append((ms(dt.datetime.fromtimestamp(r[0] / 1000, dt.timezone.utc).date()), num(r[4])))
    return out(pts, f"Deribit {ccy} DVOL", "vol pts", "D")


# ── Climate / environment ────────────────────────────────────────────────────
SEAS = {"DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6, "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10,
        "OND": 11, "NDJ": 12}


def oni(_: str = ""):
    pts = []
    for line in get_text("https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt").splitlines()[1:]:
        p = line.split()
        if len(p) >= 4 and p[0] in SEAS:
            pts.append((ms(dt.date(int(p[1]), SEAS[p[0]], 1)), num(p[3])))
    return out(pts, "Oceanic Niño Index (ENSO)", "°C anomaly", "M")


def co2(_: str = ""):
    pts = []
    for line in get_text("https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_trend_gl.txt").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        y, m, d, smooth, *_ = line.split()
        pts.append((ms(dt.date(int(y), int(m), int(d))), num(smooth)))
    return out(pts, "Global CO₂ (NOAA, smoothed)", "ppm", "D")


def giss(_: str = ""):
    rows = list(csv.reader(io.StringIO(get_text("https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv"))))
    pts = []
    for r in rows[2:]:
        if not r or not r[0].isdigit():
            continue
        for mth in range(1, 13):
            pts.append((ms(dt.date(int(r[0]), mth, 1)), num(r[mth])))
    return out(pts, "Global temperature anomaly (GISTEMP)", "°C", "M")


def drought(level: str = "D1"):
    level = level.upper() or "D1"
    end = dt.date.today()
    start = end - dt.timedelta(days=365 * 6)
    f = lambda d: f"{d.month}/{d.day}/{d.year}"
    rows = get_json("https://usdmdataservices.unl.edu/api/USStatistics/GetDroughtSeverityStatisticsByAreaPercent"
                    f"?aoi=us&startdate={f(start)}&enddate={f(end)}&statisticsType=1",
                    headers={"Accept": "application/json"})
    pts = []
    for r in rows:
        key = next((k for k in r if k.lower() == level.lower()), None)
        date = r.get("mapDate") or r.get("MapDate") or r.get("validStart")
        if key and date:
            pts.append((iso_ms(date[:10] if "-" in date[:10] else f"{date[:4]}-{date[4:6]}-{date[6:8]}"), num(r[key])))
    return out(pts, f"US area in drought ≥{level}", "% area", "W")


def kp(_: str = ""):
    rows = get_json("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json")
    pts = []
    for r in rows:
        if isinstance(r, dict):
            t, v = r.get("time_tag"), r.get("Kp")
        else:
            t, v = r[0], r[1]
        if t and t[0].isdigit():
            pts.append((int(dt.datetime.fromisoformat(t.replace(" ", "T")[:19]).replace(
                tzinfo=dt.timezone.utc).timestamp() * 1000), num(v)))
    return out(pts, "Planetary Kp index (NOAA SWPC)", "Kp", "3h")


# ── Attention: Wikipedia pageviews, GDELT news volume ────────────────────────
def wiki(article: str):
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=365 * 3)
    a = up.quote(article.replace(" ", "_"), safe="")
    d = get_json(f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
                 f"{a}/daily/{start:%Y%m%d}/{end:%Y%m%d}")
    return out([(ms(dt.date(int(i["timestamp"][:4]), int(i["timestamp"][4:6]), int(i["timestamp"][6:8]))),
                 num(i["views"])) for i in d["items"]], f"Wikipedia views: {article}", "views/day", "D")


def gdelt(query: str):
    q = up.quote(query)
    d = get_json(f"https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode=timelinevol&format=json&timespan=3m")
    data = d["timeline"][0]["data"]
    pts = [(ms(dt.date(int(x["date"][:4]), int(x["date"][4:6]), int(x["date"][6:8]))), num(x["value"]))
           for x in data]
    agg: dict[int, float] = {}
    for t, v in pts:  # hourly/15-min buckets -> daily mean
        agg.setdefault(t, []).append(v)
    return out([(t, sum(v) / len(v)) for t, v in agg.items()], f"GDELT news volume: {query}", "% of coverage", "D")


# ── FINRA daily short volume ratio — id finra:SYMBOL ─────────────────────────
def finra_day(d: dt.date) -> str | None:
    from .net import cached
    key = f"finra-file:{d:%Y%m%d}"

    def fetch():
        try:
            return get_text(f"https://cdn.finra.org/equity/regsho/daily/CNMSshvol{d:%Y%m%d}.txt")
        except FetchError as e:
            if "403" in str(e) or "404" in str(e):
                return ""
            raise
    txt, _ = cached(key, 365 * 86400 if d < dt.date.today() - dt.timedelta(days=1) else 3600, fetch)
    return txt or None


def finra(sym: str):
    sym = sym.upper()
    pts, d, n = [], dt.date.today(), 0
    while n < 40 and (dt.date.today() - d).days < 70:
        if d.weekday() < 5:
            txt = finra_day(d)
            if txt:
                n += 1
                for line in txt.splitlines():
                    if line.startswith(f"{d:%Y%m%d}|{sym}|"):
                        p = line.split("|")
                        tot = num(p[4])
                        if tot:
                            pts.append((ms(d), 100 * num(p[2]) / tot))
                        break
        d -= dt.timedelta(days=1)
    return out(pts, f"FINRA short volume ratio {sym}", "% of volume", "D")


# ── CAISO fuel mix today — id caiso:<column> ─────────────────────────────────
def caiso(col: str):
    rows = list(csv.reader(io.StringIO(get_text("https://www.caiso.com/outlook/current/fuelsource.csv"))))
    head = [h.strip() for h in rows[0]]
    want = next((i for i, h in enumerate(head) if h.lower() == col.lower()), None)
    if want is None:
        raise FetchError(f"caiso column not in {head[1:]}")
    from .net import us_tz
    tz = us_tz(dt.datetime.now(dt.timezone.utc).date(), -8)
    today = dt.datetime.now(tz).date()
    pts = []
    for r in rows[1:]:
        try:
            hh, mm = r[0].split(":")
            t = dt.datetime(today.year, today.month, today.day, int(hh), int(mm), tzinfo=tz)
            pts.append((int(t.timestamp() * 1000), num(r[want])))
        except (ValueError, IndexError):
            pass
    return out(pts, f"CAISO {head[want]} (today)", "MW", "5m")


def opt(arg: str):
    """opt:SPX:gex -> daily history of an options metric, logged by swift/options.py each time it is computed."""
    from .options import history
    sym, _, field = arg.partition(":")
    return out([tuple(p) for p in history(sym, field or "gex")], f"{sym.upper()} options · {field or 'gex'}", "", "D")


ADAPTERS = {
    "opt": opt,
    "fred": fred, "yahoo": yahoo, "yahooi": yahooi, "cboe": cboe, "cftc": cftc, "nyfed": nyfed, "tga": tga,
    "ecb": ecb, "dbn": dbn, "wb": wb, "binance": binance, "dvol": dvol, "oni": oni, "co2": co2, "giss": giss,
    "drought": drought, "kp": kp, "wiki": wiki, "gdelt": gdelt, "finra": finra, "caiso": caiso,
}


def fetch(sid: str):
    from .net import cached
    src, _, arg = sid.partition(":")
    fn = ADAPTERS.get(src)
    if fn is None:
        raise FetchError(f"unknown source '{src}'")
    payload, meta = cached("s:" + sid, TTL.get(src, 1800), lambda: fn(arg))
    return {**payload, **meta, "id": sid}
