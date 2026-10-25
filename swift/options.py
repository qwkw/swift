"""swift · @negvol — options positioning from free delayed chains.

Sources
  Cboe delayed quotes  cdn.cboe.com/api/global/delayed_quotes/options/{SYM}.json  (15-min delayed, OI, IV,
                       volume; indices take a leading underscore: _SPX, _NDX, _VIX, _RUT)
  Deribit public API   get_book_summary_by_currency (BTC, ETH; mark IV, OI in coins)

Dealer-positioning convention (crude, the usual public "GEX" one): customers are net buyers of
puts and net sellers (overwriters) of calls, so dealers are LONG calls and SHORT puts. Dealer
position q = +OI for calls, -OI for puts. Real dealer books are unknown; treat every exposure
here as a sign-and-shape guide, not a measurement.

Greeks are recomputed with Black-Scholes from each contract's IV (r = q = 0, expiry 16:00 ET,
Deribit 08:00 UTC) so the spot-shifted gamma profile is consistent with the point estimates.

Units: GEX = $ change in dealer delta for a 1% spot move. DEX = dealer delta in $.
VEX (vanna) = $ change in dealer delta per +1 vol point. CEX (charm) = $ change in dealer delta
per calendar day of decay. All in $bn.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re

from .net import CHROME, ROOT, FetchError, cached, get, us_tz

HIST = ROOT / "data" / "options"
HIST.mkdir(parents=True, exist_ok=True)
INDEX = {"SPX", "NDX", "VIX", "RUT", "XSP", "DJX", "OEX"}
SQ2PI = math.sqrt(2 * math.pi)


def pdf(x):
    return math.exp(-0.5 * x * x) / SQ2PI


def cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def greeks(S, K, T, iv, call):
    """delta, gamma, vanna, charm(per year) with r=q=0."""
    sT = iv * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * iv * iv * T) / sT
    d2 = d1 - sT
    n1 = pdf(d1)
    delta = cdf(d1) if call else cdf(d1) - 1
    gamma = n1 / (S * sT)
    vanna = -n1 * d2 / iv
    charm = -n1 * (-d2 * sT) / (2 * T * sT)  # dDelta/dT; same for calls and puts when r=q=0
    return delta, gamma, vanna, charm


# ── chain loaders → list of dicts {K, T, exp, call, iv, oi, vol, bid, ask} ────
def _cboe(sym):
    code = ("_" + sym) if sym in INDEX else sym
    raw = get(f"https://cdn.cboe.com/api/global/delayed_quotes/options/{code}.json", headers={"User-Agent": CHROME},
              timeout=60)
    d = json.loads(raw)["data"]
    S = float(d["current_price"])
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for o in d["options"]:
        m = re.match(r"([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$", o["option"])
        if not m:
            continue
        ed = dt.date(2000 + int(m[2]), int(m[3]), int(m[4]))
        exp = dt.datetime(ed.year, ed.month, ed.day, 16, 0, tzinfo=us_tz(ed, -5))
        T = (exp - now).total_seconds() / (365.25 * 86400)
        if T <= 0:
            continue
        out.append({"K": int(m[6]) / 1000, "T": max(T, 1 / (365.25 * 24)), "exp": exp.date().isoformat(),
                    "call": m[5] == "C", "iv": float(o.get("iv") or 0), "oi": float(o.get("open_interest") or 0),
                    "vol": float(o.get("volume") or 0), "bid": float(o.get("bid") or 0), "ask": float(o.get("ask") or 0)})
    return {"spot": S, "chain": out, "asof": d.get("last_trade_time") or "", "iv30": d.get("iv30"),
            "source": "Cboe delayed quotes (15-min delayed)", "mult": 100}


MON = {m: i + 1 for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def _deribit(ccy):
    d = json.loads(get(f"https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency={ccy}&kind=option",
                       timeout=60))["result"]
    now = dt.datetime.now(dt.timezone.utc)
    S = None
    out = []
    for o in d:
        m = re.match(r"[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$", o["instrument_name"])
        if not m:
            continue
        exp = dt.datetime(2000 + int(m[3]), MON[m[2]], int(m[1]), 8, 0, tzinfo=dt.timezone.utc)
        T = (exp - now).total_seconds() / (365.25 * 86400)
        if T <= 0:
            continue
        u = float(o.get("underlying_price") or 0)
        S = S or (o.get("estimated_delivery_price") or u)
        px = lambda v: (v or 0) * u  # Deribit prices are in coin
        out.append({"K": float(m[4]), "T": max(T, 1 / (365.25 * 24)), "exp": exp.date().isoformat(), "call": m[5] == "C",
                    "iv": float(o.get("mark_iv") or 0) / 100, "oi": float(o.get("open_interest") or 0),
                    "vol": float(o.get("volume") or 0), "bid": px(o.get("bid_price")), "ask": px(o.get("ask_price"))})
    return {"spot": float(S), "chain": out, "asof": now.strftime("%Y-%m-%dT%H:%M"), "iv30": None,
            "source": "Deribit public API (real-time)", "mult": 1}


def chain(sym):
    sym = sym.upper().lstrip("_")
    if not re.fullmatch(r"[A-Z.]{1,6}", sym):
        raise FetchError("bad symbol")
    fn = (lambda: _deribit(sym)) if sym in ("BTC", "ETH") else (lambda: _cboe(sym))
    payload, meta = cached(f"chain:{sym}", 600, fn, disk=False)
    return payload


# ── analytics ────────────────────────────────────────────────────────────────
def analyse(sym, band=0.15, maxdte=90):
    c = chain(sym)
    S, M = c["spot"], c["mult"]
    today = dt.date.today()
    rows = [o for o in c["chain"] if o["oi"] > 0 or o["vol"] > 0]
    live = [o for o in rows if o["iv"] > 0.005 and o["T"] * 365.25 <= maxdte and abs(o["K"] / S - 1) <= max(band * 1.7, 0.25)]

    # point exposures
    gex = dex = vex = cex = gcall = gput = 0.0
    strikes: dict[float, dict] = {}
    for o in live:
        dlt, gam, van, chm = greeks(S, o["K"], o["T"], o["iv"], o["call"])
        q = o["oi"] * M * (1 if o["call"] else -1)
        g = q * gam * S * S * 0.01
        gex += g
        if o["call"]:
            gcall += g
        else:
            gput += g
        dex += q * dlt * S
        vex += q * van * 0.01 * S
        cex += q * (-chm) / 365.25 * S
        o["delta"] = dlt
        if abs(o["K"] / S - 1) <= band:
            st = strikes.setdefault(o["K"], {"k": o["K"], "callGex": 0, "putGex": 0, "callOI": 0, "putOI": 0, "callVol": 0, "putVol": 0})
            st["callGex" if o["call"] else "putGex"] += g
    for o in rows:  # OI / volume by strike use every expiry
        if abs(o["K"] / S - 1) <= band:
            st = strikes.setdefault(o["K"], {"k": o["K"], "callGex": 0, "putGex": 0, "callOI": 0, "putOI": 0, "callVol": 0, "putVol": 0})
            st["callOI" if o["call"] else "putOI"] += o["oi"]
            st["callVol" if o["call"] else "putVol"] += o["vol"]
    by = sorted(strikes.values(), key=lambda r: r["k"])
    for r in by:
        r["netGex"] = r["callGex"] + r["putGex"]

    # gamma profile vs hypothetical spot, and the flip (zero crossing nearest spot)
    grid = [S * (1 + x / 100) for x in range(-12, 13)] if sym not in ("BTC", "ETH") else [S * (1 + x / 50) for x in range(-15, 16)]
    prof = []
    for s2 in grid:
        tot = 0.0
        for o in live:
            sT = o["iv"] * math.sqrt(o["T"])
            d1 = (math.log(s2 / o["K"]) + 0.5 * o["iv"] ** 2 * o["T"]) / sT
            tot += (1 if o["call"] else -1) * o["oi"] * M * pdf(d1) / (s2 * sT) * s2 * s2 * 0.01
        prof.append([s2, tot / 1e9])
    flip = None
    for (a, ga), (b, gb) in zip(prof, prof[1:]):
        if ga == 0 or (ga < 0) != (gb < 0):
            x = a + (b - a) * (0 - ga) / (gb - ga) if gb != ga else a
            if flip is None or abs(x - S) < abs(flip - S):
                flip = x

    # walls: largest call gamma at/above spot, largest put gamma at/below spot
    above = [r for r in by if r["k"] >= S]
    below = [r for r in by if r["k"] <= S]
    call_wall = max(above, key=lambda r: r["callGex"])["k"] if above else None
    put_wall = min(below, key=lambda r: r["putGex"])["k"] if below else None

    # expiries
    exps = sorted({o["exp"] for o in rows})
    def dte(e): return (dt.date.fromisoformat(e) - today).days
    near = next((e for e in exps if dte(e) >= 1), exps[0] if exps else None)

    def atm_iv(e):
        cands = [o for o in rows if o["exp"] == e and o["iv"] > 0.005]
        if not cands:
            return None
        k = min(cands, key=lambda o: abs(o["K"] - S))["K"]
        v = [o["iv"] for o in cands if o["K"] == k]
        return sum(v) / len(v) * 100
    term = [{"exp": e, "dte": dte(e), "iv": atm_iv(e)} for e in exps if 0 <= dte(e) <= 400]
    term = [t for t in term if t["iv"]]

    def interp(days):
        pts = [(t["dte"], t["iv"]) for t in term if t["dte"] >= 1]
        if not pts:
            return None
        if days <= pts[0][0]:
            return pts[0][1]
        for (d0, v0), (d1, v1) in zip(pts, pts[1:]):
            if d0 <= days <= d1:
                return v0 + (v1 - v0) * (days - d0) / (d1 - d0)
        return pts[-1][1]
    iv30, iv90 = interp(30), interp(90)

    # smile + 25-delta skew on the expiry nearest 30 days
    e30 = min((e for e in exps if dte(e) >= 7), key=lambda e: abs(dte(e) - 30), default=None)
    smile, skew25, rr = [], None, None
    if e30:
        T30 = max(dte(e30), 1) / 365.25
        ch = [o for o in rows if o["exp"] == e30 and o["iv"] > 0.005 and abs(o["K"] / S - 1) <= 0.25]
        for o in ch:
            if (o["call"] and o["K"] >= S) or (not o["call"] and o["K"] < S):
                smile.append([o["K"] / S, o["iv"] * 100])
        smile.sort()
        dl = [(o, greeks(S, o["K"], T30, o["iv"], o["call"])[0]) for o in ch]
        p25 = min((x for x in dl if not x[0]["call"]), key=lambda x: abs(x[1] + 0.25), default=None)
        c25 = min((x for x in dl if x[0]["call"]), key=lambda x: abs(x[1] - 0.25), default=None)
        if p25 and c25:
            skew25 = (p25[0]["iv"] - c25[0]["iv"]) * 100

    # implied move to the nearest expiry (ATM straddle mid / spot)
    move = None
    if near:
        cands = [o for o in rows if o["exp"] == near and o["bid"] > 0 and o["ask"] > 0]
        if cands:
            k = min(cands, key=lambda o: abs(o["K"] - S))["K"]
            leg = [(o["bid"] + o["ask"]) / 2 for o in cands if o["K"] == k]
            if len(leg) == 2:
                move = {"exp": near, "dte": dte(near), "pct": 100 * sum(leg) / S}

    # max pain on the nearest expiry
    maxpain = None
    if near:
        ne = [o for o in rows if o["exp"] == near and o["oi"] > 0]
        ks = sorted({o["K"] for o in ne if abs(o["K"] / S - 1) <= band})
        if ks:
            pay = lambda x: sum(o["oi"] * (max(x - o["K"], 0) if o["call"] else max(o["K"] - x, 0)) for o in ne)
            maxpain = min(ks, key=pay)

    coi = sum(o["oi"] for o in rows if o["call"]); poi = sum(o["oi"] for o in rows if not o["call"])
    cvol = sum(o["vol"] for o in rows if o["call"]); pvol = sum(o["vol"] for o in rows if not o["call"])
    m = {"spot": S, "gex": gex / 1e9, "dex": dex / 1e9, "vex": vex / 1e9, "cex": cex / 1e9,
         "gexShare": gex / (abs(gcall) + abs(gput)) if (gcall or gput) else None,
         "flip": flip, "flipDist": 100 * (S / flip - 1) if flip else None, "callWall": call_wall, "putWall": put_wall,
         "maxPain": maxpain, "pcOI": poi / coi if coi else None, "pcVol": pvol / cvol if cvol else None,
         "iv30": iv30, "iv90": iv90, "termSlope": iv90 - iv30 if iv30 and iv90 else None, "skew25": skew25,
         "skewRatio": skew25 / iv30 if skew25 is not None and iv30 else None, "move": move,
         "cboeIv30": c.get("iv30"), "nOpts": len(rows), "nLive": len(live)}
    res = {"sym": sym, "chainTime": c["asof"], "source": c["source"], "metrics": m, "byStrike": by, "profile": prof,
           "term": term, "smile": {"exp": e30, "pts": smile}, "bias": bias(m)}
    log(sym, m)
    return res


# ── crude options bias (fixed scales; becomes z-scored once history accrues) ──
def bias(m):
    t = lambda x, s: math.tanh(x / s) if x is not None else None
    vol = [  # + = vol expansion risk
        ("Dealer gamma short (net GEX share)", t(-(m["gexShare"] or 0), 0.35) if m["gexShare"] is not None else None, 1.0),
        ("Spot below gamma flip", t(-(m["flipDist"] or 0), 1.0) if m["flipDist"] is not None else None, 1.0),
        ("Term structure inverted (IV30 > IV90)", t(-(m["termSlope"]), 1.5) if m["termSlope"] is not None else None, 0.75),
        ("Put skew steep (25Δ skew / ATM)", t((m["skewRatio"] or 0) - 0.3, 0.15) if m["skewRatio"] is not None else None, 0.5),
    ]
    rng = (m["callWall"] - m["putWall"]) / 2 if m["callWall"] and m["putWall"] and m["callWall"] != m["putWall"] else None
    pos = (m["spot"] - (m["callWall"] + m["putWall"]) / 2) / rng if rng else None
    direc = [  # + = supportive / upward drift
        ("Spot above gamma flip", t(m["flipDist"], 1.0) if m["flipDist"] is not None else None, 1.0),
        ("Room to call wall vs put wall", t(-pos, 0.6) if pos is not None else None, 0.75),
        ("Put/call volume (contrarian)", t((m["pcVol"] or 0) - 1.0, 0.4) if m["pcVol"] is not None else None, 0.5),
        ("Dealer charm flow (delta bought into decay)", t(m["cex"], abs(m["dex"]) * 0.02 + 1e-9) if m["cex"] is not None and m["dex"] else None, 0.5),
    ]

    def score(items):
        live = [(v, w) for _, v, w in items if v is not None]
        tw = sum(abs(w) for _, _, w in items)
        return (100 * sum(v * w for v, w in live) / sum(w for _, w in live) if live else None,
                [{"label": l, "value": v, "w": w, "contrib": None if v is None else 100 * v * w / tw} for l, v, w in items])
    vs, vi = score(vol)
    ds, di = score(direc)
    return {"vol": {"score": vs, "items": vi}, "dir": {"score": ds, "items": di}}


# ── daily history log, so metrics become series: opt:SPX:gex ─────────────────
def log(sym, m):
    f = HIST / f"{sym}.jsonl"
    day = dt.date.today().isoformat()
    rows = {}
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
                rows[r["date"]] = r
            except ValueError:
                pass
    flat = {k: v for k, v in m.items() if isinstance(v, (int, float)) and v is not None}
    if m.get("move"):
        flat["movePct"] = m["move"]["pct"]
    b = bias(m)
    flat["biasVol"], flat["biasDir"] = b["vol"]["score"], b["dir"]["score"]
    rows[day] = {"date": day, **flat}
    f.write_text("\n".join(json.dumps(rows[k]) for k in sorted(rows)) + "\n", encoding="utf-8")


def history(sym, field):
    f = HIST / f"{sym.upper()}.jsonl"
    pts = []
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r.get(field) is not None:
                d = dt.date.fromisoformat(r["date"])
                pts.append([int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp() * 1000), r[field]])
    return pts


def get_analysis(sym, band=0.15, maxdte=90):
    sym = sym.upper().lstrip("_")
    payload, meta = cached(f"opt:{sym}:{band}:{maxdte}", 600, lambda: analyse(sym, band, maxdte), disk=False)
    return {**payload, **meta}
