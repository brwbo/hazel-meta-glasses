import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/RoundedBoxGeometry.js";
import { roundedPoly, rng, tok } from "./util.js";

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
const shadowed = (m) => {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

function screenTexture(draw, w = 512, h = 320) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function laptopScreen(g, w, h) {
  g.fillStyle = tok("--c-screen");
  g.fillRect(0, 0, w, h);
  g.fillStyle = tok("--c-sage-soft");
  rr(g, 24, 24, 280, 272, 18);
  g.fill();
  g.fillStyle = tok("--c-clay");
  g.beginPath();
  g.arc(164, 150, 46, 0, Math.PI * 2);
  g.fill();
  rr(g, 104, 196, 120, 100, 40);
  g.fill();
  g.strokeStyle = tok("--c-moss");
  g.lineWidth = 6;
  [[96, 84, 1, 1], [232, 84, -1, 1], [96, 216, 1, -1], [232, 216, -1, -1]].forEach(([x, y, sx, sy]) => {
    g.beginPath();
    g.moveTo(x + sx * 26, y);
    g.lineTo(x, y);
    g.lineTo(x, y + sy * 26);
    g.stroke();
  });
  g.fillStyle = tok("--color-paper-2");
  rr(g, 328, 24, 160, 272, 14);
  g.fill();
  g.fillStyle = tok("--c-moss");
  rr(g, 344, 44, 92, 14, 7);
  g.fill();
  g.fillStyle = tok("--color-rule");
  [78, 100, 122, 166, 188, 232, 254].forEach((y, i) => {
    rr(g, 344, y, i % 3 === 2 ? 80 : 128, 9, 4);
    g.fill();
  });
}

function phoneScreen(g, w, h) {
  g.fillStyle = tok("--c-moss-deep");
  g.fillRect(0, 0, w, h);
  g.fillStyle = tok("--c-glow");
  const r = rng(11);
  for (let i = 0; i < 9; i++) {
    const bh = 30 + r() * 120;
    rr(g, 28 + i * 20, h / 2 - bh / 2, 9, bh, 4);
    g.fill();
  }
}

export function buildDesk() {
  const group = new THREE.Group();
  const wood = std(tok("--c-wood"), { roughness: 0.65 });
  const moss = std(tok("--c-moss"));
  const top = shadowed(new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.055, 0.7, 4, 0.025), wood));
  top.position.y = 1.08;
  group.add(top);
  [[-0.62, -0.26], [0.62, -0.26], [-0.62, 0.26], [0.62, 0.26]].forEach(([x, z]) => {
    const leg = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.02, 1.06, 10), moss));
    leg.position.set(x, 0.53, z);
    group.add(leg);
  });

  const metal = std(tok("--c-metal"), { roughness: 0.35, metalness: 0.6 });
  const laptop = new THREE.Group();
  laptop.position.set(-0.18, 1.108, 0.02);
  const base = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.016, 0.25, 3, 0.007), metal));
  base.position.y = 0.008;
  laptop.add(base);
  const lid = new THREE.Group();
  lid.position.set(0, 0.016, -0.122);
  lid.rotation.x = -0.28;
  const lidMesh = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.24, 0.01, 3, 0.005), metal));
  lidMesh.position.y = 0.12;
  lid.add(lidMesh);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.336, 0.21), new THREE.MeshBasicMaterial({ map: screenTexture(laptopScreen), toneMapped: false }));
  scr.position.set(0, 0.122, 0.0056);
  lid.add(scr);
  laptop.add(lid);
  group.add(laptop);

  const phone = new THREE.Group();
  phone.position.set(0.2, 1.108, 0.12);
  phone.rotation.y = -0.3;
  const stand = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.03, 0.06, 2, 0.01), moss));
  stand.position.set(0, 0.015, -0.02);
  phone.add(stand);
  const bodyGroup = new THREE.Group();
  bodyGroup.rotation.x = -0.3;
  bodyGroup.position.set(0, 0.012, 0.012);
  const pBody = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.078, 0.16, 0.009, 3, 0.004), std(tok("--c-frame"), { roughness: 0.3 })));
  pBody.position.y = 0.08;
  bodyGroup.add(pBody);
  const pScr = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.15), new THREE.MeshBasicMaterial({ map: screenTexture(phoneScreen, 224, 480), toneMapped: false }));
  pScr.position.set(0, 0.08, 0.0048);
  bodyGroup.add(pScr);
  phone.add(bodyGroup);
  group.add(phone);

  const mugProfile = [[0.001, 0], [0.036, 0], [0.042, 0.012], [0.042, 0.09], [0.036, 0.09], [0.036, 0.016], [0.001, 0.016]].map(([x, y]) => new THREE.Vector2(x, y));
  const mug = shadowed(new THREE.Mesh(new THREE.LatheGeometry(mugProfile, 18), std(tok("--c-sage"), { roughness: 0.5, side: THREE.DoubleSide })));
  mug.position.set(0.5, 1.108, 0.18);
  group.add(mug);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.007, 6, 12, Math.PI), std(tok("--c-sage"), { roughness: 0.5 }));
  handle.rotation.z = -Math.PI / 2;
  handle.position.set(0.542, 1.156, 0.18);
  group.add(handle);

  const pot = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.052, 0.11, 12), std(tok("--c-clay"))));
  pot.position.set(-0.56, 1.163, -0.14);
  group.add(pot);
  const leafMat = std(tok("--c-moss"), { flatShading: true });
  const r = rng(5);
  for (let i = 0; i < 9; i++) {
    const leaf = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 1), leafMat));
    const a = (i / 9) * Math.PI * 2;
    const lean = 0.25 + r() * 0.5;
    leaf.scale.set(0.42, 1.5 + r() * 0.8, 0.14);
    leaf.position.set(-0.56 + Math.cos(a) * 0.05 * lean * 2, 1.3 + r() * 0.07, -0.14 + Math.sin(a) * 0.05 * lean * 2);
    leaf.rotation.set(Math.sin(a) * lean, -a, -Math.cos(a) * lean);
    group.add(leaf);
  }
  return group;
}

export function buildBackdrop() {
  const group = new THREE.Group();
  const archShape = roundedPoly(new THREE.Shape(), [[-1.1, 0], [1.1, 0], [1.1, 3.1], [-1.1, 3.1]], [0.01, 0.01, 1.09, 1.09]);
  const arch = new THREE.Mesh(new THREE.ExtrudeGeometry(archShape, { depth: 0.25, bevelEnabled: false, curveSegments: 24 }), std(tok("--c-sage-soft"), { roughness: 1 }));
  arch.receiveShadow = true;
  arch.castShadow = true;
  group.add(arch);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.18, 48), std(tok("--c-oat"), { roughness: 1 }));
  disc.rotation.x = Math.PI / 2;
  disc.position.set(-2.1, 2.25, 0.3);
  disc.castShadow = true;
  group.add(disc);
  const step = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.5, 0.9, 4, 0.12), std(tok("--color-paper-3"), { roughness: 1 }));
  step.position.set(2.3, 0.25, 0.5);
  step.castShadow = true;
  step.receiveShadow = true;
  group.add(step);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 20), std(tok("--c-sage"), { roughness: 0.9 }));
  ball.position.set(2.5, 0.92, 0.5);
  ball.castShadow = true;
  group.add(ball);
  return group;
}

export function buildBrackets() {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: tok("--c-moss-deep"), transparent: true, toneMapped: false, depthTest: false });
  const L = 0.07;
  const T = 0.011;
  const corners = [];
  [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sy]) => {
    const c = new THREE.Group();
    const h = new THREE.Mesh(new RoundedBoxGeometry(L, T, T, 2, T / 2), mat);
    h.position.x = (-sx * L) / 2 + (sx * T) / 2;
    const v = new THREE.Mesh(new RoundedBoxGeometry(T, L, T, 2, T / 2), mat);
    v.position.y = (-sy * L) / 2 + (sy * T) / 2;
    c.add(h, v);
    c.userData.s = [sx, sy];
    c.renderOrder = 5;
    h.renderOrder = 5;
    v.renderOrder = 5;
    corners.push(c);
    group.add(c);
  });
  const set = (half, opacity) => {
    corners.forEach((c) => c.position.set(c.userData.s[0] * half, c.userData.s[1] * half * 1.12, 0));
    mat.opacity = opacity;
    group.visible = opacity > 0.01;
  };
  return { group, set };
}

export function buildPills(count = 6) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: tok("--c-sage"), roughness: 0.6 });
  const pills = [];
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.02 + (i % 3) * 0.012, 4, 10), mat);
    m.rotation.z = Math.PI / 2;
    group.add(m);
    pills.push(m);
  }
  return { group, pills };
}
