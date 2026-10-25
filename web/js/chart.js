// swift · @negvol — canvas renderer: black plane, no grid, monochrome series, colour only
// with meaning (up/down/limit), navy area fill, dashed reference lines with boxed tags,
// square-swatch legend, fading bars, crosshair with a boxed date tag.
import { bisect, fmt } from "./calc.js";

export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const PALETTE = () => [css("--s1"), css("--s2"), css("--s3"), css("--s4"), css("--s5"), css("--s6"), css("--s7")];
const FONT = () => css("--font") || "system-ui";

function alpha(hex, a) {
  if (!hex.startsWith("#")) return hex;
  const n = parseInt(hex.length === 4 ? hex.slice(1).replace(/./g, "$&$&") : hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function niceStep(span, target) {
  const raw = span / Math.max(target, 1), p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * p;
}

function yTicks(lo, hi, px) {
  const step = niceStep(hi - lo, Math.max(2, px / 48));
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return { ticks: out, step };
}

const MIN = 60000, HR = 3600000, D = 86400000;
const STEPS = [[5 * MIN, "t"], [15 * MIN, "t"], [30 * MIN, "t"], [HR, "t"], [3 * HR, "t"], [6 * HR, "t"], [12 * HR, "t"],
  [D, "d"], [2 * D, "d"], [7 * D, "d"], [14 * D, "d"], [1, "M"], [2, "M"], [3, "M"], [6, "M"], [12, "Y"], [24, "Y"], [60, "Y"], [120, "Y"]];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function xTicks(t0, t1, px) {
  const want = Math.max(2, px / 95), span = t1 - t0;
  let st = STEPS.at(-1);
  for (const s of STEPS) {
    const ms = s[1] === "M" || s[1] === "Y" ? s[0] * 30.44 * D : s[0];
    if (span / ms <= want) { st = s; break; }
  }
  const [n, kind] = st, out = [];
  if (kind === "M" || kind === "Y") {
    const d = new Date(t0);
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    m = Math.ceil(m / n) * n;
    while (true) {
      const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
      if (t > t1) break;
      if (t >= t0) {
        const dd = new Date(t), mm = dd.getUTCMonth();
        out.push([t, kind === "Y" || mm === 0 ? String(dd.getUTCFullYear()) : MON[mm]]);
      }
      m += n;
    }
  } else {
    for (let t = Math.ceil(t0 / n) * n; t <= t1; t += n) {
      const dd = new Date(t);
      out.push([t, kind === "t" ? (dd.getUTCHours() === 0 && dd.getUTCMinutes() === 0 ? `${MON[dd.getUTCMonth()]} ${dd.getUTCDate()}`
        : dd.toISOString().slice(11, 16)) : `${MON[dd.getUTCMonth()]} ${dd.getUTCDate()}`]);
    }
  }
  return out;
}

function tag(ctx, x, y, text, bg, fg, align = "left") {
  ctx.font = `11px ${FONT()}`;
  const w = ctx.measureText(text).width + 10, h = 16;
  const bx = align === "left" ? x : align === "right" ? x - w : x - w / 2;
  ctx.fillStyle = bg;
  ctx.beginPath();
  if (align === "left") { ctx.moveTo(bx, y - h / 2); ctx.lineTo(bx + w, y - h / 2); ctx.lineTo(bx + w + 5, y); ctx.lineTo(bx + w, y + h / 2); ctx.lineTo(bx, y + h / 2); }
  else ctx.rect(bx, y - h / 2, w, h);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + 5, y + 0.5);
  return w;
}

export class Chart {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.cv = document.createElement("canvas");
    this.cv.className = "chart-canvas";
    host.appendChild(this.cv);
    this.spec = null;
    this.view = null;            // [t0, t1] user zoom, null = full
    this.hover = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this.cv.addEventListener("mousemove", (e) => { this.hover = this._pos(e); if (this.drag) this._pan(e); this.draw(); });
    this.cv.addEventListener("mouseleave", () => { this.hover = null; this.drag = null; this.draw(); });
    this.cv.addEventListener("mousedown", (e) => { this.drag = { x: e.offsetX, view: this._dom() }; });
    window.addEventListener("mouseup", () => { this.drag = null; });
    this.cv.addEventListener("dblclick", () => { this.view = null; this.draw(); });
    this.cv.addEventListener("wheel", (e) => { if (this.spec?.xMode === "linear") return; e.preventDefault(); this._zoom(e); }, { passive: false });
  }

  destroy() { this.ro.disconnect(); this.cv.remove(); }
  set(spec) { this.spec = spec; this.draw(); }

  _pos(e) { return { x: e.offsetX, y: e.offsetY }; }
  _full() {
    let t0 = Infinity, t1 = -Infinity;
    for (const s of this.spec.series) if (s.points.length) { t0 = Math.min(t0, s.points[0][0]); t1 = Math.max(t1, s.points.at(-1)[0]); }
    if (this.spec.x0 != null) t0 = Math.max(t0, this.spec.x0);
    return [t0, t1];
  }
  _dom() { return this.view || this._full(); }
  _zoom(e) {
    const [f0, f1] = this._full(), [t0, t1] = this._dom(), L = this.L;
    if (!L) return;
    const at = t0 + ((e.offsetX - L.x0) / (L.x1 - L.x0)) * (t1 - t0);
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    let n0 = at - (at - t0) * k, n1 = at + (t1 - at) * k;
    if (n1 - n0 >= f1 - f0) { this.view = null; } else { this.view = [Math.max(f0, n0), Math.min(f1, n1)]; }
    this.draw();
  }
  _pan(e) {
    if (!this.view || !this.L) return;
    const [f0, f1] = this._full(), [v0, v1] = this.drag.view;
    const dt = ((this.drag.x - e.offsetX) / (this.L.x1 - this.L.x0)) * (v1 - v0);
    const s = Math.min(Math.max(v0 + dt, f0), f1 - (v1 - v0));
    this.view = [s, s + (v1 - v0)];
  }

  draw(target) {
    const spec = this.spec;
    const cv = target || this.cv;
    const W = target ? target.width / (target._dpr || 1) : this.host.clientWidth;
    const H = target ? target.height / (target._dpr || 1) : this.host.clientHeight;
    if (!spec || W < 20 || H < 20) return;
    const dpr = target ? target._dpr || 1 : window.devicePixelRatio || 1;
    if (!target) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css("--plane");
    ctx.fillRect(0, 0, W, H);
    const ink = css("--ink"), muted = css("--muted"), axis = css("--axis"), tagBg = css("--tag");
    const series = spec.series.filter((s) => s.points && s.points.length);
    ctx.font = `11px ${FONT()}`;
    if (!series.length) {
      ctx.fillStyle = muted; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(spec.empty || "no data", W / 2, H / 2);
      return;
    }
    const linear = spec.xMode === "linear";
    const [t0, t1] = linear ? [spec.xMin, spec.xMax] : this._dom();
    const xf = linear ? spec.xScale || ((x) => x) : (x) => x;
    // visible slices + y ranges per axis
    const vis = series.map((s) => {
      if (linear) return s.points;
      const i0 = Math.max(0, bisect(s.points, t0)), i1 = bisect(s.points, t1);
      return s.points.slice(i0, i1 + 1);
    });
    const ext = { L: [Infinity, -Infinity], R: [Infinity, -Infinity] };
    series.forEach((s, k) => {
      const e = ext[s.axis === "R" ? "R" : "L"];
      for (const p of vis[k]) { if (p[1] < e[0]) e[0] = p[1]; if (p[1] > e[1]) e[1] = p[1]; }
      if (s.style === "bars" || s.style === "signbars" || s.style === "signarea") { e[0] = Math.min(e[0], 0); e[1] = Math.max(e[1], 0); }
    });
    for (const r of spec.refs || []) { const e = ext[r.axis === "R" ? "R" : "L"]; if (r.y < e[0]) e[0] = r.y; if (r.y > e[1]) e[1] = r.y; }
    if (spec.yMin != null) ext.L[0] = spec.yMin;
    if (spec.yMax != null) ext.L[1] = spec.yMax;
    const hasR = series.some((s) => s.axis === "R") && ext.R[0] <= ext.R[1];
    for (const k of ["L", "R"]) {
      let [lo, hi] = ext[k];
      if (!(lo <= hi)) continue;
      if (lo === hi) { lo -= Math.abs(lo) * 0.05 || 1; hi += Math.abs(hi) * 0.05 || 1; }
      const pad = (hi - lo) * 0.07;
      ext[k] = [spec.yMin != null && k === "L" ? lo : lo - pad, spec.yMax != null && k === "L" ? hi : hi + pad];
    }
    const yfmt = spec.yFmt || ((v, step) => fmt(v, step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3));
    const legendH = spec.legend === false ? 6 : 26;
    const top = legendH + 4, bottom = H - 22;
    const ytL = yTicks(ext.L[0], ext.L[1], bottom - top);
    const ytR = hasR ? yTicks(ext.R[0], ext.R[1], bottom - top) : null;
    const lw = Math.max(34, ...ytL.ticks.map((v) => ctx.measureText(yfmt(v, ytL.step)).width + 14));
    const rw = hasR ? Math.max(34, ...ytR.ticks.map((v) => ctx.measureText(yfmt(v, ytR.step)).width + 14)) : 14;
    const L = (this.L = { x0: lw, x1: W - rw, y0: top, y1: bottom });
    const X = (t) => L.x0 + ((xf(t) - xf(t0)) / (xf(t1) - xf(t0) || 1)) * (L.x1 - L.x0);
    const Y = (v, ax) => { const [lo, hi] = ext[ax === "R" ? "R" : "L"]; return L.y1 - ((v - lo) / (hi - lo || 1)) * (L.y1 - L.y0); };

    // axes labels
    ctx.fillStyle = muted; ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const v of ytL.ticks) ctx.fillText(yfmt(v, ytL.step), L.x0 - 8, Y(v, "L"));
    if (hasR) { ctx.textAlign = "left"; for (const v of ytR.ticks) ctx.fillText(yfmt(v, ytR.step), L.x1 + 8, Y(v, "R")); }
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const xfmtL = spec.xFmt || ((v) => fmt(v));
    let xt;
    if (!linear) xt = xTicks(t0, t1, L.x1 - L.x0);
    else if (spec.xTicks) xt = spec.xTicks;
    else {
      const st = niceStep(t1 - t0, Math.max(2, (L.x1 - L.x0) / 90));
      xt = [];
      for (let v = Math.ceil(t0 / st) * st; v <= t1 + st * 1e-9; v += st) xt.push([+v.toPrecision(12), xfmtL(+v.toPrecision(12))]);
    }
    let lastX = -1e9;
    for (const [t, lab] of xt) {
      const x = X(t);
      if (x < L.x0 - 1 || x > L.x1 + 1 || x - lastX < 34) continue;
      ctx.fillText(lab, x, H - 6); lastX = x;
    }
    // zero / ref lines
    const zeroAx = series.find((s) => s.style === "bars" || s.style === "signbars" || s.style === "signarea") ? "L" : null;
    const refs = [...(spec.refs || [])];
    if (spec.zero || zeroAx) refs.push({ y: 0, axis: "L", color: axis, noTag: true, solid: true });
    for (const r of refs) {
      const y = Y(r.y, r.axis);
      if (y < L.y0 || y > L.y1) continue;
      ctx.strokeStyle = r.color || css("--ref"); ctx.lineWidth = 1;
      ctx.setLineDash(r.solid ? [] : [5, 4]);
      ctx.beginPath(); ctx.moveTo(L.x0, y); ctx.lineTo(L.x1, y); ctx.stroke(); ctx.setLineDash([]);
      if (!r.noTag) tag(ctx, r.axis === "R" ? L.x1 + 2 : 2, y, r.label ?? yfmt(r.y, 0.01), r.color && r.color !== css("--ref") ? r.color : tagBg, "#fff");
    }
    // vertical reference lines (spot, flip, walls...) with tags stacked at the top
    (spec.vrefs || []).forEach((r, i) => {
      if (r.x == null) return;
      const x = X(r.x);
      if (x < L.x0 || x > L.x1) return;
      ctx.strokeStyle = r.color || css("--ref"); ctx.lineWidth = 1; ctx.setLineDash(r.solid ? [] : [4, 4]);
      ctx.beginPath(); ctx.moveTo(x, L.y0); ctx.lineTo(x, L.y1); ctx.stroke(); ctx.setLineDash([]);
      tag(ctx, x, L.y0 + 9 + (i % 5) * 18, r.label, alpha(r.color || tagBg, 0.9), r.dark ? "#000" : "#fff", "center");
    });

    ctx.save();
    ctx.beginPath(); ctx.rect(L.x0, L.y0 - 2, L.x1 - L.x0, L.y1 - L.y0 + 4); ctx.clip();
    const up = css("--up"), down = css("--down");
    series.forEach((s, k) => {
      const pts = vis[k];
      if (!pts.length) return;
      const ax = s.axis, col = s.color;
      if (s.style === "bars" || s.style === "signbars") {
        const n = Math.max(pts.length, 1);
        const bw = Math.max(1, Math.min(14, ((L.x1 - L.x0) / n) * 0.72));
        const y0 = Y(0, ax);
        for (const p of pts) {
          const x = X(p[0]), y = Y(p[1], ax);
          const c = s.style === "signbars" ? (p[1] >= 0 ? up : down) : col;
          const g = ctx.createLinearGradient(0, y0, 0, y);
          g.addColorStop(0, alpha(c, 0.06)); g.addColorStop(1, alpha(c, 0.95));
          ctx.fillStyle = g;
          ctx.fillRect(x - bw / 2, Math.min(y, y0), bw, Math.abs(y0 - y) || 1);
        }
        return;
      }
      const path = () => {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = X(p[0]), y = Y(p[1], ax);
          if (i === 0) ctx.moveTo(x, y);
          else if (s.style === "step") { ctx.lineTo(x, Y(pts[i - 1][1], ax)); ctx.lineTo(x, y); }
          else ctx.lineTo(x, y);
        });
      };
      if (s.style === "area") {
        path();
        ctx.lineTo(X(pts.at(-1)[0]), L.y1); ctx.lineTo(X(pts[0][0]), L.y1); ctx.closePath();
        const fillc = s.fill || css("--fill");
        const g = ctx.createLinearGradient(0, L.y0, 0, L.y1);
        g.addColorStop(0, alpha(fillc, 0.95)); g.addColorStop(1, alpha(fillc, 0.35));
        ctx.fillStyle = g; ctx.fill();
      }
      if (s.style === "signarea") {
        const y0 = Y(0, ax);
        for (const [sgn, c] of [[1, up], [-1, down]]) {
          ctx.save();
          ctx.beginPath();
          if (sgn > 0) ctx.rect(L.x0, L.y0 - 2, L.x1 - L.x0, y0 - L.y0 + 2); else ctx.rect(L.x0, y0, L.x1 - L.x0, L.y1 - y0 + 2);
          ctx.clip();
          path(); ctx.lineTo(X(pts.at(-1)[0]), y0); ctx.lineTo(X(pts[0][0]), y0); ctx.closePath();
          const g = ctx.createLinearGradient(0, y0, 0, sgn > 0 ? L.y0 : L.y1);
          g.addColorStop(0, alpha(c, 0.05)); g.addColorStop(1, alpha(c, 0.75));
          ctx.fillStyle = g; ctx.fill();
          ctx.restore();
        }
      }
      path();
      ctx.strokeStyle = col; ctx.lineWidth = s.width || 1.4; ctx.lineJoin = "round";
      ctx.stroke();
    });
    ctx.restore();

    // last-value dashed line (first series) and boxed tags on the axis
    series.forEach((s, k) => {
      const pts = vis[k];
      if (!pts.length || s.noTag) return;
      const v = pts.at(-1)[1], y = Y(v, s.axis);
      if (y < L.y0 || y > L.y1) return;
      if (k === 0 && !linear && s.style !== "bars" && s.style !== "signbars") {
        ctx.strokeStyle = css("--ref"); ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(L.x0, y); ctx.lineTo(L.x1, y); ctx.stroke(); ctx.setLineDash([]);
      }
      if (s.axis === "R") tag(ctx, L.x1 + 2, y, yfmt(v, 0.01), series.length > 1 ? alpha(s.color, 0.85) : tagBg, series.length > 1 ? "#000" : "#fff");
      else tag(ctx, 2, y, yfmt(v, 0.01), series.length > 1 && k > 0 ? alpha(s.color, 0.85) : tagBg, series.length > 1 && k > 0 ? "#000" : "#fff");
    });

    // crosshair
    let hv = null;
    const hx = this.hover && !target && this.hover.x >= L.x0 && this.hover.x <= L.x1 ? this.hover.x : null;
    if (hx != null) {
      const t = t0 + ((hx - L.x0) / (L.x1 - L.x0)) * (t1 - t0);
      hv = linear
        ? series.map((s, k) => vis[k].reduce((b, p) => (!b || Math.abs(X(p[0]) - hx) < Math.abs(X(b[0]) - hx) ? p : b), null))
        : series.map((s, k) => { const i = bisect(vis[k], t); return i >= 0 ? vis[k][i] : null; });
      const snap = hv.find(Boolean);
      const sx = snap ? X(snap[0]) : hx;
      ctx.strokeStyle = axis; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, L.y0); ctx.lineTo(sx, L.y1); ctx.stroke();
      series.forEach((s, k) => { const p = hv[k]; if (p) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1], s.axis), 2.6, 0, 7); ctx.fill(); } });
      if (snap) {
        const d = new Date(snap[0]);
        const lab = linear ? xfmtL(snap[0]) : spec.intraday ? d.toISOString().slice(5, 16).replace("T", " ") : d.toISOString().slice(0, 10);
        ctx.font = `11px ${FONT()}`;
        tag(ctx, sx, H - 10, lab, css("--xtag"), "#000", "center");
      }
    }

    // legend: square swatches, value at cursor or last
    if (spec.legend !== false) {
      let x = L.x0 + 4;
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      series.forEach((s, k) => {
        const p = hv ? hv[k] : vis[k].at(-1);
        const txt = `${s.label}${p ? "  " + yfmt(p[1], 0.01) : ""}${s.axis === "R" && hasR ? " (R)" : ""}`;
        ctx.font = `11.5px ${FONT()}`;
        const w = ctx.measureText(txt).width;
        if (x + w + 20 > W) return;
        ctx.fillStyle = s.style === "signbars" || s.style === "signarea" ? up : s.color;
        ctx.fillRect(x, 10, 9, 9);
        ctx.fillStyle = css("--ink2");
        ctx.fillText(txt, x + 13, 15);
        x += w + 26;
      });
    }
  }

  png(title, subtitle) {
    const W = this.host.clientWidth, H = this.host.clientHeight, dpr = 2;
    const off = document.createElement("canvas");
    off.width = W * dpr; off.height = (H + 44) * dpr; off._dpr = dpr;
    const ctx = off.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css("--plane"); ctx.fillRect(0, 0, W, H + 44);
    ctx.fillStyle = css("--ink"); ctx.font = `600 13px ${FONT()}`; ctx.fillText(title || "", 10, 18);
    ctx.fillStyle = css("--muted"); ctx.font = `11px ${FONT()}`; ctx.fillText(subtitle || "", 10, 34);
    const inner = document.createElement("canvas");
    inner.width = W * dpr; inner.height = H * dpr; inner._dpr = dpr;
    this.draw(inner);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(inner, 0, 40 * dpr);
    const a = document.createElement("a");
    a.href = off.toDataURL("image/png");
    a.download = "swift_" + (title || "chart").replace(/[^\w.-]+/g, "_") + ".png";
    a.click();
  }
}

// Horizontal fading bars from zero (bias contributions).
export function hbars(cv, items, { maxAbs, fmtv = (v) => fmt(v, 2) } = {}) {
  const pe = cv.parentElement, ps = getComputedStyle(pe);
  const W = pe.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight) - 2, rowH = 20, H = Math.max(rowH * items.length + 8, 30);
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css("--plane"); ctx.fillRect(0, 0, W, H);
  ctx.font = `11.5px ${FONT()}`;
  const labW = Math.min(W * 0.45, Math.max(...items.map((i) => ctx.measureText(i.label).width)) + 12);
  const valW = 46, x0 = labW, x1 = W - valW, mid = (x0 + x1) / 2;
  const m = maxAbs || Math.max(1e-9, ...items.map((i) => Math.abs(i.value ?? 0)));
  ctx.strokeStyle = css("--axis"); ctx.beginPath(); ctx.moveTo(mid, 2); ctx.lineTo(mid, H - 2); ctx.stroke();
  items.forEach((it, k) => {
    const y = 4 + k * rowH + rowH / 2;
    ctx.fillStyle = it.dim ? css("--muted") : css("--ink2"); ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let lab = it.label;
    while (lab.length > 4 && ctx.measureText(lab).width > labW - 8) lab = lab.slice(0, -2);
    ctx.fillText(lab === it.label ? lab : lab.trimEnd() + "…", 2, y);
    if (it.value == null) { ctx.fillStyle = css("--muted"); ctx.textAlign = "right"; ctx.fillText("n/a", W - 4, y); return; }
    const c = it.value >= 0 ? css("--up") : css("--down");
    const xe = mid + (it.value / m) * (x1 - mid);
    const g = ctx.createLinearGradient(mid, 0, xe, 0);
    g.addColorStop(0, alpha(c, 0.08)); g.addColorStop(1, alpha(c, 0.95));
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(mid, xe), y - 6, Math.abs(xe - mid), 12);
    ctx.fillStyle = css("--ink"); ctx.textAlign = "right";
    ctx.fillText(fmtv(it.value), W - 4, y);
  });
}

export function spark(cv, vals, color) {
  const W = cv.clientWidth || 80, H = cv.clientHeight || 18, dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return;
  const lo = Math.min(...v), hi = Math.max(...v);
  ctx.strokeStyle = color || css("--ink2"); ctx.lineWidth = 1.2;
  ctx.beginPath();
  v.forEach((x, i) => { const px = (i / (v.length - 1)) * (W - 2) + 1, py = H - 2 - ((x - lo) / (hi - lo || 1)) * (H - 4); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
}
