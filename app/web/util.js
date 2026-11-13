export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVGNS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

export function icon(name) {
  const paths = {
    close: "M5 5l10 10M15 5L5 15",
    plus: "M10 4v12M4 10h12",
    trash: "M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10",
    refresh: "M15 7a6 6 0 1 0 1 5M15 3v4h-4",
    upload: "M10 14V4M6 8l4-4 4 4M4 16h12",
    edit: "M4 16h3l8-8-3-3-8 8v3zM11 6l3 3",
    user: "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17c1-3 3.5-4.5 6-4.5s5 1.5 6 4.5",
  };
  const s = svg("svg", { viewBox: "0 0 20 20", width: 14, height: 14, "aria-hidden": "true", class: "icon" });
  s.append(svg("path", { d: paths[name], fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linecap": "square" }));
  return s;
}

export function toDate(ts) {
  if (ts == null) return null;
  if (typeof ts === "number") return new Date(ts < 1e12 ? ts * 1000 : ts);
  const d = new Date(ts);
  return isNaN(d) ? null : d;
}

export function clock(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function ago(ts) {
  const d = toDate(ts);
  if (!d) return "never";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return d.toLocaleDateString();
}

async function req(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body && (body.error || body.detail)) || `Request failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return body;
}

export const api = {
  people: () => req("/api/people"),
  person: (id) => req(`/api/people/${id}`),
  note: (id, text) => req(`/api/people/${id}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }),
  upload: (id, kind, file) => {
    const fd = new FormData();
    fd.append("file", file);
    return req(`/api/people/${id}/${kind}`, { method: "POST", body: fd });
  },
  remove: (id) => req(`/api/people/${id}`, { method: "DELETE" }),
  patch: (id, body) => req(`/api/people/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  session: () => req("/api/session"),
  snapshot: (id, file) => {
    const fd = new FormData();
    fd.append("file", file);
    return req(`/api/people/${id}/snapshot`, { method: "POST", body: fd });
  },
  unsnapshot: (id) => req(`/api/people/${id}/snapshot`, { method: "DELETE" }),
  delNote: (id, key) => req(`/api/people/${id}/notes/${encodeURIComponent(key)}`, { method: "DELETE" }),
  wipe: () => req("/api/session/wipe", { method: "POST" }),
};

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
  return value;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
