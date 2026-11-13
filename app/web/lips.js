const TICK_MS = 100;
const WINDOW_MS = 1500;
const KEEP_MS = 8000;
const MAX_FACES = 3;
export const MOVING_STD = 0.006;
const UPPER = 13;
const LOWER = 14;
const BROW = 10;
const CHIN = 152;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function aperture(landmarks) {
  if (!landmarks || landmarks.length < 153) return null;
  const face = dist(landmarks[BROW], landmarks[CHIN]);
  if (!face) return null;
  return dist(landmarks[UPPER], landmarks[LOWER]) / face;
}

export function activity(samples, now = performance.now()) {
  const recent = samples.filter((s) => now - s.t <= WINDOW_MS);
  if (recent.length < 6) return { moving: false, score: 0, measured: false };
  const mean = recent.reduce((a, s) => a + s.a, 0) / recent.length;
  const std = Math.sqrt(recent.reduce((a, s) => a + (s.a - mean) ** 2, 0) / recent.length);
  return { moving: std > MOVING_STD, score: Math.min(1, std / (MOVING_STD * 3)), measured: true };
}

export class Lips {
  constructor({ overlay, source, measure }) {
    this.overlay = overlay;
    this.source = source;
    this.measure = measure || null;
    this.series = new Map();
    this.state = "idle";
    this.busy = false;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = 256;
  }

  start() {
    if (this.state !== "idle") return;
    this.state = "loading";
    const ready = () => {
      this.state = "ready";
      this.timer = setInterval(() => this.tick(), TICK_MS);
    };
    if (this.measure) return ready();
    const path = "./facescan-landmarker.js";
    import(path)
      .then((m) => m.loadLandmarker())
      .then((lm) => {
        this.landmarker = lm;
        ready();
      })
      .catch(() => {
        this.state = "failed";
      });
  }

  stop() {
    clearInterval(this.timer);
    this.state = "idle";
  }

  crop(tr) {
    const src = this.source;
    const nw = src.naturalWidth || src.videoWidth || src.width;
    if (!nw) return null;
    const k = nw / this.overlay.w;
    const [x, y, w, hh] = tr.last;
    const side = Math.max(w, hh) * 1.5 * k;
    const g = this.canvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, (x + w / 2) * k - side / 2, (y + hh / 2) * k - side / 2, side, side, 0, 0, 256, 256);
    return this.canvas;
  }

  tick() {
    if (this.busy) return;
    this.busy = true;
    const now = performance.now();
    try {
      const faces = this.overlay.live().sort((a, b) => b.last[2] - a.last[2]).slice(0, MAX_FACES);
      for (const tr of faces) {
        let a = null;
        if (this.measure) a = this.measure(tr.id, now);
        else {
          const c = this.crop(tr);
          const found = c ? this.landmarker.detect(c) : null;
          a = found ? aperture(found.landmarks) : null;
        }
        if (a == null) continue;
        const list = this.series.get(tr.id) || [];
        list.push({ t: now, a });
        while (list.length && now - list[0].t > KEEP_MS) list.shift();
        this.series.set(tr.id, list);
      }
      for (const [id, list] of this.series) if (!list.length || now - list[list.length - 1].t > KEEP_MS) this.series.delete(id);
    } catch {
      this.state = "failed";
      clearInterval(this.timer);
    } finally {
      this.busy = false;
    }
  }

  latest(trackId, now = performance.now()) {
    const list = this.series.get(trackId);
    const last = list && list[list.length - 1];
    return last && now - last.t < 400 ? last.a : null;
  }

  lipsFor(trackId) {
    return activity(this.series.get(trackId) || []);
  }
}
