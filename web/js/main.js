// swift · @negvol — app shell: menu bar, ticker strip, workspace tabs, panel grid (tabs per panel), dialogs,
// persistence (localStorage + layouts/layout.json via the server), themes, feed health.
import { health, onHealth, quotes as getQuotes } from "./api.js";
import { BIAS_TF, DEFAULT_COMPOSITES, compute } from "./bias.js";
import { fmt } from "./calc.js";
import { h, inp, modal, sel } from "./dom.js";
import { DEFAULT_TICKER, DEFAULT_WORKSPACES } from "./layout.js";
import { pickFeed } from "./picker.js";
import { VIEWS } from "./views.js";

const KEY = "swift.state.v1";
const THEMES = { onyx: "Onyx Navy", graphite: "Graphite", paper: "Paper" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const defaults = () => ({ v: 1, workspaces: clone(DEFAULT_WORKSPACES), active: 0, composites: clone(DEFAULT_COMPOSITES), ticker: [...DEFAULT_TICKER], theme: "onyx" });

const app = {
  state: null,
  mounted: [],
  composite: (k) => app.state.composites.find((c) => c.key === k),

  async load() {
    let st = null;
    try { st = JSON.parse(localStorage.getItem(KEY)); } catch { /* storage blocked */ }
    try { app.hosted = (await fetch("/api/config").then((r) => r.json())).hosted; } catch { /* older server */ }
    if (!st && !app.hosted) { try { st = await fetch("/api/layout").then((r) => r.json()); } catch { /* none saved */ } }
    app.state = st && st.v === 1 ? st : defaults();
    // migration: offer default workspaces added after this layout was saved (once each)
    const seen = (app.state.seenWorkspaces ||= app.state.workspaces.map((w) => w.name));
    for (const w of DEFAULT_WORKSPACES) if (!seen.includes(w.name)) { app.state.workspaces.push(clone(w)); seen.push(w.name); }
  },
  save: (() => {
    let t;
    return () => {
      try { localStorage.setItem(KEY, JSON.stringify(app.state)); } catch { /* storage blocked */ }
      clearTimeout(t);
      if (app.hosted) return;   // hosted: each visitor keeps their own layout in their browser
      t = setTimeout(() => fetch("/api/layout", { method: "POST", body: JSON.stringify(app.state) }).catch(() => {}), 1500);
    };
  })(),

  ws: () => app.state.workspaces[app.state.active] || app.state.workspaces[0],

  render() {
    document.documentElement.dataset.theme = app.state.theme;
    renderTabs();
    renderGrid();
    renderStatus();
  },

  addTab(panel, view) {
    panel.tabs.push(view);
    panel.active = panel.tabs.length - 1;
    app.save(); renderGrid();
  },

  editBias(key) { biasEditor(key); },
};
window.swift = app;   // console access for debugging

// ── menu bar ──────────────────────────────────────────────────────────────────
function menu(label, items) {
  const drop = h("div.menu-drop", items.map(([t, f]) => t === "-" ? h("div.menu-sep") :
    h("div.menu-item", { on: { click: () => { closeMenus(); f(); } } }, t)));
  const m = h("div.menu", h("span.menu-label", { on: { click: (e) => { const open = m.classList.contains("open"); closeMenus(); if (!open) m.classList.add("open"); e.stopPropagation(); } } }, label), drop);
  return m;
}
const closeMenus = () => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
document.addEventListener("click", closeMenus);

function newPanel(view, w = 6, hh = 8) {
  app.ws().panels.push({ w, h: hh, tabs: [view], active: 0 });
  app.save(); renderGrid();
  setTimeout(() => document.querySelector(".grid .panel:last-child")?.scrollIntoView({ behavior: "smooth" }), 50);
}

function chooseView(onView) {
  const m = modal("Add view", h("div.type-grid", Object.entries(VIEWS).map(([k, v]) => h("button.type-btn", { on: { click: () => {
    m.close();
    const cfg = v.defaults();
    if (k === "chart") pickFeed("series", (id, name) => { cfg.series = [{ id, label: name || "", tf: "none" }]; cfg.title = name || id; onView(cfg); });
    else if (k === "table") pickFeed("table", (id, name) => { cfg.id = id; cfg.title = name; onView(cfg); });
    else if (k === "bias") { const c = app.state.composites[0]; onView({ ...cfg, key: c.key }); }
    else onView(cfg);
  } } }, h("b", v.name), h("span.muted", k)))));
}

function buildMenubar() {
  const bar = document.getElementById("menubar");
  bar.replaceChildren(
    h("span.brand", "Swift"),
    menu("View", [["Add panel…", () => chooseView((v) => newPanel(v))], ["Add workspace", () => {
      const name = prompt("Workspace name", "New"); if (!name) return;
      app.state.workspaces.push({ name, panels: [] }); app.state.active = app.state.workspaces.length - 1; app.save(); app.render(); }],
      ["Rename workspace", () => { const n = prompt("Rename workspace", app.ws().name); if (n) { app.ws().name = n; app.save(); renderTabs(); } }],
      ["Delete workspace", () => { if (app.state.workspaces.length > 1 && confirm(`Delete workspace "${app.ws().name}"?`)) {
        app.state.workspaces.splice(app.state.active, 1); app.state.active = 0; app.save(); app.render(); } }],
      ["-"], ["Refresh all", () => refreshAll(true)]]),
    menu("Feeds", [["Chart a series…", () => pickFeed("series", (id, name) => newPanel(Object.assign(VIEWS.chart.defaults(), { title: name || id, series: [{ id, label: name || "", tf: "none" }] })))],
      ["Open a list feed…", () => pickFeed("table", (id, name) => newPanel({ type: "table", id, title: name }))],
      ["Feed health", feedHealth]]),
    menu("Bias", [["Add bias board", () => newPanel({ type: "biasboard", title: "Bias board" }, 4, 10)],
      ...app.state.composites.map((c) => [`Add ${c.name}`, () => newPanel({ type: "bias", key: c.key, range: "2Y" }, 4, 10)]),
      ["-"], ["Edit composites…", () => biasEditor()], ["Reset composites to defaults", () => {
        if (confirm("Replace all composites with the defaults?")) { app.state.composites = clone(DEFAULT_COMPOSITES); app.save(); buildMenubar(); renderGrid(); } }]]),
    menu("Layout", [["Edit ticker strip…", tickerEditor], ["Export JSON", () => {
      const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(app.state, null, 1)], { type: "application/json" })), download: "swift-layout.json" }); a.click(); }],
      ["Import JSON…", () => { const f = h("input", { type: "file", accept: ".json", on: { change: async () => {
        try { const st = JSON.parse(await f.files[0].text()); if (st.v !== 1) throw new Error("not a swift layout"); app.state = st; app.save(); buildMenubar(); app.render(); } catch (e) { alert(e.message); } } } }); f.click(); }],
      ["Reset to defaults", () => { if (confirm("Reset all workspaces, composites and ticker to defaults?")) { app.state = defaults(); app.save(); buildMenubar(); app.render(); } }]]),
    menu("Theme", Object.entries(THEMES).map(([k, n]) => [n, () => { app.state.theme = k; app.save(); app.render(); refreshAll(); }])),
    h("span.grow"),
    h("span.menu-note", h("b", "@negvol"), h("span.muted", " · not investment advice")));
}

// ── ticker strip ──────────────────────────────────────────────────────────────
let biasCache = {};
async function renderStrip() {
  const el = document.getElementById("strip");
  let q = {};
  try { q = (await getQuotes(app.state.ticker)).quotes; } catch { /* offline */ }
  const items = app.state.ticker.map((s) => {
    const x = q[s] || {};
    return h("span.strip-item", { title: x.name || s }, h("span.strip-lab", s.replace("=F", "").replace("=X", "").replace("^", "").replace("-USD", "")),
      h("span.strip-val", fmt(x.price)), h("span", { class: x.chg >= 0 ? "pos" : "neg" }, x.chg == null ? "" : (x.chg >= 0 ? "+" : "") + x.chg.toFixed(2) + "%"));
  });
  const bias = app.state.composites.map((c) => {
    const s = biasCache[c.key];
    return h("span.strip-item", { title: c.name }, h("span.strip-lab", c.key.toUpperCase()),
      h("span.strip-val", { class: s == null ? "" : s >= 0 ? "pos" : "neg" }, s == null ? "…" : (s >= 0 ? "+" : "") + s.toFixed(0)));
  });
  el.replaceChildren(...items, h("span.strip-sep"), h("span.strip-lab.muted", "BIAS"), ...bias);
}
async function refreshBias() {
  for (const c of app.state.composites) {
    try { biasCache[c.key] = (await compute(c)).score; } catch { biasCache[c.key] = null; }
    renderStrip();
  }
}

function tickerEditor() {
  const m = modal("Ticker strip (Yahoo symbols)", [inp(app.state.ticker.join(", "), (v) => (app.state.ticker = v.split(/[,\s]+/).filter(Boolean)), { class: "wide-in" }),
    h("div.ed-foot", h("button.btn.primary", { on: { click: () => { m.close(); app.save(); renderStrip(); } } }, "Apply"))]);
}

// ── workspace tabs ────────────────────────────────────────────────────────────
function renderTabs() {
  const el = document.getElementById("wstabs");
  el.replaceChildren(...app.state.workspaces.map((w, i) => h("button.wstab" + (i === app.state.active ? ".on" : ""), {
    on: { click: () => { app.state.active = i; app.save(); renderTabs(); renderGrid(); }, dblclick: () => { const n = prompt("Rename workspace", w.name); if (n) { w.name = n; app.save(); renderTabs(); } } } }, w.name)),
  h("button.wstab.add", { title: "add panel", on: { click: () => chooseView((v) => newPanel(v)) } }, "+ panel"));
}

// ── panels ────────────────────────────────────────────────────────────────────
let dragFrom = null;
function renderGrid() {
  for (const m of app.mounted) try { m.destroy(); } catch { /* ignore */ }
  app.mounted = [];
  const grid = document.getElementById("grid");
  const ws = app.ws();
  grid.replaceChildren(...ws.panels.map((p, idx) => panelEl(p, idx, ws)));
  if (!ws.panels.length) grid.append(h("div.empty-ws", "Empty workspace — View → Add panel, or Feeds → Chart a series"));
}

function panelEl(p, idx, ws) {
  p.active = Math.min(p.active || 0, p.tabs.length - 1);
  const view = p.tabs[p.active];
  const body = h("div.panel-body");
  const el = h("div.panel", { style: { gridColumn: `span ${p.w}`, gridRow: `span ${p.h}` } });
  const tabs = h("div.panel-tabs", { draggable: true,
    on: { dragstart: (e) => { dragFrom = idx; e.dataTransfer.effectAllowed = "move"; },
          dragover: (e) => { e.preventDefault(); el.classList.add("drop"); }, dragleave: () => el.classList.remove("drop"),
          drop: (e) => { e.preventDefault(); el.classList.remove("drop"); if (dragFrom != null && dragFrom !== idx) { const [x] = ws.panels.splice(dragFrom, 1); ws.panels.splice(idx, 0, x); app.save(); renderGrid(); } dragFrom = null; } } },
    h("div.ptabs", p.tabs.map((t, i) => h("button.ptab" + (i === p.active ? ".on" : ""), {
      title: "double-click to rename · middle-click to close",
      on: { click: () => { p.active = i; app.save(); renderGrid(); },
            dblclick: () => { const n = prompt("Tab title", tabTitle(t)); if (n != null) { t.title = n; app.save(); renderGrid(); } },
            auxclick: (e) => { if (e.button === 1 && p.tabs.length > 1) { p.tabs.splice(i, 1); app.save(); renderGrid(); } } } }, tabTitle(t)))),
    h("button.icon", { title: "add tab", on: { click: () => chooseView((v) => app.addTab(p, v)) } }, "+"),
    VIEWS[view.type]?.edit ? h("button.icon", { title: "settings", on: { click: () => VIEWS[view.type].edit(view, ctx, () => { app.save(); renderGrid(); }) } }, "⚙") : null,
    h("button.icon", { title: "save PNG", on: { click: () => mounted.png ? mounted.png() : alert("PNG export is for charts") } }, "⤓"),
    h("button.icon", { title: "close tab", on: { click: () => { if (p.tabs.length > 1) { p.tabs.splice(p.active, 1); } else if (confirm("Remove panel?")) { ws.panels.splice(idx, 1); } app.save(); renderGrid(); } } }, "✕"),
    h("button.icon", { title: "fullscreen", on: { click: () => { el.classList.toggle("full"); } } }, "⛶"));
  const grip = h("div.resize", { title: "drag to resize" });
  grip.addEventListener("pointerdown", (e) => startResize(e, el, p));
  el.append(tabs, body, grip);
  const ctx = {
    app, panel: p, save: app.save,
    setTitle: (t) => { if (!view.title) { const b = tabs.querySelectorAll(".ptab")[p.active]; if (b) b.textContent = t; } },
    openChart: (id, name) => app.addTab(p, Object.assign(VIEWS.chart.defaults(), { title: name || id, series: [{ id, label: name || "", tf: "none" }] })),
  };
  let mounted = { destroy() {}, refresh() {} };
  const V = VIEWS[view.type];
  if (V) mounted = V.mount(body, view, ctx);
  else body.append(h("div.empty.err", "unknown view type " + view.type));
  app.mounted.push(mounted);
  return el;
}

function tabTitle(t) {
  if (t.title) return t.title;
  if (t.type === "bias") return app.composite(t.key)?.name || "Bias";
  if (t.type === "chart") return t.series.map((s) => s.label || s.id).join(" / ").slice(0, 30) || "Chart";
  if (t.type === "options") return `${t.sym} ${{ summary: "options", gex: "GEX", profile: "γ profile", oi: "OI", vol: "volume", smile: "smile", term: "term" }[t.mode] || ""}`;
  if (t.type === "topology") return "Topology " + t.id.replace(/^\w+:/, "");
  return VIEWS[t.type]?.name || t.type;
}

function startResize(e, el, p) {
  e.preventDefault();
  const grid = document.getElementById("grid");
  const colW = (grid.clientWidth - 11 * 6) / 12 + 6, rowH = 40 + 6;
  const r0 = el.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
  const move = (ev) => {
    p.w = Math.max(2, Math.min(12, Math.round((r0.width + ev.clientX - x0) / colW)));
    p.h = Math.max(4, Math.min(24, Math.round((r0.height + ev.clientY - y0) / rowH)));
    el.style.gridColumn = `span ${p.w}`; el.style.gridRow = `span ${p.h}`;
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); app.save(); renderGrid(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function refreshAll(force) {
  if (force) { renderGrid(); refreshBias(); renderStrip(); return; }
  for (const m of app.mounted) try { m.refresh(); } catch { /* ignore */ }
}

// ── bias editor ───────────────────────────────────────────────────────────────
function biasEditor(key) {
  const st = app.state;
  let cur = st.composites.find((c) => c.key === key) || st.composites[0];
  const left = h("div.be-list"), right = h("div.be-edit");
  const renderList = () => left.replaceChildren(...st.composites.map((c) => h("div.be-item" + (c === cur ? ".on" : ""), { on: { click: () => { cur = c; renderList(); renderEdit(); } } }, c.name)),
    h("button.btn.small", { on: { click: () => {
      const k = "c" + Date.now().toString(36);
      st.composites.push({ key: k, name: "New composite", plus: "up", minus: "down", lookback: 1095, comps: [] });
      cur = st.composites.at(-1); renderList(); renderEdit(); } } }, "+ new composite"));
  const renderEdit = () => {
    const rows = h("div.ed-rows");
    const renderRows = () => rows.replaceChildren(
      h("div.ed-row.ed-hdr", h("span.ed-id", "feed / expression"), h("span.ed-lab", "label"), h("span", "transform"), h("span.ed-n", "n days"), h("span", "sign"), h("span.ed-n", "weight")),
      ...cur.comps.map((c, i) => h("div.ed-row",
        inp(c.id, (v) => (c.id = v), { class: "ed-id" }),
        inp(c.label, (v) => (c.label = v), { class: "ed-lab" }),
        sel(BIAS_TF, c.tf, (v) => (c.tf = v)),
        inp(c.n, (v) => (c.n = v), { type: "number", class: "ed-n" }),
        sel({ 1: "+1", "-1": "−1" }, c.sign, (v) => (c.sign = +v)),
        inp(c.w, (v) => (c.w = v), { type: "number", step: "0.25", class: "ed-n" }),
        h("button.icon", { on: { click: () => { cur.comps.splice(i, 1); renderRows(); } } }, "✕"))));
    renderRows();
    right.replaceChildren(
      h("div.be-fields",
        h("label", "name ", inp(cur.name, (v) => (cur.name = v))),
        h("label", "+ means ", inp(cur.plus, (v) => (cur.plus = v))),
        h("label", "− means ", inp(cur.minus, (v) => (cur.minus = v))),
        h("label", "z lookback (days) ", inp(cur.lookback, (v) => (cur.lookback = v), { type: "number", class: "ed-n" }))),
      h("p.muted.tiny", "Each input → transform over n calendar days → rolling z over the lookback → clip ±3 → × sign × weight. Score = weighted mean z ÷ 2, clipped to ±100."),
      rows,
      h("div.ed-foot",
        h("button.btn", { on: { click: () => pickFeed("series", (id, name) => { cur.comps.push({ id, label: name || id, tf: "level", n: 30, sign: 1, w: 1 }); renderRows(); }) } }, "+ add input"),
        h("button.btn", { on: { click: () => { if (confirm(`Delete "${cur.name}"?`)) { st.composites.splice(st.composites.indexOf(cur), 1); cur = st.composites[0]; renderList(); renderEdit(); } } } }, "delete composite"),
        h("span.grow"),
        h("button.btn.primary", { on: { click: () => { m.close(); app.save(); buildMenubar(); renderGrid(); refreshBias(); } } }, "Apply")));
  };
  renderList(); renderEdit();
  const m = modal("Bias composites", h("div.bias-editor", left, right), { wide: true });
}

// ── health / status ───────────────────────────────────────────────────────────
function renderStatus() {
  const el = document.getElementById("status");
  const all = [...health.values()];
  const bad = [...health.entries()].filter(([, v]) => !v.ok);
  const stale = all.filter((v) => v.stale).length;
  el.replaceChildren(
    h("span", `${health.size} feeds loaded`),
    h("span", { class: bad.length ? "err link" : "muted", title: bad.map(([k, v]) => `${k}: ${v.error}`).join("\n"), on: { click: feedHealth } }, `${bad.length} failing`),
    stale ? h("span.err", `${stale} stale`) : "",
    h("span.muted", `updated ${new Date().toLocaleTimeString()}`),
    h("span.grow"),
    h("span.muted", THEMES[app.state.theme]),
    h("span.muted", (app.hosted ? "hosted" : "127.0.0.1") + " · free sources, most delayed"));
}
onHealth(() => { clearTimeout(renderStatus.t); renderStatus.t = setTimeout(renderStatus, 300); });

function feedHealth() {
  const rows = [...health.entries()].sort((a, b) => a[1].ok - b[1].ok || a[0].localeCompare(b[0]));
  modal("Feed health", h("div.table-wrap.tall", h("table.tbl", h("thead", h("tr", h("th", "id"), h("th", "status"), h("th", "fetched"))),
    h("tbody", rows.map(([k, v]) => h("tr", h("td", k), h("td", { class: v.ok ? "pos" : "neg" }, v.ok ? (v.stale ? "stale" : "ok") : v.error || "empty"),
      h("td.muted", v.asof ? new Date(v.asof * 1000).toLocaleTimeString() : "")))))), { wide: true });
}

// ── boot ──────────────────────────────────────────────────────────────────────
await app.load();
{ // ?ws=Rates or ?ws=2 opens a workspace (bookmarkable)
  const q = new URLSearchParams(location.search).get("ws");
  if (q != null) {
    const i = app.state.workspaces.findIndex((w, k) => w.name.toLowerCase() === q.toLowerCase() || String(k) === q);
    if (i >= 0) app.state.active = i;
  }
}
buildMenubar();
app.render();
renderStrip();
refreshBias();
setInterval(() => refreshAll(false), 120000);
setInterval(renderStrip, 30000);
setInterval(refreshBias, 600000);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { document.querySelector(".panel.full")?.classList.remove("full"); document.querySelector(".modal-back")?.remove(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pickFeed("series", (id, name) => newPanel(Object.assign(VIEWS.chart.defaults(), { title: name || id, series: [{ id, label: name || "", tf: "none" }] }))); }
});
