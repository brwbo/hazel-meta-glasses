import { h, icon, clock, ago, api, store, toDate } from "../util.js";
import { editData, editedMark, noteDelete } from "./edit.js";

const kids = (...xs) => xs.flat().filter((x) => x != null && x !== false);
const label = (text, ...more) => h("p", { class: "micro" }, text, ...more);

function glyph(d) {
  const s = icon("plus");
  s.firstChild.setAttribute("d", d);
  s.firstChild.setAttribute("stroke-linecap", "round");
  s.firstChild.setAttribute("stroke-linejoin", "round");
  return s;
}
const micGlyph = () => glyph("M10 3a2 2 0 0 1 2 2v5a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2zM5.5 9.5a4.5 4.5 0 0 0 9 0M10 14v3");

function thumbFrame(inner) {
  return h("div", { class: "thumb-frame", "data-anchor": "" }, inner);
}

function who(thumb) {
  return h("header", { class: "who" }, thumb);
}

export function renderPending(body, { snapshot, slow }) {
  const thumb = thumbFrame(snapshot
    ? h("img", { class: "p-thumb", src: snapshot, alt: "", width: 96, height: 96 })
    : h("div", { class: "p-thumb p-thumb-empty" }, icon("user")));
  body.replaceChildren(
    who(thumb),
    h("div", { class: "p-id" }, h("h2", { class: "p-name is-pending", text: "New face" }), h("p", { class: "p-role", text: "Not met before" })),
    h("p", { class: "p-status is-here", text: "In view" }),
    h("div", { class: "capture", role: "status" },
      h("span", { class: "capture-bar", "aria-hidden": "true" }),
      h("p", { class: "hint", text: slow ? "Still matching this face. The card fills in here when it is ready." : "Getting to know this face." })));
}

export function renderLoading(body) {
  body.replaceChildren(h("div", { class: "loading", role: "status" }, h("span", { class: "capture-bar", "aria-hidden": "true" }), "Opening their card"));
}

function identity(p, ctx) {
  const wrap = h("div", { class: "p-id" });
  const view = () => {
    wrap.replaceChildren(...kids(
      h("h2", { class: "p-name" },
        h("button", { type: "button", class: "name-btn", title: "Rename", "aria-label": `${p.name}. Rename`, onclick: edit }, p.name),
        (p.nameSource || p.name_source) === "audio" ? h("span", { class: "heard", title: "Name heard in conversation", "aria-label": "Name heard in conversation" }, micGlyph()) : editedMark(p, "name")),
      p.role ? h("p", { class: "p-role" }, p.role, editedMark(p, "role")) : null));
  };
  const edit = () => {
    const name = h("input", { type: "text", class: "edit-input", value: p.name, maxlength: 80, "aria-label": "Name", autocomplete: "off" });
    const role = h("input", { type: "text", class: "edit-input", value: p.role || "", maxlength: 120, "aria-label": "Role", placeholder: "Role", autocomplete: "off" });
    const err = h("p", { class: "form-error", role: "alert" });
    const form = h("form", { class: "p-edit" }, name, role,
      h("div", { class: "row" },
        h("button", { type: "submit", class: "btn btn-primary" }, h("span", { text: "Save" })),
        h("button", { type: "button", class: "btn btn-ghost", onclick: view }, h("span", { text: "Cancel" }))),
      err);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) {
        err.textContent = "A name is required.";
        return name.focus();
      }
      form.classList.add("is-busy");
      try {
        await api.patch(p.id, { name: n, role: role.value.trim() });
        ctx.refresh();
        if (ctx.renamed) ctx.renamed();
      } catch (ex) {
        form.classList.remove("is-busy");
        err.textContent = ex.message;
      }
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        view();
      }
    });
    wrap.replaceChildren(form);
    name.focus();
    name.select();
  };
  view();
  wrap.edit = edit;
  return wrap;
}

function ink(el, text, animate) {
  const words = String(text).split(/\s+/).filter(Boolean);
  el.classList.toggle("is-writing", !!animate);
  el.classList.remove("is-empty");
  el.replaceChildren(...words.flatMap((w, i) => [h("span", { class: "w", style: `--i:${i}`, text: w }), " "]));
}

function handNote(p, ctx) {
  if (!ctx.handEl) ctx.handEl = h("p", { class: "hand" });
  const latest = [...(p.notes || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  const text = ctx.heard || (latest && latest.text) || "";
  if (ctx.handText !== text) {
    ctx.handText = text;
    if (text) ink(ctx.handEl, text, false);
    else {
      ctx.handEl.classList.add("is-empty");
      ctx.handEl.textContent = "Nothing noted yet. What they say lands here.";
    }
  }
  return ctx.handEl;
}

export function hear(ctx, text) {
  if (!ctx || !text) return;
  ctx.heard = text;
  ctx.handText = text;
  if (ctx.handEl) ink(ctx.handEl, text, true);
}

function followups(p, done, save) {
  const items = (p.followups || []).map((text, i) => {
    const fid = `fu-${p.id}-${i}`;
    const box = h("input", { type: "checkbox", id: fid, checked: done.has(text) });
    box.addEventListener("change", () => save(text, box.checked));
    return h("li", { class: "check" }, box, h("label", { for: fid }, h("i", { class: "tick", "aria-hidden": "true" }, glyph("M4.5 10.5l3.5 3.5 7.5-8")), h("span", { text })));
  });
  return h("div", { class: "p-block" }, label("Follow-ups", editedMark(p, "followups")),
    items.length ? h("ul", { class: "todo" }, items) : h("p", { class: "empty", text: "Nothing to follow up." }));
}

function notes(p, ctx) {
  const list = [...(p.notes || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const input = h("input", { type: "text", name: "note", class: "edit-input", placeholder: "Add a note", maxlength: 500, autocomplete: "off", "aria-label": "New note" });
  const msg = h("p", { class: "form-error", role: "alert" });
  const form = h("form", { class: "inline-form" }, input, h("button", { type: "submit", class: "btn" }, h("span", { text: "Add" })));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return input.focus();
    form.classList.add("is-busy");
    try {
      await api.note(p.id, text);
      ctx.heard = null;
      ctx.refresh("notes");
    } catch (err) {
      msg.textContent = err.message;
      form.classList.remove("is-busy");
    }
  });
  return h("div", { class: "p-block", "data-part": "notes" }, label(list.length === 1 ? "1 note" : `${list.length} notes`),
    form, msg,
    list.length
      ? h("ol", { class: "timeline" }, list.map((n) => {
          const li = h("li", null, h("time", { text: `${ago(n.ts)}, ${clock(n.ts)}` }), h("p", { text: n.text }));
          if (ctx.editing) li.append(...noteDelete(p, n, ctx, li));
          return li;
        }))
      : h("p", { class: "empty", text: "No notes yet. Add the first one above." }));
}

export function renderPerson(body, p, ctx) {
  const doneKey = `fc.followups.${p.id}`;
  const done = new Set(store(doneKey) || []);
  const toggle = (text, on) => {
    on ? done.add(text) : done.delete(text);
    store(doneKey, [...done]);
  };
  const pinned = Array.isArray(p.edited) && p.edited.includes("thumb");
  const live = p.thumbClear === false && !pinned;
  const thumb = thumbFrame(live
    ? h("img", { class: "p-thumb", src: ctx.liveThumb || p.thumbUrl || "", alt: "", width: 96, height: 96, "data-live": "" })
    : p.thumbUrl
      ? h("img", { class: "p-thumb", src: p.thumbUrl, alt: "", width: 96, height: 96 })
      : h("div", { class: "p-thumb p-thumb-empty" }, icon("user")));
  if (live) thumb.append(h("span", { class: "thumb-state", role: "status", text: "Getting a clear photo" }));
  const consentDate = toDate(p.consentAt);
  const consent = consentDate || p.consentNote
    ? h("div", { class: "p-block p-consent" }, label("Consent"),
        h("p", null, consentDate ? `Recorded ${consentDate.toLocaleDateString([], { day: "numeric", month: "short" })}, ${clock(p.consentAt)}` : "Recorded"),
        p.consentNote ? h("q", { text: p.consentNote }) : null)
    : null;
  const status = h("p", { class: "p-status" });
  ctx.setStatus = (text, here) => {
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle("is-here", here);
  };

  let main;
  let idBlock = null;
  if (ctx.editing) {
    main = h("div", { class: "panel is-editing" }, who(thumb), ...editData(p, ctx, { thumb, consent, done, onToggle: toggle }).slice(1), notes(p, ctx));
  } else {
    idBlock = identity(p, ctx);
    const tags = (p.tags || []).map((t) => h("li", { text: t }));
    main = h("div", { class: "panel" }, ...kids(
      who(thumb),
      idBlock,
      status,
      p.summary ? h("div", { class: "p-block" }, label("Summary", editedMark(p, "summary")), h("p", { class: "p-text", text: p.summary })) : null,
      tags.length ? h("ul", { class: "tags", "aria-label": "Tags" }, tags) : null,
      h("div", { class: "p-block" }, label("Latest note"), handNote(p, ctx)),
      followups(p, done, toggle),
      notes(p, ctx),
      consent));
    main.addEventListener("dblclick", (e) => {
      if (e.target.closest("input, button, label, a")) return;
      ctx.setEditing(true);
    });
  }

  ctx.setEditing = (on) => {
    ctx.editing = on;
    ctx.refresh();
  };
  const rename = () => {
    body.scrollTop = 0;
    if (idBlock) return idBlock.edit();
    const first = main.querySelector(".edit-input");
    if (first) first.focus();
  };
  const actions = h("div", { class: "actions" });
  const askDelete = () => {
    const go = h("button", { type: "button", class: "btn btn-danger" }, h("span", { text: "Delete for good" }));
    const cancel = h("button", { type: "button", class: "btn btn-ghost", onclick: idle }, h("span", { text: "Cancel" }));
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await api.remove(p.id);
        ctx.deleted();
      } catch (err) {
        go.disabled = false;
        actions.append(h("p", { class: "form-error", role: "alert", text: err.message }));
      }
    });
    actions.replaceChildren(h("p", { class: "danger-text", text: `Delete ${p.name}, their face data and every note? This cannot be undone.` }), h("div", { class: "row" }, go, cancel));
    cancel.focus();
    actions.scrollIntoView({ block: "nearest" });
  };
  function idle() {
    actions.replaceChildren(
      h("button", { type: "button", class: "act", onclick: rename }, icon("edit"), h("span", { text: "Rename" }), h("kbd", { text: "R" })),
      h("button", { type: "button", class: "act", "aria-pressed": String(!!ctx.editing), onclick: () => ctx.setEditing(!ctx.editing) }, glyph("M4 6h12M4 10h12M4 14h7"), h("span", { text: ctx.editing ? "Done" : "Edit" }), h("kbd", { text: "E" })),
      h("button", { type: "button", class: "act act-danger", onclick: askDelete }, icon("trash"), h("span", { text: "Delete" }), h("kbd", { text: "X" })));
  }
  idle();
  const part = (name) => {
    const el = name === "data" ? main : main.querySelector(`[data-part="${name}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "auto" });
    const focusable = el.querySelector("input:not([type=file]), button");
    if (name !== "data" && focusable) focusable.focus({ preventScroll: true });
  };
  ctx.keys = { rename, del: askDelete, edit: () => ctx.setEditing(!ctx.editing), tab: part };

  const keep = body.scrollTop;
  body.replaceChildren(main, actions);
  body.scrollTop = ctx.rendered ? keep : 0;
  ctx.rendered = true;
}
