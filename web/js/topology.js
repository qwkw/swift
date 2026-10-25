// swift · @negvol — market topology: trend × momentum phase space for any series, plus trend/momentum/vol z panels
// and a status read-out.
//   trend z    = rolling z (window W) of log(P / SMA_nT)
//   momentum z = rolling z (window W) of log(P_t / P_t−nM)
//   vol z      = rolling z (window W) of nV-day realised vol
// Status from distance to the origin: < 1σ NORMAL, < 2σ EXTENDED, else EXTREME; vol z > 2 flags VOL STRESS.
// Descriptive state only — not a tested signal.
import { catalog, series } from "./api.js";
import { fmt, fmtDate } from "./calc.js";
import { css } from "./chart.js";
import { h, inp, modal } from "./dom.js";
import { pickFeed } from "./picker.js";

const HIST = { "6M": 126, "1Y": 252, "2Y": 504, "5Y": 1260 };
const QUAD = { "++": "bull impulse", "+-": "bull fading", "-+": "bear fading", "--": "bear impulse" };

function rollZ(xs, W) {             // xs: array of numbers|null, returns same length
  const out = new Array(xs.length).fill(null);
  let s = 0, q = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v != null) { s += v; q += v * v; n++; }
    if (i >= W && xs[i - W] != null) { s -= xs[i - W]; q -= xs[i - W] ** 2; n--; }
    if (v != null && n >= Math.min(W, 60)) {
      const m = s / n, sd = Math.sqrt(Math.max(q / n - m * m, 1e-18));
      out[i] = (v - m) / sd;
    }
  }
  return out;
}

export function topo(pts, { nT = 50, nM = 20, nV = 20, W = 252 } = {}) {
  const P = pts.map((p) => p[1]), N = P.length;
  const trend = new Array(N).fill(null), mom = new Array(N).fill(null), vol = new Array(N).fill(null);
  let s = 0;
  for (let i = 0; i < N; i++) {
    s += P[i]; if (i >= nT) s -= P[i - nT];
    if (i >= nT - 1 && P[i] > 0) trend[i] = Math.log(P[i] / (s / nT));
    if (i >= nM && P[i] > 0 && P[i - nM] > 0) mom[i] = Math.log(P[i] / P[i - nM]);
  }
  const r = P.map((p, i) => (i && p > 0 && P[i - 1] > 0 ? Math.log(p / P[i - 1]) : null));
  for (let i = nV; i < N; i++) {
    const w = r.slice(i - nV + 1, i + 1).filter((x) => x != null);
    if (w.length < nV * 0.8) continue;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    vol[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length * 252);
  }
  const tz = rollZ(trend, W), mz = rollZ(mom, W), vz = rollZ(vol, W);
  return pts.map((p, i) => ({ t: p[0], price: p[1], trend: tz[i], mom: mz[i], vol: vz[i] })).filter((x) => x.trend != null && x.mom != null);
}

export function status(x) {
  const d = Math.hypot(x.trend, x.mom);
  const st = d < 1 ? "NORMAL" : d < 2 ? "EXTENDED" : "EXTREME";
  const quad = QUAD[(x.trend >= 0 ? "+" : "-") + (x.mom >= 0 ? "+" : "-")];
  return { d, st, quad, stress: x.vol != null && x.vol > 2, note: d < 1 ? "in range" : d < 2 ? "stretched" : "far from centre" };
}

function setup(cv) {
  const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawPhase(cv, path, mono) {
  const { ctx, W, H } = setup(cv);
  if (W < 50 || H < 50) return;
  const teal = css("--topo"), dot = css("--topo-dot"), muted = css("--muted"), axis = css("--axis");
  ctx.fillStyle = css("--plane"); ctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const R = Math.max(2.6, ...path.map((p) => Math.max(Math.abs(p.trend), Math.abs(p.mom)))) * 1.08;
  const k = (Math.min(W, H) / 2 - 26) / R;
  const X = (v) => cx + v * k, Y = (v) => cy - v * k;
  ctx.font = `11px ${mono}`;
  // axes, rings
  ctx.strokeStyle = axis; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(24, cy); ctx.lineTo(W - 24, cy); ctx.moveTo(cx, 24); ctx.lineTo(cx, H - 24); ctx.stroke();
  ctx.setLineDash([2, 4]);
  for (const r of [1, 2]) { ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.fillStyle = muted; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText("1σ", X(1) + 3, cy + 4); ctx.fillText("2σ", X(2) + 3, cy + 4);
  ctx.fillText("bear fading", 14, 12); ctx.textAlign = "right"; ctx.fillText("bull impulse", W - 14, 12);
  ctx.textBaseline = "bottom"; ctx.fillText("bull fading", W - 14, H - 10); ctx.textAlign = "left"; ctx.fillText("bear impulse", 14, H - 10);
  ctx.textAlign = "center"; ctx.fillText("trend →", cx, H - 2);
  ctx.save(); ctx.translate(10, cy); ctx.rotate(-Math.PI / 2); ctx.textBaseline = "top"; ctx.fillText("momentum ↑", 0, 0); ctx.restore();
  // path, older segments fainter
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    ctx.strokeStyle = hexA(teal, 0.12 + 0.88 * (i / path.length) ** 1.6);
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(X(a.trend), Y(a.mom)); ctx.lineTo(X(b.trend), Y(b.mom)); ctx.stroke();
  }
  const last = path.at(-1);
  if (last) {
    const x = X(last.trend), y = Y(last.mom);
    ctx.strokeStyle = dot; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = teal; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(`(${last.trend.toFixed(2)}, ${last.mom.toFixed(2)})`, x + 11, y);
  }
}

function drawMini(cv, vals, zero, mono) {
  const { ctx, W, H } = setup(cv);
  ctx.clearRect(0, 0, W, H);
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return;
  const lo = Math.min(...v, zero ? 0 : Infinity), hi = Math.max(...v, zero ? 0 : -Infinity);
  const Y = (x) => H - 6 - ((x - lo) / (hi - lo || 1)) * (H - 12), X = (i) => 4 + (i / (vals.length - 1)) * (W - 12);
  if (zero) { ctx.strokeStyle = css("--axis"); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(4, Y(0)); ctx.lineTo(W - 8, Y(0)); ctx.stroke(); ctx.setLineDash([]); }
  ctx.strokeStyle = css("--ink2"); ctx.lineWidth = 1.2; ctx.beginPath();
  vals.forEach((x, i) => { if (x == null) return; i ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x)); });
  ctx.stroke();
  ctx.fillStyle = css("--topo-dot"); ctx.beginPath(); ctx.arc(X(vals.length - 1), Y(vals.at(-1)), 3, 0, Math.PI * 2); ctx.fill();
}

export const topologyView = {
  name: "Topology",
  defaults: () => ({ type: "topology", title: "", id: "yahoo:SPY", hist: "2Y", nT: 50, nM: 20, nV: 20, W: 252 }),
  mount(el, cfg, ctx) {
    const mono = "ui-monospace, 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace";
    const head = h("div.topo-head"), phase = h("canvas.topo-phase"), minis = h("div.topo-minis"), stat = h("div.topo-status");
    const grid = h("div.topo-grid", h("div.topo-box", phase), minis, stat);
    el.classList.add("topo"); el.append(head, grid);
    let path = [], name = cfg.id;
    const mini = {};
    for (const [k, lab] of [["trend", "trend z"], ["mom", "momentum z"], ["vol", "vol z"], ["price", "price"]]) {
      mini[k] = { val: h("span.topo-v"), cv: h("canvas.topo-mini") };
      minis.append(h("div.topo-card", h("div.topo-card-h", h("span.muted", lab), mini[k].val), mini[k].cv));
    }
    const draw = () => {
      if (!path.length) return;
      const last = path.at(-1), s = status(last);
      drawPhase(phase, path, mono);
      for (const k of ["trend", "mom", "vol", "price"]) {
        mini[k].val.textContent = last[k] == null ? "–" : k === "price" ? fmt(last[k]) : last[k].toFixed(2);
        drawMini(mini[k].cv, path.map((p) => p[k]), k !== "price", mono);
      }
      const cls = s.stress ? "neg" : s.st === "NORMAL" ? "topo-ok" : s.st === "EXTENDED" ? "hot" : "neg";
      head.replaceChildren(
        h("div", h("div.topo-title", name), h("div.muted.tiny", `Market topology · trend × momentum phase space · 1D · ${cfg.hist}`)),
        h("span.grow"),
        h("div.topo-right", h("div.topo-big", { class: cls }, s.stress ? "VOL STRESS" : s.st), h("div.muted.tiny", "as of " + fmtDate(last.t))));
      const row = (a, b, c = "") => h("div.topo-row", h("span.muted", a), h("span", { class: c }, b));
      stat.replaceChildren(h("div.topo-stat-h", "Status"),
        row("Status", s.st, cls), row("Regime", s.quad, s.quad.startsWith("bull") ? "pos" : "neg"),
        row("Trend", last.trend.toFixed(3)), row("Momentum", last.mom.toFixed(3)), row("Volatility", last.vol == null ? "–" : last.vol.toFixed(3), last.vol > 2 ? "neg" : ""),
        row("Price", fmt(last.price)), row("Dist center", s.d.toFixed(3)), h("div.topo-sep"), row("Note", s.note, cls),
        h("div.foot-note", `trend: log P/SMA${cfg.nT} · mom: ${cfg.nM}d log return · vol: ${cfg.nV}d RV · z over ${cfg.W}d. Descriptive, untested.`));
    };
    const refresh = async () => {
      const d = await series(cfg.id);
      name = /^yahoo:/.test(cfg.id) ? "^" + cfg.id.slice(6).replace(/^\^/, "") : (await catalog()).series.find((x) => x.id === cfg.id)?.name || d.name || cfg.id;
      if (!d.points.length) { head.replaceChildren(h("span.err", `${cfg.id}: ${d.error || "no data"}`)); return; }
      const all = topo(d.points, cfg);
      path = all.slice(-(HIST[cfg.hist] || 504));
      ctx.setTitle(`Topology ${name}`);
      draw();
    };
    const ro = new ResizeObserver(() => draw());
    ro.observe(grid);
    refresh();
    return { refresh, destroy: () => ro.disconnect(),
      png: () => {
        const a = h("a", { href: phase.toDataURL("image/png"), download: `topology_${name}.png` }); a.click();
      } };
  },
  edit(cfg, ctx, done) {
    const idIn = inp(cfg.id, (v) => (cfg.id = v), { class: "ed-id" });
    const m = modal("Topology", [
      h("div.ed-row", idIn, h("button.btn", { on: { click: () => pickFeed("series", (id) => { cfg.id = id; idIn.value = id; }) } }, "pick…")),
      h("div.be-fields",
        h("label", "history ", h("select", { on: { change: (e) => (cfg.hist = e.target.value) } }, Object.keys(HIST).map((k) => h("option", { value: k, selected: k === cfg.hist }, k)))),
        h("label", "trend SMA ", inp(cfg.nT, (v) => (cfg.nT = v), { type: "number", class: "ed-n" })),
        h("label", "momentum days ", inp(cfg.nM, (v) => (cfg.nM = v), { type: "number", class: "ed-n" })),
        h("label", "vol days ", inp(cfg.nV, (v) => (cfg.nV = v), { type: "number", class: "ed-n" })),
        h("label", "z window ", inp(cfg.W, (v) => (cfg.W = v), { type: "number", class: "ed-n" }))),
      h("div.ed-foot", h("button.btn.primary", { on: { click: () => { m.close(); done(); } } }, "Apply"))]);
  },
};
