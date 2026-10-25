// Bias engine: turns several feeds into one number per theme.
//
// component -> transform (time-based: n in calendar days) -> rolling z-score over the
// composite's lookback (calendar days, so daily/weekly/monthly feeds mix) -> clip ±3
// -> × sign × weight. Composite = Σ(w·s·z) / Σ|w| over components with data, mapped to
// −100…+100 by clip(avg_z / 2, ±1). So +100 means components average ≥ 2σ in the "+" direction.
//
// These are DESCRIPTIVE composites of where the inputs sit versus their own recent history.
// None has been tested as a forecast. — swift · @negvol
import { series } from "./api.js";
import { DAY, align, bisect } from "./calc.js";

const NETLIQ = "=[fred:WALCL]/1e6-[fred:WTREGEN]/1e6-[fred:RRPONTSYD]/1e3";
const CUGD = "=[yahoo:HG=F]/[yahoo:GC=F]";
const c = (id, label, tf, n, sign, w = 1) => ({ id, label, tf, n, sign, w });

export const DEFAULT_COMPOSITES = [
  { key: "vol", name: "Volatility regime", plus: "stress / vol expanding", minus: "calm / vol compressing", lookback: 1095, comps: [
    c("cboe:VIX", "VIX level", "level", 0, 1, 1),
    c("=[cboe:VIX]/[cboe:VIX3M]", "VIX/VIX3M term structure", "level", 0, 1, 1),
    c("cboe:VVIX", "VVIX level", "level", 0, 1, 0.5),
    c("yahoo:ES=F", "ES realised vol 20d", "rv", 30, 1, 1),
    c("yahoo:^MOVE", "MOVE (bond vol)", "level", 0, 1, 0.75),
    c("fred:BAMLH0A0HYM2", "HY OAS 1m change", "chg", 30, 1, 0.75),
    c("fred:STLFSI4", "St Louis stress index", "level", 0, 1, 0.5),
    c("cboe:SKEW", "SKEW", "level", 0, 1, 0.25),
  ] },
  { key: "equity", name: "US equity direction", plus: "risk-on / bullish", minus: "risk-off / bearish", lookback: 1095, comps: [
    c("yahoo:ES=F", "ES vs 50d avg", "dev", 70, 1, 1),
    c("yahoo:ES=F", "ES vs 200d avg", "dev", 290, 1, 1),
    c("fred:BAMLH0A0HYM2", "HY OAS 1m change", "chg", 30, -1, 1),
    c("=[cboe:VIX]/[cboe:VIX3M]", "VIX term inversion", "level", 0, -1, 0.75),
    c("=[yahoo:RSP]/[yahoo:SPY]", "Breadth RSP/SPY vs 50d", "dev", 70, 1, 0.5),
    c(CUGD, "Copper/gold vs 50d", "dev", 70, 1, 0.5),
    c("yahoo:DX-Y.NYB", "DXY 1m % change", "pct", 30, -1, 0.5),
    c(NETLIQ, "Net liquidity 1m % change", "pct", 30, 1, 0.75),
    c("fred:DFII10", "10Y real yield 1m change", "chg", 30, -1, 0.5),
  ] },
  { key: "rates", name: "US yields direction", plus: "yields rising", minus: "yields falling", lookback: 1095, comps: [
    c("fred:DGS10", "10Y 1m change", "chg", 30, 1, 1),
    c("fred:DGS2", "2Y 1m change", "chg", 30, 1, 1),
    c("fred:T10YIE", "10Y breakeven 1m change", "chg", 30, 1, 0.75),
    c("=100-[yahoo:ZQ=F]", "Front fed funds implied 1m change", "chg", 30, 1, 0.75),
    c("yahoo:CL=F", "WTI 1m % change", "pct", 30, 1, 0.5),
    c("fred:WEI", "Weekly economic index", "level", 0, 1, 0.5),
    c("fred:ICSA", "Initial claims 1m % change", "pct", 30, -1, 0.5),
  ] },
  { key: "usd", name: "US dollar", plus: "USD strengthening", minus: "USD weakening", lookback: 1095, comps: [
    c("yahoo:DX-Y.NYB", "DXY vs 50d avg", "dev", 70, 1, 1),
    c("=[fred:DGS2]-[ecb:YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y]", "US–EA 2Y spread 1m change", "chg", 30, 1, 1),
    c("yahoo:USDJPY=X", "USDJPY vs 50d avg", "dev", 70, 1, 0.5),
    c("cboe:VIX", "VIX level (haven bid)", "level", 0, 1, 0.25),
    c(CUGD, "Copper/gold vs 50d", "dev", 70, -1, 0.25),
  ] },
  { key: "growth", name: "US growth momentum", plus: "accelerating", minus: "slowing", lookback: 1825, comps: [
    c("fred:WEI", "Weekly economic index", "level", 0, 1, 1),
    c("fred:ICSA", "Initial claims 3m % change", "pct", 90, -1, 1),
    c("fred:SAHMREALTIME", "Sahm rule", "level", 0, -1, 0.75),
    c(CUGD, "Copper/gold vs 100d", "dev", 140, 1, 0.5),
    c("fred:CFNAI", "Chicago Fed activity", "level", 0, 1, 0.5),
    c("fred:T10Y3M", "3m10y 3m change", "chg", 90, 1, 0.25),
    c("fred:UMCSENT", "UMich sentiment 3m change", "chg", 90, 1, 0.25),
  ] },
  { key: "inflation", name: "Inflation pressure", plus: "rising", minus: "easing", lookback: 1825, comps: [
    c("fred:T5YIE", "5Y breakeven 3m change", "chg", 90, 1, 1),
    c("fred:T5YIFR", "5y5y forward 3m change", "chg", 90, 1, 0.5),
    c("yahoo:CL=F", "WTI 3m % change", "pct", 90, 1, 0.75),
    c("fred:CPILFESL", "Core CPI y/y", "yoy", 365, 1, 0.75),
    c("yahoo:HG=F", "Copper 3m % change", "pct", 90, 1, 0.25),
    c("yahoo:ZW=F", "Wheat 3m % change", "pct", 90, 1, 0.25),
  ] },
  { key: "liquidity", name: "Liquidity & conditions", plus: "easing", minus: "tightening", lookback: 1095, comps: [
    c(NETLIQ, "Net liquidity 3m % change", "pct", 90, 1, 1),
    c("fred:NFCI", "Chicago Fed NFCI", "level", 0, -1, 1),
    c("fred:BAMLH0A0HYM2", "HY OAS level", "level", 0, -1, 0.5),
    c("fred:WRESBAL", "Reserves 3m % change", "pct", 90, 1, 0.5),
    c("yahoo:DX-Y.NYB", "DXY 3m % change", "pct", 90, -1, 0.5),
    c("fred:RRPONTSYD", "ON RRP 3m change", "chg", 90, -1, 0.25),
  ] },
  { key: "crypto", name: "Crypto risk appetite", plus: "bullish", minus: "bearish", lookback: 1095, comps: [
    c("binance:BTCUSDT", "BTC vs 50d avg", "dev", 50, 1, 1),
    c("binance:BTCUSDT", "BTC vs 200d avg", "dev", 200, 1, 1),
    c("dvol:BTC", "BTC DVOL", "level", 0, -1, 0.5),
    c("yahoo:ES=F", "ES vs 50d avg", "dev", 70, 1, 0.5),
    c("yahoo:DX-Y.NYB", "DXY 1m % change", "pct", 30, -1, 0.25),
  ] },
];

export const BIAS_TF = { level: "level", chg: "change over n days", pct: "% change over n days",
  dev: "% from n-day average", rv: "realised vol over n days", yoy: "% y/y" };

// time-based transforms (n in calendar days)
function tfm(pts, tf, n) {
  const out = [];
  if (tf === "level") return pts;
  if (tf === "chg" || tf === "pct" || tf === "yoy") {
    const days = tf === "yoy" ? 365 : n;
    for (const p of pts) {
      if (p[0] - pts[0][0] < days * DAY) continue;
      const i = bisect(pts, p[0] - days * DAY);
      if (i < 0) continue;
      const b = pts[i][1];
      out.push([p[0], tf === "chg" ? p[1] - b : b ? 100 * (p[1] / b - 1) : null]);
    }
    return out.filter((p) => p[1] != null);
  }
  if (tf === "dev") {
    let s = 0, j = 0;
    for (let i = 0; i < pts.length; i++) {
      s += pts[i][1];
      while (pts[j][0] <= pts[i][0] - n * DAY) { s -= pts[j][1]; j++; }
      if (pts[i][0] - pts[0][0] >= n * DAY) out.push([pts[i][0], 100 * (pts[i][1] / (s / (i - j + 1)) - 1)]);
    }
    return out;
  }
  if (tf === "rv") {
    const r = [];
    for (let i = 1; i < pts.length; i++) if (pts[i - 1][1] > 0 && pts[i][1] > 0) r.push([pts[i][0], Math.log(pts[i][1] / pts[i - 1][1])]);
    let s = 0, q = 0, j = 0;
    for (let i = 0; i < r.length; i++) {
      s += r[i][1]; q += r[i][1] ** 2;
      while (r[j][0] <= r[i][0] - n * DAY) { s -= r[j][1]; q -= r[j][1] ** 2; j++; }
      const k = i - j + 1;
      if (k >= 10) { const m = s / k; out.push([r[i][0], 100 * Math.sqrt(Math.max(q / k - m * m, 0) * 252)]); }
    }
    return out;
  }
  return pts;
}

// rolling z over a calendar-day window, needs >= 30 obs
function zTime(pts, days) {
  const out = [];
  let s = 0, q = 0, j = 0;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i][1]; s += v; q += v * v;
    while (pts[j][0] <= pts[i][0] - days * DAY) { s -= pts[j][1]; q -= pts[j][1] ** 2; j++; }
    const k = i - j + 1;
    if (k >= 30) {
      const m = s / k, sd = Math.sqrt(Math.max(q / k - m * m, 0));
      if (sd > 0) out.push([pts[i][0], Math.max(-3, Math.min(3, (v - m) / sd))]);
    }
  }
  return out;
}

export async function compute(comp) {
  const L = comp.lookback || 1095;
  const parts = await Promise.all(comp.comps.map(async (cp) => {
    try {
      const d = await series(cp.id);
      if (!d.points.length) return { ...cp, error: d.error || "no data", z: [] };
      const t = tfm(d.points, cp.tf, cp.n || 30);
      const z = zTime(t, L);
      return { ...cp, z, raw: t.at(-1), asof: d.points.at(-1)[0], src: d.points.at(-1)[1], error: d.error && !d.points.length ? d.error : undefined };
    } catch (e) {
      return { ...cp, error: e.message, z: [] };
    }
  }));
  const ok = parts.filter((p) => p.z.length);
  const totalW = comp.comps.reduce((a, p) => a + Math.abs(p.w), 0);
  let history = [];
  if (ok.length) {
    const t0 = Math.max(...ok.map((p) => p.z[0][0]));
    const { grid, cols } = align(ok.map((p) => p.z));
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] < t0) continue;
      let num = 0, den = 0;
      ok.forEach((p, k) => { const v = cols[k][i]; if (v != null) { num += p.w * p.sign * v; den += Math.abs(p.w); } });
      if (den >= totalW * 0.5) history.push([grid[i], Math.max(-100, Math.min(100, (num / den / 2) * 100))]);
    }
  }
  const items = parts.map((p) => {
    const z = p.z.length ? p.z.at(-1)[1] : null;
    return { label: p.label, id: p.id, tf: p.tf, n: p.n, w: p.w, sign: p.sign, z, contrib: z == null ? null : (p.sign * p.w * z) / totalW,
             asof: p.asof, raw: p.raw ? p.raw[1] : null, src: p.src, error: p.error };
  });
  const score = history.length ? history.at(-1)[1] : null;
  const live = items.filter((i) => i.z != null);
  const agree = score == null || !live.length ? null
    : (100 * live.filter((i) => Math.sign(i.sign * i.z) === Math.sign(score)).length) / live.length;
  return { score, history, items, agree, coverage: live.length / items.length };
}

export const word = (s) => s == null ? "n/a" : Math.abs(s) < 20 ? "neutral" : Math.abs(s) < 50 ? "moderate" : "strong";
