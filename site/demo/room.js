import * as THREE from "three";
import { RoomEnvironment } from "../vendor/RoomEnvironment.js";
import { tok } from "../js/ad/util.js";
import { buildPerson } from "../js/ad/models/person.js";
import { buildBackdrop, buildDesk } from "../js/ad/models/props.js";

const pick = (name, fallback) => tok(name) || fallback;
const HAIR = { cap: 7, bob: 8, lockL: 9, lockR: 10, bun: 11 };

const LOOKS = [
  { x: -0.2, z: 0.25, scale: 1, skin: pick("--c-skin", "#B97A56"), hair: pick("--c-hair", "#3A2A22"), top: pick("--c-clay", "#CF8E6A"), collar: pick("--c-sage", "#A9BFA0"), hide: [] },
  { x: -1.32, z: -0.3, scale: 1.07, wide: 1.12, skin: pick("--c-skin-deep", "#5F3B2A"), hair: pick("--c-hair-black", "#1E1A18"), top: pick("--c-moss", "#4F6B4A"), collar: pick("--c-oat", "#E6CD9C"), hide: ["bob", "lockL", "lockR", "bun"] },
  { x: 1.02, z: -0.1, scale: 0.97, skin: pick("--c-skin-tan", "#D29C74"), hair: pick("--c-hair-black", "#1E1A18"), top: pick("--c-dusk", "#7C8FA0"), collar: pick("--c-cream-cloth", "#F2ECDD"), hide: ["bun"], long: 1.25 },
  { x: 1.78, z: -0.75, scale: 1.03, skin: pick("--c-skin-fair", "#E9C3A2"), hair: pick("--c-hair-blond", "#C9A566"), top: pick("--c-rust", "#A9553A"), collar: pick("--c-cream-cloth", "#F2ECDD"), hide: ["lockL", "lockR"] },
  { x: -0.78, z: -0.95, scale: 1.01, skin: pick("--c-skin-brown", "#8C5A3D"), hair: pick("--c-hair-grey", "#B9B2A6"), top: pick("--c-cream-cloth", "#F2ECDD"), collar: pick("--c-rust", "#A9553A"), hide: ["bob", "bun"], specs: true },
];

function dress(person, look) {
  const parts = person.head.children;
  look.hide.forEach((name) => {
    parts[HAIR[name]].visible = false;
  });
  if (look.long) parts[HAIR.bob].scale.y *= look.long;
  if (look.specs) {
    const mat = new THREE.MeshStandardMaterial({ color: pick("--c-frame", "#1B1F1A"), roughness: 0.4 });
    [-1, 1].forEach((s) => {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.005, 6, 18), mat);
      rim.position.set(s * 0.05, 0.165, 0.15);
      person.head.add(rim);
    });
    const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.034, 6), mat);
    bridge.rotation.z = Math.PI / 2;
    bridge.position.set(0, 0.17, 0.152);
    person.head.add(bridge);
  }
  person.group.scale.set(look.scale * (look.wide || 1), look.scale, look.scale);
  person.smile = parts[6];
}

export function createRoom({ width, height, calm, narrow }) {
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  const ratio = (window.devicePixelRatio || 1) > 1 ? 1.5 : 1;
  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const paper = new THREE.Color(pick("--color-paper", "#F6F0E3"));
  renderer.setClearColor(paper, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(paper, 6, 16);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;
  const camera = new THREE.PerspectiveCamera(narrow ? 56 : 44, width / height, 0.05, 60);
  const spread = narrow ? 0.6 : 1;
  const deep = narrow ? 1.35 : 1;

  scene.add(new THREE.HemisphereLight(new THREE.Color(pick("--color-paper-2", "#FFFDF8")), new THREE.Color(pick("--c-oat", "#E6CD9C")), 1.25));
  const key = new THREE.DirectionalLight(new THREE.Color(pick("--color-paper-2", "#FFFDF8")), 2.5);
  key.position.set(-2.6, 4.8, 3.4);
  key.target.position.set(0, 1, -0.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1536, 1536);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 16 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 5;
  const rim = new THREE.DirectionalLight(new THREE.Color(pick("--c-sage-soft", "#D3DEC8")), 0.9);
  rim.position.set(3, 2.5, -3);
  scene.add(key, key.target, rim);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ color: new THREE.Color(pick("--c-ground-shadow", "#7A6540")), opacity: 0.3 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const backdrop = buildBackdrop();
  backdrop.position.set(-0.3, 0, -3.6);
  scene.add(backdrop);
  const second = buildBackdrop();
  second.position.set(5.6, 0, -4.4);
  second.rotation.y = -0.5;
  scene.add(second);
  const desk = buildDesk();
  desk.position.set(-2.7, 0, -1.9);
  desk.rotation.y = 0.5;
  scene.add(desk);

  const people = LOOKS.map((look, i) => {
    const person = buildPerson({ skin: look.skin, hair: look.hair, top: look.top, collar: look.collar });
    dress(person, look);
    scene.add(person.group);
    return { ...person, look, phase: i * 1.7 + 0.4, speed: 0.22 + (i % 3) * 0.05 };
  });

  const amp = calm ? 0.35 : 1;
  const eye = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const top = new THREE.Vector3();
  const up = new THREE.Vector3();

  function step(sim, talk) {
    eye.set(Math.sin(sim * 0.31) * 0.16 * amp, 1.6 + Math.sin(sim * 0.47) * 0.018 * amp, 2.55 + Math.sin(sim * 0.23) * 0.06 * amp);
    aim.set(Math.sin(sim * 0.19 + 1) * 0.22 * amp * spread, narrow ? 1.22 : 1.5, 0);
    camera.position.copy(eye);
    camera.lookAt(aim);
    camera.updateMatrixWorld(true);
    up.copy(camera.up).applyQuaternion(camera.quaternion);

    return people.map((p, i) => {
      const t = sim * p.speed + p.phase;
      const said = talk(i);
      const x = p.look.x * spread + Math.sin(t) * 0.2 * amp * spread + Math.sin(t * 0.43 + 2) * 0.1 * amp;
      const z = p.look.z * deep + Math.cos(t * 0.7) * 0.14 * amp;
      p.group.position.set(x, Math.sin(sim * 1.7 + p.phase) * 0.004, z);
      p.group.rotation.y = Math.atan2(eye.x - x, eye.z - z) + Math.sin(t * 0.9) * 0.3 * amp;
      p.head.rotation.set(0.03 + Math.sin(sim * 9 + i) * 0.035 * said, Math.sin(sim * 1.3 + p.phase) * 0.14 * amp, Math.sin(sim * 1.1 + p.phase) * 0.04);
      p.smile.scale.set(1 - 0.25 * said * Math.abs(Math.sin(sim * 11 + i)), 1 + 0.9 * said * Math.abs(Math.sin(sim * 11 + i)), 1);
      p.group.updateWorldMatrix(true, true);
      centre.set(0, 0.135, 0.02).applyMatrix4(p.head.matrixWorld);
      top.copy(centre).addScaledVector(up, 0.2 * p.look.scale);
      centre.project(camera);
      top.project(camera);
      const cx = (centre.x * 0.5 + 0.5) * width;
      const cy = (-centre.y * 0.5 + 0.5) * height;
      const half = Math.abs(((-top.y * 0.5 + 0.5) * height) - cy);
      return { box: [cx - half * 0.8, cy - half, half * 1.6, half * 2].map(Math.round), depth: centre.z };
    });
  }

  const render = () => renderer.render(scene, camera);

  function portrait(box) {
    const k = canvas.width / width;
    const side = Math.max(box[2], box[3]) * 1.9 * k;
    const cx = (box[0] + box[2] / 2) * k;
    const cy = (box[1] + box[3] * 0.42) * k;
    const out = document.createElement("canvas");
    out.width = out.height = 192;
    out.getContext("2d").drawImage(canvas, cx - side / 2, cy - side / 2, side, side, 0, 0, 192, 192);
    return out.toDataURL("image/jpeg", 0.86);
  }

  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Simulated glasses view of a room with five fictional people");
  return { canvas, step, render, portrait, count: people.length };
}
