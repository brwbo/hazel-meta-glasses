import { createSession } from './facescan-session.js';
import { loadLandmarker } from './facescan-landmarker.js';
import { exportGlb, uploadGlb } from './facescan-export.js';
import { buildAtlasOffThread, warmAtlasWorker } from './facescan-atlas.js';

export { renderScanGuide } from './facescan-guide.js';

export const SCAN_DESCRIPTION = 'Textured face mask built from what the camera saw. It covers the face surface up to the ears; there is no hair or back of the head.';
const MAX_ACTIVE = 4;
const MAX_SESSIONS = 6;
const CROP_SIZE = 400;
const DETECT_SIZE = 256;
const CROP_PAD = 1.7;
const MIN_FACE_PX = 48;

let support = null;

export function scanSupport() {
  if (support) return support;
  let webgl = false, canvas = false, wasm = false;
  try {
    const probe = document.createElement('canvas');
    canvas = Boolean(probe.getContext('2d')) && typeof probe.toBlob === 'function';
    const gl = document.createElement('canvas');
    webgl = Boolean(gl.getContext('webgl2') || gl.getContext('webgl'));
  } catch {
    webgl = false;
  }
  try {
    wasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function' && WebAssembly.validate(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  } catch {
    wasm = false;
  }
  support = { webgl, wasm, canvas, ok: webgl && wasm && canvas };
  return support;
}

export function scanSupported() {
  return scanSupport().ok;
}

function unsupportedMessage(s) {
  const missing = [!s.webgl && 'WebGL', !s.wasm && 'WebAssembly', !s.canvas && 'canvas'].filter(Boolean).join(', ');
  return `Face scan is off: this browser has ${missing} turned off or missing.`;
}

export function logTiming(t) {
  const { stage, ms, ...rest } = t;
  const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 10) / 10 : v}`).join(' ');
  console.info(`[facescan] ${stage}: ${ms.toFixed(1)} ms${extra ? ' ' + extra : ''}`);
}

export function warmUp({ assets, onTiming = logTiming } = {}) {
  if (!scanSupport().ok) return Promise.resolve(false);
  warmAtlasWorker();
  const started = performance.now();
  const exporter = Promise.all([import('three'), import('three/addons/exporters/GLTFExporter.js')]).then(() => onTiming({ stage: 'exporter download (three)', ms: performance.now() - started }), () => {});
  return Promise.all([loadLandmarker(assets, { onTiming }), exporter]).then(() => {
    onTiming({ stage: 'warm-up total', ms: performance.now() - started });
    return true;
  });
}

function sourceSize(source) {
  return [source.videoWidth || source.naturalWidth || source.width || 0, source.videoHeight || source.naturalHeight || source.height || 0];
}

export function startAutoScan({ source, getTracks, onProgress, onModel, onError, getSelectedPersonId, getFrameSize, apiBase = '', assets, includeAutoEnrolled = false, intervalMs = 60, uploadIntervalMs = 4000, firstUploadDelayMs = 0, atlasSize = 1024, onTiming = logTiming } = {}) {
  const sessions = new Map();
  const consent = new Map();
  const work = document.createElement('canvas');
  const small = document.createElement('canvas');
  const stats = { frames: 0, detectMs: 0, totalMs: 0, sampled: 0, since: performance.now() };
  let ctx = null;
  let smallCtx = null;
  let landmarker = null;
  let loading = null;
  let stopped = false;
  let timer = 0;
  let building = false;

  const report = (code, message, extra = {}) => {
    if (onError) onError({ code, message, fatal: false, ...extra });
  };
  const fatal = (code, message) => {
    stop();
    if (onError) onError({ code, message, fatal: true });
  };

  async function checkConsent(personId) {
    consent.set(personId, { state: 'pending' });
    try {
      const res = await fetch(`${apiBase}/api/people/${encodeURIComponent(personId)}`);
      if (res.status === 404) return consent.set(personId, { state: 'no', retryAt: performance.now() + 60000 });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const person = await res.json();
      const enrolled = typeof person.consentNote === 'string' && person.consentNote.trim().length > 0 && (includeAutoEnrolled || !person.autoEnrolled);
      consent.set(personId, enrolled ? { state: 'yes' } : { state: 'no', retryAt: performance.now() + 60000 });
    } catch {
      consent.set(personId, { state: 'no', unreachable: true, retryAt: performance.now() + 5000 });
    }
    return consent.get(personId);
  }

  function isEnrolled(personId) {
    const known = consent.get(personId);
    if (!known || (known.state === 'no' && performance.now() >= known.retryAt)) checkConsent(personId);
    return Boolean(known) && known.state === 'yes';
  }

  function forget(personId) {
    sessions.delete(personId);
    consent.delete(personId);
  }

  function entryFor(personId, now) {
    let entry = sessions.get(personId);
    if (!entry) {
      entry = { personId, session: createSession(), lastScan: 0, lastSeen: now, lastUpload: now - uploadIntervalMs + firstUploadDelayMs, uploads: 0 };
      sessions.set(personId, entry);
      if (sessions.size > MAX_SESSIONS) {
        let oldest = null;
        for (const e of sessions.values()) if (e !== entry && (!oldest || e.lastSeen < oldest.lastSeen)) oldest = e;
        if (oldest) sessions.delete(oldest.personId);
      }
    }
    entry.lastSeen = now;
    return entry;
  }

  function grab(box) {
    const [sw, sh] = sourceSize(source);
    if (!sw || !sh) return null;
    const frame = (getFrameSize && getFrameSize()) || [sw, sh];
    const kx = sw / (frame[0] || sw), ky = sh / (frame[1] || sh);
    const bw = box[2] * kx, bh = box[3] * ky;
    if (Math.max(bw, bh) < MIN_FACE_PX) return null;
    const side = Math.max(bw, bh) * CROP_PAD;
    const mx = box[0] * kx + bw / 2, my = box[1] * ky + bh / 2;
    const x0 = Math.max(0, Math.round(mx - side / 2)), y0 = Math.max(0, Math.round(my - side / 2));
    const x1 = Math.min(sw, Math.round(mx + side / 2)), y1 = Math.min(sh, Math.round(my + side / 2));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < MIN_FACE_PX || ch < MIN_FACE_PX) return null;
    const k = Math.min(1, CROP_SIZE / Math.max(cw, ch));
    const d = Math.min(1, DETECT_SIZE / Math.max(cw, ch));
    const width = Math.max(2, Math.round(cw * k)), height = Math.max(2, Math.round(ch * k));
    small.width = Math.max(2, Math.round(cw * d));
    small.height = Math.max(2, Math.round(ch * d));
    smallCtx = smallCtx || small.getContext('2d');
    smallCtx.drawImage(source, x0, y0, cw, ch, 0, 0, small.width, small.height);
    const getImage = () => {
      work.width = width;
      work.height = height;
      ctx = ctx || work.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, x0, y0, cw, ch, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    };
    return { width, height, getImage };
  }

  function frameStats(detectMs, totalMs, sampled) {
    stats.frames++;
    stats.detectMs += detectMs;
    stats.totalMs += totalMs;
    if (sampled) stats.sampled++;
    const span = performance.now() - stats.since;
    if (span < 3000) return;
    onTiming({ stage: 'per-frame average', ms: stats.totalMs / stats.frames, tracker: stats.detectMs / stats.frames, fps: (stats.frames * 1000) / span, frames: stats.frames, pixelReads: stats.sampled });
    Object.assign(stats, { frames: 0, detectMs: 0, totalMs: 0, sampled: 0, since: performance.now() });
  }

  function emit(entry, selectedId, extra = {}) {
    if (!onProgress) return;
    onProgress({ personId: entry.personId, selected: entry.personId === selectedId, phase: 'scanning', uploads: entry.uploads, ...entry.session.progress(), ...extra });
  }

  function scanOne(entry, track, selectedId) {
    entry.lastScan = performance.now();
    const t0 = performance.now();
    let crop, result;
    try {
      crop = grab(track.box);
      if (!crop) return;
      let found = null;
      try {
        found = landmarker.detect(small);
      } catch {
        return;
      }
      const t1 = performance.now();
      result = entry.session.ingest({ ...crop, landmarks: found && found.landmarks, matrix: found && found.matrix });
      frameStats(t1 - t0, performance.now() - t0, result.sampled !== false && Boolean(found));
    } catch (cause) {
      if (!cause || cause.name !== 'SecurityError') throw cause;
      fatal('source-blocked', 'Face scan is off: the camera image cannot be read by the page.');
      return;
    }
    if (result.accepted && result.replaced && !entry.firstFrameAt) entry.firstFrameAt = performance.now();
    emit(entry, selectedId, { trackId: track.trackId });
  }

  async function publish(entry, selectedId) {
    building = true;
    const { personId, session } = entry;
    entry.lastUpload = performance.now();
    try {
      const still = await checkConsent(personId);
      if (still.state !== 'yes') {
        if (!still.unreachable) sessions.delete(personId);
        return;
      }
      emit(entry, selectedId, { phase: 'building' });
      const model = await session.build({ size: atlasSize, atlasBuilder: buildAtlasOffThread, isCancelled: () => stopped || !sessions.has(personId) });
      if (!model) return;
      onTiming({ stage: 'atlas build', ms: model.atlasMs, frames: model.frames, worker: Boolean(model.atlas.offThread), personId });
      let t = performance.now();
      const blob = await exportGlb(model);
      const exportMs = performance.now() - t;
      onTiming({ stage: 'glb export', ms: exportMs, bytes: blob.size, personId });
      if (stopped || !sessions.has(personId)) return;
      emit(entry, selectedId, { phase: 'uploading' });
      t = performance.now();
      const url = await uploadGlb(blob, personId, apiBase);
      const uploadMs = performance.now() - t;
      const sinceFirstFrameMs = performance.now() - (entry.firstFrameAt || performance.now());
      onTiming({ stage: 'upload', ms: uploadMs, personId });
      if (!entry.uploads) onTiming({ stage: 'first model after first good frame', ms: sinceFirstFrameMs, personId });
      session.markUploaded(model.builtVersion);
      entry.lastUpload = performance.now();
      entry.uploads++;
      const partial = !model.complete;
      if (onModel) {
        onModel({
          personId,
          modelUrl: `${url}?v=${Date.now()}`,
          coverage: model.coverage,
          partial,
          complete: model.complete,
          timings: { atlasMs: model.atlasMs, exportMs, uploadMs, sinceFirstFrameMs, worker: Boolean(model.atlas.offThread) },
          warning: partial ? `Partial scan: ${Math.round(model.coverage * 100)}% of the target angles captured so far. Unseen areas are filled with nearby colour.` : '',
          description: SCAN_DESCRIPTION,
          frames: model.frames,
          bytes: blob.size,
        });
      }
      emit(entry, selectedId, { phase: 'scanning' });
    } catch (cause) {
      if (cause && cause.status === 404) {
        forget(personId);
        return;
      }
      report('upload-failed', 'The face scan could not be saved. It will be tried again shortly.', { personId, cause });
    } finally {
      building = false;
    }
  }

  async function tick() {
    timer = 0;
    if (stopped) return;
    const started = performance.now();
    let delay = intervalMs;
    try {
      if (document.hidden) {
        delay = 1000;
        return;
      }
      const selectedId = getSelectedPersonId ? getSelectedPersonId() : null;
      const seen = new Map();
      for (const track of getTracks() || []) {
        if (!track || track.personId == null || !Array.isArray(track.box) || seen.has(track.personId)) continue;
        if (isEnrolled(track.personId)) seen.set(track.personId, track);
      }
      if (!seen.size) {
        delay = 400;
        return;
      }
      if (!landmarker) {
        loading = loading || loadLandmarker(assets, { onTiming });
        landmarker = await loading;
        if (stopped) return;
      }
      const active = [...seen.values()]
        .map((track) => ({ track, entry: entryFor(track.personId, started), chosen: track.personId === selectedId || track.selected === true }))
        .sort((a, b) => b.chosen - a.chosen || a.entry.session.coverage() - b.entry.session.coverage())
        .slice(0, MAX_ACTIVE);
      let pick = null, urgency = -1;
      for (const item of active) {
        const settled = item.entry.session.complete() && !item.entry.session.dirty;
        const period = (settled ? 1500 : intervalMs) * (item.chosen ? 0.5 : 1);
        const u = (started - item.entry.lastScan) / period;
        if (u > urgency) {
          urgency = u;
          pick = item;
        }
      }
      if (pick && urgency >= 1) scanOne(pick.entry, pick.track, selectedId);
      if (stopped || building) return;
      const due = active.find((item) => item.entry.session.dirty && item.entry.session.filled > 0 && performance.now() - item.entry.lastUpload >= uploadIntervalMs);
      if (due) publish(due.entry, selectedId);
    } catch (cause) {
      if (cause && cause.code) fatal(cause.code, cause.message);
      else report('scan-error', 'Face scan hit an unexpected error and will keep trying.', { cause });
    } finally {
      if (!stopped) timer = setTimeout(tick, Math.max(30, delay - (performance.now() - started)));
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    sessions.clear();
    landmarker = null;
  }

  const s = scanSupport();
  if (!s.ok) {
    stopped = true;
    queueMicrotask(() => onError && onError({ code: 'unsupported', message: unsupportedMessage(s), fatal: true }));
  } else if (!source || typeof getTracks !== 'function') {
    stopped = true;
    queueMicrotask(() => onError && onError({ code: 'bad-arguments', message: 'Face scan needs a video or image source and a getTracks function.', fatal: true }));
  } else {
    timer = setTimeout(tick, 0);
  }

  return {
    stop,
    forget,
    progress: (personId) => (sessions.has(personId) ? sessions.get(personId).session.progress() : null),
    get running() {
      return !stopped;
    },
  };
}
