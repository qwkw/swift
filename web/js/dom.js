// Tiny DOM helper: h("div.cls#id", {attrs, on:{click}}, ...children)
export function h(sel, attrs, ...kids) {
  const [tag, ...rest] = sel.split(/(?=[.#])/);
  const el = document.createElement(tag || "div");
  for (const r of rest) r[0] === "." ? el.classList.add(r.slice(1)) : (el.id = r.slice(1));
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [e, f] of Object.entries(v)) el.addEventListener(e, f);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "class") { if (v) el.classList.add(...String(v).split(/\s+/).filter(Boolean)); }
    else if (k in el && k !== "list") el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const sel = (opts, value, on) =>
  h("select", { on: { change: (e) => on(e.target.value) } },
    Object.entries(opts).map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)));

export const inp = (value, on, attrs = {}) =>
  h("input", { value: value ?? "", ...attrs, on: { change: (e) => on(attrs.type === "number" ? +e.target.value : e.target.value) } });

export function modal(title, body, { onClose, wide } = {}) {
  const close = () => { back.remove(); onClose && onClose(); };
  const back = h("div.modal-back", { on: { mousedown: (e) => { if (e.target === back) close(); } } },
    h("div.modal" + (wide ? ".wide" : ""),
      h("div.modal-head", h("span", title), h("button.icon", { title: "close", on: { click: close } }, "✕")),
      h("div.modal-body", body)));
  document.body.append(back);
  return { close, el: back };
}

// −100…+100 horizontal gauge
export function gauge(score) {
  const pct = score == null ? 0 : Math.min(50, Math.abs(score) / 2);
  return h("div.gauge", h("div.gauge-mid"),
    h("div.gauge-fill", { style: { [score >= 0 ? "left" : "right"]: "50%", width: pct + "%", background: score >= 0 ? "var(--up)" : "var(--down)" } }));
}
