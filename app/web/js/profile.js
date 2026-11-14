import { h, api } from "../util.js";

const SYSTEM = /^named from speech/i;

function clock(ts) {
  return ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

function section(title, ...body) {
  return h("section", { class: "prof-block" }, h("h3", { class: "prof-label", text: title }), ...body);
}

export async function renderProfile(into, id, { back }) {
  into.replaceChildren(h("p", { class: "hint", text: "Loading…" }));
  let p;
  try {
    p = await api.person(id);
  } catch (err) {
    into.replaceChildren(h("p", { class: "form-error", text: `Could not load this profile. ${err.message}` }));
    return;
  }
  const said = [...(p.notes || [])].filter((n) => !SYSTEM.test(n.text)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const heard = p.nameSource === "audio";
  const photo = p.thumbUrl ? h("img", { class: "prof-photo", src: p.thumbUrl, alt: `Photo of ${p.name}`, decoding: "async" }) : h("span", { class: "prof-photo prof-initial", text: (p.name || "?").slice(0, 1) });
  const follow = (p.followups || []).length
    ? h("ul", { class: "prof-list" }, p.followups.map((f) => h("li", { text: f })))
    : h("p", { class: "hint", text: "Nothing to follow up." });
  const told = said.length
    ? h("ol", { class: "prof-told" }, said.map((n) => h("li", {}, h("span", { class: "prof-time", text: clock(n.ts) }), h("span", { class: "prof-line", text: n.text }))))
    : h("p", { class: "hint", text: "Nothing said yet." });
  into.replaceChildren(
    h("button", { type: "button", class: "btn btn-ghost prof-back", onclick: back }, h("span", { text: "← People" })),
    h("article", { class: "prof", "aria-label": `Profile of ${p.name}` },
      h("header", { class: "prof-hero" },
        photo,
        h("div", { class: "prof-id" },
          h("h2", { class: "prof-name", text: p.name }),
          p.role ? h("p", { class: "prof-role", text: p.role }) : null,
          heard ? h("p", { class: "prof-chip", text: "Name heard in speech" }) : null)),
      h("div", { class: "prof-cols" },
        h("div", { class: "prof-col" },
          section("Summary", h("p", { class: "prof-summary", text: p.summary || "No summary yet." })),
          section("Follow-ups", follow),
          p.consentNote ? section("Consent", h("p", { class: "hint", text: p.consentNote })) : null),
        h("div", { class: "prof-col" }, section(`What they told you (${said.length})`, told)))));
}
