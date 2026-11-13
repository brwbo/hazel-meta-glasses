import * as THREE from "three";

const css = getComputedStyle(document.documentElement);
export const tok = (name) => css.getPropertyValue(name).trim();
export const tone = (name) => new THREE.Color(tok(name));
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const damp = (dt, rate) => 1 - Math.exp(-dt * rate);
export const ease = {
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  out: (k) => 1 - Math.pow(1 - k, 3),
  outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
  outBack: (k) => 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2),
};

export function roundedRect(target, w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  const k = Math.min(r, w / 2, h / 2);
  target.moveTo(x + k, y);
  target.lineTo(x + w - k, y);
  target.quadraticCurveTo(x + w, y, x + w, y + k);
  target.lineTo(x + w, y + h - k);
  target.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
  target.lineTo(x + k, y + h);
  target.quadraticCurveTo(x, y + h, x, y + h - k);
  target.lineTo(x, y + k);
  target.quadraticCurveTo(x, y, x + k, y);
  return target;
}

export function softShadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 24, 128, 128, 128);
  grad.addColorStop(0, "rgba(0,0,0,0.62)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.2)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
