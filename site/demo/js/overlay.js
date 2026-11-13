import { Overlay } from "../overlay.js";

export class CreamOverlay extends Overlay {
  label(tr) {
    const f = tr.face;
    const known = f.personId != null;
    const wasKnown = tr.el.classList.contains("is-known");
    tr.el.classList.toggle("is-known", known);
    tr.el.classList.toggle("is-unknown", !known);
    const nm = known ? f.name || "Known" : "unknown";
    const before = tr.name.textContent;
    if (before !== nm) {
      tr.name.textContent = nm;
      if (before && !tr.el.classList.contains("is-new")) this.pop(tr);
    } else if (known !== wasKnown && before) this.pop(tr);
    tr.el.setAttribute("aria-label", known ? `Show context for ${nm}` : "Unknown face. Show what is known so far");
  }

  pop(tr) {
    tr.el.classList.remove("is-renamed");
    tr.el.getBoundingClientRect();
    tr.el.classList.add("is-renamed");
    clearTimeout(tr.popTimer);
    tr.popTimer = setTimeout(() => tr.el.classList.remove("is-renamed"), 700);
  }

  side(id) {
    const tr = this.tracks.get(id);
    if (!tr || !tr.rect) return null;
    const r = this.stage.getBoundingClientRect();
    return tr.rect.x + tr.rect.w / 2 > r.width / 2 ? "right" : "left";
  }
}
