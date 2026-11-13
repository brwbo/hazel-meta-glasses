import { POSITIONS, UVS, INDICES, VERTEX_COUNT } from './facescan-topology.js';
import { toCamera, align, unpose, poseFromRotation, poseFromMatrix, vertexNormals, laplacianSharpness } from './facescan-math.js';
import { buildAtlas } from './facescan-texture.js';

export const YAWS = [-50, -25, 0, 25, 50];
export const PITCHES = [-16, 0, 16];
const YAW_STEP = 25;
const PITCH_STEP = 16;
const MID_ROW = 1;
const CENTRE = 2;
const REQUIRED_YAWS = [1, 2, 3];
const TARGETS = YAWS.length + 2;
const RESAMPLE_EVERY = 3;
const MAX_RESIDUAL = 0.14;
const REPLACE_GAIN = 1.15;
const BIG_GAIN = 1.5;

export function cellOf(yaw, pitch) {
  if (Math.abs(yaw) > 62.5 || Math.abs(pitch) > 30) return -1;
  const yi = Math.min(YAWS.length - 1, Math.max(0, Math.round(yaw / YAW_STEP) + CENTRE));
  const pi = Math.min(PITCHES.length - 1, Math.max(0, Math.round(pitch / PITCH_STEP) + 1));
  return pi * YAWS.length + yi;
}

export function createSession() {
  const n = VERTEX_COUNT;
  const cells = new Array(YAWS.length * PITCHES.length).fill(null);
  const shapeSum = new Float64Array(n * 3);
  let shapeCount = 0;
  let sharpRef = 0;
  let last = { yaw: 0, pitch: 0, cell: -1, accepted: false, reason: 'no frame yet' };
  let dirty = false;
  let version = 0;
  let frameNo = 0;

  const rowHas = (row) => cells.slice(row * YAWS.length, (row + 1) * YAWS.length).some(Boolean);
  const filled = () => cells.filter(Boolean).length;

  function met() {
    let count = 0;
    for (let yi = 0; yi < YAWS.length; yi++) if (cells[MID_ROW * YAWS.length + yi]) count++;
    if (rowHas(0)) count++;
    if (rowHas(2)) count++;
    return count;
  }

  const coverage = () => met() / TARGETS;
  const complete = () => REQUIRED_YAWS.every((yi) => cells[MID_ROW * YAWS.length + yi]) && rowHas(0) && rowHas(2);

  function hint() {
    if (complete()) return 'done';
    if (!last.accepted && last.reason !== 'no frame yet') return 'hold still';
    let best = -1;
    for (const yi of REQUIRED_YAWS) {
      if (cells[MID_ROW * YAWS.length + yi]) continue;
      if (best < 0 || Math.abs(YAWS[yi] - last.yaw) < Math.abs(YAWS[best] - last.yaw)) best = yi;
    }
    if (best >= 0) {
      const delta = YAWS[best] - last.yaw;
      if (Math.abs(delta) <= YAW_STEP / 2) return last.pitch > PITCH_STEP / 2 ? 'look down' : last.pitch < -PITCH_STEP / 2 ? 'look up' : 'hold still';
      return delta > 0 ? 'turn left' : 'turn right';
    }
    return rowHas(2) ? 'look down' : 'look up';
  }

  function reject(reason, extra = {}) {
    last = { ...last, ...extra, accepted: false, reason };
    return { accepted: false, reason, newCell: false, ...extra };
  }

  function ingest({ image, getImage, width, height, landmarks, matrix }) {
    if (!landmarks || landmarks.length < n) return reject('no face found');
    if (image) ({ width, height } = image);
    let outside = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const px = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = landmarks[i];
      if (p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1) outside++;
      px[i * 2] = p.x * width;
      px[i * 2 + 1] = p.y * height;
      x0 = Math.min(x0, px[i * 2]);
      x1 = Math.max(x1, px[i * 2]);
      y0 = Math.min(y0, px[i * 2 + 1]);
      y1 = Math.max(y1, px[i * 2 + 1]);
    }
    if (outside > n * 0.12) return reject('face is partly out of frame');
    const cam = toCamera(landmarks, width, height, n);
    const fit = align(POSITIONS, cam, n);
    if (!fit) return reject('pose could not be solved');
    const own = poseFromRotation(fit.R);
    const given = poseFromMatrix(matrix);
    const agrees = given && Math.abs(given.yaw - own.yaw) < 20 && Math.abs(given.pitch - own.pitch) < 20;
    const { yaw, pitch } = agrees ? given : own;
    const pose = { yaw, pitch, poseSource: agrees ? 'matrix' : 'landmarks' };
    if (fit.residual > MAX_RESIDUAL) return reject('face is covered or tracking is poor', pose);
    const cell = cellOf(yaw, pitch);
    if (cell < 0) return reject('angle is too far to the side', { ...pose, cell });
    if (Math.abs(yaw) < 20 && Math.abs(pitch) < 15) {
      const shape = unpose(cam, fit, n);
      for (let i = 0; i < n * 3; i++) shapeSum[i] += shape[i];
      shapeCount++;
    }
    frameNo++;
    if (!image && cells[cell] && frameNo % RESAMPLE_EVERY) {
      last = { ...pose, cell, accepted: true, reason: '' };
      return { accepted: true, reason: '', newCell: false, replaced: false, sampled: false, cell, residual: fit.residual, ...pose };
    }
    image = image || getImage();
    if (!image) return reject('frame could not be read', { ...pose, cell });
    const q = laplacianSharpness(image, x0, y0, x1, y1);
    if (q.mean < 30 || q.mean > 235 || q.clipped > 0.35) return reject('lighting is too dark or too bright', { ...pose, cell });
    if (q.sharpness < sharpRef * 0.45) return reject('frame is blurred', { ...pose, cell });
    sharpRef = Math.max(sharpRef * 0.995, q.sharpness);
    const exposure = 1 - Math.min(1, Math.abs(q.mean - 128) / 128);
    const centre = 1 - Math.min(1, Math.hypot((yaw - YAWS[cell % YAWS.length]) / YAW_STEP, (pitch - PITCHES[(cell / YAWS.length) | 0]) / PITCH_STEP));
    const score = q.sharpness * (0.5 + 0.5 * exposure) * (0.8 + 0.2 * centre) * (1 - q.clipped);
    const held = cells[cell];
    const newCell = !held;
    let replaced = false;
    if (newCell || score > held.score * REPLACE_GAIN) {
      if (newCell || score > held.uploadedScore * BIG_GAIN) dirty = true;
      const depth = new Float32Array(n);
      for (let i = 0; i < n; i++) depth[i] = cam[i * 3 + 2];
      cells[cell] = { image, px, depth, R: fit.R, fit, cam, yaw, pitch, score, uploadedScore: held ? held.uploadedScore : score };
      replaced = true;
      version++;
    }
    last = { ...pose, cell, accepted: true, reason: '' };
    return { accepted: true, reason: '', newCell, replaced, cell, score, sharpness: q.sharpness, residual: fit.residual, ...pose };
  }

  function progress() {
    return {
      coverage: coverage(),
      complete: complete(),
      targets: TARGETS,
      met: met(),
      filled: filled(),
      total: cells.length,
      hint: hint(),
      yaw: last.yaw,
      pitch: last.pitch,
      detail: last.accepted ? '' : last.reason,
      cells: cells.map((c, i) => {
        const yi = i % YAWS.length, pi = (i / YAWS.length) | 0;
        return { yaw: YAWS[yi], pitch: PITCHES[pi], halfYaw: YAW_STEP / 2, halfPitch: PITCH_STEP / 2, filled: Boolean(c), required: pi === MID_ROW && REQUIRED_YAWS.includes(yi), current: i === last.cell };
      }),
    };
  }

  function shape() {
    const out = new Float32Array(n * 3);
    if (shapeCount) {
      for (let i = 0; i < n * 3; i++) out[i] = shapeSum[i] / shapeCount;
      return out;
    }
    const kept = cells.filter(Boolean);
    if (!kept.length) return Float32Array.from(POSITIONS);
    for (const frame of kept) {
      const s = unpose(frame.cam, frame.fit, n);
      for (let i = 0; i < n * 3; i++) out[i] += s[i] / kept.length;
    }
    return out;
  }

  async function build({ size = 1024, isCancelled, atlasBuilder = buildAtlas } = {}) {
    const frames = cells.filter(Boolean);
    if (!frames.length) return null;
    const builtVersion = version;
    const positions = shape();
    const normals = vertexNormals(positions, INDICES);
    const complete_ = complete(), coverage_ = coverage();
    const started = performance.now();
    const job = frames.map((f) => ({ image: { data: f.image.data, width: f.image.width, height: f.image.height }, px: f.px, depth: f.depth, R: f.R }));
    const atlas = await atlasBuilder({ frames: job, normals, uvs: UVS, indices: INDICES, size, isCancelled });
    if (!atlas) return null;
    return { positions, normals, uvs: UVS, indices: INDICES, atlas, frames: frames.length, coverage: coverage_, complete: complete_, builtVersion, shapeFrames: shapeCount, atlasMs: performance.now() - started };
  }

  function markUploaded(builtVersion) {
    if (builtVersion !== version) return;
    dirty = false;
    for (const c of cells) if (c) c.uploadedScore = Math.max(c.uploadedScore, c.score);
  }

  return {
    ingest,
    progress,
    coverage,
    complete,
    build,
    markUploaded,
    get dirty() {
      return dirty;
    },
    get filled() {
      return filled();
    },
    get lastPose() {
      return last;
    },
  };
}
