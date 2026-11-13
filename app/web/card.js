import { h, icon, clock, ago, api, store, toDate } from "./util.js";
import { editData, editedMark, noteDelete } from "./edit.js";

let viewer = null;
let viewerState = "idle";
const modelHost = h("div", { class: "model-view" });
const modelNote = h("p", { class: "hint" });

let pendingModel = null;

function ensureViewer() {
  if (viewerState !== "idle") return;
  viewerState = "loading";
  import("./viewer3d.js")
    .then((m) => {
      viewer = m.mountViewer(modelHost, { accent: "#22d3ee" });
      viewerState = "ready";
      if (pendingModel) applyModel(pendingModel);
    })
    .catch(() => {
      viewerState = "failed";
      modelHost.replaceChildren(h("p", { class: "model-fallback", text: "3D view unavailable on this device." }));
    });
}

function applyModel(p) {
  pendingModel = p;
  modelNote.textContent = p.modelUrl ? "Model loaded. Drag to orbit." : "No model attached. Upload a .glb to add one.";
  if (!viewer) return;
  try {
    viewer.setModel(p.modelUrl || null);
    viewer.setLabel(p.name || "");
  } catch {
    modelNote.textContent = "The model could not be shown.";
  }
}

const kids = (...xs) => xs.flat().filter((x) => x != null && x !== false);
const micro = (text) => h("p", { class: "micro", text });

export function renderPending(body, { snapshot, slow, onClose }) {
  const thumb = framed(snapshot
    ? h("img", { class: "p-thumb", src: snapshot, alt: "", width: 112, height: 112 })
    : h("div", { class: "p-thumb p-thumb-empty" }, icon("user")));
  body.replaceChildren(
    h("header", { class: "card-head" }, h("div", { class: "tabs" }, h("span", { class: "tab", "aria-selected": "true" }, h("span", { text: "Data" })))),
    h("div", { class: "card-sub" }, h("p", { class: "p-status is-here", text: "Target in view" })),
    h("article", { class: "person" },
      h("div", { class: "tab-panel" },
        thumb,
        h("div", { class: "p-id" }, micro("Identity"), h("h2", { class: "p-name is-pending", text: "Capturing..." })),
        h("div", { class: "capture", role: "status" },
          h("span", { class: "capture-bar", "aria-hidden": "true" }),
          h("p", { class: "hint", text: slow ? "Still matching this face. The profile opens here when it is ready." : "Building a profile for this face." })))));
}

export function renderLoading(body) {
  body.replaceChildren(h("div", { class: "loading", role: "status" }, h("span", { class: "scan" }), "Scanning profile"));
}

function framed(inner) {
  return h("div", { class: "thumb-frame", "data-anchor": "" }, inner, h("i", { class: "sweep", "aria-hidden": "true" }),
    h("i", { class: "c tl" }), h("i", { class: "c tr" }), h("i", { class: "c bl" }), h("i", { class: "c br" }));
}

function rowIcon(kind) {
  const paths = {
    tag: "M3 3h6l8 8-6 6-8-8zM6.5 6.5h.01",
    task: "M4 10l4 4 8-8",
    open: "M5 5h10v10H5z",
  };
  const s = icon("plus");
  s.firstChild.setAttribute("d", paths[kind]);
  return s;
}

function micIcon() {
  const s = icon("plus");
  s.firstChild.setAttribute("d", "M10 3a2 2 0 0 1 2 2v5a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2zM5.5 9.5a4.5 4.5 0 0 0 9 0M10 14v3");
  return s;
}

function identity(p, ctx) {
  const wrap = h("div", { class: "p-id" });
  const view = () => {
    wrap.replaceChildren(...kids(
      micro("Identity"),
      h("h2", { class: "p-name" },
        h("button", { type: "button", class: "name-btn", title: "Rename", "aria-label": `${p.name}. Rename`, onclick: edit }, p.name),
        (p.nameSource || p.name_source) === "audio" ? h("span", { class: "heard", title: "Name heard in conversation", "aria-label": "Name heard in conversation" }, micIcon()) : editedMark(p, "name")),
      p.role ? h("p", { class: "micro" }, "Role", editedMark(p, "role")) : null,
      p.role ? h("p", { class: "p-role", text: p.role }) : null));
  };
  const edit = () => {
    const name = h("input", { type: "text", value: p.name, maxlength: 80, "aria-label": "Name", autocomplete: "off" });
    const role = h("input", { type: "text", value: p.role || "", maxlength: 120, "aria-label": "Role", placeholder: "Role", autocomplete: "off" });
    const err = h("p", { class: "form-error", role: "alert" });
    const form = h("form", { class: "p-edit" }, micro("Identity"), name, micro("Role"), role,
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

function dataTab(p, ctx, id) {
  const doneKey = `fc.followups.${p.id}`;
  const done = new Set(store(doneKey) || []);
  const pinned = Array.isArray(p.edited) && p.edited.includes("thumb");
  const live = p.thumbClear === false && !pinned;
  const thumb = framed(live
    ? h("img", { class: "p-thumb", src: ctx.liveThumb || p.thumbUrl || "", alt: "", width: 112, height: 112, "data-live": "" })
    : p.thumbUrl
      ? h("img", { class: "p-thumb", src: p.thumbUrl, alt: "", width: 112, height: 112 })
      : h("div", { class: "p-thumb p-thumb-empty" }, icon("user")));
  if (live) thumb.append(h("span", { class: "thumb-state", role: "status", text: "Capturing clear photo" }));
  const consentDate = toDate(p.consentAt);
  const consent = consentDate || p.consentNote
    ? h("div", { class: "p-consent" },
        micro("Consent"),
        h("p", null, h("span", { class: "ok", text: "Given" }), consentDate ? ` ${consentDate.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(p.consentAt)}` : ""),
        p.consentNote ? h("q", { text: p.consentNote }) : null)
    : null;
  const toggle = (text, on) => {
    on ? done.add(text) : done.delete(text);
    store(doneKey, [...done]);
  };
  if (ctx.editing) return h("div", { class: "tab-panel is-editing", id, role: "tabpanel" }, ...editData(p, ctx, { thumb, consent, done, onToggle: toggle }));
  const tags = (p.tags || []).map((t) => h("li", { class: "vuln" }, rowIcon("tag"), h("span", { text: t })));
  const fu = (p.followups || []).map((text, i) => {
    const fid = `fu-${p.id}-${i}`;
    const box = h("input", { type: "checkbox", id: fid, checked: done.has(text) });
    box.addEventListener("change", () => {
      box.checked ? done.add(text) : done.delete(text);
      store(doneKey, [...done]);
    });
    return h("li", { class: "vuln check" }, box, h("label", { for: fid, text }));
  });
  const panel = h("div", { class: "tab-panel", id, role: "tabpanel" }, ...kids(
    thumb,
    identity(p, ctx),
    p.summary ? h("div", { class: "p-block" }, h("p", { class: "micro" }, "Scan results", editedMark(p, "summary")), h("p", { class: "p-text", text: p.summary })) : null,
    tags.length ? h("div", { class: "p-block" }, h("p", { class: "micro" }, "Tags", editedMark(p, "tags")), h("ul", { class: "vulns" }, tags)) : null,
    h("div", { class: "p-block" }, h("p", { class: "micro" }, "Follow-ups", editedMark(p, "followups")),
      fu.length ? h("ul", { class: "vulns" }, fu) : h("p", { class: "empty", text: "Nothing to follow up." })),
    consent));
  panel.addEventListener("dblclick", (e) => {
    if (e.target.closest("input, button, label")) return;
    ctx.setEditing(true);
  });
  return panel;
}

function notesTab(p, ctx, id) {
  const notes = [...(p.notes || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const input = h("input", { type: "text", name: "note", placeholder: "Add a note", maxlength: 500, autocomplete: "off", "aria-label": "New note" });
  const msg = h("p", { class: "form-error", role: "alert" });
  const form = h("form", { class: "inline-form" }, input, h("button", { type: "submit", class: "btn" }, h("span", { text: "Add" })));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return input.focus();
    form.classList.add("is-busy");
    try {
      await api.note(p.id, text);
      ctx.refresh("notes");
    } catch (err) {
      msg.textContent = err.message;
      form.classList.remove("is-busy");
    }
  });
  return h("div", { class: "tab-panel", id, role: "tabpanel" },
    micro(`Notes ${notes.length}`),
    form, msg,
    notes.length
      ? h("ol", { class: "timeline" }, notes.map((n) => {
          const li = h("li", null, h("time", { text: `${clock(n.ts)}  ${ago(n.ts)}` }), h("p", { text: n.text }));
          if (ctx.editing) li.append(...noteDelete(p, n, ctx, li));
          return li;
        }))
      : h("p", { class: "empty", text: "No notes yet. Add the first one above." }));
}

function modelTab(p, id) {
  const status = h("p", { class: "hint", role: "status" });
  const input = h("input", { type: "file", accept: ".glb,model/gltf-binary", class: "visually-hidden" });
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    status.textContent = "Uploading...";
    try {
      const res = await api.upload(p.id, "model", file);
      status.textContent = "Model replaced.";
      if (res && res.modelUrl) applyModel({ ...p, modelUrl: res.modelUrl });
    } catch (err) {
      status.textContent = err.message;
    }
  });
  return h("div", { class: "tab-panel", id, role: "tabpanel" },
    micro("3D model"), modelHost, modelNote,
    h("label", { class: "btn btn-ghost" }, icon("upload"), h("span", { text: "Upload .glb" }), input),
    status);
}

export function renderPerson(body, p, ctx, tab = "data") {
  const ids = { data: "tab-data", notes: "tab-notes", model: "tab-model" };
  const panels = { data: dataTab(p, ctx, ids.data), notes: notesTab(p, ctx, ids.notes), model: modelTab(p, ids.model) };
  const tabs = {};
  const select = (name, focus) => {
    for (const k of Object.keys(panels)) {
      panels[k].hidden = k !== name;
      tabs[k].setAttribute("aria-selected", String(k === name));
      tabs[k].tabIndex = k === name ? 0 : -1;
    }
    ctx.tab = name;
    if (focus) tabs[name].focus();
  };
  const strip = h("div", { class: "tabs", role: "tablist", "aria-label": "Profile sections" });
  [["data", "Data", "1"], ["notes", "Notes", "2"], ["model", "Model", "3"]].forEach(([k, label, key]) => {
    tabs[k] = h("button", { type: "button", role: "tab", class: "tab", "aria-controls": ids[k], onclick: () => select(k) },
      h("span", { text: label }), h("kbd", { text: key }));
    strip.append(tabs[k]);
  });
  strip.addEventListener("keydown", (e) => {
    const order = ["data", "notes", "model"];
    const i = order.indexOf(ctx.tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      select(order[(i + (e.key === "ArrowRight" ? 1 : -1) + 3) % 3], true);
    }
  });

  const tracking = h("button", { type: "button", class: "pill", "aria-pressed": String(ctx.tracking !== false) },
    h("span", { text: "Tracking" }), h("b", { text: ctx.tracking !== false ? "On" : "Off" }));
  tracking.addEventListener("click", () => {
    ctx.tracking = ctx.tracking === false;
    tracking.setAttribute("aria-pressed", String(ctx.tracking));
    tracking.lastChild.textContent = ctx.tracking ? "On" : "Off";
    ctx.onTracking(ctx.tracking);
  });
  const status = h("p", { class: "p-status" });
  ctx.setStatus = (text, here) => {
    status.textContent = text;
    status.classList.toggle("is-here", here);
  };

  const actions = h("div", { class: "actions" });
  const idBlock = panels.data.querySelector(".p-id");
  const rename = () => {
    select("data");
    if (idBlock) return idBlock.edit();
    const first = panels.data.querySelector(".edit-input");
    if (first) first.focus();
  };
  ctx.setEditing = (on) => {
    ctx.editing = on;
    ctx.refresh(ctx.tab);
  };
  const editBtn = h("button", { type: "button", class: "edit-toggle", "aria-pressed": String(!!ctx.editing), "aria-label": ctx.editing ? "Finish editing" : "Edit profile", title: ctx.editing ? "Done" : "Edit", onclick: () => ctx.setEditing(!ctx.editing) },
    ctx.editing ? h("span", { class: "edit-done", text: "Done" }) : icon("edit"));
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
  };
  function idle() {
    actions.replaceChildren(
      h("button", { type: "button", class: "act", onclick: rename }, h("kbd", { text: "R" }), h("span", { text: "Rename" })),
      h("button", { type: "button", class: "act", onclick: () => ctx.setEditing(!ctx.editing) }, h("kbd", { text: "E" }), h("span", { text: ctx.editing ? "Done" : "Edit" })),
      h("button", { type: "button", class: "act act-danger", onclick: askDelete }, h("kbd", { text: "X" }), h("span", { text: "Delete" })));
  }
  idle();
  ctx.keys = { rename, del: askDelete, edit: () => ctx.setEditing(!ctx.editing), tab: (k) => select(k, true) };

  body.replaceChildren(
    h("header", { class: "card-head" }, strip, editBtn),
    h("div", { class: "card-sub" }, status, tracking),
    h("article", { class: "person" }, panels.data, panels.notes, panels.model),
    actions);
  select(ctx.tab || tab);
  ensureViewer();
  applyModel(p);
}
