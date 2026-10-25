# Swift

**A free-feed macro terminal that runs on your own machine.** Rates, liquidity, vol, credit, FX,
commodities, positioning, options dealer exposure, prediction markets, central-bank wires and
more, all in configurable chart panels with a built-in bias engine.

by **@negvol**

> Not investment advice. Most data is delayed, all of it is free, and none of the scores have been
> tested as forecasts.

---

## Quick start

```bash
git clone https://github.com/<you>/swift.git
cd swift
python start.py
```

You only need **Python 3.9+**. There are no packages to install.

On first run `start.py` asks for your **FRED API key**, checks it with FRED, saves it to a local
`.env` file (git-ignored), starts the server and opens your browser. The terminal prints the address:

```
  Swift is running  ->  http://127.0.0.1:8777/
```

Options:

```bash
python start.py --port 9000     # choose the port (default: first free one from 8777)
python start.py --reset-key     # enter a different FRED key
python start.py --no-browser    # don't open a tab
python tools/check_feeds.py     # fetch every feed once and report what works
```

## API keys

| Key | Needed? | Where to get it |
|---|---|---|
| `FRED_API_KEY` | **yes** | free, instant: https://fred.stlouisfed.org/docs/api/api_key.html |

That's the only one. Every other source is keyless. The key lives in `.env` next to `start.py`:

```
FRED_API_KEY=your32characterkeyhere
```

The server binds to `127.0.0.1` only. The key is used server-side and never sent to the page.

## Hosting (free, with a password)

Swift runs as a website on **Render's free tier**, so it's up while your computer is off.

1. Sign in at https://render.com with GitHub and let Render read this repo.
2. **New → Blueprint**, pick the repo. `render.yaml` sets everything up.
3. When asked, enter `FRED_API_KEY` and a `SWIFT_PASSWORD`.
4. Deploy. Your site is `https://swift-xxxx.onrender.com`. Log in with any username and that password.

Free instances sleep after 15 minutes without visits (the first visit after takes ~1 minute). To keep
it awake, add a free monitor at https://uptimerobot.com pinging `https://<your-site>/healthz` every
5–10 minutes. One always-on free instance fits in Render's monthly free hours.

Hosted mode (on whenever the `PORT` environment variable is set):

- listens on `0.0.0.0`
- takes the key from `FRED_API_KEY` instead of prompting
- puts the whole site behind `SWIFT_PASSWORD` (HTTP basic auth)
- limits each visitor to `SWIFT_RATE` API calls a minute (default 240)
- saves layouts in each visitor's browser rather than on the server

All visitors share one data cache, so more visitors barely adds upstream load. Free-tier disks reset on
redeploy, which also resets the options history. Some sources throttle cloud IPs more than home ones.
Keep the password on: Cboe, Yahoo and ForexFactory don't allow public redistribution.

The `Dockerfile` also runs anywhere else that takes containers (Koyeb, Fly.io, Hugging Face Spaces,
a VPS). Set `PORT`, `FRED_API_KEY` and `SWIFT_PASSWORD` there.

---

## What's in it

**Workspaces** (tabs along the top): Overview · Rates · Volatility · Credit & FX · Growth & Inflation ·
Positioning · Options · Topology · Bias · Global · Wire. `?ws=Rates` in the URL opens one directly.

**Panels** hold tabs. `+` adds a tab, `⚙` edits it, `⤓` saves a PNG and `⛶` goes full screen (Esc exits).
Drag a panel's tab bar to move it and its corner to resize it. Double-click a tab to rename it.
The layout autosaves; *Layout → Export / Import / Reset*.

**Charts** take any number of series. Each series gets its own transform (level, change, % change,
y/y, z-score, percentile, moving average, % from average, realised vol, rebased to 100, first
difference), axis (left/right) and style (line, area, bars, ± bars, step, ± area). Mouse wheel zooms,
drag pans, double-click resets. Press **Ctrl K** to search the feed catalogue.

### Series ids

Anything in the picker, or type your own:

| id | source |
|---|---|
| `fred:DGS10` | any FRED series |
| `yahoo:ES=F` · `yahooi:ES=F` | Yahoo daily close · 5-minute bars (last 5 days) |
| `cboe:VIX` | Cboe index history: VIX, VIX9D, VIX3M, VIX6M, VVIX, SKEW, … |
| `cftc:13874A:lev` | CFTC COT net position, group `nc` `comm` `lev` `am` `dealer` |
| `nyfed:sofr` | NY Fed: `sofr` `effr` `tgcr` `bgcr` `obfr` `rrp` |
| `tga:` | Treasury General Account, daily |
| `ecb:FM/D.U2.EUR.4F.KR.DFR.LEV` | ECB Data Portal (SDMX) |
| `dbn:Eurostat/prc_hicp_manr/M.RCH_A.CP00.EA` | DBnomics: Eurostat, OECD, IMF, BIS, … |
| `wb:DEU/FP.CPI.TOTL.ZG` | World Bank (annual) |
| `binance:BTCUSDT` · `dvol:BTC` | crypto daily · Deribit vol index |
| `finra:SPY` | FINRA daily short-volume ratio |
| `opt:SPX:gex` | options metrics history (see below) |
| `wiki:Recession` · `gdelt:tariff` | Wikipedia page views · GDELT news volume |
| `=[fred:WALCL]/1e6-[fred:WTREGEN]/1e6-[fred:RRPONTSYD]/1e3` | expression: `+ − * / ^ ( )` over any ids |

**List feeds:** economic calendar, Fed / ECB / BoE / BoJ / BIS releases, SEC EDGAR 8-K and Form 4,
OFAC actions, USAspending, Grants.gov, Kalshi and Polymarket by topic, Manifold, COT snapshot, FINRA
top short ratios, World Bank cross-sections, GB power mix, GDELT conflict events, UNHCR, OONI, IODA,
USGS quakes, NASA EONET, NHC, NWS, GDACS, volcanoes, tsunami, WHO, CDC wastewater, CISA KEV, FAA,
Hacker News, Wikipedia top. Also included: 23 live YouTube news channels and a live Binance price stream.

### Options positioning

Built from free chains: **Cboe delayed quotes** (15-min delayed; SPX, NDX, VIX, RUT and any US-listed
stock or ETF) and **Deribit** (BTC, ETH, real time).

- Modes: Summary · GEX by strike · Gamma profile · Open interest · Volume · Smile · Term.
- Dealer exposures: **GEX** (dealer delta change per 1% move), **DEX**, **VEX** (vanna, per vol point),
  **CEX** (charm, per day). Also the gamma flip, call/put walls, max pain, ATM IV 30/90, term slope,
  25Δ skew, put/call ratios and the implied move to the next expiry.
- Greeks are recomputed with Black-Scholes from each contract's IV.
- **Assumption:** dealers are long calls and short puts, the usual public-GEX convention. Nobody
  outside the dealers knows their real books, so read signs and shapes, not exact sizes.
- Two crude scores, *Vol pressure* and *Direction lean*, built from fixed-scale components.
- Each day's metrics are logged locally (`data/options/`), so they build into chartable series such as
  `opt:SPX:gex`, `:flipDist`, `:iv30`, `:skew25`, `:biasVol` and `:biasDir`. There is no free
  history to backfill, so the series starts the day you first open a symbol.

### Topology

A trend × momentum phase space for any series:

- **trend z:** z-score of log(price / 50-day average)
- **momentum z:** z-score of the 20-day log return
- **vol z:** z-score of 20-day realised vol

Each is z-scored over 252 days, and every window can be changed in the panel settings. The plot shows
the two-year path with 1σ/2σ rings and quadrants (bull impulse, bull fading, bear fading, bear impulse).
Status reads NORMAL within 1σ, EXTENDED within 2σ, EXTREME beyond that, and VOL STRESS when vol z > 2.

### Bias engine

Eight default composites: volatility regime, US equity direction, US yields, USD, growth, inflation,
liquidity, crypto. Edit them under *Bias → Edit composites*: add any series or expression and set its
transform, window, sign and weight, or build new composites.

For each input:

1. Transform it over *n* calendar days.
2. Z-score it against the composite's lookback.
3. Clip to ±3, then multiply by sign × weight.

The **score** is Σ(w·s·z) / Σ|w| ÷ 2, clipped to ±100. **Agreement** is the share of inputs pointing
the same way as the score; **coverage** is the share that have data.

These are **descriptive**: they show where each input sits against its own history. They are not
backtested signals.

---

## Notes

- Yahoo throttles requests that don't look like a browser, so Swift sends a Chrome user-agent. Futures
  quotes are delayed (CME ~10 min). The Binance websocket is the only true real-time feed.
- GDELT's news-volume API rate-limits hard. Results are cached for an hour and served stale on error.
- YouTube embeds only play while a channel is live and allows embedding. If one shows "unavailable",
  switch channels.
- Cboe, Yahoo and ForexFactory data is free to read but not to redistribute. Keep Swift local.
- The feed list was partly seeded from [Pythia](https://github.com/jangles-byte/Pythia) (MIT).

## Layout

```
start.py            setup + local server (stdlib only)
swift/net.py        fetching, per-host pacing, memory+disk cache, stale-on-error
swift/series.py     time-series adapters
swift/tables.py     list adapters
swift/options.py    options chains → dealer exposures, vol surface, options bias
swift/catalog.py    picker presets, TV channels, UST curve
web/                the app: vanilla ES modules + canvas, no build step
tools/check_feeds.py
```

---

*swift · @negvol*
