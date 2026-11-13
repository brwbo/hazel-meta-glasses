const PRE_ROLL = 0.3;
const HANG = 0.5;
const MAX_SEG = 2.5;
const MIN_LOUD = 0.3;
const PRESENT_SHARE = 0.5;
const MIN_LIP_SHARE = 0.3;
const MIN_CORR = 0.2;
const WIN_SCORE = 0.3;
const WIN_MARGIN = 0.15;
const MOVING_STD = 0.006;
const MIN_PAIRS = 8;
const OUT_RATE = 16000;
const BATCH = 2048;

function smooth(xs) {
  return xs.map((_, i) => {
    const w = xs.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

function scoreFor(ticks, loud, trackId) {
  const lm = loud.map((t) => t.lips && t.lips[trackId]).filter((x) => x && x.moving != null);
  if (lm.length < loud.length / 2) return { trackId, ok: false, lip: 0, std: 0 };
  const share = lm.filter((x) => x.moving).length / lm.length;
  const pairs = ticks.filter((t) => t.lips && t.lips[trackId] && t.lips[trackId].a != null);
  const corr = pairs.length >= MIN_PAIRS ? pearson(smooth(pairs.map((t) => t.rms)), smooth(pairs.map((t) => t.lips[trackId].a))) : 0;
  const as = lm.map((x) => x.a);
  const mean = as.reduce((a, b) => a + b, 0) / as.length;
  const std = Math.sqrt(as.reduce((a, b) => a + (b - mean) ** 2, 0) / as.length);
  return { trackId, ok: true, share, corr, std, lip: Math.max(0, Math.min(1, 0.5 * share + 0.5 * Math.max(0, corr))) };
}

export function judge(ticks, cands) {
  const loud = ticks.filter((t) => t.open);
  const loudDur = loud.reduce((a, t) => a + t.dt, 0);
  if (loudDur < MIN_LOUD) return { upload: false, reason: "too short", loud: false };
  if (!cands.length) return { upload: false, reason: "no face", loud: true };
  const scores = cands.map((c) => ({ ...scoreFor(ticks, loud, c.trackId), personId: c.personId })).filter((x) => x.ok);
  if (!scores.length) return { upload: false, reason: "lips not measurable", loud: true };
  let win = null;
  if (cands.length === 1) {
    const one = scores[0];
    if (one.share < MIN_LIP_SHARE) return { upload: false, reason: "lips still", loud: true, still: true, lip: one.lip };
    if (one.corr < MIN_CORR) return { upload: false, reason: "lips not in step with sound", loud: true, still: true, lip: one.lip };
    win = one;
  } else {
    const byLip = [...scores].sort((a, b) => b.lip - a.lip);
    const second = byLip[1] ? byLip[1].lip : 0;
    if (byLip[0].lip >= WIN_SCORE && byLip[0].lip - second >= WIN_MARGIN) win = byLip[0];
    else {
      const byStd = [...scores].sort((a, b) => b.std - a.std);
      const runner = byStd[1] ? byStd[1].std : 0;
      if (byStd[0].std > MOVING_STD && byStd[0].std >= runner * 2) win = byStd[0];
    }
    if (!win) return { upload: false, reason: "ambiguous speaker", loud: true };
  }
  if (win.personId == null) return { upload: false, reason: "speaker not enrolled", loud: true };
  return { upload: true, reason: cands.length === 1 ? "speech" : `active speaker of ${cands.length}`, loud: true, lip: win.lip, personId: win.personId };
}

export function candidates(samples, t0, t1) {
  const inWin = samples.filter((s) => s.t >= t0 && s.t <= t1);
  if (!inWin.length) return [];
  const seen = new Map();
  for (const s of inWin) {
    for (const f of s.faces) {
      const c = seen.get(f.trackId) || { trackId: f.trackId, personId: f.personId, n: 0 };
      c.n += 1;
      if (f.personId != null) c.personId = f.personId;
      seen.set(f.trackId, c);
    }
  }
  return [...seen.values()].filter((c) => c.n / inWin.length > PRESENT_SHARE).slice(0, 3);
}

export class Gate {
  constructor() {
    this.floor = 0.01;
    this.open = false;
  }
  push(rms) {
    if (rms < this.floor * 2) this.floor = this.floor * 0.97 + rms * 0.03;
    else this.floor = this.floor * 0.999 + rms * 0.001;
    this.floor = Math.min(Math.max(this.floor, 0.002), 0.08);
    const threshold = Math.max(this.floor * 3, 0.012);
    this.open = this.open ? rms > threshold * 0.7 : rms > threshold;
    return this.open;
  }
}

export class Segmenter {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.pre = [];
    this.active = null;
  }
  push(frame, tick) {
    const t = tick.t;
    if (!this.active) {
      this.pre.push({ frame, tick });
      while (this.pre.length && t - this.pre[0].tick.t > PRE_ROLL) this.pre.shift();
      if (tick.open) this.begin(t, this.pre);
      return;
    }
    const a = this.active;
    a.items.push({ frame, tick });
    if (tick.open) a.lastLoud = t;
    if (t - a.lastLoud >= HANG) this.emit(t);
    else if (t - a.speechStart >= MAX_SEG) {
      const tail = a.items.filter((x) => t - x.tick.t <= PRE_ROLL);
      this.emit(t);
      if (tick.open) this.begin(t, tail);
    }
  }
  begin(t, lead) {
    this.active = { items: [...lead], speechStart: t, lastLoud: t };
    this.pre = [];
  }
  emit(t) {
    const a = this.active;
    this.active = null;
    this.onSegment({ items: a.items, start: a.items[0].tick.t, end: t, speechEnd: a.lastLoud });
  }
}

export function encodeWav(frames, rate) {
  const total = frames.reduce((a, f) => a + f.length, 0);
  const ratio = rate / OUT_RATE;
  const n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  const all = new Float32Array(total);
  let o = 0;
  for (const f of frames) {
    all.set(f, o);
    o += f.length;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const v = s / Math.max(1, b - a);
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, OUT_RATE, true);
  v.setUint32(28, OUT_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

const WORKLET = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${BATCH}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("fc-tap", Tap);`;

async function tap(ctx, source, onFrame) {
  if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, "fc-tap");
    node.port.onmessage = (e) => onFrame(e.data);
    source.connect(node);
    return;
  }
  const node = ctx.createScriptProcessor(BATCH, 1, 1);
  node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(ctx.destination);
}

export function startMic(dot, { lips = null } = {}) {
  const gate = new Gate();
  const stats = { uploaded: 0, dropped: 0, reasons: {}, last: null, latencyMs: [] };
  window.__mic = stats;
  const samples = [];
  let current = [];
  const set = (state, label) => {
    dot.dataset.state = state;
    dot.title = label;
    dot.setAttribute("aria-label", label);
  };
  const api = {
    sample(faces) {
      const list = faces || [];
      current = list.slice(0, 3).map((f) => f.trackId);
      const t = performance.now() / 1000;
      samples.push({ t, faces: list.map((f) => ({ trackId: f.trackId, personId: f.personId })) });
      while (samples.length && t - samples[0].t > 10) samples.shift();
    },
    stop() {},
  };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    set("off", "Microphone not available in this browser");
    return api;
  }
  set("off", "Microphone waiting for permission");
  let stopped = false;
  let flash = 0;
  let idle = { state: "on", label: "Microphone listening" };
  let rate = 48000;

  const log = (verdict, who, latency) => {
    stats.reasons[verdict.reason] = (stats.reasons[verdict.reason] || 0) + 1;
    stats.last = verdict.reason;
    if (verdict.upload) {
      stats.uploaded += 1;
      stats.latencyMs.push(Math.round(latency));
      if (stats.latencyMs.length > 50) stats.latencyMs.shift();
    } else stats.dropped += 1;
    if (verdict.loud) console.debug(`[mic] ${verdict.upload ? "upload" : "drop"}: ${verdict.reason}${who != null ? ` person ${who}` : ""}${verdict.lip != null ? ` lip ${verdict.lip.toFixed(2)}` : ""}${verdict.upload ? ` ${Math.round(latency)} ms after speech end` : ""}`);
  };

  const send = (blob, personId, lip) => {
    fetch(`/api/ingest/audio?personId=${encodeURIComponent(personId)}&lip=${lip.toFixed(2)}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: blob })
      .then((res) => { idle = res.ok ? { state: "on", label: "Microphone listening" } : { state: "warn", label: "Microphone on, server did not accept audio" }; })
      .catch(() => { idle = { state: "warn", label: "Microphone on, server unreachable" }; });
  };

  const onSegment = (seg) => {
    const ticks = seg.items.map((x) => x.tick);
    const cands = candidates(samples, seg.start, seg.end);
    const verdict = judge(ticks, cands);
    const who = verdict.personId ?? null;
    if (verdict.upload) {
      const blob = encodeWav(seg.items.map((x) => x.frame), rate);
      const latency = performance.now() - seg.speechEnd * 1000;
      send(blob, who, verdict.lip);
      log(verdict, who, latency);
      flash = performance.now() + 1200;
      set("speech", "Speech sent");
    } else {
      log(verdict, who, 0);
      if (verdict.still) {
        flash = performance.now() + 1200;
        set("ignored", "Sound ignored: lips did not match");
      }
    }
  };
  const segmenter = new Segmenter(onSegment);

  const onFrame = (frame) => {
    if (stopped) return;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const open = gate.push(rms);
    const per = {};
    if (lips) for (const id of current) {
      const a = lips.latest(id);
      const act = a != null ? lips.lipsFor(id) : null;
      per[id] = { a, moving: act && act.measured ? act.moving : null };
    }
    segmenter.push(frame, { t: performance.now() / 1000, dt: frame.length / rate, rms, open, lips: per });
    if (performance.now() < flash) return;
    if (open && dot.dataset.state !== "speaking") set("speaking", "Sound detected");
    else if (!open && dot.dataset.state !== idle.state) set(idle.state, idle.label);
  };
  api.feed = onFrame;

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then(async (s) => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      rate = ctx.sampleRate;
      const resume = () => ctx.state === "suspended" && ctx.resume().catch(() => {});
      document.addEventListener("pointerdown", resume, { once: true });
      await tap(ctx, ctx.createMediaStreamSource(s), onFrame);
      set("on", "Microphone listening");
      s.getAudioTracks().forEach((t) => t.addEventListener("ended", () => set("off", "Microphone stopped")));
      if (lips) lips.start();
      api.stop = () => {
        stopped = true;
        s.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      };
    })
    .catch((err) => {
      set("denied", err && err.name === "NotAllowedError" ? "Microphone blocked. Allow it in the browser to capture names." : "Microphone unavailable");
    });
  return api;
}
