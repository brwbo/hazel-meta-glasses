import { h, svg, reducedMotion } from "./util.js";

const GRACE_MS = 150;
const COAST_MS = 600;
const fitQuery = matchMedia("(max-width: 720px)");
export const PHONE_TOP = 56;
const phoneQuery = matchMedia("(max-width: 720px), (pointer: coarse)");

export class Overlay {
  constructor({ stage, layer, onPick, onMiss }) {
    this.stage = stage;
    this.layer = layer;
    this.onPick = onPick;
    this.onMiss = onMiss;
    this.tracks = new Map();
    this.w = 1280;
    this.h = 720;
    this.selected = null;
    this.cursor = null;
    this.fit = { s: 1, ox: 0, oy: 0, left: 0, top: 0 };
    stage.addEventListener("pointerdown", (e) => this.stagePointer(e));
  }

  get pad() {
    return phoneQuery.matches ? 36 : 24;
  }

  setDetections(msg) {
    if (msg.w && msg.h) {
      this.w = msg.w;
      this.h = msg.h;
    }
    const t = performance.now();
    const seen = new Set();
    for (const f of msg.faces || []) {
      const id = f.trackId != null ? f.trackId : `i${seen.size}`;
      seen.add(id);
      let tr = this.tracks.get(id);
      if (!tr) {
        tr = this.create(id, f.box);
        this.tracks.set(id, tr);
      }
      const gap = t - tr.lastT;
      tr.prev = gap > 700 ? null : tr.last;
      tr.prevT = tr.lastT;
      tr.last = f.box.slice();
      tr.lastT = t;
      const span = tr.prev ? (tr.lastT - tr.prevT) / 1000 : 0;
      if (tr.prev && span >= 0.04) {
        const cap = Math.max(40, tr.last[2] * 4);
        const v = tr.last.map((val, i) => Math.max(-cap, Math.min(cap, (val - tr.prev[i]) / span)));
        tr.vel = tr.vel ? tr.vel.map((old, i) => old * 0.5 + v[i] * 0.5) : v;
      } else if (!tr.prev) tr.vel = null;
      tr.face = f;
      tr.goneAt = null;
      tr.missingAt = null;
      tr.el.classList.remove("is-gone", "is-coasting");
      tr.el.classList.toggle("is-predicted", !!f.predicted);
      tr.el.removeAttribute("tabindex");
      this.label(tr);
    }
    for (const [id, tr] of this.tracks) {
      if (seen.has(id) || tr.goneAt || tr.missingAt) continue;
      tr.missingAt = t;
      tr.el.classList.add("is-coasting");
    }
  }

  create(id, box) {
    const name = h("span", { class: "face-name" });
    const meta = h("b", { class: "scale-val" });
    const size = h("b", { class: "scale-val" });
    const ring = svg("svg", { class: "reticle", viewBox: "0 0 100 100", "aria-hidden": "true" });
    ring.append(
      svg("circle", { cx: 50, cy: 50, r: 48, class: "ring" }),
      svg("circle", { cx: 50, cy: 50, r: 44, class: "ring-in" }),
      svg("path", { d: "M84 16 l4 -4 l4 4 l-4 4z", class: "diamond" }));
    const target = h("span", { class: "target", "aria-hidden": "true" },
      h("span", { class: "dots" }), ring,
      h("span", { class: "scale scale-l" }, h("small", { text: "MATCH" }), meta),
      h("span", { class: "scale scale-r" }, h("small", { text: "SIZE" }), size));
    const el = h(
      "button",
      { type: "button", class: "face", "data-track": id },
      h("span", { class: "face-frame", "aria-hidden": "true" },
        h("i", { class: "c tl" }), h("i", { class: "c tr" }), h("i", { class: "c bl" }), h("i", { class: "c br" }),
        h("i", { class: "cross" }), h("i", { class: "hex" })),
      target,
      h("span", { class: "face-label" }, name),
    );
    el.classList.add("is-new");
    setTimeout(() => el.classList.remove("is-new"), 600);
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch {}
      this.onPick(this.hitTest(e.clientX, e.clientY) ?? id);
    });
    el.addEventListener("click", (e) => {
      if (e.detail === 0) this.onPick(id);
    });
    this.layer.append(el);
    return { id, el, name, meta, size, cur: box.slice(), last: box.slice(), prev: null, lastT: performance.now(), prevT: 0, hist: [], face: null, goneAt: null, missingAt: null };
  }

  label(tr) {
    const f = tr.face;
    const known = f.personId != null;
    tr.el.classList.toggle("is-known", known);
    tr.el.classList.toggle("is-unknown", !known);
    const nm = known ? f.name || "Enrolled" : "Unidentified";
    if (tr.name.textContent !== nm) tr.name.textContent = nm;
    const sc = typeof f.score === "number" ? f.score.toFixed(2) : "--";
    if (tr.meta.textContent !== sc) tr.meta.textContent = sc;
    tr.el.setAttribute("aria-label", known ? `Show context for ${nm}` : "Unidentified face");
    const sz = String(Math.round(f.box[2]));
    if (tr.size.textContent !== sz) tr.size.textContent = sz;
  }

  measure() {
    const r = this.stage.getBoundingClientRect();
    if (fitQuery.matches) {
      const s = Math.min(r.width / this.w, (r.height - PHONE_TOP) / this.h) || 1;
      this.fit = { s, ox: (r.width - this.w * s) / 2, oy: PHONE_TOP, left: r.left, top: r.top };
      return;
    }
    const s = Math.max(r.width / this.w, r.height / this.h) || 1;
    this.fit = { s, ox: (r.width - this.w * s) / 2, oy: (r.height - this.h * s) / 2, left: r.left, top: r.top };
  }

  frame(dt) {
    this.measure();
    this.layer.classList.toggle("no-target", this.targeting === false);
    const t = performance.now();
    const snap = reducedMotion();
    const k = 1 - Math.exp(-dt * 18);
    const pad = this.pad;
    const { s, ox, oy } = this.fit;
    for (const [id, tr] of this.tracks) {
      if (tr.missingAt && !tr.goneAt && t - tr.missingAt > COAST_MS) {
        tr.goneAt = t;
        tr.el.classList.add("is-gone");
        tr.el.setAttribute("tabindex", "-1");
      }
      if (tr.goneAt && t - tr.goneAt > 320) {
        tr.el.remove();
        this.tracks.delete(id);
        continue;
      }
      let target = tr.last;
      if (!snap && tr.vel && !tr.goneAt) {
        const ahead = Math.min(t - tr.lastT, tr.missingAt ? 300 : GRACE_MS) / 1000;
        target = tr.last.map((v, i) => v + tr.vel[i] * ahead);
      }
      tr.cur = snap ? target.slice() : tr.cur.map((v, i) => v + (target[i] - v) * k);
      const [x, y, w, hh] = tr.cur;
      const px = ox + x * s;
      const py = oy + y * s;
      const pw = w * s;
      const ph = hh * s;
      tr.el.style.transform = `translate3d(${px - pad}px, ${py - pad}px, 0)`;
      tr.el.style.width = `${pw + pad * 2}px`;
      tr.el.style.height = `${ph + pad * 2}px`;
      tr.el.style.setProperty("--pad", `${pad}px`);
      tr.el.style.zIndex = String(Math.max(1, 2000 - Math.round(pw)));
      tr.rect = { x: px, y: py, w: pw, h: ph };
      tr.hist.push({ t, x: px - pad, y: py - pad, w: pw + pad * 2, h: ph + pad * 2 });
      while (tr.hist.length && t - tr.hist[0].t > GRACE_MS) tr.hist.shift();
      tr.el.classList.toggle("is-selected", id === this.selected);
      tr.el.classList.toggle("is-cursor", id === this.cursor && id !== this.selected);
    }
  }

  hitTest(cx, cy) {
    const x = cx - this.fit.left;
    const y = cy - this.fit.top;
    let best = null;
    let bestScore = Infinity;
    for (const [id, tr] of this.tracks) {
      if (tr.goneAt || !tr.rect) continue;
      const r = tr.rect;
      const inside = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      const d = Math.hypot((x - (r.x + r.w / 2)) / r.w, (y - (r.y + r.h / 2)) / r.h);
      const score = inside ? d : 10 + d;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return bestScore < 10 ? best : null;
  }

  stagePointer(e) {
    if (e.button !== 0 || e.target.closest(".face, button, a, input, .card, .drawer")) return;
    const x = e.clientX - this.fit.left;
    const y = e.clientY - this.fit.top;
    let best = null;
    let bestD = Infinity;
    for (const [id, tr] of this.tracks) {
      if (tr.goneAt) continue;
      for (const r of tr.hist) {
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          const d = Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2));
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    if (best != null) this.onPick(best);
    else if (this.onMiss) this.onMiss();
  }

  live() {
    return [...this.tracks.values()].filter((tr) => !tr.goneAt && tr.face);
  }

  ordered() {
    return this.live().sort((a, b) => a.cur[0] - b.cur[0]);
  }

  has(id) {
    const tr = this.tracks.get(id);
    return !!(tr && !tr.goneAt);
  }

  face(id) {
    const tr = this.tracks.get(id);
    return tr && !tr.goneAt ? tr.face : null;
  }

  findPerson(personId) {
    return this.live().find((tr) => tr.face.personId === personId) || null;
  }

  clientRect(id) {
    const tr = this.tracks.get(id);
    if (!tr || tr.goneAt || !tr.rect) return null;
    return { x: this.fit.left + tr.rect.x, y: this.fit.top + tr.rect.y, w: tr.rect.w, h: tr.rect.h };
  }

  focus(id) {
    const tr = this.tracks.get(id);
    if (tr) tr.el.focus({ preventScroll: true });
  }
}

export class Leader {
  constructor(root) {
    this.root = root;
    const defs = svg("defs");
    const marker = svg("marker", { id: "leader-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.append(svg("path", { d: "M0 1 L9 5 L0 9", fill: "none", stroke: "currentColor", "stroke-width": 1.4 }));
    defs.append(marker);
    this.path = svg("path", { class: "leader-path", pathLength: 1, "marker-end": "url(#leader-arrow)" });
    this.tick = svg("circle", { class: "leader-node", r: 3 });
    root.append(defs, this.path, this.tick);
    this.visible = false;
  }

  draw() {
    const p = this.path;
    p.classList.remove("is-drawing");
    p.getBoundingClientRect();
    p.classList.add("is-drawing");
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.remove("is-on");
  }

  update(head, anchor, vertical, right) {
    if (!head || !anchor) return this.hide();
    let d;
    let a;
    if (vertical) {
      a = { x: anchor.left + anchor.width / 2, y: anchor.top - 6 };
      const hx = head.x + head.w / 2;
      const hy = head.y + head.h + 4;
      const mid = Math.max(hy + 14, (a.y + hy) / 2);
      d = `M${a.x} ${a.y} L${a.x} ${mid} L${hx} ${mid} L${hx} ${hy}`;
    } else if (right) {
      a = { x: anchor.left - 6, y: anchor.top + anchor.height / 2 };
      const hx = head.x + head.w + 4;
      const hy = head.y + head.h * 0.32;
      const elbow = a.x - Math.max(18, Math.min(60, (a.x - hx) * 0.25));
      d = `M${a.x} ${a.y} L${elbow} ${a.y} L${Math.min(elbow, hx + 26)} ${hy} L${hx} ${hy}`;
    } else {
      a = { x: anchor.right + 6, y: anchor.top + anchor.height / 2 };
      const hx = head.x - 4;
      const hy = head.y + head.h * 0.32;
      const elbow = a.x + Math.max(18, Math.min(60, (hx - a.x) * 0.25));
      d = `M${a.x} ${a.y} L${elbow} ${a.y} L${Math.max(elbow, hx - 26)} ${hy} L${hx} ${hy}`;
    }
    this.path.setAttribute("d", d);
    this.tick.setAttribute("cx", a.x);
    this.tick.setAttribute("cy", a.y);
    if (!this.visible) {
      this.visible = true;
      this.root.classList.add("is-on");
    }
  }
}
