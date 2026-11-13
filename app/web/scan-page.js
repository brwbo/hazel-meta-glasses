import { createSession } from './facescan-session.js';
import { startAutoScan, warmUp, logTiming, scanSupported, scanSupport, renderScanGuide, SCAN_DESCRIPTION } from './facescan.js';

const $ = (id) => document.getElementById(id);
const feed = $('feed');
const boxes = $('boxes');
const stageNote = $('stage-note');
const statusEl = $('status');
const hintEl = $('hint');
const startBtn = $('start');
const stopBtn = $('stop');
const downloadBtn = $('download');
const mirrored = $('mirrored');

const HINTS = {
  'turn left': 'Turn head left',
  'turn right': 'Turn head right',
  'look up': 'Look up a little',
  'look down': 'Look down a little',
  'hold still': 'Hold still',
  done: 'Enough angles captured',
};

const IDLE = { ...createSession().progress(), yaw: NaN };
const state = { det: null, detAt: 0, subject: null, scan: null, progress: null, progressAt: 0, startedAt: 0, endedAt: 0, warm: 'loading', warmMs: 0, firstModelMs: 0, model: null, viewer: null, viewerLoading: null, error: null, socket: null, retry: 0 };

function setStatus(text, tone = '') {
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function connect() {
  let socket;
  try {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  } catch {
    stageNote.textContent = 'Cannot open the detection socket';
    return;
  }
  state.socket = socket;
  socket.onopen = () => {
    state.retry = 0;
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type !== 'detections') return;
    state.det = msg;
    state.detAt = performance.now();
  };
  socket.onclose = () => {
    state.retry = Math.min(state.retry + 1, 6);
    setTimeout(connect, 500 * state.retry);
  };
}

function pickSubject() {
  const fresh = state.det && performance.now() - state.detAt < 1500;
  const faces = fresh ? state.det.faces || [] : [];
  let best = null;
  for (const face of faces) {
    if (!Array.isArray(face.box)) continue;
    if (!best || face.box[2] * face.box[3] > best.box[2] * best.box[3]) best = face;
  }
  state.subject = best;
  return faces;
}

function drawBoxes(faces) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = boxes.clientWidth, h = boxes.clientHeight;
  if (boxes.width !== Math.round(w * dpr) || boxes.height !== Math.round(h * dpr)) {
    boxes.width = Math.round(w * dpr);
    boxes.height = Math.round(h * dpr);
  }
  const ctx = boxes.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!state.det || !state.det.w || !state.det.h || !faces.length) return;
  const k = Math.min(w / state.det.w, h / state.det.h);
  const ox = (w - state.det.w * k) / 2, oy = (h - state.det.h * k) / 2;
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'bottom';
  for (const face of faces) {
    const [x, y, bw, bh] = face.box;
    const subject = face === state.subject;
    ctx.strokeStyle = subject ? '#3b82f6' : 'rgba(150, 168, 198, 0.6)';
    ctx.lineWidth = subject ? 2 : 1;
    ctx.strokeRect(ox + x * k, oy + y * k, bw * k, bh * k);
    const label = `${subject ? 'SUBJECT ' : ''}#${face.trackId}${face.personId != null ? ` ${face.name || 'person ' + face.personId}` : ' not enrolled yet'}`;
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(4, 6, 11, 0.8)';
    ctx.fillRect(ox + x * k, oy + y * k - 17, tw, 16);
    ctx.fillStyle = subject ? '#8dbdff' : '#8e9bb0';
    ctx.fillText(label, ox + x * k + 4, oy + y * k - 2);
  }
}

function shownHint(hint) {
  if (!mirrored.checked) return HINTS[hint] || '';
  if (hint === 'turn left') return HINTS['turn right'];
  if (hint === 'turn right') return HINTS['turn left'];
  return HINTS[hint] || '';
}

function renderReadout() {
  const p = state.progress;
  const shown = p || IDLE;
  const guide = mirrored.checked ? { ...shown, yaw: -shown.yaw, cells: shown.cells.map((c) => ({ ...c, yaw: -c.yaw })) } : shown;
  renderScanGuide($('guide'), guide, { label: false });
  hintEl.textContent = state.scan && p ? shownHint(p.hint) : '';
  $('coverage').textContent = `${Math.round((p ? p.coverage : 0) * 100)}%`;
  $('angles').textContent = p ? `(${p.filled} of ${p.total} angle cells)` : '';
  $('detail').textContent = state.scan && p && p.detail ? `Last frame skipped: ${p.detail}` : '';
}

function requiredLeft(p) {
  let left = 0;
  for (const c of p.cells) if (c.required && !c.filled) left++;
  if (!p.cells.some((c) => c.pitch > 0 && c.filled)) left++;
  if (!p.cells.some((c) => c.pitch < 0 && c.filled)) left++;
  return left;
}

function renderClock() {
  if (!state.startedAt) return;
  const end = state.scan ? performance.now() : state.endedAt;
  const elapsed = (end - state.startedAt) / 1000;
  $('elapsed').textContent = `${elapsed.toFixed(1)} s`;
  const p = state.progress;
  let eta = '';
  if (state.scan && p) {
    const left = requiredLeft(p), done = 5 - left;
    eta = left === 0 ? 'finishing' : done > 0 ? `about ${Math.max(1, Math.round((elapsed / done) * left))} s left at this pace` : 'estimate after the first angle';
  }
  $('eta').textContent = eta;
}

function renderStatus(faces) {
  const live = state.det && performance.now() - state.detAt < 1500;
  stageNote.textContent = !state.det ? 'Connecting to the camera server' : !live ? 'Detections have stopped arriving. Is the camera server running?' : faces.length ? `${faces.length} face${faces.length === 1 ? '' : 's'} in view` : 'No face in view';
  if (state.error) return setStatus(state.error, 'error');
  if (!state.scan) {
    if (state.model) return setStatus(`${state.model.complete ? `Done in ${((state.endedAt - state.startedAt) / 1000).toFixed(1)} s.` : 'Scan stopped.'} The last model stays in the panel. Start scan begins a fresh capture.`);
    if (state.warm === 'loading') return setStatus('Loading the face tracker. You can press Start scan now; it begins as soon as loading ends.', 'wait');
    if (state.warm === 'failed') return setStatus('The face tracker could not be preloaded. Start scan will try again.', 'error');
    return setStatus(`Face tracker ready (loaded in ${(state.warmMs / 1000).toFixed(1)} s). Press Start scan, then turn your head slowly.`);
  }
  const s = state.subject;
  if (!live) return setStatus('Waiting for the camera server.', 'wait');
  if (!s) return setStatus('No face in view. Sit so your face fills about a third of the picture.', 'wait');
  if (s.personId == null) return setStatus('Waiting for enrolment. The server enrols a face after about a second in view.', 'wait');
  const p = state.progress;
  if (!p || p.personId !== s.personId) {
    const slow = performance.now() - state.startedAt > 6000;
    return setStatus(slow ? 'Loading the face tracker is taking a while. Check the console timing log and the network connection.' : 'Enrolled. Starting the face tracker.', 'wait');
  }
  if (p.phase === 'building') return setStatus('Building the model from the captured angles.', 'wait');
  if (p.phase === 'uploading') return setStatus('Saving the model.', 'wait');
  if (p.filled === 0) return setStatus(`Tracking ${s.name || 'person ' + s.personId}, no usable frame yet. Face the camera in even light.`, 'wait');
  setStatus(p.complete ? 'Enough angles captured. Saving the final model.' : `Scanning ${s.name || 'person ' + s.personId}. Follow the hint and move slowly.`);
}

function frame() {
  const faces = pickSubject();
  drawBoxes(faces);
  if (state.scan && state.subject && state.subject.personId != null) {
    const latest = state.scan.progress(state.subject.personId);
    if (latest && !(state.progress && state.progress.personId === state.subject.personId)) state.progress = { ...latest, personId: state.subject.personId, phase: 'scanning' };
  }
  renderStatus(faces);
  renderClock();
  requestAnimationFrame(frame);
}

async function showModel(model) {
  state.model = model;
  if (!state.firstModelMs) state.firstModelMs = performance.now() - state.startedAt;
  const t = model.timings;
  $('timing').textContent = `First model ${(state.firstModelMs / 1000).toFixed(1)} s after Start. Last model: ${(t.sinceFirstFrameMs / 1000).toFixed(1)} s after first good frame, atlas ${Math.round(t.atlasMs)} ms, export ${Math.round(t.exportMs)} ms, upload ${Math.round(t.uploadMs)} ms.`;
  downloadBtn.disabled = false;
  $('model-note').textContent = `${model.warning || 'Full target coverage.'} ${SCAN_DESCRIPTION}`;
  try {
    if (!state.viewer) {
      state.viewerLoading = state.viewerLoading || import('./viewer3d.js');
      const { mountViewer } = await state.viewerLoading;
      if (!state.viewer) {
        $('viewer-empty').remove();
        state.viewer = mountViewer($('viewer'), { accent: '#3b82f6' });
      }
    }
    state.viewer.setModel(state.model.modelUrl);
    state.viewer.setLabel(`face scan ${Math.round(state.model.coverage * 100)}%`);
  } catch {
    $('model-note').textContent = 'The model was saved but the 3D viewer could not be loaded. You can still download the .glb.';
  }
}

function start() {
  if (state.scan) return;
  state.error = null;
  if (!scanSupported()) {
    const s = scanSupport();
    const missing = [!s.webgl && 'WebGL', !s.wasm && 'WebAssembly', !s.canvas && 'canvas'].filter(Boolean).join(', ');
    state.error = `Face scan cannot run here: this browser has ${missing} turned off or missing.`;
    return;
  }
  state.progress = null;
  state.model = null;
  state.firstModelMs = 0;
  state.startedAt = performance.now();
  $('timing').textContent = '';
  const scan = startAutoScan({
    source: feed,
    getTracks: () => (state.subject ? [state.subject] : []),
    getFrameSize: () => (state.det && state.det.w ? [state.det.w, state.det.h] : null),
    getSelectedPersonId: () => (state.subject ? state.subject.personId : null),
    includeAutoEnrolled: true,
    onProgress: (p) => {
      if (state.scan !== scan || !state.subject || p.personId !== state.subject.personId) return;
      state.progress = p;
      state.progressAt = performance.now();
      renderReadout();
    },
    onModel: (model) => {
      if (state.scan !== scan) return;
      showModel(model);
      if (model.complete) finish();
    },
    onError: (e) => {
      if (state.scan !== scan) return;
      if (e.fatal) {
        state.error = e.message;
        finish();
      } else {
        $('detail').textContent = e.message;
      }
    },
  });
  state.scan = scan;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  renderReadout();
}

function finish() {
  if (state.scan) state.scan.stop();
  state.scan = null;
  state.endedAt = performance.now();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  renderReadout();
}

async function download() {
  if (!state.model) return;
  downloadBtn.disabled = true;
  try {
    const res = await fetch(state.model.modelUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `face-scan-${state.model.personId}.glb`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    $('model-note').textContent = 'The model could not be downloaded. It may have been deleted on the server.';
  } finally {
    downloadBtn.disabled = false;
  }
}

function retryFeed() {
  stageNote.textContent = 'The video stream could not be loaded. Is the camera server running?';
  setTimeout(() => {
    feed.src = `video.mjpg?t=${Date.now()}`;
  }, 2000);
}
feed.addEventListener('error', retryFeed);
setTimeout(() => {
  if (!feed.naturalWidth) retryFeed();
}, 4000);
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', () => {
  state.error = null;
  finish();
});
downloadBtn.addEventListener('click', download);
mirrored.addEventListener('change', renderReadout);
connect();
renderReadout();
const warmStart = performance.now();
warmUp({ onTiming: logTiming }).then(
  (ok) => {
    state.warm = ok ? 'ready' : 'failed';
    state.warmMs = performance.now() - warmStart;
  },
  () => {
    state.warm = 'failed';
  },
);
requestAnimationFrame(frame);
