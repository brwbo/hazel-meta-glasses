import { h, icon, api } from "../util.js";

const micro = (text) => h("p", { class: "micro", text });

export function editedMark(p, field) {
  const edited = Array.isArray(p.edited) ? p.edited : [];
  const manual = edited.includes(field) || (field === "name" && (p.nameSource || p.name_source) === "manual");
  if (!manual) return null;
  const s = icon("edit");
  return h("span", { class: "edited", title: "Edited by hand", "aria-label": "Edited by hand" }, s);
}

function quietError(el, err) {
  el.textContent = err && err.message ? `Not saved. ${err.message}` : "Not saved.";
}

function field(p, ctx, key, label, { multiline = false, required = false, max = 120 } = {}) {
  const err = h("p", { class: "form-error", role: "alert" });
  const attrs = { "aria-label": label, maxlength: max, autocomplete: "off", class: "edit-input" };
  const input = multiline ? h("textarea", { ...attrs, rows: 4 }) : h("input", { ...attrs, type: "text" });
  input.value = p[key] || "";
  let saved = input.value;
  const save = async () => {
    const v = input.value.trim();
    if (v === saved) return;
    if (required && !v) {
      input.value = saved;
      err.textContent = `${label} cannot be empty.`;
      return;
    }
    const before = saved;
    saved = v;
    p[key] = v;
    err.textContent = "";
    input.classList.add("is-saving");
    try {
      await api.patch(p.id, { [key]: v });
      if (key === "name" && ctx.renamed) ctx.renamed();
    } catch (e) {
      saved = before;
      p[key] = before;
      input.value = before;
      quietError(err, e);
    } finally {
      input.classList.remove("is-saving");
    }
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      input.value = saved;
      input.blur();
    }
  });
  return h("div", { class: "p-block" }, h("label", { class: "micro" }, label, editedMark(p, key)), input, err);
}

function listEditor(p, key, label, { checkable, done, onToggle } = {}) {
  let items = [...(p[key] || [])];
  const err = h("p", { class: "form-error", role: "alert" });
  const list = h("ul", { class: key === "tags" ? "chips-edit" : "vulns" });
  const input = h("input", { type: "text", class: "edit-input", maxlength: key === "tags" ? 40 : 300, autocomplete: "off", "aria-label": `Add ${label.toLowerCase()}`, placeholder: key === "tags" ? "Add tag" : "Add follow-up" });
  const commit = async (next) => {
    const before = items;
    items = next;
    p[key] = next;
    render();
    err.textContent = "";
    try {
      await api.patch(p.id, { [key]: next });
    } catch (e) {
      items = before;
      p[key] = before;
      render();
      quietError(err, e);
    }
  };
  function render() {
    list.replaceChildren(...items.map((text, i) => {
      const del = h("button", { type: "button", class: "x-btn", "aria-label": `Remove ${text}`, onclick: () => commit(items.filter((_, j) => j !== i)) }, icon("close"));
      if (key === "tags") return h("li", { class: "chip-edit" }, h("span", { text }), del);
      const kids = [];
      if (checkable) {
        const fid = `fue-${p.id}-${i}`;
        const box = h("input", { type: "checkbox", id: fid, checked: done.has(text) });
        box.addEventListener("change", () => onToggle(text, box.checked));
        kids.push(box, h("label", { for: fid, text }));
      } else kids.push(h("span", { text }));
      return h("li", { class: "vuln check fu-edit" }, ...kids, del);
    }));
  }
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v || items.includes(v)) return;
    if (items.length >= 12) {
      err.textContent = "Twelve is the limit. Remove one first.";
      return;
    }
    input.value = "";
    commit([...items, v]);
  });
  render();
  return h("div", { class: "p-block" }, h("p", { class: "micro" }, label, editedMark(p, key)), list, input, err);
}

export function photoEditor(p, ctx, thumb) {
  const err = h("p", { class: "form-error", role: "alert" });
  const file = h("input", { type: "file", accept: "image/*", class: "visually-hidden", "aria-label": "Replace photo" });
  const img = thumb.querySelector("img");
  const send = async (f) => {
    if (!f || !/^image\//.test(f.type)) {
      err.textContent = "Drop an image file.";
      return;
    }
    const before = img ? img.src : null;
    const local = URL.createObjectURL(f);
    if (img) img.src = local;
    err.textContent = "";
    thumb.classList.add("is-saving");
    try {
      const res = await api.snapshot(p.id, f);
      if (img && res && res.thumbUrl) img.src = res.thumbUrl;
      ctx.refresh("data");
    } catch (e) {
      if (img && before) img.src = before;
      quietError(err, e);
    } finally {
      thumb.classList.remove("is-saving");
    }
  };
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    file.value = "";
    send(f);
  });
  const pickBtn = h("button", { type: "button", class: "thumb-pick", "aria-label": "Replace photo" }, icon("upload"));
  pickBtn.addEventListener("click", () => file.click());
  thumb.append(pickBtn, file);
  thumb.addEventListener("dragover", (e) => {
    e.preventDefault();
    thumb.classList.add("is-drop");
  });
  thumb.addEventListener("dragleave", () => thumb.classList.remove("is-drop"));
  thumb.addEventListener("drop", (e) => {
    e.preventDefault();
    thumb.classList.remove("is-drop");
    send(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  const reset = h("button", { type: "button", class: "link-btn" }, "Reset to automatic");
  reset.addEventListener("click", async () => {
    err.textContent = "";
    try {
      await api.unsnapshot(p.id);
      ctx.refresh("data");
    } catch (e) {
      quietError(err, e);
    }
  });
  return h("div", { class: "photo-tools" }, h("p", { class: "hint", text: "Click or drop an image on the photo to replace it." }), editedMark(p, "thumb") ? reset : null, err);
}

export function editData(p, ctx, { thumb, consent, done, onToggle }) {
  return [
    thumb,
    photoEditor(p, ctx, thumb),
    field(p, ctx, "name", "Name", { required: true, max: 80 }),
    field(p, ctx, "role", "Role"),
    field(p, ctx, "summary", "Summary", { multiline: true, max: 2000 }),
    listEditor(p, "tags", "Tags"),
    listEditor(p, "followups", "Follow-ups", { checkable: true, done, onToggle }),
    consent,
  ].filter(Boolean);
}

export function noteDelete(p, n, ctx, li) {
  const err = h("span", { class: "form-error", role: "alert" });
  const btn = h("button", { type: "button", class: "x-btn", "aria-label": "Delete note" }, icon("close"));
  btn.addEventListener("click", async () => {
    li.classList.add("is-removing");
    try {
      await api.delNote(p.id, n.id ?? n.ts);
      li.remove();
      ctx.refresh("notes");
    } catch (e) {
      li.classList.remove("is-removing");
      quietError(err, e);
    }
  });
  return [btn, err];
}

export { micro };
