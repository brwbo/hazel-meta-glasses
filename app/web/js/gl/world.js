import * as THREE from "three";
import { CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js";
import { reducedMotion } from "../../util.js";
import { tone } from "./kit.js";

const FOV = 34;

export function createWorld({ canvas, layer }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.localClippingEnabled = true;
  renderer.sortObjects = true;

  const cssRenderer = new CSS3DRenderer({ element: layer });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 20, 8000);
  scene.add(new THREE.HemisphereLight(tone("--color-paper-2"), tone("--c-oat"), 1.7));
  const key = new THREE.DirectionalLight(tone("--color-paper-2"), 2.3);
  key.position.set(-500, 900, 1100);
  scene.add(key);
  const rim = new THREE.DirectionalLight(tone("--c-sage-soft"), 0.8);
  rim.position.set(700, 200, 500);
  scene.add(rim);

  const size = { w: 1, h: 1, d: 1, ratio: 1 };
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  const perf = { frames: 0, total: 0, slow: 0, worst: 0, cap: 2 };
  let phone = false;

  function resize() {
    size.w = window.innerWidth;
    size.h = window.innerHeight;
    size.d = size.h / 2 / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    size.ratio = Math.min(window.devicePixelRatio || 1, perf.cap);
    renderer.setPixelRatio(size.ratio);
    renderer.setSize(size.w, size.h, false);
    cssRenderer.setSize(size.w, size.h);
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
    aim(0);
  }

  function aim(t) {
    const still = phone || reducedMotion();
    const ax = still ? 0 : Math.sin(t * 0.31) * 16 + Math.sin(t * 0.17 + 1) * 8 + pointer.sx * 26;
    const ay = still ? 0 : Math.sin(t * 0.23 + 2) * 9 - pointer.sy * 16;
    camera.position.set(ax, ay, size.d);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  }

  addEventListener("resize", resize);
  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    pointer.x = (e.clientX / size.w) * 2 - 1;
    pointer.y = (e.clientY / size.h) * 2 - 1;
  });

  const v = new THREE.Vector3();
  function toWorld(sx, sy, z = 0, out = new THREE.Vector3()) {
    v.set((sx / size.w) * 2 - 1, -(sy / size.h) * 2 + 1, 0.5).unproject(camera).sub(camera.position);
    const k = (z - camera.position.z) / v.z;
    return out.copy(camera.position).addScaledVector(v, k);
  }
  function toScreen(world, out = { x: 0, y: 0 }) {
    v.copy(world).project(camera);
    out.x = (v.x * 0.5 + 0.5) * size.w;
    out.y = (-v.y * 0.5 + 0.5) * size.h;
    return out;
  }

  function frame(dt, now) {
    const k = 1 - Math.exp(-dt * 3);
    pointer.sx += (pointer.x - pointer.sx) * k;
    pointer.sy += (pointer.y - pointer.sy) * k;
    aim(now / 1000);
  }

  function render(dt) {
    renderer.render(scene, camera);
    cssRenderer.render(scene, camera);
    perf.frames += 1;
    perf.total += dt;
    perf.worst = Math.max(perf.worst, dt);
    if (dt > 0.024) perf.slow += 1;
    else perf.slow = Math.max(0, perf.slow - 0.25);
    if (perf.slow > 45 && perf.cap > 1) {
      perf.cap = Math.max(1, perf.cap - 0.5);
      perf.slow = 0;
      resize();
    }
  }

  resize();
  return { renderer, scene, camera, size, perf, toWorld, toScreen, frame, render, resize, setPhone: (on) => { phone = on; } };
}
