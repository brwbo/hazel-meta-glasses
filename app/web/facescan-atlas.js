import { buildAtlas } from './facescan-texture.js';

let worker = null;
let broken = false;
let nextId = 1;
const waiting = new Map();

function ensureWorker() {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL('./facescan-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, atlas, error } = event.data;
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(atlas);
    };
    worker.onerror = () => {
      broken = true;
      worker = null;
      for (const entry of waiting.values()) entry.reject(new Error('atlas worker failed'));
      waiting.clear();
    };
  } catch {
    broken = true;
    worker = null;
  }
  return worker;
}

export function warmAtlasWorker() {
  ensureWorker();
}

export async function buildAtlasOffThread(job) {
  const { isCancelled, ...data } = job;
  const w = ensureWorker();
  if (w) {
    try {
      const atlas = await new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, job: data });
      });
      if (isCancelled && isCancelled()) return null;
      atlas.offThread = true;
      return atlas;
    } catch {
      broken = true;
    }
  }
  return buildAtlas(job);
}
