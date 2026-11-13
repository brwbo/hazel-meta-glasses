const PACKAGE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const CACHE_NAME = 'facescan-assets-v1';

export const DEFAULT_ASSETS = {
  lib: `${PACKAGE}/vision_bundle.mjs`,
  wasm: `${PACKAGE}/wasm`,
  model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

const VENDOR = new URL('./vendor/mediapipe/', import.meta.url).href;
const shared = new Map();
let vendorProbe = null;

function coded(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

const exists = (url) => fetch(url, { method: 'HEAD' }).then((r) => r.ok, () => false);

function probeVendor() {
  vendorProbe = vendorProbe || Promise.all([exists(`${VENDOR}vision_bundle.mjs`), exists(`${VENDOR}wasm/vision_wasm_internal.wasm`), exists(`${VENDOR}face_landmarker.task`)]).then(([lib, wasm, model]) => ({
    ...(lib && wasm ? { lib: `${VENDOR}vision_bundle.mjs`, wasm: `${VENDOR}wasm` } : {}),
    ...(model ? { model: `${VENDOR}face_landmarker.task` } : {}),
  }));
  return vendorProbe;
}

async function fetchModel(url, timeoutMs) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  } catch {
    cache = null;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: abort.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const copy = cache ? res.clone() : null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100000) throw new Error('file is too small to be the model');
    if (copy) cache.put(url, copy).catch(() => {});
    return { bytes, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

async function create(assets, timeoutMs, onTiming) {
  const vendored = await probeVendor();
  const urls = { ...DEFAULT_ASSETS, ...vendored, ...assets };
  const local = urls.lib.startsWith(VENDOR);
  const mark = (stage, since, extra = {}) => onTiming && onTiming({ stage, ms: performance.now() - since, ...extra });
  let t = performance.now();
  const modelJob = fetchModel(urls.model, timeoutMs).then((m) => {
    mark('model download', t, { cached: m.cached, bytes: m.bytes.length, local: urls.model.startsWith(VENDOR) });
    return m.bytes;
  });
  modelJob.catch(() => {});
  let vision;
  try {
    vision = await import(urls.lib);
    mark('library download', t, { local });
  } catch (cause) {
    throw coded('library-unavailable', 'Face scan is off: the face tracking library could not be loaded. Check the network connection and reload.', cause);
  }
  let model;
  try {
    model = await modelJob;
  } catch (cause) {
    throw coded('model-unavailable', 'Face scan is off: the face tracking model (about 4 MB) could not be downloaded. Check the network connection and reload.', cause);
  }
  t = performance.now();
  let fileset;
  try {
    fileset = await vision.FilesetResolver.forVisionTasks(urls.wasm);
  } catch (cause) {
    throw coded('library-unavailable', 'Face scan is off: the face tracking runtime could not be loaded. Check the network connection and reload.', cause);
  }
  let landmarker = null;
  let delegate = '';
  let lastCause = null;
  for (const choice of ['GPU', 'CPU']) {
    try {
      landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate: choice },
        runningMode: 'IMAGE',
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: false,
      });
      delegate = choice;
      break;
    } catch (cause) {
      lastCause = cause;
    }
  }
  if (!landmarker) throw coded('tracker-failed', 'Face scan is off: face tracking could not start in this browser.', lastCause);
  mark('tracker load (wasm + graph)', t, { delegate, local });
  t = performance.now();
  try {
    const blank = document.createElement('canvas');
    blank.width = blank.height = 128;
    blank.getContext('2d').fillRect(0, 0, 128, 128);
    landmarker.detect(blank);
    mark('tracker warm-up frame', t);
  } catch {
    t = 0;
  }
  return {
    delegate,
    detect(canvas) {
      const result = landmarker.detect(canvas);
      const landmarks = result.faceLandmarks && result.faceLandmarks[0];
      if (!landmarks) return null;
      const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
      return { landmarks, matrix: m ? m.data : null };
    },
  };
}

export function loadLandmarker(assets = {}, { timeoutMs = 45000, onTiming } = {}) {
  const key = JSON.stringify(assets || {});
  if (!shared.has(key)) {
    const job = create(assets || {}, timeoutMs, onTiming);
    shared.set(key, job);
    job.catch(() => shared.delete(key));
  }
  return shared.get(key);
}
