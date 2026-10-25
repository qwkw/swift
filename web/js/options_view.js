// Options positioning view: dealer greeks exposures, gamma profile, walls, vol surface summary and a
// crude options bias. Server does the maths (swift/options.py); this only draws.
import { getJSON } from "./api.js";
import { fmt } from "./calc.js";
import { Chart, css, hbars } from "./chart.js";
import { gauge, h, inp, modal, sel } from "./dom.js";

const MODES = { summary: "Summary", gex: "GEX by strike", profile: "Gamma profile", oi: "Open interest", vol: "Volume",
  smile: "Smile", term: "Term" };
const SYMS = ["SPX", "SPY", "QQQ", "NDX", "IWM", "VIX", "TLT", "GLD", "USO", "SLV", "HYG", "XLF", "NVDA", "AAPL", "TSLA", "BTC", "ETH"];
const bn = (v) => (v == null ? "–" : (v >= 0 ? "+" : "") + fmt(v, Math.abs(v) >= 10 ? 1 : 2) + "bn");
const pct = (v, d = 2) => (v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(d) + "%");

export const optionsView = {
  name: "Options positioning",
  defaults: () => ({ type: "options", title: "", sym: "SPX", mode: "summary", band: 0.15, maxdte: 90 }),
  mount(el, cfg, ctx) {
    const head = h("div.opt-head"), sub = h("div.view-sub"), body = h("div.opt-body");
    el.append(head, sub, body);
    let r = null, chart = null, ro = null;
    const clear = () => { chart?.destroy(); chart = null; ro?.disconnect(); ro = null; body.replaceChildren(); };

    const header = () => {
      const m = r.metrics;
      const cell = (lab, val, cls = "") => h("div.opt-cell", h("span.opt-lab", lab), h("span.opt-val", { class: cls }, val));
      head.replaceChildren(
        h("div.opt-sym", r.sym, h("span.muted.tiny", ` ${fmt(m.spot)}`)),
        cell("net GEX /1%", bn(m.gex), m.gex >= 0 ? "pos" : "neg"),
        cell("gamma flip", m.flip ? `${fmt(m.flip)} (${pct(m.flipDist, 1)})` : "–", m.flipDist >= 0 ? "pos" : "neg"),
        cell("call wall", fmt(m.callWall)), cell("put wall", fmt(m.putWall)), cell("max pain", fmt(m.maxPain)),
        cell("IV30", m.iv30 ? m.iv30.toFixed(1) : "–"), cell("25Δ skew", m.skew25 != null ? m.skew25.toFixed(1) : "–"),
        cell("IV90−30", m.termSlope != null ? (m.termSlope >= 0 ? "+" : "") + m.termSlope.toFixed(1) : "–", m.termSlope < 0 ? "neg" : ""),
        cell("P/C OI", m.pcOI ? m.pcOI.toFixed(2) : "–"),
        cell("impl. move", m.move ? `±${m.move.pct.toFixed(2)}% ${m.move.exp.slice(5)}` : "–"));
      sub.replaceChildren(
        sel(Object.fromEntries([...new Set([...SYMS, cfg.sym])].map((s) => [s, s])), cfg.sym, (v) => { cfg.sym = v; ctx.save(); refresh(); }),
        h("div.chips.small", Object.entries(MODES).map(([k, l]) => h("button.chip" + (k === cfg.mode ? ".on" : ""), { on: { click: () => { cfg.mode = k; ctx.save(); header(); draw(); } } }, l))),
        h("span.grow"), h("span.muted.tiny", `${r.source} · ${String(r.chainTime || "").replace("T", " ").slice(0, 16) || ""}`));
    };

    const vrefs = () => {
      const m = r.metrics;
      return [{ x: m.spot, label: "spot " + fmt(m.spot), color: css("--ink"), dark: true, solid: true },
        { x: m.flip, label: "flip " + fmt(m.flip), color: css("--limit"), dark: true },
        { x: m.callWall, label: "call wall " + fmt(m.callWall), color: css("--up") }, { x: m.putWall, label: "put wall " + fmt(m.putWall), color: css("--down") },
        ...(cfg.mode === "oi" ? [{ x: m.maxPain, label: "max pain", color: css("--ref") }] : [])];
    };
    const plot = (spec) => {
      const host = h("div.chart-host");
      body.append(host);
      chart = new Chart(host);
      chart.set({ xMode: "linear", legend: true, ...spec });
    };

    const draw = () => {
      clear();
      if (!r) return;
      const m = r.metrics, by = r.byStrike;
      const lim = (xs) => [Math.min(...xs), Math.max(...xs)];
      if (cfg.mode === "summary") return summary();
      if (cfg.mode === "gex") {
        const [a, b] = lim(by.map((x) => x.k));
        plot({ series: [{ label: "dealer net GEX $bn / 1%", points: by.map((x) => [x.k, x.netGex / 1e9]), style: "signbars", color: css("--up"), axis: "L", noTag: true }],
          xMin: a, xMax: b, vrefs: vrefs(), zero: true, xFmt: (v) => fmt(v, 0) });
      } else if (cfg.mode === "profile") {
        const [a, b] = lim(r.profile.map((p) => p[0]));
        plot({ series: [{ label: "dealer GEX $bn / 1% if spot were here", points: r.profile, style: "signarea", color: css("--ink"), axis: "L", noTag: true }],
          xMin: a, xMax: b, vrefs: vrefs().slice(0, 2), zero: true, xFmt: (v) => fmt(v, 0) });
      } else if (cfg.mode === "oi" || cfg.mode === "vol") {
        const c = cfg.mode === "oi" ? ["callOI", "putOI"] : ["callVol", "putVol"];
        const [a, b] = lim(by.map((x) => x.k));
        plot({ series: [{ label: "calls", points: by.map((x) => [x.k, x[c[0]]]), style: "bars", color: css("--up"), axis: "L", noTag: true },
          { label: "puts (shown negative)", points: by.map((x) => [x.k, -x[c[1]]]), style: "bars", color: css("--down"), axis: "L", noTag: true }],
          xMin: a, xMax: b, vrefs: vrefs(), zero: true, xFmt: (v) => fmt(v, 0) });
      } else if (cfg.mode === "smile") {
        const pts = r.smile.pts;
        if (!pts.length) { body.append(h("div.empty", "no smile data")); return; }
        plot({ series: [{ label: `IV % · ${r.smile.exp} (OTM puts left, calls right)`, points: pts, style: "line", color: css("--ink"), axis: "L" }],
          xMin: pts[0][0], xMax: pts.at(-1)[0], vrefs: [{ x: 1, label: "ATM", color: css("--ink"), dark: true }], xFmt: (v) => (v * 100).toFixed(0) + "%" });
      } else if (cfg.mode === "term") {
        const pts = r.term.filter((t) => t.dte >= 1).map((t) => [t.dte, t.iv]);
        if (!pts.length) { body.append(h("div.empty", "no term data")); return; }
        plot({ series: [{ label: "ATM IV % by days to expiry", points: pts, style: "line", color: css("--ink"), axis: "L" }],
          xMin: pts[0][0], xMax: pts.at(-1)[0], xScale: Math.sqrt, vrefs: [{ x: 30, label: "30d", color: css("--ref") }], xFmt: (v) => v.toFixed(0) + "d" });
      }
    };

    const summary = () => {
      const m = r.metrics, b = r.bias;
      const block = (title, plus, minus, s) => {
        const cv = h("canvas");
        const wrap = h("div.contrib.flat", cv);
        const el = h("div.opt-bias",
          h("div.bias-head",
            h("div.bias-score", { class: s.score == null ? "" : s.score >= 0 ? "pos" : "neg" }, s.score == null ? "–" : (s.score >= 0 ? "+" : "") + s.score.toFixed(0)),
            h("div.bias-meta", h("div", h("b", title), h("span.muted", ` · + = ${plus}, − = ${minus}`)), gauge(s.score))),
          wrap);
        requestAnimationFrame(() => hbars(cv, s.items.map((i) => ({ label: `${i.w} · ${i.label}`, value: i.contrib, dim: i.value == null })),
          { maxAbs: 40, fmtv: (v) => (v >= 0 ? "+" : "") + v.toFixed(0) }));
        return el;
      };
      const regime = [
        m.gex >= 0 ? "Dealers net long gamma: hedging dampens moves (sell rallies, buy dips)." : "Dealers net short gamma: hedging amplifies moves (buy rallies, sell dips).",
        m.flipDist != null ? `Spot is ${Math.abs(m.flipDist).toFixed(1)}% ${m.flipDist >= 0 ? "above" : "below"} the gamma flip at ${fmt(m.flip)}.` : "No gamma flip found within ±12%.",
        m.callWall && m.putWall ? `Largest call gamma ${fmt(m.callWall)} (${pct(100 * (m.callWall / m.spot - 1), 1)}), largest put gamma ${fmt(m.putWall)} (${pct(100 * (m.putWall / m.spot - 1), 1)}).` : "",
        m.termSlope != null ? `Vol term structure ${m.termSlope >= 0 ? "in contango" : "inverted"} (IV90 − IV30 = ${m.termSlope.toFixed(1)} vol pts).` : "",
        m.skew25 != null ? `25Δ put skew ${m.skew25.toFixed(1)} vol pts (${(100 * m.skewRatio).toFixed(0)}% of ATM IV).` : "",
        m.move ? `Options price a ±${m.move.pct.toFixed(2)}% move to ${m.move.exp} (${m.move.dte}d).` : "",
      ].filter(Boolean);
      const greeks = h("table.tbl.stats", h("tbody",
        [["Dealer delta (DEX)", bn(m.dex), "$ delta held by dealers"], ["Dealer gamma (GEX)", bn(m.gex), "Δ$ delta per 1% spot"],
         ["Dealer vanna (VEX)", bn(m.vex), "Δ$ delta per +1 vol pt"], ["Dealer charm (CEX)", bn(m.cex), "Δ$ delta per day of decay"],
         ["P/C open interest", m.pcOI?.toFixed(2) ?? "–", ""], ["P/C volume", m.pcVol?.toFixed(2) ?? "–", ""],
         ["ATM IV 30d / 90d", `${m.iv30?.toFixed(1) ?? "–"} / ${m.iv90?.toFixed(1) ?? "–"}`, m.cboeIv30 ? `Cboe iv30 ${m.cboeIv30}` : ""],
         ["Contracts used", `${m.nLive} / ${m.nOpts}`, "≤90d, ±25%, with IV"]]
          .map(([a, v, n]) => h("tr", h("td", a), h("td.num", v), h("td.muted.tiny", n)))));
      body.append(h("div.opt-summary",
        h("div.opt-col", block("Vol pressure", "expansion risk", "suppression", b.vol), block("Direction lean", "supportive", "heavy", b.dir)),
        h("div.opt-col", h("div.opt-regime", regime.map((t) => h("div", t))), greeks,
          h("div.foot-note", "Assumes dealers long calls / short puts (public-GEX convention). Real books are unknown. Scores use fixed scales, untested. Metrics are logged daily → chart as opt:" + r.sym + ":gex, :flipDist, :biasVol…"))));
    };

    const refresh = async () => {
      head.replaceChildren(h("span.muted", `loading ${cfg.sym} chain…`));
      try {
        r = await getJSON(`/api/options?sym=${encodeURIComponent(cfg.sym)}&band=${cfg.band}&maxdte=${cfg.maxdte}`);
        if (r.error) throw new Error(r.error);
      } catch (e) { r = null; head.replaceChildren(h("span.err", `${cfg.sym}: ${e.message}`)); clear(); return; }
      ctx.setTitle(`Options ${r.sym}`);
      header(); draw();
    };
    refresh();
    return { refresh, destroy: clear, png: () => chart?.png(`${cfg.sym} ${MODES[cfg.mode]}`, `${r?.source} · ${r?.chainTime} · dealers long calls/short puts assumption · swift @negvol`) };
  },
  edit(cfg, ctx, done) {
    const m = modal("Options view", [
      h("label", "symbol (Cboe-listed, or BTC/ETH) ", inp(cfg.sym, (v) => (cfg.sym = v.toUpperCase()))),
      h("label", "strike band ± ", inp(cfg.band, (v) => (cfg.band = v), { type: "number", step: "0.01", class: "ed-n" })),
      h("label", "max days to expiry for exposures ", inp(cfg.maxdte, (v) => (cfg.maxdte = v), { type: "number", class: "ed-n" })),
      h("div.ed-foot", h("button.btn.primary", { on: { click: () => { m.close(); done(); } } }, "Apply"))]);
  },
};
