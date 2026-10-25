// Feed picker: searchable catalogue of series presets / tables, plus free-form ids.
import { catalog } from "./api.js";
import { h, modal } from "./dom.js";

const HELP = [
  ["fred:SERIES", "any FRED series id (key in .env)"], ["yahoo:SYMBOL", "Yahoo daily close, e.g. yahoo:^VIX, yahoo:EURUSD=X"],
  ["yahooi:SYMBOL", "Yahoo 5-minute bars, last 5 days"], ["cboe:INDEX", "Cboe history CSV: VIX, VIX9D, VIX3M, VIX6M, VVIX, SKEW…"],
  ["cftc:CODE:group", "COT net, group nc|comm|lev|am|dealer"], ["nyfed:sofr|effr|tgcr|bgcr|obfr|rrp", "NY Fed rates / RRP"],
  ["ecb:FLOW/KEY", "ECB Data Portal SDMX series"], ["dbn:PROV/DATASET/SERIES", "DBnomics (Eurostat, OECD, IMF, BIS…)"],
  ["wb:ISO3/INDICATOR", "World Bank annual"], ["binance:SYMBOL / dvol:BTC", "crypto daily / Deribit vol index"],
  ["wiki:Article / gdelt:query", "attention: Wikipedia views, GDELT news volume"], ["finra:SYMBOL", "FINRA daily short-volume ratio"],
  ["=[a]/[b]*100", "expression over any ids: + − × ÷ ^ ( )"],
];

export async function pickFeed(kind, onPick) {
  const cat = await catalog();
  const list = kind === "table" ? cat.tables : cat.series;
  const groups = ["all", ...new Set(list.map((x) => x.group))];
  let grp = "all", q = "";
  const body = h("div.picker");
  const results = h("div.pick-list");
  const render = () => {
    results.replaceChildren(...list
      .filter((x) => (grp === "all" || x.group === grp) && (x.name + " " + x.id).toLowerCase().includes(q.toLowerCase()))
      .map((x) => h("div.pick-row", { on: { click: () => { m.close(); onPick(x.id, x.name); } } },
        h("span.pick-name", x.name), h("span.pick-id", x.id), h("span.pick-grp", x.group))));
  };
  const search = h("input.pick-search", { placeholder: "search feeds…", on: { input: (e) => { q = e.target.value; render(); } } });
  const chips = h("div.chips", groups.map((g) => h("button.chip" + (g === "all" ? ".on" : ""), {
    on: { click: (e) => { grp = g; chips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === e.target)); render(); } } }, g)));
  body.append(search, chips, results);
  if (kind !== "table") {
    const custom = h("input.pick-search", { placeholder: "or type any id / expression, then Enter  (e.g. fred:DEXKOUS or =[fred:DGS10]-[fred:DGS2])",
      on: { keydown: (e) => { if (e.key === "Enter" && e.target.value.trim()) { m.close(); onPick(e.target.value.trim()); } } } });
    body.append(h("div.pick-custom", custom,
      h("details", h("summary", "id syntax"), h("table.help", HELP.map(([a, b]) => h("tr", h("td", h("code", a)), h("td", b)))))));
  }
  const m = modal(kind === "table" ? "Add list feed" : "Add series", body, { wide: true });
  render();
  search.focus();
}
