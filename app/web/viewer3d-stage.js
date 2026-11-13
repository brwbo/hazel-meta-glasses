import * as THREE from 'three';
import { additive, disposeTree } from './viewer3d-holo.js';

const FLAT_VERT = `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GRID_FRAG = `
uniform vec3 uColor;
uniform float uGlow;
varying vec2 vP;
float hex(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 c = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - c.xy * s, p - (c.zw + 0.5) * s);
  vec2 q = abs(dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw);
  float edge = 0.5 - max(dot(q, s * 0.5), q.x);
  return 1.0 - smoothstep(0.0, fwidth(edge) * 1.6, edge);
}
void main() {
  float r = length(vP);
  float fade = smoothstep(5.0, 0.3, r);
  float pool = smoothstep(1.9, 0.0, r) * (0.06 + uGlow * 0.16);
  gl_FragColor = vec4(uColor, hex(vP / 0.3) * 0.3 * fade * fade + pool);
}`;

const SCAN_FRAG = `
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vP;
void main() {
  float r = length(vP);
  float rim = smoothstep(0.82, 1.0, r) * (1.0 - smoothstep(0.985, 1.0, r));
  float sweep = 0.5 + 0.5 * sin(atan(vP.y, vP.x) * 24.0);
  gl_FragColor = vec4(uColor, (rim * (0.5 + sweep * 0.25) + 0.03 * (1.0 - smoothstep(0.9, 1.0, r))) * uAlpha);
}`;

function glowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [stop, alpha] of [[0, 1], [0.12, 0.62], [0.26, 0.32], [0.42, 0.15], [0.6, 0.06], [0.8, 0.015], [1, 0]]) {
    g.addColorStop(stop, `rgba(255,255,255,${alpha})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function tickRing(radius, count, material) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const len = i % 10 === 0 ? 0.085 : i % 5 === 0 ? 0.05 : 0.026;
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius, Math.cos(a) * (radius + len), 0, Math.sin(a) * (radius + len));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, material);
}

function orbiter(material, glow, arc, tilt, speed) {
  const pts = [];
  const steps = 28;
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * arc;
    const a1 = ((i + 1) / steps) * arc;
    pts.push(Math.cos(a0), 0, Math.sin(a0), Math.cos(a1), 0, Math.sin(a1));
    if (i % 4 === 0) pts.push(Math.cos(a0), 0, Math.sin(a0), Math.cos(a0) * 1.04, 0, Math.sin(a0) * 1.04);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const spin = new THREE.Group();
  const head = new THREE.Sprite(glow);
  head.position.set(1, 0, 0);
  head.scale.setScalar(0.13);
  spin.add(new THREE.LineSegments(geo, material), head);
  const holder = new THREE.Group();
  holder.rotation.set(tilt[0], 0, tilt[1]);
  holder.add(spin);
  return { holder, spin, speed };
}

export function createStage(accent) {
  const group = new THREE.Group();
  const color = new THREE.Color(accent);
  const bright = color.clone().lerp(new THREE.Color(0xffffff), 0.35);
  const texture = glowTexture();
  const flat = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, ...uniforms },
    vertexShader: FLAT_VERT,
    fragmentShader,
    side: THREE.DoubleSide,
    ...additive,
  });

  const grid = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), flat(GRID_FRAG, { uGlow: { value: 0 } }));
  grid.rotation.x = -Math.PI / 2;

  const ringGeo = new THREE.RingGeometry(1.25, 1.262, 160);
  const ringMat = (opacity) => new THREE.MeshBasicMaterial({ color, opacity, side: THREE.DoubleSide, ...additive });
  const base = new THREE.Mesh(ringGeo, ringMat(0.5));
  const pulse = new THREE.Mesh(ringGeo, ringMat(0));
  for (const ring of [base, pulse]) {
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
  }
  const lineMat = new THREE.LineBasicMaterial({ color, opacity: 0.6, ...additive });
  const ticks = tickRing(1.29, 120, lineMat);
  ticks.position.y = 0.004;

  const scan = new THREE.Mesh(new THREE.CircleGeometry(1, 64), flat(SCAN_FRAG, { uAlpha: { value: 0 } }));
  scan.rotation.x = -Math.PI / 2;
  scan.scale.setScalar(1.25);
  scan.visible = false;

  const glowMat = (opacity, tint) => new THREE.SpriteMaterial({ map: texture, color: tint, opacity, depthTest: false, ...additive });
  const halo = new THREE.Sprite(glowMat(0.16, color));
  halo.renderOrder = -1;
  const headGlow = glowMat(0.95, bright);
  const orbitMat = new THREE.LineBasicMaterial({ color: bright, opacity: 0.55, ...additive });
  const orbits = new THREE.Group();
  const orbiters = [
    orbiter(orbitMat, headGlow, 1.1, [0.42, 0.18], 0.55),
    orbiter(orbitMat, headGlow, 0.7, [-0.3, -0.36], -0.38),
    orbiter(orbitMat, headGlow, 0.45, [1.05, 0.5], 0.3),
  ];
  orbiters.forEach((o, i) => {
    o.spin.rotation.y = i * 2.2;
    orbits.add(o.holder);
  });
  group.add(grid, base, pulse, ticks, scan, halo, orbits);

  return {
    group,
    update({ dt, still, pulse: p, scanY, center, radius }) {
      const k = Math.min(Math.max(p, 0), 1);
      const ease = 1 - (1 - k) * (1 - k);
      pulse.scale.setScalar(still ? 1 : 1 + ease * 0.6);
      pulse.material.opacity = (1 - k) * 0.9;
      base.material.opacity = 0.5 + (1 - k) * 0.4;
      grid.material.uniforms.uGlow.value = 1 - k;
      halo.position.copy(center);
      halo.scale.setScalar(radius * (3.4 + (1 - k) * 0.8));
      halo.material.opacity = 0.16 + (1 - k) * 0.2;
      orbits.position.copy(center);
      orbits.scale.setScalar(radius * 0.97);
      scan.visible = scanY !== null;
      if (scan.visible) {
        scan.position.y = scanY;
        scan.material.uniforms.uAlpha.value = 0.42;
      }
      if (still) return;
      ticks.rotation.y -= dt * 0.07;
      for (const o of orbiters) o.spin.rotation.y += dt * o.speed;
    },
    dispose() {
      texture.dispose();
      disposeTree(group);
    },
  };
}
