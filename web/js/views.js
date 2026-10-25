// swift · @negvol — view types. Each: {name, defaults(), mount(el, cfg, ctx) -> {refresh, destroy, png?}, edit(cfg, ctx, done)}.
// ctx: {app, panel, setTitle(s), openChart(id, name), save()}
import { catalog, curve as getCurve, nameOf, quotes as getQuotes, series, table as getTable } from "./api.js";
import { compute, word, BIAS_TF } from "./bias.js";
import { DAY, RANGES, TRANSFORMS, clip, fmt, fmtDate, rangeStart, snapshot, transform, valueAt } from "./calc.js";
import { Chart, PALETTE, css, hbars, spark } from "./chart.js";
import { gauge, h, inp, modal, sel } from "./dom.js";
import { pickFeed } from "./picker.js";

const INTRADAY = /^(yahooi|caiso|kp):/;
const ago = (t) => { const s = (Date.now() - t * 1000) / 1000; return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

function rangeChips(cur, on, keys = Object.keys(RANGES)) {
  return h("div.chips.small", keys.map((k) => h("button.chip" + (k === cur ? ".on" : ""), { on: { click: () => on(k) } }, k)));
}

// ── chart ─────────────────────────────────────────────────────────────────────
const chart = {
  name: "Chart",
  defaults: () => ({ type: "chart", title: "", range: "1Y", series: [], refs: [] }),
  mount(el, cfg, ctx) {
    const sub = h("div.view-sub"), body = h("div.chart-host");
    el.append(sub, body);
    const ch = new Chart(body);
    let data = [];
    const draw = () => {
      const pal = PALETTE();
      let lastT = -Infinity;
      for (const d of data) if (d.pts.length) lastT = Math.max(lastT, d.pts.at(-1)[0]);
      const x0 = rangeStart(cfg.range, lastT);
      const ser = data.map((d, i) => {
        let pts = d.pts;
        if (d.s.tf === "rebase") { const b = valueAt(pts, x0) ?? clip(pts, x0)[0]?.[1]; pts = b ? pts.map((p) => [p[0], (100 * p[1]) / b]) : pts; }
        const style = d.s.style || (data.length === 1 ? "area" : "line");
        return { label: d.s.label || d.name, points: pts, color: d.s.color || pal[i % pal.length], axis: d.s.axis || "L", style };
      });
      ch.view = null;
      ch.set({ series: ser, x0, refs: (cfg.refs || []).map((r) => ({ ...r, y: +r.y })), intraday: data.some((d) => INTRADAY.test(d.s.id)),
        empty: cfg.series.length ? "loading…" : "no series — use ⚙ to add" });
    };
    const header = () => {
      const errs = data.filter((d) => d.err).map((d) => `${d.s.label || d.s.id}: ${d.err}`);
      const last = Math.max(0, ...data.map((d) => d.pts.at(-1)?.[0] ?? 0));
      sub.replaceChildren(
        h("span.muted", data.map((d) => d.s.label || d.name).join(" · ").slice(0, 120) || "–"),
        errs.length ? h("span.err", { title: errs.join("\n") }, ` ⚠ ${errs.length} failed`) : "",
        last ? h("span.muted", `  last ${fmtDate(last, data.some((d) => INTRADAY.test(d.s.id)))}`) : "",
        h("span.grow"),
        rangeChips(cfg.range, (k) => { cfg.range = k; ctx.save(); header(); draw(); }));
    };
    const refresh = async (force) => {
      const res = await Promise.all(cfg.series.map(async (s) => {
        try {
          const d = await series(s.id, force);
          const pts = s.tf && s.tf !== "none" && s.tf !== "rebase" ? transform(d.points, s.tf, s.n || 20) : d.points;
          const name = await nameOf(s.id);
          return { s, pts, name: name || d.name || s.id, err: d.points.length ? null : d.error || "no data" };
        } catch (e) { return { s, pts: [], name: s.id, err: e.message }; }
      }));
      data = res;
      header(); draw();
    };
    header(); draw(); refresh();
    return { refresh, destroy: () => ch.destroy(), png: () => ch.png(cfg.title || data.map((d) => d.s.label || d.name).join(" / "),
      `${data.map((d) => d.s.id).join(", ")} · ${new Date().toISOString().slice(0, 16)} UTC · swift @negvol`) };
  },
  edit(cfg, ctx, done) {
    const rows = h("div.ed-rows");
    const render = () => rows.replaceChildren(...cfg.series.map((s, i) => h("div.ed-row",
      inp(s.id, (v) => (s.id = v), { class: "ed-id", title: "series id or =expression" }),
      inp(s.label, (v) => (s.label = v), { placeholder: "label", class: "ed-lab" }),
      sel(TRANSFORMS, s.tf || "none", (v) => (s.tf = v)),
      inp(s.n || 20, (v) => (s.n = v), { type: "number", class: "ed-n", title: "n" }),
      sel({ L: "left axis", R: "right axis" }, s.axis || "L", (v) => (s.axis = v)),
      sel({ "": "auto", line: "line", area: "area", bars: "bars", signbars: "± bars", step: "step", signarea: "± area" }, s.style || "", (v) => (s.style = v || undefined)),
      h("button.icon", { title: "up", on: { click: () => { if (i) { cfg.series.splice(i - 1, 0, cfg.series.splice(i, 1)[0]); render(); } } } }, "↑"),
      h("button.icon", { title: "remove", on: { click: () => { cfg.series.splice(i, 1); render(); } } }, "✕"))));
    render();
    const refs = inp((cfg.refs || []).map((r) => r.y + (r.label ? ":" + r.label : "")).join(", "),
      (v) => (cfg.refs = v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [y, label] = x.split(":"); return { y: +y, label, axis: "L" }; })),
      { placeholder: "reference lines e.g. 1, 0:zero, 20:VIX 20" });
    const m = modal("Chart settings", [
      h("label", "title ", inp(cfg.title, (v) => (cfg.title = v), { placeholder: "tab title" })),
      h("div.ed-head", "series"), rows,
      h("button.btn", { on: { click: () => pickFeed("series", (id, name) => { cfg.series.push({ id, label: name || "", tf: "none" }); render(); }) } }, "+ add series"),
      h("div.ed-head", "reference lines"), refs,
      h("div.ed-foot", h("button.btn.primary", { on: { click: () => { m.close(); done(); } } }, "Apply")),
    ], { wide: true });
  },
};

// ── yield curve ───────────────────────────────────────────────────────────────
const curveView = {
  name: "Yield curve",
  defaults: () => ({ type: "curve", title: "UST curve", show: ["latest", "1 month", "1 year"] }),
  mount(el, cfg, ctx) {
    const sub = h("div.view-sub"), body = h("div.chart-host");
    el.append(sub, body);
    const ch = new Chart(body);
    let d = null;
    const draw = () => {
      if (!d) return;
      const pal = [css("--ink"), css("--s2"), css("--s3"), css("--s4"), css("--s5")];
      const ser = d.curves.filter((c) => cfg.show.includes(c.label)).map((c, i) => ({
        label: `${c.label} (${c.date})`, color: pal[d.curves.indexOf(c)] || pal[i], axis: "L", style: "line", width: c.label === "latest" ? 2 : 1.2,
        points: c.values.map((v, k) => [d.years[k], v]).filter((p) => p[1] != null), noTag: c.label !== "latest" }));
      ch.set({ series: ser, xMode: "linear", xMin: d.years[0], xMax: 30, xScale: Math.sqrt,
        xTicks: d.tenors.map((t, k) => [d.years[k], t.replace(" Mo", "m").replace(" Yr", "y")]).filter((t) => !["2m", "4m"].includes(t[1])) });
    };
    const refresh = async () => {
      try { d = await getCurve(); } catch (e) { sub.textContent = "curve failed: " + e.message; return; }
      sub.replaceChildren(h("span.muted", "UST par yields · Treasury daily CSV"), h("span.grow"),
        h("div.chips.small", d.curves.map((c) => h("button.chip" + (cfg.show.includes(c.label) ? ".on" : ""), { on: { click: () => {
          cfg.show = cfg.show.includes(c.label) ? cfg.show.filter((x) => x !== c.label) : [...cfg.show, c.label]; ctx.save(); refresh(); } } }, c.label))));
      draw();
    };
    refresh();
    return { refresh, destroy: () => ch.destroy(), png: () => ch.png("US Treasury par yield curve", "home.treasury.gov · swift @negvol") };
  },
};

// ── table ─────────────────────────────────────────────────────────────────────
const IMPACT = { High: "imp-high", Medium: "imp-med", Low: "imp-low", Holiday: "imp-low" };
const tableView = {
  name: "List feed",
  defaults: () => ({ type: "table", id: "calendar:thisweek", title: "" }),
  mount(el, cfg, ctx) {
    const sub = h("div.view-sub"), wrap = h("div.table-wrap");
    el.append(sub, wrap);
    let d = null, sortK = null, sortD = 1;
    const filter = inp(cfg.filter || "", (v) => { cfg.filter = v; ctx.save(); render(); }, { placeholder: "filter…", class: "filter" });
    filter.addEventListener("input", (e) => { cfg.filter = e.target.value; render(); });
    const render = () => {
      if (!d) return;
      if (d.error && !d.rows) { wrap.replaceChildren(h("div.empty.err", d.error)); return; }
      const f = (cfg.filter || "").toLowerCase();
      let rows = d.rows.filter((r) => !f || Object.values(r).join(" ").toLowerCase().includes(f));
      if (sortK) rows = [...rows].sort((a, b) => (a[sortK] > b[sortK] ? 1 : a[sortK] < b[sortK] ? -1 : 0) * sortD);
      const isCal = cfg.id.startsWith("calendar");
      const now = Date.now();
      let marked = false;
      wrap.replaceChildren(h("table.tbl",
        h("thead", h("tr", d.columns.map((c) => h("th" + (c.num ? ".num" : ""), { on: { click: () => { sortD = sortK === c.key ? -sortD : c.num ? -1 : 1; sortK = c.key; render(); } } },
          c.label, sortK === c.key ? (sortD > 0 ? " ▲" : " ▼") : "")))),
        h("tbody", rows.map((r) => {
          let cls = "";
          if (isCal) {
            const t = Date.parse(r._ts);
            if (!marked && t > now) { cls = "next"; marked = true; }
            if (t < now) cls += " past";
          }
          return h("tr" + (r._url || r._series ? ".link" : ""), {
            class: cls, title: r._series ? "click to chart" : r._url || "",
            on: { click: () => { if (r._series) ctx.openChart(r._series, r.market || r.symbol || r.article || r.country); else if (r._url) window.open(r._url, "_blank", "noopener"); } } },
            d.columns.map((c) => {
              const v = r[c.key];
              const txt = c.num ? fmt(typeof v === "string" ? parseFloat(v) : v, Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 1 : 2)
                : v && typeof v === "object" ? v.name || JSON.stringify(v) : v ?? "";
              const ic = c.key === "impact" ? IMPACT[v] : c.key === "chg" && v != null ? (v >= 0 ? "pos" : "neg") : "";
              return h("td" + (c.num ? ".num" : ""), { class: ic || "" }, txt);
            }));
        }))));
      sub.replaceChildren(filter, h("span.muted", ` ${rows.length} rows`), d.asof ? h("span.muted", ` · ${ago(d.asof)}`) : "",
        d.stale ? h("span.err", " · stale: " + (d.error || "")) : "");
    };
    const refresh = async () => {
      try { d = await getTable(cfg.id); } catch (e) { d = { error: e.message }; }
      render();
    };
    refresh();
    return { refresh, destroy() {} };
  },
  async edit(cfg, ctx, done) {
    pickFeed("table", (id, name) => { cfg.id = id; cfg.title = name; done(); });
  },
};

// ── stats table ──────────────────────
const RATEY = /^(fred:(DGS|T10Y|T5Y|DFII|DFF|BAML|MORTGAGE|SOFR|EFFR|UNRATE|SAHM)|nyfed:|ecb:(FM|YC))/;
const statsView = {
  name: "Stats",
  defaults: () => ({ type: "stats", title: "Snapshot", ids: ["yahoo:ES=F", "cboe:VIX", "fred:DGS10"] }),
  mount(el, cfg, ctx) {
    const sub = h("div.view-sub"), wrap = h("div.table-wrap");
    el.append(sub, wrap);
    sub.append(h("span.muted", "Δ in bp for rates/spreads, % otherwise · z = vs last 12m"));
    const refresh = async () => {
      const cat = await catalog();
      const rows = await Promise.all(cfg.ids.map(async (id) => {
        const d = await series(id).catch((e) => ({ points: [], error: e.message }));
        const s = snapshot(d.points);
        const name = cat.series.find((x) => x.id === id)?.name || d.name || id;
        const bp = RATEY.test(id) || /%|Percent/.test(d.unit || "");
        const ch = (b) => (s && b != null ? (bp ? (s.v - b) * 100 : (100 * (s.v / b - 1))) : null);
        return { id, name, s, bp, d1: ch(s?.d1), w1: ch(s?.w1), m1: ch(s?.m1), y1: ch(s?.y1), err: d.error };
      }));
      const cell = (v, bp) => h("td.num", { class: v == null ? "" : v >= 0 ? "pos" : "neg" }, v == null ? "–" : (v >= 0 ? "+" : "") + fmt(v, bp ? 0 : 2) + (bp ? "" : "%"));
      wrap.replaceChildren(h("table.tbl.stats",
        h("thead", h("tr", h("th", ""), h("th.num", "last"), h("th.num", "1d"), h("th.num", "1w"), h("th.num", "1m"), h("th.num", "1y"), h("th.num", "z"), h("th.num", "as of"))),
        h("tbody", rows.map((r) => h("tr.link", { title: r.err || r.id, on: { click: () => ctx.openChart(r.id, r.name) } },
          h("td", r.name), h("td.num", r.s ? fmt(r.s.v) : r.err ? "err" : "…"), cell(r.d1, r.bp), cell(r.w1, r.bp), cell(r.m1, r.bp), cell(r.y1, r.bp),
          h("td.num", { class: r.s?.z == null ? "" : Math.abs(r.s.z) > 2 ? "hot" : "" }, r.s?.z == null ? "–" : fmt(r.s.z, 2)),
          h("td.num.muted", r.s ? fmtDate(r.s.t) : ""))))));
    };
    refresh();
    return { refresh, destroy() {} };
  },
  edit(cfg, ctx, done) {
    const rows = h("div.ed-rows");
    const render = () => rows.replaceChildren(...cfg.ids.map((id, i) => h("div.ed-row", inp(id, (v) => (cfg.ids[i] = v), { class: "ed-id" }),
      h("button.icon", { on: { click: () => { cfg.ids.splice(i, 1); render(); } } }, "✕"))));
    render();
    const m = modal("Stats rows", [rows,
      h("button.btn", { on: { click: () => pickFeed("series", (id) => { cfg.ids.push(id); render(); }) } }, "+ add row"),
      h("div.ed-foot", h("button.btn.primary", { on: { click: () => { m.close(); done(); } } }, "Apply"))]);
  },
};

// ── bias ──────────────────────────────────────────────────────────────────────

const biasView = {
  name: "Bias",
  defaults: () => ({ type: "bias", key: "vol", range: "2Y" }),
  mount(el, cfg, ctx) {
    const head = h("div.bias-head"), sub = h("div.view-sub"), body = h("div.chart-host.bias-hist"), cwrap = h("div.contrib"), cv = h("canvas");
    cwrap.append(cv);
    el.append(head, sub, body, cwrap, h("div.foot-note", "Descriptive composite of where inputs sit vs their own history — not a tested signal."));
    const ch = new Chart(body);
    let r = null;
    const draw = () => {
      if (!r) return;
      const lastT = r.history.at(-1)?.[0] ?? Date.now();
      ch.set({ series: [{ label: "score", points: r.history, color: css("--ink"), style: "signarea", axis: "L" }],
        x0: rangeStart(cfg.range, lastT), yMin: -100, yMax: 100, refs: [{ y: 50, color: css("--ref"), label: "+50" }, { y: -50, color: css("--ref"), label: "−50" }],
        legend: false });
      hbars(cv, r.items.map((i) => ({ label: `${i.sign < 0 ? "−" : "+"}${i.w} · ${i.label}`, value: i.contrib == null ? null : i.contrib * 100 / 2, dim: !!i.error })),
        { maxAbs: Math.max(10, ...r.items.map((i) => Math.abs((i.contrib ?? 0) * 50))), fmtv: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) });
    };
    const refresh = async () => {
      const comp = ctx.app.composite(cfg.key);
      if (!comp) { head.textContent = "unknown composite " + cfg.key; return; }
      ctx.setTitle(comp.name);
      head.replaceChildren(h("span.muted", "computing…"));
      r = await compute(comp);
      const s = r.score;
      head.replaceChildren(
        h("div.bias-score", { class: s == null ? "" : s >= 0 ? "pos" : "neg" }, s == null ? "–" : (s >= 0 ? "+" : "") + s.toFixed(0)),
        h("div.bias-meta",
          h("div", h("b", comp.name), h("span.muted", ` · ${word(s)} ${s == null ? "" : s >= 0 ? comp.plus : comp.minus}`)),
          gauge(s),
          h("div.muted", `+ = ${comp.plus} · agreement ${r.agree == null ? "–" : r.agree.toFixed(0) + "%"} · coverage ${(r.coverage * 100).toFixed(0)}% · z over ${Math.round(comp.lookback / 365)}y`)),
        h("button.btn.small", { on: { click: () => ctx.app.editBias(cfg.key) } }, "edit inputs"));
      const errs = r.items.filter((i) => i.error);
      sub.replaceChildren(h("span.muted", "score history"), errs.length ? h("span.err", { title: errs.map((e) => `${e.label}: ${e.error}`).join("\n") }, ` ⚠ ${errs.length} inputs missing`) : "",
        h("span.grow"), rangeChips(cfg.range, (k) => { cfg.range = k; ctx.save(); draw(); }, ["6M", "1Y", "2Y", "5Y", "MAX"]));
      draw();
    };
    const ro = new ResizeObserver(() => r && draw());
    ro.observe(cwrap);
    refresh();
    return { refresh, destroy: () => { ch.destroy(); ro.disconnect(); }, png: () => ch.png(ctx.app.composite(cfg.key)?.name + " bias score", "swift @negvol · descriptive composite, untested") };
  },
  edit(cfg, ctx, done) {
    const comps = Object.fromEntries(ctx.app.state.composites.map((c) => [c.key, c.name]));
    const m = modal("Bias view", [h("label", "composite ", sel(comps, cfg.key, (v) => (cfg.key = v))),
      h("div.ed-foot", h("button.btn", { on: { click: () => { m.close(); ctx.app.editBias(cfg.key); } } }, "edit composite inputs…"),
        h("button.btn.primary", { on: { click: () => { m.close(); done(); } } }, "Apply"))]);
  },
};

const boardView = {
  name: "Bias board",
  defaults: () => ({ type: "biasboard", title: "Bias board" }),
  mount(el, cfg, ctx) {
    const wrap = h("div.board");
    el.append(h("div.view-sub", h("span.muted", "score −100…+100 · 6m history · click a row to open"), h("span.grow"),
      h("button.btn.small", { on: { click: () => ctx.app.editBias() } }, "edit composites")), wrap, h("div.foot-note", "Descriptive composites, not tested signals."));
    const refresh = async () => {
      const comps = ctx.app.state.composites;
      wrap.replaceChildren(...comps.map((c) => h("div.board-row", { "data-k": c.key }, h("span.board-name", c.name), h("span.muted", "…"))));
      await Promise.all(comps.map(async (c) => {
        const r = await compute(c);
        const row = wrap.querySelector(`[data-k="${c.key}"]`);
        if (!row) return;
        const cv = h("canvas.spark");
        const s = r.score;
        row.replaceChildren(
          h("span.board-name", c.name),
          h("span.board-score", { class: s == null ? "" : s >= 0 ? "pos" : "neg" }, s == null ? "–" : (s >= 0 ? "+" : "") + s.toFixed(0)),
          gauge(s), cv,
          h("span.board-word.muted", s == null ? "" : `${word(s)} · ${s >= 0 ? c.plus : c.minus}`));
        row.onclick = () => ctx.app.addTab(ctx.panel, { type: "bias", key: c.key, range: "2Y" });
        requestAnimationFrame(() => spark(cv, r.history.slice(-130).map((p) => p[1]), s >= 0 ? css("--up") : css("--down")));
      }));
    };
    refresh();
    return { refresh, destroy() {} };
  },
};

// ── quotes (Yahoo, delayed) ──────────────────────────────────────────────────
const quotesView = {
  name: "Quotes",
  defaults: () => ({ type: "quotes", title: "Futures", symbols: ["ES=F", "NQ=F", "RTY=F", "^VIX", "ZN=F", "CL=F", "GC=F", "HG=F", "DX-Y.NYB", "EURUSD=X", "USDJPY=X", "BTC-USD"] }),
  mount(el, cfg, ctx) {
    const wrap = h("div.table-wrap"), sub = h("div.view-sub");
    el.append(sub, wrap);
    const refresh = async () => {
      let r;
      try { r = await getQuotes(cfg.symbols); } catch (e) { sub.textContent = e.message; return; }
      sub.replaceChildren(h("span.muted", `Yahoo · delayed (CME ~10 min) · ${ago(r.asof)}`));
      wrap.replaceChildren(h("table.tbl", h("tbody", cfg.symbols.map((s) => {
        const q = r.quotes[s] || {};
        const cv = h("canvas.spark");
        requestAnimationFrame(() => spark(cv, q.spark || [], q.chg >= 0 ? css("--up") : css("--down")));
        return h("tr.link", { on: { click: () => ctx.openChart("yahoo:" + s, q.name) } },
          h("td", h("b", s), h("div.muted.tiny", q.name || q.error || "")), h("td.num", fmt(q.price)),
          h("td.num", { class: q.chg >= 0 ? "pos" : "neg" }, q.chg == null ? "–" : (q.chg >= 0 ? "+" : "") + q.chg.toFixed(2) + "%"), h("td", cv));
      }))));
    };
    refresh();
    const iv = setInterval(refresh, 30000);
    return { refresh, destroy: () => clearInterval(iv) };
  },
  edit(cfg, ctx, done) {
    const m = modal("Quote symbols (Yahoo)", [inp(cfg.symbols.join(", "), (v) => (cfg.symbols = v.split(/[,\s]+/).filter(Boolean)), { class: "wide-in" }),
      h("div.ed-foot", h("button.btn.primary", { on: { click: () => { m.close(); done(); } } }, "Apply"))]);
  },
};

// ── live crypto (Binance websocket) ─────────────────────────────────────────
const liveView = {
  name: "Live crypto",
  defaults: () => ({ type: "live", title: "Live crypto", symbols: ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "bnbusdt", "dogeusdt"] }),
  mount(el, cfg) {
    const sub = h("div.view-sub", h("span.muted", "Binance websocket · real-time")), wrap = h("div.table-wrap");
    el.append(sub, wrap);
    const st = {}, rows = {};
    const tb = h("tbody");
    wrap.append(h("table.tbl", tb));
    for (const s of cfg.symbols) {
      const cv = h("canvas.spark");
      rows[s] = { px: h("td.num", "…"), ch: h("td.num", ""), cv };
      st[s] = [];
      tb.append(h("tr", h("td", h("b", s.toUpperCase().replace("USDT", "")), h("span.muted", "/USDT")), rows[s].px, rows[s].ch, h("td", cv)));
    }
    let ws, dead = false;
    const open = () => {
      ws = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + cfg.symbols.map((s) => s + "@miniTicker").join("/"));
      ws.onmessage = (e) => {
        const d = JSON.parse(e.data).data, s = d.s.toLowerCase(), r = rows[s];
        if (!r) return;
        const px = +d.c, prev = st[s].at(-1);
        st[s].push(px); if (st[s].length > 300) st[s].shift();
        r.px.textContent = fmt(px);
        r.px.className = "num " + (prev == null ? "" : px > prev ? "flash-up" : px < prev ? "flash-down" : "");
        const chg = 100 * (px / +d.o - 1);
        r.ch.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
        r.ch.className = "num " + (chg >= 0 ? "pos" : "neg");
        spark(r.cv, st[s], css("--ink2"));
      };
      ws.onclose = () => { if (!dead) { sub.replaceChildren(h("span.err", "websocket closed — reconnecting")); setTimeout(open, 3000); } };
      ws.onopen = () => sub.replaceChildren(h("span.muted", "Binance websocket · real-time · 24h change"));
    };
    open();
    return { refresh() {}, destroy: () => { dead = true; ws?.close(); } };
  },
  edit: quotesView.edit,
};

// ── live TV ──────────────────────────────────────────────────────────────────
const tvView = {
  name: "Live TV",
  defaults: () => ({ type: "tv", title: "Bloomberg TV", channel: "UC_vQ72b7v5n2938v9d5c80w" }),
  mount(el, cfg, ctx) {
    const sub = h("div.view-sub"), frame = h("iframe.tv", { allow: "autoplay; encrypted-media; picture-in-picture", allowfullscreen: true });
    el.append(sub, h("div.img-host", frame));
    const load = () => { frame.src = `https://www.youtube-nocookie.com/embed/live_stream?channel=${cfg.channel}&autoplay=1&mute=1`; };
    catalog().then((cat) => sub.replaceChildren(sel(Object.fromEntries(cat.tv.map((t) => [t.channel, t.name])), cfg.channel, (v) => {
      cfg.channel = v; cfg.title = cat.tv.find((t) => t.channel === v).name; ctx.setTitle(cfg.title); ctx.save(); load(); }), h("span.muted", "  YouTube live, muted")));
    load();
    return { refresh() {}, destroy: () => { frame.src = "about:blank"; } };
  },
};

import { optionsView } from "./options_view.js";
import { topologyView } from "./topology.js";

export const VIEWS = { chart, curve: curveView, table: tableView, stats: statsView, bias: biasView, biasboard: boardView,
  options: optionsView, topology: topologyView, quotes: quotesView, live: liveView, tv: tvView };
