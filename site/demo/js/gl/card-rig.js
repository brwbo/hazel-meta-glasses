import * as THREE from "three";
import { CSS3DObject } from "three/addons/renderers/CSS3DRenderer.js";
import { reducedMotion } from "../../util.js";
import { clamp, damp, ease, lerp, roundedRect, softShadowTexture, tone } from "./kit.js";
import { createGhosts } from "./ghost.js";

const DEPTH = 14;
const BEVEL = 3;
const RADIUS = 23;
const FLY_S = 0.85;
const BEADS = 12;
const LIFT = 40;

export function buildSlab(w, h, mats) {
  const geo = new THREE.ExtrudeGeometry(roundedRect(new THREE.Shape(), w + 2, h + 2, RADIUS), { depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 3, curveSegments: 10 });
  geo.translate(0, 0, -(DEPTH + BEVEL));
  const hole = new THREE.ShapeGeometry(roundedRect(new THREE.Shape(), w - 3, h - 3, RADIUS - 2), 10);
  hole.translate(0, 0, 0.6);
  return { geo, hole, mats };
}

export function createCardRig({ world, flakes, wrapper, card }) {
  const face = card.querySelector(".card-face");
  const body = card.querySelector(".card-body");
  const holder = new THREE.Group();
  holder.visible = false;
  world.scene.add(holder);
  const capMat = new THREE.MeshStandardMaterial({ color: tone("--color-paper-2"), roughness: 0.92 });
  const sideMat = new THREE.MeshStandardMaterial({ color: tone("--color-paper-3"), roughness: 0.9 });
  const holeMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const shadowTex = softShadowTexture();
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: tone("--c-ground-shadow"), transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
  const slab = new THREE.Mesh(new THREE.BufferGeometry(), [capMat, sideMat]);
  const hole = new THREE.Mesh(new THREE.BufferGeometry(), holeMat);
  hole.renderOrder = -10;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  shadow.renderOrder = -5;
  const cssObject = new CSS3DObject(wrapper);
  cssObject.position.z = 0.4;
  holder.add(slab, hole, shadow, cssObject);

  const beadMat = new THREE.MeshStandardMaterial({ color: tone("--c-sage"), roughness: 0.6 });
  const beads = new THREE.InstancedMesh(new THREE.CapsuleGeometry(3, 9, 4, 10), beadMat, BEADS);
  beads.frustumCulled = false;
  beads.visible = false;
  world.scene.add(beads);
  const ghosts = createGhosts({ world, flakes, shadowTex });

  const size = { w: 0, h: 0 };
  const pos = new THREE.Vector3();
  const target = new THREE.Vector3();
  const headC = new THREE.Vector3();
  const lastHead = { w: 160, h: 200, ok: false };
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const c3 = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const side = 1;
  let openAt = -1e9;
  let placed = false;
  let wantGather = false;
  let phone = false;

  function measure() {
    const w = face.offsetWidth;
    const h = face.offsetHeight;
    if (!w || !h || (Math.abs(w - size.w) < 0.5 && Math.abs(h - size.h) < 0.5)) return;
    size.w = w;
    size.h = h;
    slab.geometry.dispose();
    hole.geometry.dispose();
    const next = buildSlab(w, h);
    slab.geometry = next.geo;
    hole.geometry = next.hole;
    shadow.scale.set(w * 1.42, h * 1.36, 1);
  }

  function aim(head) {
    if (phone) {
      world.toWorld(world.size.w / 2, world.size.h - size.h / 2, 0, target);
      return;
    }
    if (head) {
      world.toWorld(head.x + head.w / 2, head.y + head.h / 2, 0, headC);
      lastHead.w = head.w;
      lastHead.h = head.h;
      lastHead.ok = true;
    }
    if (!lastHead.ok) headC.set(world.size.w * 0.1, 0, 0);
    const margin = Math.max(26, world.size.w * 0.022);
    world.toWorld(world.size.w - margin - size.w / 2 - 22, 58 + size.h / 2, LIFT, target);
  }

  function gather(now) {
    const t = now / 1000;
    const n = phone ? 150 : 240;
    dummy.position.copy(target);
    dummy.rotation.set(0, phone ? 0 : -side * 0.16, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * 6.28;
      const rad = 0.3 + Math.random() * 0.5;
      a3.set(Math.cos(ang) * lastHead.w * rad, Math.sin(ang) * lastHead.h * rad, 10 + Math.random() * 30).add(headC);
      b3.set((Math.random() - 0.5) * size.w * 0.96, (Math.random() - 0.5) * size.h * (phone ? 0.5 : 0.96), 4).applyMatrix4(dummy.matrix);
      flakes.gather(a3, b3, { at: t + Math.random() * 0.26, size: 3.4 + Math.random() * 3.6, life: 0.42 + Math.random() * 0.4 });
    }
  }

  function placeBeads(now, k) {
    const show = !phone && lastHead.ok && k > 0.5 && !card.classList.contains("is-faded");
    beads.visible = show;
    if (!show) return;
    a3.set(side * (lastHead.w / 2 + 10), lastHead.h * 0.12, 2).add(headC);
    b3.set(-side * (size.w / 2 + 10), size.h / 2 - 84, -4).applyMatrix4(holder.matrixWorld);
    c3.lerpVectors(a3, b3, 0.5);
    c3.y += 22;
    c3.z += 36;
    const crawl = reducedMotion() ? 0 : (now / 2600) % (1 / BEADS);
    for (let i = 0; i < BEADS; i++) {
      const t = (i + 0.5) / BEADS + crawl - 0.5 / BEADS;
      const u = 1 - t;
      dummy.position.set(u * u * a3.x + 2 * u * t * c3.x + t * t * b3.x, u * u * a3.y + 2 * u * t * c3.y + t * t * b3.y, u * u * a3.z + 2 * u * t * c3.z + t * t * b3.z);
      dummy.quaternion.setFromUnitVectors(up, c3.set(b3.x - a3.x, b3.y - a3.y + (0.5 - t) * 44, 0).normalize());
      c3.lerpVectors(a3, b3, 0.5);
      c3.y += 22;
      c3.z += 36;
      const fadeEnds = Math.sin(clamp(t) * Math.PI);
      dummy.scale.setScalar(clamp((k - 0.5) * 2 - i * 0.05) * (0.7 + 0.3 * fadeEnds));
      dummy.updateMatrix();
      beads.setMatrixAt(i, dummy.matrix);
    }
    beads.instanceMatrix.needsUpdate = true;
  }

  function update(dt, now, { head, isPhone, dragging }) {
    phone = isPhone;
    ghosts.update(now);
    const open = !card.hidden && card.classList.contains("is-open");
    holder.visible = open;
    cssObject.visible = open;
    if (!open) {
      beads.visible = false;
      placed = false;
      return;
    }
    measure();
    aim(head);
    if (!placed) {
      pos.copy(target);
      placed = true;
    }
    pos.lerp(target, damp(dt, phone ? 30 : 6.5));
    const still = reducedMotion();
    const a = still ? 1 : clamp((now - openAt) / 1000 / FLY_S);
    const e = ease.outExpo(a);
    if (wantGather && !still) gather(now);
    wantGather = false;
    if (phone) {
      holder.position.set(pos.x, pos.y - (1 - e) * size.h * 0.55, 0);
      holder.rotation.set(0, 0, 0);
      holder.scale.setScalar(1);
      shadow.position.set(0, 26, -60);
    } else {
      const t = now / 1000;
      holder.position.lerpVectors(headC, pos, e);
      holder.position.y += still ? 0 : Math.sin(t * 1.4) * 2.5;
      holder.rotation.set(0.02, -side * 0.16 + (1 - ease.outBack(a)) * side * 1.25 + (still ? 0 : Math.sin(t * 0.9) * 0.02), (1 - e) * side * 0.18);
      holder.scale.setScalar(lerp(0.3, 1, e));
      shadow.position.set(side * 26, -38, -90);
    }
    shadowMat.opacity = 0.5 * e * (dragging ? 0.4 : 1);
    card.style.opacity = a < 0.4 ? clamp(a * 2.6).toFixed(3) : "";
    holder.updateMatrixWorld(true);
    placeBeads(now, a);
  }

  function open({ replay }) {
    const fresh = card.hidden || !card.classList.contains("is-open");
    card.hidden = false;
    card.style.transform = "";
    card.classList.remove("is-faded");
    card.classList.add("is-open");
    document.body.classList.add("has-card");
    if (fresh || replay) {
      openAt = performance.now();
      placed = false;
      wantGather = true;
    }
  }

  function dissolve() {
    if (card.hidden || !card.classList.contains("is-open") || !size.w || reducedMotion()) return;
    holder.updateMatrixWorld(true);
    ghosts.spawn({ holder, face, w: size.w, h: size.h, side, phone, mats: [capMat, sideMat], slab: slab.geometry, hole: hole.geometry });
  }

  function close() {
    dissolve();
    card.classList.remove("is-open");
    document.body.classList.remove("has-card");
    card.hidden = true;
    holder.visible = false;
    cssObject.visible = false;
    beads.visible = false;
  }

  return { update, open, close, dissolve };
}
