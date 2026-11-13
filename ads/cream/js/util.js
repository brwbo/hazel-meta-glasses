export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const ease = {
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  out: (k) => 1 - Math.pow(1 - k, 3),
  outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
  in: (k) => k * k * k,
  outBack: (k) => 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2),
};
export const pulse = (t, a, b, fade = 0.3) => Math.min(seg(t, a, a + fade), 1 - seg(t, b - fade, b));

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const styles = getComputedStyle(document.documentElement);
export const tok = (name) => styles.getPropertyValue(name).trim();

export function roundedPoly(target, pts, radii) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const r = Array.isArray(radii) ? radii[i] : radii;
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ra = Math.min(r, da / 2);
    const rb = Math.min(r, db / 2);
    const ax = p[0] + ((a[0] - p[0]) / da) * ra;
    const ay = p[1] + ((a[1] - p[1]) / da) * ra;
    const bx = p[0] + ((b[0] - p[0]) / db) * rb;
    const by = p[1] + ((b[1] - p[1]) / db) * rb;
    if (i === 0) target.moveTo(ax, ay);
    else target.lineTo(ax, ay);
    target.quadraticCurveTo(p[0], p[1], bx, by);
  }
  target.closePath();
  return target;
}
