// Client data layer: batched, de-duplicated series fetches with a short client cache.
// Expressions ("=...") are resolved here from their referenced raw series.
import { evalExpr, isExpr, refsOf } from "./calc.js";

const TTL = 120000;                 // client re-asks the server after 2 min; server caches upstream
const cache = new Map();            // raw id -> {t, data} | {t, promise}
let queue = new Map(), timer = null;
export const health = new Map();    // raw id -> {ok, error, asof, stale}
const listeners = new Set();
export const onHealth = (f) => listeners.add(f);

function flush() {
  const batch = queue; queue = new Map(); timer = null;
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    fetch("/api/series?" + chunk.map((x) => "id=" + encodeURIComponent(x)).join("&"))
      .then((r) => r.json())
      .then((res) => {
        for (const id of chunk) {
          const d = res[id] || { error: "no response", points: [] };
          health.set(id, { ok: !d.error && d.points.length > 0, error: d.error, asof: d.asof, stale: d.stale, name: d.name });
          cache.set(id, { t: Date.now(), data: d });
          batch.get(id).forEach((f) => f.res(d));
        }
        listeners.forEach((f) => f());
      })
      .catch((e) => chunk.forEach((id) => { cache.delete(id); batch.get(id).forEach((f) => f.rej(e)); }));
  }
}

function raw(id, force) {
  const c = cache.get(id);
  if (c && !force && Date.now() - c.t < TTL) return c.data ? Promise.resolve(c.data) : c.promise;
  const p = new Promise((res, rej) => {
    if (!queue.has(id)) queue.set(id, []);
    queue.get(id).push({ res, rej });
    if (!timer) timer = setTimeout(flush, 30);
  });
  cache.set(id, { t: Date.now(), promise: p });
  return p;
}

// Resolve a series id or expression to {id, name, unit, points, error?}.
export async function series(id, force = false) {
  if (!isExpr(id)) return raw(id, force);
  const refs = [...new Set(refsOf(id))];
  const parts = await Promise.all(refs.map((r) => raw(r, force)));
  const data = Object.fromEntries(refs.map((r, i) => [r, parts[i].points]));
  const errs = parts.filter((p) => p.error).map((p) => `${p.id}: ${p.error}`);
  try {
    return { id, name: id, unit: "", points: evalExpr(id, data), error: errs.length ? errs.join("; ") : undefined };
  } catch (e) {
    return { id, name: id, unit: "", points: [], error: errs.join("; ") || e.message };
  }
}

export const getJSON = (url) => fetch(url).then((r) => r.json());
export const table = (id) => getJSON("/api/table?id=" + encodeURIComponent(id));
export const curve = () => getJSON("/api/curve");
export const quotes = (syms) => getJSON("/api/quotes?" + syms.map((s) => "s=" + encodeURIComponent(s)).join("&"));

let _catalog;
export const catalog = () => (_catalog ||= getJSON("/api/catalog"));
export async function nameOf(id) {
  const c = await catalog();
  return c.series.find((s) => s.id === id)?.name;
}
