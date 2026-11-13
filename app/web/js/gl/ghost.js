import * as THREE from "three";
import { CSS3DObject } from "three/addons/renderers/CSS3DRenderer.js";
import { clamp, lerp, tone } from "./kit.js";

const ANGLE = 0.67;
const NX = -Math.sin(ANGLE);
const NY = Math.cos(ANGLE);
const SWEEP_S = 0.75;
const DEG = -(ANGLE * 180) / Math.PI;

export function createGhosts({ world, flakes, shadowTex }) {
  const list = [];
  const holeMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const shadowColour = tone("--c-ground-shadow");
  const n = new THREE.Vector3();
  const p = new THREE.Vector3();
  const from = new THREE.Vector3();
  const wind = new THREE.Vector3();

  function spawn({ holder, face, w, h, side, phone, mats, slab, hole }) {
    const group = new THREE.Group();
    group.position.copy(holder.position);
    group.quaternion.copy(holder.quaternion);
    group.scale.copy(holder.scale);
    const plane = new THREE.Plane();
    const cloned = mats.map((m) => {
      const c = m.clone();
      c.clippingPlanes = [plane];
      return c;
    });
    const holeClip = holeMat.clone();
    holeClip.clippingPlanes = [plane];
    const slabMesh = new THREE.Mesh(slab.clone(), cloned);
    const holeMesh = new THREE.Mesh(hole.clone(), holeClip);
    holeMesh.renderOrder = -10;
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: shadowColour, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.42, h * 1.36), shadowMat);
    shadow.position.set(phone ? 0 : side * 26, phone ? 26 : -38, phone ? -60 : -90);
    shadow.renderOrder = -5;

    const el = document.createElement("div");
    el.className = "card3d card-ghost";
    el.setAttribute("aria-hidden", "true");
    el.inert = true;
    const copy = face.cloneNode(true);
    copy.querySelectorAll("[id]").forEach((x) => x.removeAttribute("id"));
    copy.removeAttribute("id");
    el.append(copy);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.setProperty("--sweep-angle", `${DEG}deg`);
    el.style.setProperty("--sweep", "-6%");
    const css = new CSS3DObject(el);
    css.position.z = 0.4;
    group.add(slabMesh, holeMesh, shadow, css);
    world.scene.add(group);
    group.updateMatrixWorld(true);
    const scrollFrom = face.querySelector(".card-body");
    const scrollTo = copy.querySelector(".card-body");
    const top = scrollFrom ? scrollFrom.scrollTop : 0;

    const span = Math.abs(NX) * w + Math.abs(NY) * h;
    const step = Math.max(9, Math.sqrt((w * h) / 880));
    const cols = Math.max(4, Math.round(w / step));
    const rows = Math.max(4, Math.round(h / step));
    const reach = Math.min(h, 620) * 0.78;
    const t = performance.now() / 1000;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = ((i + 0.5 + (Math.random() - 0.5) * 0.7) / cols - 0.5) * w;
        const y = ((j + 0.5 + (Math.random() - 0.5) * 0.7) / rows - 0.5) * h;
        const order = (x * NX + y * NY + span / 2) / span;
        from.set(x, y, 5).applyMatrix4(group.matrixWorld);
        wind.set(-(0.05 + Math.random() * 0.5) * reach, (0.2 + Math.random() * 0.8) * reach, (Math.random() - 0.3) * 1.5 * reach * 0.6);
        flakes.scatter(from, { at: t + order * SWEEP_S, wind, size: step * (0.34 + Math.random() * 0.3), life: 1.25 + Math.random() * 0.5, lift: reach * 0.22 });
      }
    }
    list.push({ group, plane, el, css, span, shadowMat, slabMesh, holeMesh, shadow, cloned, holeClip, t0: performance.now(), scrollTo, top, primed: false });
  }

  function update(now) {
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (!g.primed && g.el.isConnected) {
        if (g.scrollTo) g.scrollTo.scrollTop = g.top;
        g.primed = true;
      }
      const k = clamp((now - g.t0) / 1000 / SWEEP_S);
      const d = lerp(-g.span / 2 - 10, g.span / 2 + 10, k);
      n.set(NX, NY, 0).transformDirection(g.group.matrixWorld);
      p.set(NX * d, NY * d, 0).applyMatrix4(g.group.matrixWorld);
      g.plane.setFromNormalAndCoplanarPoint(n, p);
      g.el.style.setProperty("--sweep", `${(((d + g.span / 2) / g.span) * 100).toFixed(1)}%`);
      g.shadowMat.opacity = 0.5 * (1 - k);
      if (k >= 1) {
        world.scene.remove(g.group);
        g.el.remove();
        g.slabMesh.geometry.dispose();
        g.holeMesh.geometry.dispose();
        g.shadow.geometry.dispose();
        g.shadowMat.dispose();
        g.holeClip.dispose();
        g.cloned.forEach((m) => m.dispose());
        list.splice(i, 1);
      }
    }
  }

  return { spawn, update };
}
