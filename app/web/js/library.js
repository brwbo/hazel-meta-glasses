import { h, api } from "../util.js";
import { renderProfile } from "./profile.js";

function when(ts) {
  if (!ts) return "";
  const mins = Math.round((Date.now() / 1000 - ts) / 60);
  if (mins < 1) return "Here now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function tile(p, pick) {
  const initial = h("span", { class: "lib-initial", text: (p.name || "?").slice(0, 1).toUpperCase() });
  const img = h("img", { class: "lib-face", src: `/api/people/${p.id}/thumb.jpg`, alt: "", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(initial));
  const note = p.role || p.summary || "";
  return h("button", { type: "button", class: "lib-tile", role: "listitem", onclick: () => pick(p.id) },
    h("span", { class: "lib-photo" }, img),
    h("span", { class: "lib-name", text: p.name }),
    note ? h("span", { class: "lib-note", text: note }) : null,
    h("span", { class: "lib-seen", text: when(p.lastSeen) }));
}

export function initLibrary() {
  const count = h("b", { class: "lib-count", text: "0" });
  const btn = h("button", { type: "button", class: "lib-btn", id: "lib-btn", "aria-expanded": "false", "aria-controls": "lib" }, h("span", { text: "People" }), count);
  const grid = h("div", { class: "lib-grid", role: "list" });
  const empty = h("p", { class: "hint", text: "Nobody yet. Faces appear here as people are met." });
  const body = h("div", { class: "lib-body" }, grid);
  const sheet = h("section", { class: "lib", id: "lib", "aria-label": "People library", hidden: true },
    h("header", { class: "lib-head" },
      h("h2", { text: "People" }),
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => hide() }, h("span", { text: "Close" }))),
    body);
  document.body.append(btn, sheet);

  function hide() {
    sheet.hidden = true;
    document.body.classList.remove("lib-open");
    btn.setAttribute("aria-expanded", "false");
    btn.focus({ preventScroll: true });
  }

  async function show() {
    body.replaceChildren(grid);
    try {
      const people = await api.people();
      count.textContent = String(people.length);
      grid.replaceChildren(...(people.length ? people.map((p) => tile(p, (id) => renderProfile(body, id, { back: () => { body.replaceChildren(grid); } }))) : [empty]));
    } catch {
      grid.replaceChildren(h("p", { class: "form-error", text: "Could not load people." }));
    }
    sheet.hidden = false;
    document.body.classList.add("lib-open");
    btn.setAttribute("aria-expanded", "true");
  }

  btn.addEventListener("click", () => (sheet.hidden ? show() : hide()));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) hide(); });
  return { refresh: async () => { try { count.textContent = String((await api.people()).length); } catch {} } };
}
