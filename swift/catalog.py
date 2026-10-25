"""swift · @negvol — feed catalogue served to the UI picker, plus the Treasury curve snapshot.

Series ids are open-ended (any fred:XXX / yahoo:XXX / dbn:... works); the presets
here are just what the picker lists. Ids starting with "=" are expressions over
other series, evaluated in the browser: [id] references, + - * / ( ), numbers.
"""
from __future__ import annotations

import csv
import datetime as dt
import io

from .net import cached, get_text

S = []


def g(group, *items):
    for sid, name in items:
        S.append({"id": sid, "name": name, "group": group})


g("Rates",
  ("fred:DGS3MO", "UST 3M"), ("fred:DGS2", "UST 2Y"), ("fred:DGS5", "UST 5Y"), ("fred:DGS10", "UST 10Y"),
  ("fred:DGS30", "UST 30Y"), ("fred:T10Y2Y", "2s10s spread"), ("fred:T10Y3M", "3m10y spread"),
  ("fred:DFII10", "10Y real yield (TIPS)"), ("fred:T5YIE", "5Y breakeven"), ("fred:T10YIE", "10Y breakeven"),
  ("fred:T5YIFR", "5y5y forward inflation"), ("fred:DFF", "Fed funds effective"), ("nyfed:sofr", "SOFR (NY Fed)"),
  ("nyfed:effr", "EFFR (NY Fed)"), ("nyfed:tgcr", "TGCR"), ("fred:MORTGAGE30US", "30Y mortgage rate"),
  ("yahoo:ZQ=F", "30-day fed funds future (front)"), ("=100-[yahoo:ZQ=F]", "Fed funds implied (front ZQ)"),
  ("yahoo:^TNX", "10Y yield (CBOE TNX, live-ish)"), ("yahoo:ZN=F", "10Y T-note future"),
  ("yahoo:ZB=F", "T-bond future"), ("yahoo:ZT=F", "2Y T-note future"),
  ("ecb:FM/D.U2.EUR.4F.KR.DFR.LEV", "ECB deposit rate"),
  ("ecb:YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", "Euro area AAA 10Y yield"),
  ("ecb:YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y", "Euro area AAA 2Y yield"),
  ("=[fred:DGS10]-[ecb:YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y]", "US–EA 10Y spread"))
g("Liquidity",
  ("fred:WALCL", "Fed balance sheet ($m)"), ("tga:", "Treasury General Account (daily, $bn)"),
  ("fred:WTREGEN", "TGA weekly ($m)"), ("fred:RRPONTSYD", "ON RRP ($bn)"), ("nyfed:rrp", "ON RRP accepted (NY Fed, $bn)"),
  ("fred:WRESBAL", "Bank reserves ($m)"), ("fred:M2SL", "M2 ($bn)"),
  ("=[fred:WALCL]/1e6-[fred:WTREGEN]/1e6-[fred:RRPONTSYD]/1e3", "Net liquidity ($tn) = Fed BS − TGA − RRP"))
g("Credit & conditions",
  ("fred:BAMLH0A0HYM2", "HY OAS"), ("fred:BAMLC0A0CM", "IG OAS"), ("=[fred:BAMLH0A0HYM2]-[fred:BAMLC0A0CM]", "HY − IG"),
  ("fred:NFCI", "Chicago Fed NFCI"), ("fred:ANFCI", "Adjusted NFCI"), ("fred:STLFSI4", "St Louis financial stress"),
  ("fred:KCFSI", "KC Fed financial stress"), ("fred:USEPUINDXD", "Economic policy uncertainty (daily)"),
  ("yahoo:HYG", "HYG"), ("yahoo:LQD", "LQD"))
g("Volatility",
  ("cboe:VIX", "VIX"), ("cboe:VIX9D", "VIX9D"), ("cboe:VIX3M", "VIX3M"), ("cboe:VIX6M", "VIX6M"), ("cboe:VVIX", "VVIX"),
  ("cboe:SKEW", "SKEW"), ("=[cboe:VIX]/[cboe:VIX3M]", "VIX / VIX3M (>1 = inverted)"),
  ("=[cboe:VIX9D]/[cboe:VIX]", "VIX9D / VIX"), ("fred:VXNCLS", "VXN (Nasdaq vol)"), ("fred:OVXCLS", "OVX (oil vol)"),
  ("fred:GVZCLS", "GVZ (gold vol)"), ("yahoo:^MOVE", "MOVE (bond vol)"), ("dvol:BTC", "BTC DVOL (Deribit)"),
  ("dvol:ETH", "ETH DVOL (Deribit)"), ("yahooi:^VIX", "VIX 5-min"))
g("Equities",
  ("yahoo:ES=F", "S&P 500 e-mini"), ("yahoo:NQ=F", "Nasdaq-100 e-mini"), ("yahoo:YM=F", "Dow e-mini"),
  ("yahoo:RTY=F", "Russell 2000 e-mini"), ("yahoo:^GSPC", "S&P 500 index"), ("yahoo:^STOXX50E", "Euro Stoxx 50"),
  ("yahoo:^GDAXI", "DAX"), ("yahoo:^FTSE", "FTSE 100"), ("yahoo:^N225", "Nikkei 225"), ("yahoo:^HSI", "Hang Seng"),
  ("yahoo:000001.SS", "Shanghai composite"), ("yahoo:RSP", "S&P equal weight (RSP)"), ("=[yahoo:RSP]/[yahoo:SPY]", "Breadth: RSP/SPY"),
  ("=[yahoo:IWM]/[yahoo:SPY]", "Small/large: IWM/SPY"), ("=[yahoo:XLY]/[yahoo:XLP]", "Cyclicals/defensives XLY/XLP"),
  ("yahooi:ES=F", "ES 5-min"), ("yahooi:NQ=F", "NQ 5-min"))
g("FX",
  ("yahoo:DX-Y.NYB", "Dollar index (DXY)"), ("fred:DTWEXBGS", "Broad trade-weighted USD"),
  ("yahoo:EURUSD=X", "EURUSD"), ("yahoo:USDJPY=X", "USDJPY"), ("yahoo:GBPUSD=X", "GBPUSD"), ("yahoo:AUDUSD=X", "AUDUSD"),
  ("yahoo:CNY=X", "USDCNY"), ("yahoo:USDMXN=X", "USDMXN"), ("yahoo:EURGBP=X", "EURGBP"), ("yahoo:USDCHF=X", "USDCHF"),
  ("ecb:EXR/D.USD.EUR.SP00.A", "EURUSD ECB reference"))
g("Commodities",
  ("yahoo:CL=F", "WTI crude"), ("yahoo:BZ=F", "Brent"), ("yahoo:NG=F", "Henry Hub gas"), ("yahoo:RB=F", "RBOB gasoline"),
  ("yahoo:HO=F", "Heating oil"), ("yahoo:GC=F", "Gold"), ("yahoo:SI=F", "Silver"), ("yahoo:HG=F", "Copper"),
  ("yahoo:PL=F", "Platinum"), ("yahoo:ZW=F", "Wheat"), ("yahoo:ZC=F", "Corn"), ("yahoo:ZS=F", "Soybeans"),
  ("=[yahoo:HG=F]/[yahoo:GC=F]*1000", "Copper / gold ×1000"), ("=[yahoo:BZ=F]-[yahoo:CL=F]", "Brent − WTI"),
  ("fred:PCOPPUSDM", "Copper (IMF monthly)"), ("oni:", "ENSO ONI"), ("drought:D1", "US drought ≥D1 % area"))
g("Crypto",
  ("binance:BTCUSDT", "BTC (Binance)"), ("binance:ETHUSDT", "ETH (Binance)"), ("binance:SOLUSDT", "SOL (Binance)"),
  ("yahoo:BTC-USD", "BTC (Yahoo)"), ("yahoo:IBIT", "IBIT ETF"))
g("Growth",
  ("fred:GDPNOW", "Atlanta Fed GDPNow"), ("fred:WEI", "Weekly economic index"), ("fred:ICSA", "Initial claims"),
  ("fred:CCSA", "Continuing claims"), ("fred:PAYEMS", "Nonfarm payrolls (level)"), ("fred:UNRATE", "Unemployment rate"),
  ("fred:SAHMREALTIME", "Sahm rule (real-time)"), ("fred:JTSJOL", "JOLTS openings"), ("fred:INDPRO", "Industrial production"),
  ("fred:RSAFS", "Retail sales"), ("fred:UMCSENT", "UMich sentiment"), ("fred:CFNAI", "Chicago Fed activity index"),
  ("fred:USREC", "NBER recession flag"))
g("Inflation",
  ("fred:CPIAUCSL", "CPI (index)"), ("fred:CPILFESL", "Core CPI (index)"), ("fred:PCEPILFE", "Core PCE (index)"),
  ("dbn:Eurostat/prc_hicp_manr/M.RCH_A.CP00.EA", "Euro area HICP y/y"),
  ("dbn:Eurostat/prc_hicp_manr/M.RCH_A.TOT_X_NRG_FOOD.EA", "Euro area core HICP y/y"))
g("Positioning",
  ("cftc:13874A:lev", "COT S&P e-mini · leveraged funds"), ("cftc:13874A:am", "COT S&P e-mini · asset managers"),
  ("cftc:209742:lev", "COT Nasdaq e-mini · leveraged funds"), ("cftc:043602:lev", "COT 10Y note · leveraged funds"),
  ("cftc:043602:am", "COT 10Y note · asset managers"), ("cftc:042601:lev", "COT 2Y note · leveraged funds"),
  ("cftc:1170E1:lev", "COT VIX · leveraged funds"), ("cftc:099741:lev", "COT Euro FX · leveraged funds"),
  ("cftc:097741:lev", "COT yen · leveraged funds"), ("cftc:067651:nc", "COT WTI · non-commercial"),
  ("cftc:088691:nc", "COT gold · non-commercial"), ("cftc:085692:nc", "COT copper · non-commercial"),
  ("cftc:133741:lev", "COT bitcoin · leveraged funds"), ("finra:SPY", "FINRA short vol ratio SPY"),
  ("finra:QQQ", "FINRA short vol ratio QQQ"))
g("Options history (logged daily from first view)",
  *[(f"opt:{sym}:{f}", f"{sym} options · {lab}") for sym in ("SPX", "SPY", "QQQ", "BTC") for f, lab in
    (("gex", "net GEX $bn/1%"), ("flipDist", "% from gamma flip"), ("iv30", "ATM IV30"), ("skew25", "25Δ skew"),
     ("termSlope", "IV90−IV30"), ("pcOI", "put/call OI"), ("biasVol", "vol pressure score"), ("biasDir", "direction lean score"))])
g("Global macro",
  ("wb:USA/NY.GDP.MKTP.KD.ZG", "US real GDP growth (WB)"), ("wb:CHN/NY.GDP.MKTP.KD.ZG", "China real GDP growth (WB)"),
  ("wb:DEU/FP.CPI.TOTL.ZG", "Germany CPI (WB)"), ("dbn:OECD/DSD_STES@DF_CLI/USA.M.LI...AA...H", "OECD CLI USA"),
  ("dbn:IMF/WEO:latest/USA.NGDP_RPCH.pcent_change", "IMF WEO US GDP"))
g("Attention & other",
  ("gdelt:recession", "GDELT news volume: recession"), ("gdelt:tariff", "GDELT: tariff"),
  ("gdelt:\"rate cut\"", "GDELT: rate cut"), ("wiki:Recession", "Wikipedia views: Recession"),
  ("wiki:Inflation", "Wikipedia views: Inflation"), ("kp:", "Geomagnetic Kp"), ("co2:", "Global CO₂"),
  ("giss:", "Global temp anomaly"), ("caiso:Natural Gas", "CAISO gas MW (today)"), ("caiso:Solar", "CAISO solar MW (today)"))

TABLES = [
    ("calendar:thisweek", "Economic calendar · this week", "Calendar & wires"),
    ("rss:fed_press", "Fed press releases", "Calendar & wires"), ("rss:fed_speeches", "Fed speeches", "Calendar & wires"),
    ("rss:ecb", "ECB press", "Calendar & wires"), ("rss:boe", "Bank of England news", "Calendar & wires"),
    ("rss:boj", "Bank of Japan what's new", "Calendar & wires"), ("rss:bis", "BIS central banker speeches", "Calendar & wires"),
    ("edgar:8-K", "SEC EDGAR 8-K stream", "Filings & policy"), ("edgar:4", "SEC Form 4 (insiders)", "Filings & policy"),
    ("ofac", "OFAC recent actions", "Filings & policy"),
    ("usaspending", "Largest federal awards (45d)", "Filings & policy"), ("grants", "Grants.gov opportunities", "Filings & policy"),
    ("kalshi", "Kalshi (ex sports)", "Prediction markets"), ("kalshi:Economics", "Kalshi · economics", "Prediction markets"),
    ("kalshi:Financials", "Kalshi · financials", "Prediction markets"), ("kalshi:Politics", "Kalshi · politics", "Prediction markets"),
    ("polymarket:economy", "Polymarket · economy", "Prediction markets"), ("polymarket:fed", "Polymarket · Fed", "Prediction markets"),
    ("polymarket:finance", "Polymarket · finance", "Prediction markets"), ("polymarket:geopolitics", "Polymarket · geopolitics", "Prediction markets"),
    ("polymarket:politics", "Polymarket · politics", "Prediction markets"), ("polymarket:crypto", "Polymarket · crypto", "Prediction markets"),
    ("manifold", "Manifold", "Prediction markets"),
    ("cot", "CFTC COT snapshot (spec net)", "Positioning"), ("finra_top", "FINRA highest short-volume ratio", "Positioning"),
    ("wbx:FP.CPI.TOTL.ZG", "World Bank CPI by country", "Global macro"),
    ("wbx:NY.GDP.MKTP.KD.ZG", "World Bank GDP growth by country", "Global macro"),
    ("wbx:SL.UEM.TOTL.ZS", "World Bank unemployment by country", "Global macro"),
    ("wbx:SI.POV.DDAY", "World Bank poverty by country", "Global macro"),
    ("ukgrid", "GB power mix", "Energy"),
    ("gdelt_events", "GDELT conflict events (1h)", "Geopolitics"), ("unhcr", "UNHCR displacement", "Geopolitics"),
    ("ooni", "OONI censorship", "Geopolitics"), ("ioda", "IODA internet outages", "Geopolitics"),
    ("frontline", "DeepState frontline map", "Geopolitics"),
    ("quakes", "USGS M4.5+ earthquakes (7d)", "Hazards"), ("eonet", "NASA EONET open events", "Hazards"),
    ("nhc", "NHC active storms", "Hazards"), ("nws", "NWS severe alerts", "Hazards"), ("volcano", "USGS elevated volcanoes", "Hazards"),
    ("tsunami", "Tsunami messages", "Hazards"), ("rss:gdacs", "GDACS disaster alerts", "Hazards"),
    ("who", "WHO outbreak news", "Health & cyber"), ("wastewater", "CDC COVID wastewater", "Health & cyber"),
    ("kev", "CISA known exploited vulns", "Health & cyber"), ("faa", "FAA airport status", "Transport"),
    ("hn", "Hacker News front page", "Attention"), ("wikitop", "Wikipedia top articles", "Attention"),
    ("safecast", "Safecast radiation", "Sensors"), ("sondes", "SondeHub radiosondes", "Sensors"),
]
TV = [("Bloomberg TV", "UC_vQ72b7v5n2938v9d5c80w"), ("CNA 24/7", "UC83jt4dlz1Gjl58fzQrrKZg"),
      ("Sky News", "UCoMdktPbSTixAyNGwb-UYkQ"), ("Al Jazeera EN", "UCNye-wNBqNL5ZzHSJj3l8Bg"),
      ("DW News", "UCknLrEdhRCp1aegoMqRaCZg"), ("France 24 EN", "UCQfwfsi5VrQ8yKZ-UWmAEFg"),
      ("Euronews", "UCtUbOIRGKZkW7555n6x6q6g"), ("NHK World", "UCSPEjw8F2nQDtmUKPFNF7_A"),
      ("NBC News NOW", "UCeY0bbntWzzVIaj2z3QigXg"),
      ("CBS News 24/7", "UC8p1vwvWtl6T73JiExfWs1g"), ("ABC News Live", "UCBi2mrWuNuyYy4gbM6fU18Q"),
      ("C-SPAN", "UCb--64Gl51jIEVE-GLDAVTg"), ("CBC News", "UCKy1dAqELon0zgzZPOz9SVw"),
      ("TRT World", "UC7fWeaHZQg1p9-4v98L1D1A"), ("UKRINFORM", "UCaDkCK6iFHPE0lmpaYL-WxQ"),
      ("Al Mayadeen", "UCZCFHCU-2eGF7V5ciMkoPHw"), ("LBCI", "UCpE6gpKewomi17XDyPfpFjA"), ("WION", "UC_gUM8rL-Lrg6O3adPW9K1g"),
      ("Arirang", "UCw9-5Y1CjW7Qy1Yf5q1y2-Q"), ("ABC Australia", "UC5iLnYoF4Ryb63YdGD9RfWQ"),
      ("Africanews", "UC5T2fB_W0Z31T0c8yN36a8A"), ("SABC News", "UC8yH-uI81UUtEMDsowQyx1g"),
      ("teleSUR EN", "UCmuTmpLY35O3csvhyA6vrkg")]


def catalog():
    return {"series": S,
            "tables": [{"id": i, "name": n, "group": gr} for i, n, gr in TABLES],
            "tv": [{"name": n, "channel": c} for n, c in TV]}


TENORS = ["1 Mo", "2 Mo", "3 Mo", "4 Mo", "6 Mo", "1 Yr", "2 Yr", "3 Yr", "5 Yr", "7 Yr", "10 Yr", "20 Yr", "30 Yr"]
YEARS = [1 / 12, 2 / 12, 0.25, 4 / 12, 0.5, 1, 2, 3, 5, 7, 10, 20, 30]


def _year(y):
    url = (f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{y}/all"
           f"?type=daily_treasury_yield_curve&field_tdr_date_value={y}&page&_format=csv")
    rows = list(csv.DictReader(io.StringIO(get_text(url))))
    out = {}
    for r in rows:
        m, d, yy = r["Date"].split("/")
        out[f"{yy}-{m}-{d}"] = [float(r[t]) if r.get(t) not in (None, "") else None for t in TENORS]
    return out


def curve():
    def build():
        y = dt.date.today().year
        data = {**_year(y - 1), **_year(y)}
        dates = sorted(data)
        last = dates[-1]
        pick = lambda days: max(d for d in dates if d <= (dt.date.fromisoformat(last) - dt.timedelta(days=days)).isoformat())
        snaps = [("latest", last), ("1 week", pick(7)), ("1 month", pick(30)), ("3 months", pick(91)), ("1 year", pick(365))]
        return {"tenors": TENORS, "years": YEARS,
                "curves": [{"label": lab, "date": d, "values": data[d]} for lab, d in snaps]}
    payload, meta = cached("curve:ust", 3600, build)
    return {**payload, **meta}
