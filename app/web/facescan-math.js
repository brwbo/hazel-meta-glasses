const DEG = 180 / Math.PI;

export function toCamera(landmarks, w, h, n, out = new Float32Array(n * 3)) {
  for (let i = 0; i < n; i++) {
    const p = landmarks[i];
    out[i * 3] = p.x * w;
    out[i * 3 + 1] = -p.y * h;
    out[i * 3 + 2] = -p.z * w;
  }
  return out;
}

function inverse3(m, out) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return 0;
  const k = 1 / det;
  out[0] = A * k;
  out[1] = (c * h - b * i) * k;
  out[2] = (b * f - c * e) * k;
  out[3] = B * k;
  out[4] = (a * i - c * g) * k;
  out[5] = (c * d - a * f) * k;
  out[6] = C * k;
  out[7] = (b * g - a * h) * k;
  out[8] = (a * e - b * d) * k;
  return det;
}

function polarRotation(H) {
  let norm = 0;
  for (let i = 0; i < 9; i++) norm += H[i] * H[i];
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null;
  const R = new Float64Array(9);
  for (let i = 0; i < 9; i++) R[i] = H[i] / norm;
  const inv = new Float64Array(9);
  for (let k = 0; k < 30; k++) {
    const det = inverse3(R, inv);
    if (!(det > 0)) return null;
    let delta = 0;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const v = 0.5 * (R[r * 3 + c] + inv[c * 3 + r]);
        delta += Math.abs(v - R[r * 3 + c]);
        R[r * 3 + c] = v;
      }
    }
    if (delta < 1e-10) break;
  }
  return R;
}

export function align(model, pts, n) {
  let mx = 0, my = 0, mz = 0, px = 0, py = 0, pz = 0;
  for (let i = 0; i < n; i++) {
    mx += model[i * 3];
    my += model[i * 3 + 1];
    mz += model[i * 3 + 2];
    px += pts[i * 3];
    py += pts[i * 3 + 1];
    pz += pts[i * 3 + 2];
  }
  mx /= n; my /= n; mz /= n; px /= n; py /= n; pz /= n;
  const H = new Float64Array(9);
  let mm = 0;
  for (let i = 0; i < n; i++) {
    const a = model[i * 3] - mx, b = model[i * 3 + 1] - my, c = model[i * 3 + 2] - mz;
    const u = pts[i * 3] - px, v = pts[i * 3 + 1] - py, w = pts[i * 3 + 2] - pz;
    H[0] += u * a; H[1] += u * b; H[2] += u * c;
    H[3] += v * a; H[4] += v * b; H[5] += v * c;
    H[6] += w * a; H[7] += w * b; H[8] += w * c;
    mm += a * a + b * b + c * c;
  }
  const R = polarRotation(H);
  if (!R || !(mm > 0)) return null;
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += R[i] * H[i];
  const s = tr / mm;
  if (!(s > 0)) return null;
  const t = [
    px - s * (R[0] * mx + R[1] * my + R[2] * mz),
    py - s * (R[3] * mx + R[4] * my + R[5] * mz),
    pz - s * (R[6] * mx + R[7] * my + R[8] * mz),
  ];
  let err = 0;
  for (let i = 0; i < n; i++) {
    const a = model[i * 3], b = model[i * 3 + 1], c = model[i * 3 + 2];
    const dx = s * (R[0] * a + R[1] * b + R[2] * c) + t[0] - pts[i * 3];
    const dy = s * (R[3] * a + R[4] * b + R[5] * c) + t[1] - pts[i * 3 + 1];
    const dz = s * (R[6] * a + R[7] * b + R[8] * c) + t[2] - pts[i * 3 + 2];
    err += dx * dx + dy * dy + dz * dz;
  }
  const spread = Math.sqrt(mm / n) * s;
  return { R, s, t, residual: Math.sqrt(err / n) / spread };
}

export function unpose(pts, fit, n, out = new Float32Array(n * 3)) {
  const { R, s, t } = fit;
  for (let i = 0; i < n; i++) {
    const x = (pts[i * 3] - t[0]) / s, y = (pts[i * 3 + 1] - t[1]) / s, z = (pts[i * 3 + 2] - t[2]) / s;
    out[i * 3] = R[0] * x + R[3] * y + R[6] * z;
    out[i * 3 + 1] = R[1] * x + R[4] * y + R[7] * z;
    out[i * 3 + 2] = R[2] * x + R[5] * y + R[8] * z;
  }
  return out;
}

export function anglesFromForward(fx, fy, fz) {
  const len = Math.hypot(fx, fy, fz) || 1;
  return { yaw: Math.atan2(fx, fz) * DEG, pitch: Math.asin(Math.max(-1, Math.min(1, fy / len))) * DEG };
}

export function poseFromRotation(R) {
  return anglesFromForward(R[2], R[5], R[8]);
}

export function poseFromMatrix(data) {
  if (!data || data.length < 16) return null;
  const pose = anglesFromForward(data[8], data[9], data[10]);
  return Number.isFinite(pose.yaw) && Number.isFinite(pose.pitch) ? pose : null;
}

export function rotationFromAngles(yawDeg, pitchDeg) {
  const y = yawDeg / DEG, p = pitchDeg / DEG;
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
  return Float64Array.from([cy, -sy * sp, sy * cp, 0, cp, sp, -sy, -cy * sp, cy * cp]);
}

export function vertexNormals(positions, indices, out = new Float32Array(positions.length)) {
  out.fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      out[k] += nx;
      out[k + 1] += ny;
      out[k + 2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const len = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= len;
    out[i + 1] /= len;
    out[i + 2] /= len;
  }
  return out;
}

export function laplacianSharpness(image, x0, y0, x1, y1) {
  const { data, width, height } = image;
  const ax = Math.max(1, Math.floor(x0)), ay = Math.max(1, Math.floor(y0));
  const bx = Math.min(width - 2, Math.ceil(x1)), by = Math.min(height - 2, Math.ceil(y1));
  if (bx - ax < 8 || by - ay < 8) return { sharpness: 0, mean: 0, clipped: 1 };
  const lum = (i) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  let sum = 0, sum2 = 0, total = 0, count = 0, clipped = 0;
  for (let y = ay; y <= by; y += 2) {
    for (let x = ax; x <= bx; x += 2) {
      const i = (y * width + x) * 4;
      const c = lum(i);
      const lap = lum(i - 4) + lum(i + 4) + lum(i - width * 4) + lum(i + width * 4) - 4 * c;
      sum += lap;
      sum2 += lap * lap;
      total += c;
      if (c < 6 || c > 249) clipped++;
      count++;
    }
  }
  const m = sum / count;
  return { sharpness: sum2 / count - m * m, mean: total / count, clipped: clipped / count };
}
