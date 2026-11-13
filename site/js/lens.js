import * as THREE from "three";
import { RoomEnvironment } from "three/addons/RoomEnvironment.js";
import { tok } from "./ad/util.js";
import { buildGlasses } from "./ad/models/glasses.js";

export function initLens({ reduced }) {
  const canvas = document.getElementById("lens");
  const box = canvas.parentElement;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err) {
    box.hidden = true;
    return null;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  scene.add(new THREE.HemisphereLight(new THREE.Color(tok("--color-paper-2")), new THREE.Color(tok("--c-oat")), 1.3));
  const key = new THREE.DirectionalLight(new THREE.Color(tok("--color-paper-2")), 2.4);
  key.position.set(-2, 3, 3);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
  camera.position.set(0, 0.42, 3.5);
  camera.lookAt(0, 0, 0);
  const glasses = buildGlasses();
  scene.add(glasses.group);

  const pointer = { x: 0, y: 0 };
  let px = 0;
  let py = 0;
  let live = 0;
  let last = 0;
  let raf = 0;
  let visible = false;

  function resize() {
    const r = box.getBoundingClientRect();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  }

  function draw() {
    const g = glasses.group;
    g.position.y = Math.sin(live * 2.2) * 0.02;
    g.rotation.set(0.46 + Math.sin(live * 0.7) * 0.05 + py * 0.08, Math.sin(live * 0.45) * 0.38 + px * 0.25, Math.sin(live * 0.6) * 0.03);
    glasses.setGlow(0.8 + 0.2 * Math.sin(live * 3.2));
    renderer.render(scene, camera);
  }

  function tick(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    live += dt;
    px += (pointer.x - px) * (1 - Math.exp(-dt * 4));
    py += (pointer.y - py) * (1 - Math.exp(-dt * 4));
    draw();
    raf = requestAnimationFrame(tick);
  }

  function wake() {
    if (raf || !visible || document.hidden || reduced) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  resize();
  live = 1.2;
  draw();
  addEventListener("resize", () => {
    resize();
    draw();
  });
  if (reduced) return { running: () => false };
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    wake();
  }).observe(box);
  document.addEventListener("visibilitychange", wake);
  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });
  return { running: () => !!raf };
}
