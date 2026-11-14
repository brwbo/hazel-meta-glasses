import { createRoom } from "./room/room.js";

const NARROW = window.innerWidth < 720;
const W = NARROW ? 960 : 1280;
const H = NARROW ? 1080 : 720;
const now = () => Date.now() / 1000;
const t0 = now();

const cast = [
  {
    track: 11, joinAt: 0,
    person: { name: "Mira Castell", role: "Product designer, Fernhill", tags: ["design", "transit", "maps"], summary: "Met at the demo hall. Building a tactile transit map and looking for people to test it.", followups: ["Offer to test the transit map"], notes: [{ ts: t0 - 1900, text: "Sketches everything on paper first." }] },
    lines: [
      { text: "Could you send the workshop deck by Friday?", note: "wants the workshop deck by Friday", todo: "Send Mira the workshop deck" },
      { text: "We are testing the map with riders next month.", note: "rider tests start next month" },
      { text: "The raised lines need to be thicker than I thought.", note: "raised lines must be thicker" },
    ],
  },
  {
    track: 12, joinAt: 0,
    person: { name: "Sam Okafor", role: "Robotics researcher", tags: ["robotics", "grippers"], summary: "Works on grasp planning for soft grippers. Looking for teammates with vision experience.", followups: ["Ask about the gripper dataset"], notes: [{ ts: t0 - 5400, text: "Prefers Python. Simulates before building." }] },
    lines: [
      { text: "The gripper only needs about two newtons before it slips.", note: "gripper slips at about two newtons" },
      { text: "Happy to share the dataset after the weekend.", note: "will share the dataset after the weekend", todo: "Remind Sam about the dataset" },
      { text: "Who else is on the hardware track?" },
    ],
  },
  {
    track: 13, joinAt: 0,
    person: { name: "Priya Shah", role: "Founder, climate data startup", tags: ["climate", "founder", "hiring"], summary: "Building emissions dashboards for city councils. Hiring a frontend engineer.", followups: ["Share portfolio link"], notes: [{ ts: t0 - 3100, text: "Wants honest feedback on the pitch deck." }] },
    lines: [
      { text: "We pull new satellite data every six hours.", note: "data refreshes every six hours" },
      { text: "Send me your portfolio and I will pass it on.", note: "will pass my portfolio to her team", todo: "Send Priya the portfolio" },
      { text: "Councils buy slowly, so we start with pilots.", note: "starting with council pilots" },
    ],
  },
  {
    track: 14, guestAt: 6,
    lines: [
      { text: "Hi, I am Aino Laine.", rename: "Aino Laine" },
      { text: "I mostly prototype on paper and then fake it with a webcam.", note: "prototypes on paper, then a webcam" },
      { text: "The overlay should never cover anyone's eyes.", note: "overlay must not cover eyes" },
    ],
  },
  {
    track: 15, guestAt: 10,
    lines: [
      { text: "Is this thing only showing people who said yes?" },
      { text: "I am just here for the coffee, honestly.", note: "here for the coffee" },
    ],
  },
];

const people = [];
const tracks = cast.map((c, i) => ({ index: i, trackId: c.track, personId: null, lines: c.lines, said: 0, cast: c }));
const sockets = new Set();
const session = { roomConsent: false, text: "Simulated demo room. Everyone here is fictional.", autoEnrolled: 0 };
const joinedAt = new Map();
let noteSeq = 100;
let room = null;
let boxes = [];
let sim = 0;
let speaking = { index: -1, until: 0, line: null };
let nextTurn = 2.2;
let turn = 0;

const clearOf = (p) => !joinedAt.has(p.id) || now() - joinedAt.get(p.id) > 4;
const broadcast = (obj) => sockets.forEach((ws) => ws.emit(obj));

function enrol(tr, data, fresh) {
  const id = Math.max(0, ...people.map((p) => p.id)) + 1;
  const p = { id, tags: [], summary: "", followups: [], notes: [], role: "", ...data, lastSeen: now(), consentAt: now(), consentNote: session.text };
  p.notes = p.notes.map((n, i) => ({ id: id * 10 + i, ...n }));
  p.thumbUrl = boxes[tr.index] ? room.portrait(boxes[tr.index].box) : "";
  people.push(p);
  tr.personId = id;
  if (fresh) joinedAt.set(id, now());
  return p;
}

function casting() {
  for (const tr of tracks) {
    if (tr.personId != null || tr.gone) continue;
    if (tr.cast.joinAt != null && sim >= tr.cast.joinAt) enrol(tr, tr.cast.person, false);
    else if (tr.cast.guestAt != null && sim > tr.cast.guestAt) {
      session.autoEnrolled += 1;
      enrol(tr, { name: `Guest ${session.autoEnrolled}` }, true);
      broadcast({ type: "session", ...session });
    }
  }
}

function finish(tr, line) {
  const p = people.find((x) => x.id === tr.personId);
  if (!p || !line) return;
  if (line.rename && /^Guest/.test(p.name)) {
    p.name = line.rename;
    p.nameSource = "audio";
  }
  if (line.note) p.notes.push({ id: ++noteSeq, ts: now(), text: line.note });
  if (line.todo && !p.followups.includes(line.todo)) p.followups = [...p.followups, line.todo];
}

function speech() {
  if (speaking.index >= 0 && sim > speaking.until) {
    finish(tracks[speaking.index], speaking.line);
    speaking = { index: -1, until: 0, line: null };
  }
  if (speaking.index >= 0 || sim < nextTurn) return;
  const ready = tracks.filter((tr) => tr.personId != null);
  if (!ready.length) return;
  const tr = ready[turn % ready.length];
  turn += 1;
  const line = tr.lines[tr.said % tr.lines.length];
  const first = tr.said < tr.lines.length;
  tr.said += 1;
  speaking = { index: tr.index, until: sim + 2.3, line: first ? line : { text: line.text } };
  nextTurn = sim + 3.4;
  broadcast({ type: "transcript", personId: tr.personId, text: line.text, ts: now() });
}

function detections(params) {
  const t = now();
  const faces = params.empty || params.lost ? [] : tracks.map((tr) => {
    const p = people.find((x) => x.id === tr.personId);
    if (p) p.lastSeen = t;
    return { trackId: tr.trackId, box: boxes[tr.index].box, personId: p ? p.id : null, thumbClear: p ? clearOf(p) : null, name: p ? p.name : null, score: p ? 0.88 : 0.61, predicted: false };
  });
  broadcast({ type: "detections", w: W, h: H, fps: 20, ts: t, live: true, faces });
}

class MockSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    setTimeout(() => {
      this.readyState = 1;
      sockets.add(this);
      if (this.onopen) this.onopen(new Event("open"));
      this.emit({ type: "session", ...session });
    }, 150);
  }
  emit(obj) {
    if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  send() {}
  close() {
    sockets.delete(this);
    this.readyState = 3;
  }
  addEventListener(type, fn) {
    this["on" + type] = fn;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const summary = ({ id, name, role, tags, summary: text, lastSeen }) => ({ id, name, role, tags, summary: text, lastSeen });
const detail = (p) => ({ thumbClear: clearOf(p), id: p.id, name: p.name, role: p.role, tags: p.tags, summary: p.summary, followups: p.followups, notes: p.notes, thumbUrl: p.thumbUrl, lastSeen: p.lastSeen, consentAt: p.consentAt, consentNote: p.consentNote, edited: p.edited || [], nameSource: p.nameSource || null, autoEnrolled: /^Guest/.test(p.name) || p.nameSource === "audio" });

function forget(p) {
  people.splice(people.indexOf(p), 1);
  tracks.forEach((tr) => {
    if (tr.personId === p.id) {
      tr.personId = null;
      tr.gone = true;
    }
  });
}

async function route(path, method, init) {
  if (path === "/api/session" && method === "GET") return json(session);
  if (path === "/api/ingest/audio" && method === "POST") return json({ ok: true });
  if (path === "/api/session/wipe" && method === "POST") {
    [...people].forEach(forget);
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
  const m = path.match(/^\/api\/people\/(\d+)(?:\/(notes|conversation))?$/);
  if (!m) return json({ detail: "Not found" }, 404);
  const p = people.find((x) => x.id === Number(m[1]));
  if (!p) return json({ detail: "Not found" }, 404);
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
    forget(p);
    return new Response(null, { status: 204 });
  }
  if (m[2] === "notes" && method === "POST") {
    const text = String(JSON.parse(init.body || "{}").text || "").trim();
    if (!text) return json({ detail: "Note text is required" }, 400);
    const note = { id: ++noteSeq, ts: now(), text };
    p.notes.push(note);
    return json(note);
  }
  if (m[2] === "conversation" && method === "POST") return json({ ok: true });
  return json({ detail: "Method not allowed" }, 405);
}

export function installMock(params) {
  session.roomConsent = !!params.room;
  session.stt = params.stt || "local";
  session.cloudSpeech = session.stt === "gemini";
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin === location.origin && url.pathname.includes("/api/")) {
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 70));
      return route(url.pathname.slice(url.pathname.indexOf("/api/")), (init.method || "GET").toUpperCase(), init);
    }
    return realFetch(input, init);
  };
  window.WebSocket = MockSocket;

  room = createRoom({ width: W, height: H, narrow: NARROW, calm: matchMedia("(prefers-reduced-motion: reduce)").matches });
  const talk = (i) => (speaking.index === i ? Math.min(1, (speaking.until - sim) * 4, (sim - (speaking.until - 2.3)) * 6) : 0);
  let last = performance.now();
  let sinceEmit = 0;
  const loop = (t) => {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    sim += dt;
    boxes = room.step(sim, talk);
    room.render();
    casting();
    speech();
    sinceEmit += dt;
    if (sinceEmit >= 0.05) {
      sinceEmit = 0;
      detections(params);
    }
    requestAnimationFrame(loop);
  };
  boxes = room.step(0, talk);
  room.render();
  casting();
  requestAnimationFrame(loop);
  return { video: room.canvas, mouth: (trackId) => (tracks[speaking.index] && tracks[speaking.index].trackId === trackId ? 0.05 : 0.015) };
}
