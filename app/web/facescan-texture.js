const DEPTH_GRID = 96;
const WEIGHT_POWER = 8;
const MIN_WEIGHT = 0.08;

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

function edge(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

export function vertexVisibility(frame, indices, n) {
  const { px, depth } = frame;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, px[i * 2]);
    x1 = Math.max(x1, px[i * 2]);
    y0 = Math.min(y0, px[i * 2 + 1]);
    y1 = Math.max(y1, px[i * 2 + 1]);
  }
  const span = Math.max(x1 - x0, y1 - y0, 1e-6);
  const k = (DEPTH_GRID - 1) / span;
  const buf = new Float32Array(DEPTH_GRID * DEPTH_GRID).fill(-Infinity);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const ax = (px[a * 2] - x0) * k, ay = (px[a * 2 + 1] - y0) * k;
    const bx = (px[b * 2] - x0) * k, by = (px[b * 2 + 1] - y0) * k;
    const cx = (px[c * 2] - x0) * k, cy = (px[c * 2 + 1] - y0) * k;
    const area = edge(ax, ay, bx, by, cx, cy);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(DEPTH_GRID - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(DEPTH_GRID - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = edge(bx, by, cx, cy, x, y) / area, w1 = edge(cx, cy, ax, ay, x, y) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * depth[a] + w1 * depth[b] + w2 * depth[c];
        const j = y * DEPTH_GRID + x;
        if (d > buf[j]) buf[j] = d;
      }
    }
  }
  const tolerance = span * 0.05;
  const visible = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const gx = Math.round((px[i * 2] - x0) * k), gy = Math.round((px[i * 2 + 1] - y0) * k);
    let nearest = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = gx + dx, yy = gy + dy;
        if (xx < 0 || yy < 0 || xx >= DEPTH_GRID || yy >= DEPTH_GRID) continue;
        nearest = Math.max(nearest, buf[yy * DEPTH_GRID + xx]);
      }
    }
    visible[i] = depth[i] >= nearest - tolerance ? 1 : 0;
  }
  return visible;
}

export function frameWeights(frame, normals, indices, n) {
  const R = frame.R;
  const visible = vertexVisibility(frame, indices, n);
  const { width, height } = frame.image;
  const weights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = frame.px[i * 2], y = frame.px[i * 2 + 1];
    if (!visible[i] || x < 1 || y < 1 || x > width - 2 || y > height - 2) continue;
    const facing = R[6] * normals[i * 3] + R[7] * normals[i * 3 + 1] + R[8] * normals[i * 3 + 2];
    weights[i] = Math.max(0, facing);
  }
  return weights;
}

function sample(image, x, y, out) {
  const { data, width, height } = image;
  const cx = Math.min(Math.max(x, 0), width - 1.001), cy = Math.min(Math.max(y, 0), height - 1.001);
  const ix = cx | 0, iy = cy | 0, fx = cx - ix, fy = cy - iy;
  const i = (iy * width + ix) * 4, j = i + width * 4;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
  out[0] = data[i] * a + data[i + 4] * b + data[j] * c + data[j + 4] * d;
  out[1] = data[i + 1] * a + data[i + 5] * b + data[j + 1] * c + data[j + 5] * d;
  out[2] = data[i + 2] * a + data[i + 6] * b + data[j + 2] * c + data[j + 6] * d;
}

export function frameGains(frames, weights, n) {
  const order = frames.map((_, i) => i).sort((a, b) => sum(weights[b]) - sum(weights[a]));
  const colour = new Float32Array(n * 3);
  const mass = new Float32Array(n);
  const gains = frames.map(() => [1, 1, 1]);
  const rgb = [0, 0, 0];
  for (const f of order) {
    const frame = frames[f], w = weights[f];
    const mine = [0, 0, 0], theirs = [0, 0, 0];
    let shared = 0;
    for (let i = 0; i < n; i++) {
      if (w[i] < 0.3 || mass[i] <= 0) continue;
      sample(frame.image, frame.px[i * 2], frame.px[i * 2 + 1], rgb);
      for (let c = 0; c < 3; c++) {
        mine[c] += rgb[c];
        theirs[c] += colour[i * 3 + c] / mass[i];
      }
      shared++;
    }
    if (shared >= 24) {
      for (let c = 0; c < 3; c++) gains[f][c] = Math.min(1.6, Math.max(0.6, theirs[c] / Math.max(mine[c], 1)));
    }
    for (let i = 0; i < n; i++) {
      if (w[i] < 0.3) continue;
      sample(frame.image, frame.px[i * 2], frame.px[i * 2 + 1], rgb);
      for (let c = 0; c < 3; c++) colour[i * 3 + c] += rgb[c] * gains[f][c] * w[i];
      mass[i] += w[i];
    }
  }
  return gains;
}

function sum(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export function fillUnseen(rgba, seen, size) {
  const total = size * size;
  const queue = new Int32Array(total);
  const done = new Uint8Array(seen);
  let head = 0, tail = 0;
  for (let i = 0; i < total; i++) if (seen[i]) queue[tail++] = i;
  if (!tail) {
    for (let i = 0; i < total; i++) {
      rgba[i * 4] = 96;
      rgba[i * 4 + 1] = 104;
      rgba[i * 4 + 2] = 120;
      rgba[i * 4 + 3] = 255;
    }
    return 0;
  }
  const spread = (from, to) => {
    if (done[to]) return;
    done[to] = 1;
    rgba[to * 4] = rgba[from * 4];
    rgba[to * 4 + 1] = rgba[from * 4 + 1];
    rgba[to * 4 + 2] = rgba[from * 4 + 2];
    rgba[to * 4 + 3] = 255;
    queue[tail++] = to;
  };
  while (head < tail) {
    const i = queue[head++];
    const x = i % size;
    if (x > 0) spread(i, i - 1);
    if (x < size - 1) spread(i, i + 1);
    if (i >= size) spread(i, i - size);
    if (i < total - size) spread(i, i + size);
  }
  const copy = new Uint8ClampedArray(rgba.length);
  for (let pass = 0; pass < 3; pass++) {
    copy.set(rgba);
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        if (seen[i]) continue;
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) acc += copy[(i + dy * size + dx) * 4 + c];
          rgba[i * 4 + c] = acc / 9;
        }
      }
    }
  }
  return tail;
}

export async function buildAtlas({ frames, normals, uvs, indices, size = 1024, isCancelled, yieldMs = 8 }) {
  isCancelled = isCancelled || (() => false);
  const n = uvs.length / 2;
  const weights = frames.map((frame) => frameWeights(frame, normals, indices, n));
  const gains = frameGains(frames, weights, n);
  const rgba = new Uint8ClampedArray(size * size * 4);
  const seen = new Uint8Array(size * size);
  const covered = new Uint8Array(size * size);
  const rgb = [0, 0, 0];
  const active = [];
  let slice = performance.now();
  for (let t = 0; t < indices.length; t += 3) {
    if (performance.now() - slice > yieldMs) {
      await pause();
      if (isCancelled()) return null;
      slice = performance.now();
    }
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const ax = uvs[a * 2] * size, ay = uvs[a * 2 + 1] * size;
    const bx = uvs[b * 2] * size, by = uvs[b * 2 + 1] * size;
    const cx = uvs[c * 2] * size, cy = uvs[c * 2 + 1] * size;
    const area = edge(ax, ay, bx, by, cx, cy);
    if (Math.abs(area) < 1e-9) continue;
    active.length = 0;
    for (let f = 0; f < frames.length; f++) {
      const w = weights[f];
      if (w[a] > MIN_WEIGHT || w[b] > MIN_WEIGHT || w[c] > MIN_WEIGHT) active.push(f);
    }
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = edge(bx, by, cx, cy, x + 0.5, y + 0.5) / area, w1 = edge(cx, cy, ax, ay, x + 0.5, y + 0.5) / area, w2 = 1 - w0 - w1;
        if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        const j = y * size + x;
        covered[j] = 1;
        let r = 0, g = 0, bl = 0, mass = 0;
        for (let k = 0; k < active.length; k++) {
          const f = active[k], frame = frames[f], w = weights[f], px = frame.px;
          let wt = w0 * w[a] + w1 * w[b] + w2 * w[c];
          if (wt <= MIN_WEIGHT) continue;
          wt = wt ** WEIGHT_POWER;
          sample(frame.image, w0 * px[a * 2] + w1 * px[b * 2] + w2 * px[c * 2], w0 * px[a * 2 + 1] + w1 * px[b * 2 + 1] + w2 * px[c * 2 + 1], rgb);
          r += rgb[0] * gains[f][0] * wt;
          g += rgb[1] * gains[f][1] * wt;
          bl += rgb[2] * gains[f][2] * wt;
          mass += wt;
        }
        if (mass <= 0) continue;
        rgba[j * 4] = r / mass;
        rgba[j * 4 + 1] = g / mass;
        rgba[j * 4 + 2] = bl / mass;
        rgba[j * 4 + 3] = 255;
        seen[j] = 1;
      }
    }
  }
  let coveredCount = 0, seenCount = 0;
  for (let i = 0; i < seen.length; i++) {
    coveredCount += covered[i];
    seenCount += seen[i];
  }
  if (Number.isFinite(yieldMs)) await pause();
  if (isCancelled()) return null;
  fillUnseen(rgba, seen, size);
  return { rgba, size, seen, covered, seenFraction: coveredCount ? seenCount / coveredCount : 0 };
}
