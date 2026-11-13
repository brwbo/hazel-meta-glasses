import * as THREE from "three";
import { clamp, ease, tone } from "./kit.js";

const CAP = 2200;
const dummy = new THREE.Object3D();
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const a3 = new THREE.Vector3();

function oatGeometry() {
  const geo = new THREE.SphereGeometry(1, 7, 5);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i) * 0.6;
    const y = p.getY(i) * 0.13 + 0.16 * x * x - 0.1 * Math.exp(-z * z * 30) * (1 - x * x);
    p.setXYZ(i, x, y, z);
  }
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

export function createFlakes(scene) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78 });
  const mesh = new THREE.InstancedMesh(oatGeometry(), mat, CAP);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  const light = tone("--c-oat");
  const deep = tone("--c-oat-deep");
  const toast = tone("--c-toast");
  const colour = new THREE.Color();
  const items = new Array(CAP).fill(null);
  let cursor = 0;
  let live = 0;
  for (let i = 0; i < CAP; i++) {
    mesh.setMatrixAt(i, hidden);
    mesh.setColorAt(i, light);
  }
  scene.add(mesh);

  function add(it) {
    const i = cursor;
    cursor = (cursor + 1) % CAP;
    if (!items[i]) live += 1;
    items[i] = it;
    mesh.setMatrixAt(i, hidden);
    const r = Math.random();
    colour.copy(light).lerp(r > 0.8 ? toast : deep, r * r);
    mesh.setColorAt(i, colour);
    mesh.instanceColor.needsUpdate = true;
    it.rot = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];
    it.spin = [(Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9];
    it.ph = Math.random() * 6.28;
  }

  function scatter(from, { at, wind, size, life = 1.5, lift = 0 }) {
    add({ mode: 0, from: from.clone(), to: wind.clone(), t0: at, life, s: size, lift });
  }

  function gather(from, to, { at, size, life = 0.7 }) {
    add({ mode: 1, from: from.clone(), to: to.clone(), t0: at, life, s: size, lift: 0 });
  }

  function update(now) {
    if (!live) return;
    const t = now / 1000;
    for (let i = 0; i < CAP; i++) {
      const it = items[i];
      if (!it) continue;
      const age = t - it.t0;
      if (age < 0) continue;
      if (age > it.life) {
        items[i] = null;
        live -= 1;
        mesh.setMatrixAt(i, hidden);
        continue;
      }
      const k = age / it.life;
      let s;
      if (it.mode === 0) {
        const e = 1 - Math.exp(-age * 1.9);
        a3.copy(it.from).addScaledVector(it.to, e);
        a3.x += Math.sin(age * 3 + it.ph) * it.s * 0.9 * e;
        a3.y += age * age * it.lift + Math.cos(age * 2.6 + it.ph) * it.s * 0.8 * e;
        s = it.s * clamp(age / 0.07) * (1 + e * 0.4) * clamp((1 - k) / 0.35);
      } else {
        const e = ease.inOut(k);
        a3.lerpVectors(it.from, it.to, e);
        const arc = Math.sin(k * Math.PI);
        a3.x += Math.sin(it.ph) * arc * 46;
        a3.y += Math.cos(it.ph * 1.7) * arc * 40;
        a3.z += arc * 70;
        s = it.s * clamp(k / 0.15) * clamp((1 - k) / 0.22);
      }
      dummy.position.copy(a3);
      dummy.rotation.set(it.rot[0] + age * it.spin[0], it.rot[1] + age * it.spin[1], it.rot[2] + age * it.spin[2]);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { scatter, gather, update, count: () => live };
}
