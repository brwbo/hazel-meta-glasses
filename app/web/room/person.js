import * as THREE from "three";
import { tok } from "./util.js";

const flat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...extra });

export function buildPerson({ skin = tok("--c-skin"), hair = tok("--c-hair"), top = tok("--c-clay"), collar = tok("--c-sage") } = {}) {
  const group = new THREE.Group();
  const skinMat = flat(skin, { roughness: 0.7 });
  const hairMat = flat(hair, { roughness: 0.6 });
  const topMat = flat(top);

  const profile = [[0.001, 1.43], [0.085, 1.43], [0.2, 1.37], [0.255, 1.27], [0.262, 1.1], [0.235, 0.6], [0.215, 0]].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 14), topMat);
  body.scale.set(1.22, 1, 0.72);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const collarMesh = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.022, 6, 14), flat(collar));
  collarMesh.rotation.x = Math.PI / 2;
  collarMesh.position.y = 1.432;
  collarMesh.scale.set(1.1, 1, 1);
  group.add(collarMesh);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.06, 0.14, 8), skinMat);
  neck.position.y = 1.47;
  group.add(neck);

  const head = new THREE.Group();
  head.position.y = 1.5;
  group.add(head);

  const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 2), skinMat);
  skull.scale.set(0.9, 1.1, 0.98);
  skull.position.y = 0.14;
  skull.castShadow = true;
  head.add(skull);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 4), skinMat);
  nose.position.set(0, 0.125, 0.152);
  nose.rotation.x = 1.15;
  head.add(nose);

  const eyeMat = new THREE.MeshStandardMaterial({ color: tok("--c-frame"), roughness: 0.3 });
  [-1, 1].forEach((s) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), eyeMat);
    eye.scale.set(1, 1.35, 0.6);
    eye.position.set(s * 0.05, 0.165, 0.134);
    head.add(eye);
    const ear = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), skinMat);
    ear.scale.set(0.5, 1, 0.8);
    ear.position.set(s * 0.135, 0.13, 0);
    head.add(ear);
  });

  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 4, 10, Math.PI * 0.8), eyeMat);
  smile.position.set(0, 0.085, 0.135);
  smile.rotation.z = Math.PI + Math.PI * 0.1;
  smile.rotation.x = -0.25;
  head.add(smile);

  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.162, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.52), hairMat);
  cap.scale.set(0.95, 1.08, 1.02);
  cap.position.set(0, 0.15, -0.012);
  cap.rotation.x = -0.42;
  cap.castShadow = true;
  head.add(cap);

  const bob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), hairMat);
  bob.scale.set(1.06, 1.25, 0.72);
  bob.position.set(0, 0.07, -0.075);
  bob.castShadow = true;
  head.add(bob);

  [-1, 1].forEach((s) => {
    const lock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 1), hairMat);
    lock.scale.set(0.5, 1.9, 1.1);
    lock.position.set(s * 0.137, 0.085, -0.005);
    head.add(lock);
  });

  const bun = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 1), hairMat);
  bun.position.set(0, 0.325, -0.06);
  bun.castShadow = true;
  head.add(bun);

  return { group, head, mouth: new THREE.Vector3(0, 1.585, 0.16), face: new THREE.Vector3(0, 1.64, 0) };
}
