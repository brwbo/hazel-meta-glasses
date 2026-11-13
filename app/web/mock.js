const W = 1280;
const H = 720;
const now = () => Date.now() / 1000;

function avatar(initials, hue) {
  const c = document.createElement("canvas");
  c.width = c.height = 192;
  const g = c.getContext("2d");
  const bg = g.createLinearGradient(0, 0, 0, 192);
  bg.addColorStop(0, `hsl(${hue} 45% 14%)`);
  bg.addColorStop(1, "#05080f");
  g.fillStyle = bg;
  g.fillRect(0, 0, 192, 192);
  g.fillStyle = `hsl(${hue} 30% 30%)`;
  g.beginPath();
  g.ellipse(96, 84, 42, 52, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(96, 200, 78, 52, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#d6dde8";
  g.font = "600 30px ui-monospace, Menlo, monospace";
  g.textAlign = "center";
  g.fillText(initials, 96, 96);
  return c.toDataURL("image/jpeg", 0.85);
}

const t0 = now();
const people = [
  {
    id: 1, name: "Sam Lee", role: "Robotics researcher, Aalto University", hue: 215,
    tags: ["robotics", "manipulation", "ROS 2", "Aalto"],
    summary: "Works on grasp planning for soft grippers. Met at the opening keynote; looking for teammates with vision experience for the hardware track.",
    followups: ["Send the YuNet benchmark notes", "Intro to the Junction hardware mentors", "Ask about the soft gripper dataset"],
    notes: [
      { ts: t0 - 5400, text: "Talked about tactile sensing. Prefers Python, uses MuJoCo for sim." },
      { ts: t0 - 1900, text: "Interested in trying the face-to-context demo with their lab group." },
    ],
  },
  {
    id: 2, name: "Priya Shah", role: "Founder, climate data startup", hue: 200,
    tags: ["climate", "founder", "geospatial", "hiring"],
    summary: "Building emissions dashboards from satellite methane data. Raised a pre-seed in spring and is hiring a frontend engineer in Helsinki.",
    followups: ["Share portfolio link", "Check the Sentinel-5P pipeline repo she mentioned"],
    notes: [{ ts: t0 - 3100, text: "Pitch is municipal buyers first. Wants honest feedback on the deck." }],
  },
  {
    id: 3, name: "Joon Park", role: "Design student, interaction design", hue: 228,
    tags: ["design", "prototyping", "Figma", "HUD"],
    summary: "Second-year interaction design student. Into heads-up interfaces and wants to see how the glasses overlay handles crowded rooms.",
    followups: ["Send screenshots of the phone layout"],
    notes: [],
  },
];
for (const p of people) {
  p.notes.forEach((n, i) => { n.id = p.id * 10 + i; });
  p.consentAt = t0 - 7200;
  p.consentNote = "fictional mock profile";
  p.thumbUrl = avatar(p.name.split(" ").map((s) => s[0]).join(""), p.hue);
  p.lastSeen = t0;
  p.modelUrl = null;
}

const tracks = [
  { trackId: 11, personId: null, joins: 1, at: 1.2, off: 0.0, yo: 0.3, k: 0.33 },
  { trackId: 12, personId: null, joins: 2, at: 2.4, off: 2.1, yo: 1.7, k: 0.41 },
  { trackId: 13, personId: null, joins: 3, at: 3.6, off: 4.2, yo: 2.9, k: 0.29 },
  { trackId: 14, personId: null, off: 1.0, yo: 4.4, k: 0.37 },
  { trackId: 15, personId: null, off: 5.3, yo: 0.9, k: 0.45 },
];

function pose(tr, t) {
  const phase = t * tr.k + 1.6 * Math.sin(t * 0.21 + tr.off) + tr.off;
  const cx = W / 2 + W * 0.36 * Math.sin(phase);
  const cy = H * 0.46 + H * 0.1 * Math.sin(phase * 1.7 + tr.yo);
  const s = 128 + 34 * Math.sin(phase * 0.5 + tr.yo);
  return { cx, cy, s };
}

function draw(g, t, params) {
  g.fillStyle = "#070a10";
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.5, H * 0.2, 40, W * 0.5, H * 0.3, W * 0.7);
  glow.addColorStop(0, "#151c2a");
  glow.addColorStop(1, "#06080d");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(141,189,255,0.06)";
  g.lineWidth = 1;
  for (let i = -8; i <= 8; i++) {
    g.beginPath();
    g.moveTo(W / 2 + i * 40, H * 0.62);
    g.lineTo(W / 2 + i * 220, H);
    g.stroke();
  }
  for (let y = H * 0.62; y < H; y += 26 + (y - H * 0.62) * 0.3) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  g.fillStyle = "rgba(141,189,255,0.05)";
  g.fillRect(W * 0.08, H * 0.1, W * 0.18, H * 0.34);
  g.fillRect(W * 0.72, H * 0.08, W * 0.2, H * 0.3);
  if (params.lost) {
    g.fillStyle = "rgba(214,221,232,0.4)";
    g.font = "24px ui-monospace, Menlo, monospace";
    g.textAlign = "center";
    g.fillText("NO SIGNAL", W / 2, H / 2);
    return;
  }
  if (params.empty) return;
  const ps = (params.faces ? tracks.slice(0, params.faces) : tracks).map((tr) => pose(tr, t)).sort((a, b) => a.s - b.s);
  for (const p of ps) {
    const shade = g.createLinearGradient(0, p.cy - p.s, 0, p.cy + p.s * 1.6);
    shade.addColorStop(0, "#3a4458");
    shade.addColorStop(1, "#141a26");
    g.fillStyle = shade;
    g.beginPath();
    g.ellipse(p.cx, p.cy + p.s * 1.45, p.s * 0.95, p.s * 0.7, 0, Math.PI, 0);
    g.fill();
    g.fillRect(p.cx - p.s * 0.16, p.cy + p.s * 0.4, p.s * 0.32, p.s * 0.5);
    g.beginPath();
    g.ellipse(p.cx, p.cy, p.s * 0.4, p.s * 0.52, 0, 0, Math.PI * 2);
    g.fill();
  }
}

const lines = [
  "so the gripper only needs about two newtons before it slips",
  "we are pulling methane plumes from Sentinel five P every six hours",
  "I mostly prototype in Figma and then fake it with a webcam",
  "is this thing only showing people who said yes",
  "the overlay should not cover anyone's eyes",
  "happy to share the dataset after the weekend",
  "who else is on the hardware track",
];

const sockets = new Set();
let t0Run = now();
let noteSeq = 100;
const joinedAt = new Map();
const clearOf = (p) => {
  if (!joinedAt.has(p.id)) return true;
  return now() - joinedAt.get(p.id) > 6;
};

class MockSocket {
  constructor(url, params) {
    sockets.add(this);
    this.url = url;
    this.readyState = 0;
    this.params = params;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.timers = [];
    if (params.lost) {
      setTimeout(() => {
        this.readyState = 3;
        this.onerror && this.onerror(new Event("error"));
        this.onclose && this.onclose(new CloseEvent("close"));
      }, 400);
      return;
    }
    setTimeout(() => {
      this.readyState = 1;
      this.onopen && this.onopen(new Event("open"));
      this.emit({ type: "session", ...session });
      this.timers.push(setInterval(() => this.emitDetections(), 100));
      this.timers.push(setInterval(() => this.emitTranscript(), 2600));
      this.emitTranscript();
    }, 150);
  }
  emit(obj) {
    if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  emitDetections() {
    const t = now();
    const age = t - t0Run;
    for (const tr of tracks) {
      if (tr.joins && tr.personId == null && age > tr.at && people.some((p) => p.id === tr.joins)) {
        tr.personId = tr.joins;
        joinedAt.set(tr.joins, t);
      }
    }
    const cyc = age % 7;
    const pool = this.params.faces ? tracks.slice(0, this.params.faces) : tracks;
    const faces = this.params.empty ? [] : pool.filter((tr) => !(tr.trackId === 13 && cyc > 5 && cyc < 5.4)).map((tr) => {
      const p = pose(tr, t);
      const person = people.find((x) => x.id === tr.personId);
      if (person) person.lastSeen = t;
      return {
        trackId: tr.trackId,
        box: [p.cx - p.s * 0.42, p.cy - p.s * 0.56, p.s * 0.84, p.s * 1.08].map(Math.round),
        personId: person ? person.id : null,
        thumbClear: person ? clearOf(person) : null,
        name: person ? person.name : null,
        score: person ? 0.82 + 0.1 * Math.sin(t + tr.off) : 0.61,
        predicted: tr.trackId === 12 && cyc > 3 && cyc < 3.4,
      };
    });
    this.emit({ type: "detections", w: W, h: H, fps: 9.6 + Math.random() * 0.6, ts: t, faces });
  }
  emitTranscript() {
    const known = tracks.filter((tr) => tr.personId != null);
    const pick = Math.random() < 0.2 ? null : known[Math.floor(Math.random() * known.length)].personId;
    this.emit({ type: "transcript", personId: pick, text: lines[Math.floor(Math.random() * lines.length)], ts: now() });
  }
  send() {}
  close() {
    sockets.delete(this);
    this.timers.forEach(clearInterval);
    this.readyState = 3;
  }
  addEventListener(type, fn) { this["on" + type] = fn; }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function summary(p) {
  const { id, name, role, tags, summary, lastSeen, modelUrl } = p;
  return { id, name, role, tags, summary, lastSeen, hasModel: !!modelUrl };
}

function detail(p) {
  const { id, name, role, tags, summary, followups, notes, modelUrl, thumbUrl, lastSeen, consentAt, consentNote, nameSource, edited } = p;
  return { thumbClear: clearOf(p), id, name, role, tags, summary, followups, notes, modelUrl, thumbUrl, lastSeen, consentAt, consentNote, edited: edited || [], nameSource: nameSource || null, autoEnrolled: /^Guest|^Aino/.test(name) };
}

const session = { roomConsent: false, text: "Junction 2026 hall B, everyone here agreed to be recognised", autoEnrolled: 0 };

async function route(path, method, init) {
  if (path === "/api/session" && method === "GET") return json(session);
  if (path === "/api/ingest/audio" && method === "POST") return json({ ok: true });
  if (path === "/api/session/wipe" && method === "POST") {
    people.splice(0, people.length);
    tracks.forEach((tr) => { tr.personId = null; });
    session.autoEnrolled = 0;
    return json({ ok: true });
  }
  if (path === "/api/people" && method === "GET") return json(people.map(summary));
  const snap = path.match(/^\/api\/people\/(\d+)\/snapshot$/);
  if (snap) {
    const q = people.find((x) => x.id === Number(snap[1]));
    if (!q) return json({ detail: "Not found" }, 404);
    if (method === "DELETE") {
      q.thumbUrl = q.autoThumb || q.thumbUrl;
      q.edited = (q.edited || []).filter((f) => f !== "thumb");
      return new Response(null, { status: 204 });
    }
    const f = init.body instanceof FormData ? init.body.get("file") : null;
    if (!f) return json({ detail: "No image" }, 400);
    q.autoThumb = q.autoThumb || q.thumbUrl;
    q.thumbUrl = URL.createObjectURL(f);
    q.edited = [...new Set([...(q.edited || []), "thumb"])];
    return json({ thumbUrl: q.thumbUrl });
  }
  const nd = path.match(/^\/api\/people\/(\d+)\/notes\/(\d+)$/);
  if (nd && method === "DELETE") {
    const q = people.find((x) => x.id === Number(nd[1]));
    const i = q ? q.notes.findIndex((n) => n.id === Number(nd[2])) : -1;
    if (i < 0) return json({ detail: "Not found" }, 404);
    q.notes.splice(i, 1);
    return new Response(null, { status: 204 });
  }
  const m = path.match(/^\/api\/people\/(\d+)(?:\/(notes|model|conversation))?$/);
  if (!m) return null;
  const p = people.find((x) => x.id === Number(m[1]));
  if (!p) return json({ error: "Not found" }, 404);
  if (!m[2] && method === "GET") return json(detail(p));
  if (!m[2] && method === "PATCH") {
    const body = JSON.parse(init.body || "{}");
    if (body.name != null) {
      if (!String(body.name).trim()) return json({ detail: "Name is required" }, 400);
      p.name = String(body.name).trim();
      p.nameSource = "manual";
    }
    for (const k of ["role", "summary"]) if (body[k] != null) p[k] = String(body[k]).trim();
    for (const k of ["tags", "followups"]) if (Array.isArray(body[k])) p[k] = body[k].map(String);
    p.edited = [...new Set([...(p.edited || []), ...["role", "summary", "tags", "followups"].filter((k) => body[k] != null)])];
    return json(detail(p));
  }
  if (!m[2] && method === "DELETE") {
    people.splice(people.indexOf(p), 1);
    tracks.forEach((tr) => { if (tr.personId === p.id) tr.personId = null; });
    return new Response(null, { status: 204 });
  }
  if (m[2] === "notes" && method === "POST") {
    const text = String(JSON.parse(init.body || "{}").text || "").trim();
    if (!text) return json({ error: "Note text is required" }, 400);
    const note = { id: ++noteSeq, ts: now(), text };
    p.notes.push(note);
    return json(note);
  }
  if (m[2] === "model" && method === "POST") {
    const file = init.body instanceof FormData ? init.body.get("file") : null;
    if (!file) return json({ error: "No file" }, 400);
    p.modelUrl = URL.createObjectURL(file);
    return json({ modelUrl: p.modelUrl });
  }
  if (m[2] === "conversation" && method === "POST") {
    p.notes.push({ ts: now(), text: "Conversation recorded. Summary pending." });
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

export function installMock(params) {
  t0Run = now();
  session.roomConsent = !!params.room;
  setTimeout(() => {
    const g = people.find((p) => p.name === "Guest 1");
    if (!g) return;
    g.name = "Aino Laine";
    g.nameSource = "audio";
  }, 14000);
  {
    [5000, 9000].forEach((ms) => setTimeout(() => {
      const guest = tracks.find((tr) => tr.personId == null);
      if (!guest) return;
      const id = Math.max(0, ...people.map((p) => p.id)) + 1;
      session.autoEnrolled += 1;
      const n = session.autoEnrolled;
      people.push({ id, name: `Guest ${n}`, role: "", hue: 190, tags: [], summary: "", followups: [], notes: [], modelUrl: null, lastSeen: now(), consentAt: now(), consentNote: session.text, thumbUrl: avatar(`G${n}`, 190) });
      guest.personId = id;
      joinedAt.set(id, now());
      sockets.forEach((ws) => ws.emit({ type: "session", ...session }));
    }, ms));
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const method = (init.method || "GET").toUpperCase();
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
      await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
      const res = await route(url.pathname, method, init);
      if (res) return res;
    }
    return realFetch(input, init);
  };
  window.WebSocket = class extends MockSocket {
    constructor(url) { super(url, params); }
  };
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Simulated camera feed");
  const g = canvas.getContext("2d");
  const loop = () => {
    draw(g, now() - 0.12, params);
    requestAnimationFrame(loop);
  };
  loop();
  return { video: canvas };
}
