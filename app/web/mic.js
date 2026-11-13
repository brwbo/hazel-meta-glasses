const CHUNK_MS = 5000;
const TICK_MS = 100;
const MIN_SPEECH_TICKS = 8;
const SOLE_SHARE = 0.7;

function pickType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined") return null;
  return types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
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

export class Speaker {
  constructor() {
    this.reset();
  }
  reset() {
    this.total = 0;
    this.sole = new Map();
  }
  sample(faces) {
    this.total += 1;
    if (faces.length !== 1 || faces[0].personId == null) return;
    const id = faces[0].personId;
    this.sole.set(id, (this.sole.get(id) || 0) + 1);
  }
  decide() {
    if (!this.total) return null;
    for (const [id, n] of this.sole) if (n / this.total > SOLE_SHARE) return id;
    return null;
  }
}

export function startMic(dot) {
  const speaker = new Speaker();
  const gate = new Gate();
  const set = (state, label) => {
    dot.dataset.state = state;
    dot.title = label;
    dot.setAttribute("aria-label", label);
  };
  const api = { sample: (faces) => speaker.sample(faces || []), stop() {} };
  const type = pickType();
  if (type === null || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    set("off", "Microphone not available in this browser");
    return api;
  }
  set("off", "Microphone waiting for permission");
  let stream = null;
  let stopped = false;
  let speechTicks = 0;
  let idle = { state: "on", label: "Microphone listening" };

  const send = async (blob, personId) => {
    try {
      const res = await fetch(`/api/ingest/audio?personId=${encodeURIComponent(personId)}`, { method: "POST", headers: { "Content-Type": blob.type || type || "audio/webm" }, body: blob });
      idle = res.ok ? { state: "on", label: "Microphone listening" } : { state: "warn", label: "Microphone on, server did not accept audio" };
    } catch {
      idle = { state: "warn", label: "Microphone on, server unreachable" };
    }
    if (!gate.open) set(idle.state, idle.label);
  };

  const cycle = () => {
    if (stopped || !stream) return;
    let rec;
    try {
      rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    } catch {
      set("off", "Microphone could not record");
      return;
    }
    const parts = [];
    speechTicks = 0;
    speaker.reset();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      const who = speaker.decide();
      const spoke = speechTicks >= MIN_SPEECH_TICKS;
      if (spoke && who != null) send(new Blob(parts, { type: rec.mimeType || type }), who);
      cycle();
    };
    rec.start();
    setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, CHUNK_MS);
  };

  const listen = (s) => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(s).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const resume = () => ctx.state === "suspended" && ctx.resume().catch(() => {});
    document.addEventListener("pointerdown", resume, { once: true });
    const timer = setInterval(() => {
      if (stopped) return clearInterval(timer);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const open = gate.push(Math.sqrt(sum / buf.length));
      if (open) speechTicks += 1;
      if (open && dot.dataset.state !== "speaking") set("speaking", "Speech detected");
      else if (!open && dot.dataset.state === "speaking") set(idle.state, idle.label);
    }, TICK_MS);
  };

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then((s) => {
      stream = s;
      set("on", "Microphone listening");
      s.getAudioTracks().forEach((t) => t.addEventListener("ended", () => set("off", "Microphone stopped")));
      listen(s);
      cycle();
    })
    .catch((err) => {
      set("denied", err && err.name === "NotAllowedError" ? "Microphone blocked. Allow it in the browser to capture names." : "Microphone unavailable");
    });

  api.stop = () => {
    stopped = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };
  return api;
}
