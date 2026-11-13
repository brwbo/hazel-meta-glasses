import * as THREE from "three";
import { clamp, damp, ease, lerp, tok, tone } from "./kit.js";

const ARM = 22;
const CORNERS = [[-1, 1], [1, 1], [-1, -1], [1, -1]];

function cornerGeometry(arm, thick, radius, grow) {
  const s = new THREE.Shape();
  const o = -grow;
  const t = thick + grow * 2;
  const r = radius + grow;
  const a = arm + grow;
  const ri = Math.max(0.5, r - t);
  s.moveTo(a, -o);
  s.lineTo(o + r, -o);
  s.quadraticCurveTo(o, -o, o, -o - r);
  s.lineTo(o, -a);
  s.quadraticCurveTo(o + t / 2, -a - t / 2, o + t, -a);
  s.lineTo(o + t, -o - t - ri);
  s.quadraticCurveTo(o + t, -o - t, o + t + ri, -o - t);
  s.lineTo(a, -o - t);
  s.quadraticCurveTo(a + t / 2, -o - t / 2, a, -o);
  const g = new THREE.ExtrudeGeometry(s, { depth: grow ? 1 : 4, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, grow ? -1.2 : 0);
  return g;
}

function tagTexture() {
  const canvas = document.createElement("canvas");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return { canvas, tex };
}

export function createBrackets({ world, overlay, flakes }) {
  const group = new THREE.Group();
  world.scene.add(group);
  const geo = cornerGeometry(ARM, 3.6, 12, 0);
  const haloGeo = cornerGeometry(ARM, 3.6, 12, 1.6);
  const tagGeo = new THREE.PlaneGeometry(1, 1);
  const known = tone("--color-known");
  const unknown = tone("--color-unknown");
  const halo = tone("--color-paper-2");
  const font = `600 15px ${tok("--font-body")}`;
  const ink = tok("--color-accent-ink");
  const items = new Map();
  const centre = new THREE.Vector3();
  const from = new THREE.Vector3();
  const wind = new THREE.Vector3();

  function paintTag(it, text, isKnown) {
    const k = 2 * world.size.ratio;
    const g = it.tag.canvas.getContext("2d");
    g.font = font;
    const tw = Math.min(210, Math.ceil(g.measureText(text).width));
    const w = tw + 26;
    const h = 28;
    it.tag.canvas.width = Math.ceil(w * k);
    it.tag.canvas.height = Math.ceil(h * k);
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = `#${(isKnown ? known : unknown).getHexString()}`;
    g.beginPath();
    g.roundRect(0, 0, w, h, h / 2);
    g.fill();
    g.font = font;
    g.fillStyle = ink;
    g.textBaseline = "middle";
    g.textAlign = "center";
    g.fillText(text, w / 2, h / 2 + 1, tw);
    it.tag.tex.needsUpdate = true;
    it.tagSize = [w, h];
  }

  function make(tr, now) {
    const root = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: unknown.clone(), transparent: true, toneMapped: false, side: THREE.DoubleSide });
    const haloMat = new THREE.MeshBasicMaterial({ color: halo, transparent: true, toneMapped: false, side: THREE.DoubleSide });
    const corners = CORNERS.map(([sx, sy]) => {
      const c = new THREE.Group();
      const m = new THREE.Mesh(geo, mat);
      const hm = new THREE.Mesh(haloGeo, haloMat);
      m.renderOrder = 3;
      hm.renderOrder = 2;
      c.add(hm, m);
      c.scale.set(-sx, sy, 1);
      root.add(c);
      return c;
    });
    const tag = tagTexture();
    const tagMat = new THREE.MeshBasicMaterial({ map: tag.tex, transparent: true, toneMapped: false, depthWrite: false });
    const tagMesh = new THREE.Mesh(tagGeo, tagMat);
    tagMesh.renderOrder = 4;
    root.add(tagMesh);
    group.add(root);
    return { root, corners, mat, haloMat, tag, tagMat, tagMesh, born: now, text: null, known: null, popAt: -1e9, sel: 0, alpha: 1, tagSize: [60, 28], puffed: false };
  }

  function puff(it, w, h, now) {
    const t = now / 1000;
    for (let i = 0; i < 34; i++) {
      const ang = (i / 34) * 6.28 + Math.random() * 0.3;
      from.set(Math.cos(ang) * w * 0.62, Math.sin(ang) * h * 0.62, 6).add(it.root.position);
      wind.set(Math.cos(ang) * (30 + Math.random() * 70), Math.sin(ang) * (30 + Math.random() * 70) + 20, 20 + Math.random() * 60);
      flakes.scatter(from, { at: t + 0.16 + Math.random() * 0.16, wind, size: 3.2 + Math.random() * 3, life: 0.9 + Math.random() * 0.5, lift: 40 });
    }
  }

  function update(dt, now) {
    for (const [id, tr] of overlay.tracks) {
      if (!tr.rect || !tr.face) continue;
      let it = items.get(id);
      if (!it) {
        it = make(tr, now);
        items.set(id, it);
      }
      it.seen = now;
      const r = tr.rect;
      world.toWorld(r.x + r.w / 2, r.y + r.h / 2, 0, centre);
      it.root.position.copy(centre);
      const age = (now - it.born) / 1000;
      const lock = lerp(1.95, 1, ease.outBack(clamp(age / 0.42))) * (1 + 0.045 * Math.sin(clamp((age - 0.42) / 0.3) * Math.PI));
      const isKnown = tr.face.personId != null;
      const selected = id === overlay.selected;
      it.sel += ((selected ? 1 : 0) - it.sel) * damp(dt, 12);
      const arm = clamp(r.w * 0.24, 13, 30) / ARM;
      const hw = (r.w / 2) * lock;
      const hh = (r.h / 2) * lock;
      it.corners.forEach((c, i) => {
        const [sx, sy] = CORNERS[i];
        c.position.set(sx * hw, sy * hh, 0);
        const k = arm * (1 + it.sel * 0.22);
        c.scale.set(-sx * k, sy * k, 1 + it.sel);
      });
      it.mat.color.lerp(isKnown ? known : unknown, damp(dt, 9));
      const dim = tr.goneAt ? 0 : tr.missingAt || tr.face.predicted ? 0.5 : 1;
      it.alpha += (dim - it.alpha) * damp(dt, tr.goneAt ? 14 : 10);
      const fade = clamp(age / 0.16) * it.alpha;
      it.mat.opacity = fade;
      it.haloMat.opacity = fade * 0.9;
      const text = isKnown ? tr.face.name || "Known" : "unknown";
      if (text !== it.text || isKnown !== it.known) {
        if (it.text !== null) it.popAt = now;
        it.text = text;
        it.known = isKnown;
        paintTag(it, text, isKnown);
      }
      const tagIn = ease.outBack(clamp((age - 0.24) / 0.38));
      const pop = 1 + 0.24 * Math.sin(clamp((now - it.popAt) / 520) * Math.PI);
      const ts = Math.max(0.001, tagIn) * pop * (1 + it.sel * 0.12) * (world.size.w < 720 ? 0.74 : 1);
      it.tagMesh.scale.set(it.tagSize[0] * ts, it.tagSize[1] * ts, 1);
      it.tagMesh.position.set(0, r.h / 2 + 10 + (it.tagSize[1] * ts) / 2 + (1 - tagIn) * -8, 14);
      it.tagMat.opacity = clamp((age - 0.24) / 0.2) * it.alpha;
      if (!it.puffed && age > 0.05) {
        it.puffed = true;
        puff(it, r.w, r.h, now);
      }
    }
    for (const [id, it] of items) {
      if (it.seen === now) continue;
      group.remove(it.root);
      it.mat.dispose();
      it.haloMat.dispose();
      it.tagMat.dispose();
      it.tag.tex.dispose();
      items.delete(id);
    }
  }

  return { update };
}
