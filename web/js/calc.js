// Series maths: alignment, expressions, transforms, summary stats.
// A series here is an array of [epoch_ms, value] sorted by time.

export const DAY = 86400000;

export function bisect(pts, t) {            // index of last point with time <= t, or -1
  let lo = 0, hi = pts.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (pts[m][0] <= t) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

export function valueAt(pts, t) {
  const i = bisect(pts, t);
  return i < 0 ? null : pts[i][1];
}

// Union grid of all timestamps, each series forward-filled (never back-filled).
export function align(list) {
  const set = new Set();
  for (const s of list) for (const p of s) set.add(p[0]);
  const grid = [...set].sort((a, b) => a - b);
  const cols = list.map((s) => {
    const out = new Array(grid.length).fill(null);
    let j = 0, last = null;
    for (let i = 0; i < grid.length; i++) {
      while (j < s.length && s[j][0] <= grid[i]) { last = s[j][1]; j++; }
      out[i] = last;
    }
    return out;
  });
  return { grid, cols };
}

// ── expressions: "=[fred:WALCL]/1e6 - [fred:WTREGEN]/1e6" ─────────────────────
export const isExpr = (id) => typeof id === "string" && id.startsWith("=");
export const refsOf = (id) => (isExpr(id) ? [...id.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]) : [id]);

function tokenize(src) {
  const out = [...src.matchAll(/\[[^\]]+\]|\d*\.?\d+(?:e[+-]?\d+)?|[-+*/^()]/gi)].map((m) => m[0]);
  if (out.join("").replace(/\s/g, "") !== src.replace(/\s/g, "")) throw new Error("cannot parse expression");
  return out;
}

function toRPN(tokens) {             // shunting-yard; "u-" is unary minus
  const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3, "u-": 4 };
  const right = new Set(["^", "u-"]);
  const out = [], ops = [];
  let expectOperand = true;
  for (const t of tokens) {
    if (t.startsWith("[") || /^[\d.]/.test(t)) { out.push(t); expectOperand = false; }
    else if (t === "(") { ops.push(t); expectOperand = true; }
    else if (t === ")") { while (ops.length && ops.at(-1) !== "(") out.push(ops.pop()); ops.pop(); expectOperand = false; }
    else {
      const op = t === "-" && expectOperand ? "u-" : t;
      while (ops.length && ops.at(-1) !== "(" &&
             (prec[ops.at(-1)] > prec[op] || (prec[ops.at(-1)] === prec[op] && !right.has(op)))) out.push(ops.pop());
      ops.push(op);
      expectOperand = true;
    }
  }
  while (ops.length) out.push(ops.pop());
  return out;
}

export function evalExpr(id, data) {          // data: {ref: points}
  const rpn = toRPN(tokenize(id.slice(1)));
  const refs = [...new Set(refsOf(id))];
  const missing = refs.filter((r) => !data[r] || !data[r].length);
  if (missing.length) throw new Error("no data for " + missing.join(", "));
  const { grid, cols } = align(refs.map((r) => data[r]));
  const col = Object.fromEntries(refs.map((r, i) => [r, cols[i]]));
  const out = [];
  for (let i = 0; i < grid.length; i++) {
    const st = [];
    let bad = false;
    for (const t of rpn) {
      if (t.startsWith("[")) { const v = col[t.slice(1, -1)][i]; if (v == null) { bad = true; break; } st.push(v); }
      else if (/^[\d.]/.test(t)) st.push(parseFloat(t));
      else if (t === "u-") st.push(-st.pop());
      else {
        const b = st.pop(), a = st.pop();
        st.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b : t === "/" ? a / b : a ** b);
      }
    }
    if (!bad && st.length === 1 && Number.isFinite(st[0])) out.push([grid[i], st[0]]);
  }
  return out;
}

// ── transforms ────────────────────────────────────────────────────────────────
export const TRANSFORMS = {
  none: "level", chg: "change (n obs)", pct: "% change (n obs)", yoy: "% y/y", z: "z-score (n obs)",
  pctile: "percentile (n obs)", sma: "moving avg (n)", dev: "% from n-avg", rv: "realised vol (n, ann. %)",
  rebase: "rebased =100 at range start", diff1: "first difference (bars)",
};

export function transform(pts, tf, n = 20) {
  n = Math.max(1, n | 0);
  const out = [];
  switch (tf) {
    case "chg": for (let i = n; i < pts.length; i++) out.push([pts[i][0], pts[i][1] - pts[i - n][1]]); return out;
    case "diff1": for (let i = 1; i < pts.length; i++) out.push([pts[i][0], pts[i][1] - pts[i - 1][1]]); return out;
    case "pct": for (let i = n; i < pts.length; i++) if (pts[i - n][1]) out.push([pts[i][0], 100 * (pts[i][1] / pts[i - n][1] - 1)]); return out;
    case "yoy":
      for (const p of pts) { const v = valueAt(pts, p[0] - 365 * DAY + DAY * 3); if (v && p[0] - pts[0][0] > 360 * DAY) out.push([p[0], 100 * (p[1] / v - 1)]); }
      return out;
    case "sma": case "dev": {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        s += pts[i][1]; if (i >= n) s -= pts[i - n][1];
        if (i >= n - 1) { const m = s / n; out.push([pts[i][0], tf === "sma" ? m : 100 * (pts[i][1] / m - 1)]); }
      }
      return out;
    }
    case "z": {
      let s = 0, q = 0;
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i][1]; s += v; q += v * v;
        if (i >= n) { const o = pts[i - n][1]; s -= o; q -= o * o; }
        if (i >= n - 1) { const m = s / n, sd = Math.sqrt(Math.max(q / n - m * m, 1e-18)); out.push([pts[i][0], (v - m) / sd]); }
      }
      return out;
    }
    case "pctile":
      for (let i = n - 1; i < pts.length; i++) {
        let c = 0; const v = pts[i][1];
        for (let k = i - n + 1; k <= i; k++) if (pts[k][1] <= v) c++;
        out.push([pts[i][0], (100 * c) / n]);
      }
      return out;
    case "rv": {
      const r = [];
      for (let i = 1; i < pts.length; i++) if (pts[i - 1][1] > 0 && pts[i][1] > 0) r.push([pts[i][0], Math.log(pts[i][1] / pts[i - 1][1])]);
      let s = 0, q = 0;
      for (let i = 0; i < r.length; i++) {
        s += r[i][1]; q += r[i][1] ** 2;
        if (i >= n) { s -= r[i - n][1]; q -= r[i - n][1] ** 2; }
        if (i >= n - 1) { const m = s / n; out.push([r[i][0], 100 * Math.sqrt(Math.max(q / n - m * m, 0) * 252)]); }
      }
      return out;
    }
    default: return pts;
  }
}

export const RANGES = { "1D": 1, "5D": 5, "1M": 31, "3M": 92, "6M": 183, YTD: -1, "1Y": 366, "2Y": 731, "5Y": 1827, "10Y": 3653, MAX: 0 };

export function rangeStart(r, lastT) {
  const d = RANGES[r];
  if (d === -1) return Date.UTC(new Date(lastT).getUTCFullYear(), 0, 1);
  return d ? lastT - d * DAY : -Infinity;
}

export function clip(pts, t0) {
  const i = Math.max(0, bisect(pts, t0));
  return pts.slice(pts[i] && pts[i][0] < t0 ? i + 1 : i);
}

// ── snapshot stats for the stats table ──────────────────────────────────────
export function snapshot(pts) {
  if (!pts.length) return null;
  const [t, v] = pts.at(-1);
  const back = (d) => valueAt(pts, t - d * DAY);
  const yr = clip(pts, t - 365 * DAY).map((p) => p[1]);
  const m = yr.reduce((a, b) => a + b, 0) / yr.length;
  const sd = Math.sqrt(yr.reduce((a, b) => a + (b - m) ** 2, 0) / yr.length);
  const prev = pts.length > 1 ? pts.at(-2)[1] : null;
  return { t, v, d1: prev, w1: back(7), m1: back(30), y1: back(365), z: sd ? (v - m) / sd : null };
}

export const fmt = (v, d) => {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (d == null) d = a >= 1e5 ? 0 : a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 5;
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6 && d === 0) return (v / 1e6).toFixed(2) + "M";
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const fmtDate = (t, intraday) => {
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return intraday ? d.toISOString().slice(5, 16).replace("T", " ") : d.toISOString().slice(0, 10);
};
