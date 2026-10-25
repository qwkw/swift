"""swift · @negvol — list/table adapters. Each returns {"columns": [{key,label,num?}], "rows": [{...}]}.
A row may carry "_url" (opens on click) or "_series" (charts on click)."""
from __future__ import annotations

import csv
import datetime as dt
import html
import io
import json
import re
import time
import xml.etree.ElementTree as ET
import zipfile

from .net import CHROME, FetchError, get, get_json, get_text

TTL = 600


def T(cols, rows):
    return {"columns": [dict(key=k, label=l, num=n) for k, l, n in cols], "rows": rows}


def strip(s):
    return html.unescape(re.sub(r"<[^>]+>", " ", s or "")).strip()


# ── Prediction markets ───────────────────────────────────────────────────────
KALSHI_SKIP = {"Sports", "Entertainment"}


def kalshi(category=""):
    """kalshi -> all non-sport/entertainment; kalshi:Economics -> one category."""
    d = get_json("https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200")
    rows = []
    for ev in d.get("events", []):
        cat = ev.get("category", "")
        if (category and cat.lower() != category.lower()) or (not category and cat in KALSHI_SKIP):
            continue
        for m in ev.get("markets", []):
            p = m.get("last_price_dollars") or m.get("last_price")
            p = float(p) * (100 if m.get("last_price_dollars") else 1) if p not in (None, "") else None
            vol = float(m.get("volume_24h_fp") or m.get("volume_24h") or 0)
            label = ev.get("title", "") + (f" — {m['yes_sub_title']}" if len(ev.get("markets", [])) > 1 and
                                             m.get("yes_sub_title") else "")
            rows.append({"market": label, "category": cat, "yes": p, "vol24": vol,
                         "close": (m.get("close_time") or "")[:10],
                         "_url": f"https://kalshi.com/markets/{ev.get('event_ticker', '').lower()}"})
    rows.sort(key=lambda r: -r["vol24"])
    return T([("market", "market", 0), ("category", "category", 0), ("yes", "yes %", 1), ("vol24", "24h vol", 1),
              ("close", "closes", 0)], rows[:150])


def polymarket(tag="economy"):
    """polymarket:<tag> -> open events under a Polymarket tag (economy, finance, fed, geopolitics, politics, crypto)."""
    tag = re.sub(r"[^a-z0-9-]", "", (tag or "economy").lower())
    d = get_json(f"https://gamma-api.polymarket.com/events?tag_slug={tag}&active=true&closed=false&order=volume24hr"
                 "&ascending=false&limit=60", headers={"User-Agent": CHROME})
    rows = []
    for ev in d:
        for m in ev.get("markets", []):
            if m.get("closed") or not m.get("active", True):
                continue
            try:
                prices = json.loads(m.get("outcomePrices") or "[]")
                outs = json.loads(m.get("outcomes") or "[]")
            except ValueError:
                prices, outs = [], []
            yes = float(prices[0]) * 100 if prices else None
            sub = m.get("groupItemTitle") or ""
            rows.append({"market": ev.get("title", "") + (f" — {sub}" if sub else ""), "outcome": outs[0] if outs else "",
                         "yes": yes, "vol24": float(m.get("volume24hr") or 0), "close": (m.get("endDate") or "")[:10],
                         "_url": f"https://polymarket.com/event/{ev.get('slug', '')}"})
    rows.sort(key=lambda r: -r["vol24"])
    return T([("market", "market", 0), ("outcome", "outcome", 0), ("yes", "price %", 1), ("vol24", "24h vol $", 1),
              ("close", "ends", 0)], rows[:200])


def manifold(_=""):
    d = get_json("https://api.manifold.markets/v0/search-markets?sort=24-hour-vol&filter=open&contractType=BINARY"
                 "&limit=100&term=")
    rows = [{"market": m.get("question", ""), "prob": (m.get("probability") or 0) * 100,
             "vol24": m.get("volume24Hours") or 0, "traders": m.get("uniqueBettorCount") or 0, "_url": m.get("url")}
            for m in d if isinstance(m.get("probability"), (int, float))]
    return T([("market", "market", 0), ("prob", "prob %", 1), ("vol24", "24h vol M$", 1), ("traders", "traders", 1)],
             rows)


# ── Calendar and central-bank / official wires ───────────────────────────────
def calendar(which="thisweek"):
    d = get_json("https://nfs.faireconomy.media/ff_calendar_thisweek.json")
    rows = [{"time": e.get("date", "")[:16].replace("T", " "), "ccy": e.get("country", ""), "impact": e.get("impact", ""),
             "event": e.get("title", ""), "forecast": e.get("forecast", ""), "previous": e.get("previous", ""),
             "_ts": e.get("date", "")} for e in d]
    return T([("time", "time (ET)", 0), ("ccy", "ccy", 0), ("impact", "impact", 0), ("event", "event", 0),
              ("forecast", "fcst", 0), ("previous", "prev", 0)], rows)


RSS = {
    "fed_press": "https://www.federalreserve.gov/feeds/press_all.xml",
    "fed_speeches": "https://www.federalreserve.gov/feeds/speeches.xml",
    "ecb": "https://www.ecb.europa.eu/rss/press.html",
    "boe": "https://www.bankofengland.co.uk/rss/news",
    "boj": "https://www.boj.or.jp/en/rss/whatsnew.xml",
    "bis": "https://www.bis.org/doclist/cbspeeches.rss",
    "treasury": "https://home.treasury.gov/system/files/126/ofac.xml",
    "gdacs": "https://www.gdacs.org/xml/rss.xml",
}


def _when(s):
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return dt.datetime.strptime(s.strip(), fmt).strftime("%Y-%m-%d %H:%M")
        except (ValueError, AttributeError):
            pass
    return (s or "")[:16]


def rss(which):
    url = RSS.get(which)
    if not url:
        raise FetchError("unknown rss feed")
    raw = get(url, headers={"User-Agent": CHROME})
    root = ET.fromstring(raw.lstrip(b"\xef\xbb\xbf").strip())
    rows = []
    for it in root.iter():
        tag = it.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        g = lambda n: next((c for c in it if c.tag.split("}")[-1] == n), None)
        title = g("title")
        link = g("link")
        date = next((e for e in map(g, ("pubDate", "updated", "published", "date")) if e is not None), None)
        href = (link.get("href") or link.text) if link is not None else ""
        rows.append({"when": _when(date.text if date is not None else ""),
                     "title": strip(title.text if title is not None else ""), "_url": (href or "").strip()})
    return T([("when", "time", 0), ("title", "title", 0)], rows[:80])


def edgar(form="8-K"):
    form = re.sub(r"[^0-9A-Za-z/ -]", "", form) or "8-K"
    raw = get(f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type={form.replace(' ', '+')}&company=&dateb=&owner=include"
              f"&count=100&output=atom")
    ns = {"a": "http://www.w3.org/2005/Atom"}
    rows = []
    for e in ET.fromstring(raw).findall("a:entry", ns):
        rows.append({"when": (e.findtext("a:updated", "", ns))[:16].replace("T", " "),
                     "title": e.findtext("a:title", "", ns), "_url": e.find("a:link", ns).get("href")})
    return T([("when", "filed", 0), ("title", "filing", 0)], rows)


def ofac(_=""):
    page = get_text("https://ofac.treasury.gov/recent-actions", headers={"User-Agent": CHROME})
    rows, seen = [], set()
    for path, ymd, title in re.findall(r'href="(/recent-actions/(\d{8}))"[^>]*>\s*([^<]{6,200})', page):
        if path in seen:
            continue
        seen.add(path)
        rows.append({"date": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}", "title": html.unescape(title.strip()),
                     "_url": "https://ofac.treasury.gov" + path})
    return T([("date", "date", 0), ("title", "action", 0)], rows[:40])


def usaspending(_=""):
    end = dt.date.today()
    body = {"filters": {"award_type_codes": ["A", "B", "C", "D"],
                        "time_period": [{"start_date": str(end - dt.timedelta(days=45)), "end_date": str(end)}]},
            "fields": ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date",
                       "generated_internal_id"], "sort": "Award Amount", "order": "desc", "limit": 100}
    d = json.loads(get("https://api.usaspending.gov/api/v2/search/spending_by_award/", data=json.dumps(body).encode()))
    rows = [{"recipient": x.get("Recipient Name"), "amount": (x.get("Award Amount") or 0) / 1e6,
             "agency": x.get("Awarding Agency"), "date": x.get("Start Date"),
             "_url": f"https://www.usaspending.gov/award/{x.get('generated_internal_id')}"} for x in d.get("results", [])]
    return T([("date", "start", 0), ("recipient", "recipient", 0), ("agency", "agency", 0),
              ("amount", "$m", 1)], rows)


def grants(_=""):
    d = json.loads(get("https://api.grants.gov/v1/api/search2",
                       data=json.dumps({"rows": 200, "keyword": "", "oppStatuses": "posted"}).encode()))
    f = lambda s: f"{s[6:]}-{s[:2]}-{s[3:5]}" if s and len(s) == 10 else s
    rows = [{"posted": f(o.get("openDate", "")), "title": o.get("title", ""), "agency": o.get("agencyName", ""),
             "close": f(o.get("closeDate", "")), "_url": f"https://www.grants.gov/search-results-detail/{o.get('id')}"}
            for o in d.get("data", {}).get("oppHits", [])]
    rows.sort(key=lambda r: r["posted"], reverse=True)
    return T([("posted", "posted", 0), ("title", "opportunity", 0), ("agency", "agency", 0), ("close", "closes", 0)],
             rows)


# ── Positioning snapshots ────────────────────────────────────────────────────
COT = [("13874A", "S&P 500 e-mini"), ("209742", "Nasdaq-100 e-mini"), ("124603", "Dow e-mini"),
       ("239742", "Russell 2000 e-mini"), ("1170E1", "VIX"), ("042601", "2Y T-note"), ("044601", "5Y T-note"),
       ("043602", "10Y T-note"), ("020601", "T-bond"), ("134741", "SOFR 3M"), ("099741", "Euro FX"),
       ("097741", "Japanese yen"), ("096742", "British pound"), ("098662", "US dollar index"),
       ("133741", "Bitcoin"), ("067651", "WTI crude"), ("023651", "Natural gas"), ("088691", "Gold"),
       ("084691", "Silver"), ("085692", "Copper"), ("002602", "Corn"), ("001602", "Wheat"), ("005602", "Soybeans")]


def cot(_=""):
    codes = ",".join(f"'{c}'" for c, _ in COT)
    since = (dt.date.today() - dt.timedelta(days=3 * 365 + 30)).isoformat()
    rows = get_json("https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=50000"
                    f"&$select=cftc_contract_market_code,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,"
                    f"noncomm_positions_short_all,open_interest_all"
                    f"&$where=cftc_contract_market_code in({codes}) and report_date_as_yyyy_mm_dd>='{since}'"
                    f"&$order=report_date_as_yyyy_mm_dd".replace(" ", "%20"))
    by: dict[str, list] = {}
    for r in rows:
        net = float(r["noncomm_positions_long_all"]) - float(r["noncomm_positions_short_all"])
        by.setdefault(r["cftc_contract_market_code"], []).append((r["report_date_as_yyyy_mm_dd"][:10], net,
                                                                  float(r["open_interest_all"])))
    out = []
    for code, name in COT:
        s = by.get(code)
        if not s:
            continue
        nets = [x[1] for x in s]
        lo, hi = min(nets), max(nets)
        out.append({"market": name, "date": s[-1][0], "net": nets[-1], "chg": nets[-1] - nets[-2] if len(s) > 1 else None,
                    "pct_oi": 100 * nets[-1] / s[-1][2] if s[-1][2] else None,
                    "cot_index": 100 * (nets[-1] - lo) / (hi - lo) if hi > lo else None,
                    "_series": f"cftc:{code}:nc"})
    return T([("market", "market", 0), ("date", "as of", 0), ("net", "spec net", 1), ("chg", "w/w", 1),
              ("pct_oi", "% OI", 1), ("cot_index", "3y COT idx", 1)], out)


def finra_top(minvol="5000000"):
    from .series import finra_day
    d = dt.date.today()
    for _ in range(10):
        if d.weekday() < 5 and (txt := finra_day(d)):
            break
        d -= dt.timedelta(days=1)
    else:
        raise FetchError("no FINRA file in last 10 days")
    mv = float(minvol or 5e6)
    rows = []
    for line in txt.splitlines()[1:]:
        p = line.split("|")
        if len(p) < 5:
            continue
        try:
            sv, tv = float(p[2]), float(p[4])
        except ValueError:
            continue
        if tv >= mv:
            rows.append({"symbol": p[1], "ratio": 100 * sv / tv, "volume": tv / 1e6, "_series": f"finra:{p[1]}"})
    rows.sort(key=lambda r: -r["ratio"])
    return T([("symbol", "symbol", 0), ("ratio", "short %", 1), ("volume", "vol (m)", 1)], rows[:60])


# ── Macro cross-sections ─────────────────────────────────────────────────────
def wbx(ind="FP.CPI.TOTL.ZG"):
    d = get_json(f"https://api.worldbank.org/v2/country/all/indicator/{ind}?format=json&per_page=400&mrnev=1")
    rows = [{"country": r["country"]["value"], "iso": r.get("countryiso3code"), "value": r["value"], "year": r["date"],
             "_series": f"wb:{r.get('countryiso3code')}/{ind}"}
            for r in (d[1] or []) if r.get("value") is not None and r.get("countryiso3code")]
    rows.sort(key=lambda r: -r["value"])
    name = d[1][0]["indicator"]["value"] if d[1] else ind
    return T([("country", name[:40], 0), ("value", "value", 1), ("year", "year", 0)], rows)


def ukgrid(_=""):
    g = get_json("https://api.carbonintensity.org.uk/generation")["data"]
    i = get_json("https://api.carbonintensity.org.uk/intensity")["data"][0]["intensity"]
    rows = [{"fuel": x["fuel"], "pct": x["perc"]} for x in g.get("generationmix", [])]
    rows.sort(key=lambda r: -r["pct"])
    rows.append({"fuel": f"carbon intensity ({i.get('index', '')})", "pct": i.get("actual") or i.get("forecast")})
    return T([("fuel", "GB generation", 0), ("pct", "% / gCO₂", 1)], rows)


# ── Hazards, health, cyber, transport ────────────────────────────────────────
def quakes(_=""):
    d = get_json("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson")
    rows = [{"when": dt.datetime.fromtimestamp(f["properties"]["time"] / 1000, dt.timezone.utc).strftime("%m-%d %H:%M"),
             "mag": f["properties"]["mag"], "place": f["properties"]["place"], "_url": f["properties"]["url"]}
            for f in d["features"]]
    return T([("when", "UTC", 0), ("mag", "M", 1), ("place", "place", 0)], rows)


def eonet(_=""):
    d = get_json("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=80")
    rows = [{"date": (e["geometry"][-1]["date"] if e.get("geometry") else "")[:10], "category":
             ", ".join(c["title"] for c in e.get("categories", [])), "title": e["title"],
             "_url": (e.get("sources") or [{}])[0].get("url")} for e in d["events"]]
    rows.sort(key=lambda r: r["date"], reverse=True)
    return T([("date", "date", 0), ("category", "type", 0), ("title", "event", 0)], rows)


def nhc(_=""):
    d = get_json("https://www.nhc.noaa.gov/CurrentStorms.json")
    rows = [{"name": s.get("name"), "class": s.get("classification"), "wind_kt": s.get("intensity"),
             "pressure": s.get("pressure"), "move": f"{s.get('movementDir', '')}° {s.get('movementSpeed', '')}kt",
             "_url": s.get("publicAdvisory", {}).get("url") if isinstance(s.get("publicAdvisory"), dict) else None}
            for s in d.get("activeStorms", [])]
    return T([("name", "storm", 0), ("class", "class", 0), ("wind_kt", "wind kt", 1), ("pressure", "mb", 1),
              ("move", "movement", 0)], rows)


def nws(_=""):
    d = get_json("https://api.weather.gov/alerts/active?status=actual&message_type=alert",
                 headers={"Accept": "application/geo+json"})
    sev = {"Extreme": 0, "Severe": 1}
    rows = [{"sev": p["severity"], "event": p["event"], "area": (p.get("areaDesc") or "")[:90],
             "sent": (p.get("sent") or "")[:16].replace("T", " ")}
            for p in (f["properties"] for f in d["features"]) if p.get("severity") in sev]
    rows.sort(key=lambda r: (sev[r["sev"]], r["sent"]), reverse=False)
    return T([("sev", "severity", 0), ("event", "event", 0), ("area", "area", 0), ("sent", "sent", 0)], rows[:120])


def volcano(_=""):
    d = get_json("https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes")
    rows = [{"name": v.get("volcano_name"), "level": v.get("alert_level"), "color": v.get("color_code"),
             "obs": v.get("obs_abbr"), "sent": (v.get("sent_utc") or "")[:16]} for v in d]
    return T([("name", "volcano", 0), ("level", "alert", 0), ("color", "aviation", 0), ("obs", "obs", 0),
              ("sent", "sent", 0)], rows)


def tsunami(_=""):
    rows = []
    for u in ("https://www.tsunami.gov/events/xml/PAAQAtom.xml", "https://www.tsunami.gov/events/xml/PHEBAtom.xml"):
        root = ET.fromstring(get(u))
        for e in root.iter():
            if e.tag.endswith("entry"):
                g = lambda n: next((c for c in e if c.tag.endswith(n)), None)
                rows.append({"when": (g("updated").text or "")[:16], "title": strip(g("title").text)})
    return T([("when", "updated", 0), ("title", "message", 0)], rows)


def kev(_=""):
    d = get_json("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json")
    v = sorted(d["vulnerabilities"], key=lambda x: x["dateAdded"], reverse=True)[:80]
    return T([("date", "added", 0), ("cve", "CVE", 0), ("vendor", "vendor", 0), ("product", "product", 0)],
             [{"date": x["dateAdded"], "cve": x["cveID"], "vendor": x["vendorProject"], "product": x["product"],
               "_url": f"https://nvd.nist.gov/vuln/detail/{x['cveID']}"} for x in v])


def who(_=""):
    d = get_json("https://www.who.int/api/news/diseaseoutbreaknews?sf_culture=en&%24orderby=PublicationDateAndTime%20desc"
                 "&%24top=50&%24select=Title,PublicationDateAndTime,ItemDefaultUrl", headers={"User-Agent": CHROME})
    return T([("date", "date", 0), ("title", "outbreak", 0)],
             [{"date": (x.get("PublicationDateAndTime") or "")[:10], "title": x.get("Title"),
               "_url": "https://www.who.int/emergencies/disease-outbreak-news" + (x.get("ItemDefaultUrl") or "")}
              for x in d.get("value", [])])


def wastewater(_=""):
    rows = get_json("https://data.cdc.gov/resource/2ew6-ywp6.json?$select=wwtp_jurisdiction,date_end,percentile,ptc_15d"
                    "&$order=date_end%20DESC&$limit=4000")
    cut = max(r["date_end"] for r in rows if r.get("date_end"))[:10]
    cutoff = (dt.date.fromisoformat(cut) - dt.timedelta(days=14)).isoformat()
    g: dict[str, list] = {}
    for r in rows:
        if r.get("date_end", "")[:10] >= cutoff and r.get("percentile") not in (None, "999"):
            try:
                p = float(r["percentile"])
            except ValueError:
                continue
            if 0 <= p <= 100:
                g.setdefault(r["wwtp_jurisdiction"], []).append(p)
    out = [{"state": k, "pctile": sum(v) / len(v), "sites": len(v)} for k, v in g.items() if len(v) >= 2]
    out.sort(key=lambda r: -r["pctile"])
    return T([("state", "jurisdiction", 0), ("pctile", "COVID wastewater pctile", 1), ("sites", "sites", 1)], out)


def faa(_=""):
    x = get_text("https://nasstatus.faa.gov/api/airport-status-information")
    rows = []
    for kind, tag in (("ground stop", "Ground_Stop"), ("ground delay", "Ground_Delay"), ("closure", "Airport_Closure"),
                      ("delays", "Delay_type")):
        for m in re.finditer(rf"<{tag}>[\s\S]*?<ARPT>(\w+)</ARPT>[\s\S]*?<Reason>([\s\S]*?)</Reason>", x):
            if not any(r["airport"] == m[1] for r in rows):
                rows.append({"airport": m[1], "type": kind, "reason": strip(m[2])[:120]})
    return T([("airport", "airport", 0), ("type", "status", 0), ("reason", "reason", 0)], rows)


# ── Geopolitics ──────────────────────────────────────────────────────────────
def gdelt_events(_=""):
    """Last hour of GDELT 2.0 events: count and mean Goldstein of material-conflict events by country."""
    lu = get_text("http://data.gdeltproject.org/gdeltv2/lastupdate.txt")
    stamp = re.search(r"(\d{14})\.export\.CSV\.zip", lu)[1]
    base = dt.datetime.strptime(stamp, "%Y%m%d%H%M%S")
    agg: dict[str, list] = {}
    for k in range(4):
        t = base - dt.timedelta(minutes=15 * k)
        try:
            z = zipfile.ZipFile(io.BytesIO(get(f"http://data.gdeltproject.org/gdeltv2/{t:%Y%m%d%H%M%S}.export.CSV.zip")))
        except FetchError:
            continue
        for line in z.read(z.namelist()[0]).decode("utf-8", "replace").splitlines():
            p = line.split("\t")
            if len(p) < 58 or not p[53]:
                continue
            a = agg.setdefault(p[53], [0, 0, 0.0])
            a[0] += 1
            if p[29] == "4":
                a[1] += 1
                a[2] += float(p[30] or 0)
    rows = [{"fips": c, "events": a[0], "conflict": a[1], "share": 100 * a[1] / a[0],
             "goldstein": a[2] / a[1] if a[1] else None} for c, a in agg.items() if a[0] >= 20]
    rows.sort(key=lambda r: -r["conflict"])
    return T([("fips", "country (FIPS)", 0), ("events", "events 1h", 1), ("conflict", "material conflict", 1),
              ("share", "conflict %", 1), ("goldstein", "mean Goldstein", 1)], rows[:40])


def unhcr(_=""):
    for y in range(dt.date.today().year - 1, dt.date.today().year - 4, -1):
        d = get_json(f"https://api.unhcr.org/population/v1/population/?yearFrom={y}&yearTo={y}&coo_all=true&limit=1000",
                     headers={"User-Agent": CHROME})
        if d.get("items"):
            break
    n = lambda v: int(v) if str(v).isdigit() else 0
    rows = [{"country": i["coo_name"], "refugees": n(i.get("refugees")) / 1e6, "idps": n(i.get("idps")) / 1e6,
             "asylum": n(i.get("asylum_seekers")) / 1e6, "year": y} for i in d.get("items", [])]
    for r in rows:
        r["total"] = r["refugees"] + r["idps"] + r["asylum"]
    rows.sort(key=lambda r: -r["total"])
    return T([("country", "origin", 0), ("total", "displaced (m)", 1), ("refugees", "refugees", 1), ("idps", "IDPs", 1),
              ("year", "year", 0)], rows[:60])


def ooni(_=""):
    since = (dt.date.today() - dt.timedelta(days=14)).isoformat()
    d = get_json(f"https://api.ooni.org/api/v1/aggregation?since={since}&axis_x=probe_cc&anomaly=true")
    rows = [{"cc": r["probe_cc"], "anomalies": r.get("anomaly_count", 0)} for r in d.get("result", [])]
    rows.sort(key=lambda r: -r["anomalies"])
    return T([("cc", "country", 0), ("anomalies", "network anomalies 14d", 1)], rows[:50])


def ioda(_=""):
    until = int(time.time())
    d = get_json(f"https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary?entityType=country&from={until - 86400}"
                 f"&until={until}&limit=30")
    rows = [{"country": r["entity"]["name"], "score": round(r.get("scores", {}).get("overall", 0)),
             "events": r.get("event_cnt", 0)} for r in d.get("data", [])]
    return T([("country", "country", 0), ("score", "outage score 24h", 1), ("events", "events", 1)], rows)


def frontline(_=""):
    d = get_json("https://deepstatemap.live/api/history/last", headers={"User-Agent": CHROME})
    feats = (d.get("map") or {}).get("features", [])
    kinds: dict[str, int] = {}
    for f in feats:
        k = (f.get("properties") or {}).get("name", "")[:60] or f.get("geometry", {}).get("type", "?")
        kinds[k] = kinds.get(k, 0) + 1
    when = d.get("datetime") or d.get("createdAt") or ""
    rows = [{"layer": k, "n": v, "updated": str(when)[:16]} for k, v in sorted(kinds.items(), key=lambda x: -x[1])]
    return T([("layer", "DeepState layer", 0), ("n", "features", 1), ("updated", "map time", 0)], rows[:40])


# ── Attention ────────────────────────────────────────────────────────────────
def hn(_=""):
    d = get_json("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30")
    return T([("points", "pts", 1), ("title", "story", 0)],
             [{"points": h.get("points"), "title": h.get("title"),
               "_url": h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}"} for h in d["hits"]])


def wikitop(_=""):
    y = dt.date.today() - dt.timedelta(days=1)
    d = get_json(f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/{y:%Y/%m/%d}")
    skip = re.compile(r"^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:)")
    arts = [a for a in d["items"][0]["articles"] if not skip.match(a["article"])][:50]
    return T([("rank", "#", 1), ("article", "article", 0), ("views", "views", 1)],
             [{"rank": a["rank"], "article": a["article"].replace("_", " "), "views": a["views"],
               "_series": f"wiki:{a['article']}", "_url": f"https://en.wikipedia.org/wiki/{a['article']}"} for a in arts])


# ── Misc sensors ─────────────────────────────────────────────────────────────
def safecast(_=""):
    d = get_json("https://api.safecast.org/measurements.json?order=created_at+desc&per_page=100")
    return T([("when", "time", 0), ("value", "value", 1), ("unit", "unit", 0), ("where", "location", 0)],
             [{"when": (m.get("captured_at") or "")[:16], "value": m.get("value"), "unit": m.get("unit"),
               "where": m.get("location_name") or f"{m.get('latitude', 0):.2f},{m.get('longitude', 0):.2f}"} for m in d])


def sondes(_=""):
    d = get_json("https://api.v2.sondehub.org/sondes/telemetry?duration=1h")
    rows = []
    for serial, frames in d.items():
        last = frames[sorted(frames)[-1]]
        rows.append({"serial": serial, "type": last.get("type"), "alt": last.get("alt"),
                     "where": f"{last.get('lat', 0):.2f},{last.get('lon', 0):.2f}"})
    rows.sort(key=lambda r: -(r["alt"] or 0))
    return T([("serial", "radiosonde", 0), ("type", "type", 0), ("alt", "alt m", 1), ("where", "lat,lon", 0)], rows[:100])


ADAPTERS = {
    "kalshi": kalshi, "polymarket": polymarket, "manifold": manifold, "calendar": calendar, "rss": rss,
    "edgar": edgar, "ofac": ofac, "usaspending": usaspending, "grants": grants, "cot": cot, "finra_top": finra_top,
    "wbx": wbx, "ukgrid": ukgrid, "quakes": quakes, "eonet": eonet, "nhc": nhc, "nws": nws, "volcano": volcano,
    "tsunami": tsunami, "kev": kev, "who": who, "wastewater": wastewater, "faa": faa, "gdelt_events": gdelt_events,
    "unhcr": unhcr, "ooni": ooni, "ioda": ioda, "frontline": frontline, "hn": hn, "wikitop": wikitop,
    "safecast": safecast, "sondes": sondes,
}
TTLS = {"calendar": 1800, "cot": 6 * 3600, "wbx": 86400, "unhcr": 86400, "finra_top": 6 * 3600, "kalshi": 120,
        "polymarket": 120, "manifold": 300, "gdelt_events": 900, "usaspending": 3600, "grants": 3600, "ofac": 3600,
        "edgar": 300, "faa": 300}


def fetch(tid: str):
    from .net import cached
    name, _, arg = tid.partition(":")
    fn = ADAPTERS.get(name)
    if fn is None:
        raise FetchError(f"unknown table '{name}'")
    payload, meta = cached("t:" + tid, TTLS.get(name, TTL), lambda: fn(arg) if arg else fn())
    return {**payload, **meta, "id": tid}
