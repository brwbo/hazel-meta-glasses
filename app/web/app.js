import { h, api } from "./util.js";
import { Overlay, Leader } from "./overlay.js";
import { renderPerson, renderLoading, renderPending } from "./card.js";
import { setupSession } from "./session.js";
import { startMic } from "./mic.js";
import { cropFace } from "./crop.js";

const params = new URLSearchParams(location.search);
let mock = null;
if (params.get("mock") === "1") {
  mock = (await import("./mock.js")).installMock({ lost: params.has("lost"), empty: params.has("empty"), room: params.has("room"), faces: Number(params.get("faces")) || 0 });
}

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const card = $("card");
const cardBody = $("card-body");
const stageMsg = $("stage-msg");
const caption = $("caption");
const live = $("live");
const phone = matchMedia("(max-width: 720px)");
let mic = null;

const state = { clear: new Map(), bustThumb: false, names: new Map(), manual: new Set(), noFacesSince: 0, people: [], sel: null, conn: "connecting", lastDetAt: 0, faces: 0, ws: null, retry: 0, retryAt: 0, retryTimer: null, cardCtx: null };

const overlay = new Overlay({ stage, layer: $("faces"), onPick: pick, onMiss: () => state.sel && clearSel() });
const leader = new Leader($("leader"));
const session = setupSession({
  indicator: $("session-dot"),
  slot: $("session-pop"),
  onWiped: () => {
    clearSel();
    loadPeople();
  },
});
$("card-close").addEventListener("click", () => clearSel());

let feed = null;
if (mock) {
  $("media").append(mock.video);
} else {
  feed = h("img", { src: "/video.mjpg", alt: "Live camera feed", decoding: "async" });
  feed.addEventListener("error", () => setConn("lost"));
  $("media").append(feed);
}

function setConn(next) {
  if (state.conn === next) return;
  state.conn = next;
  live.dataset.state = next;
  $("live-sr").textContent = next === "live" ? "Live" : next === "lost" ? "Camera lost" : "Connecting";
  renderStageMsg();
}

function renderStageMsg() {
  if (state.conn === "lost") {
    const secs = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
    const text = secs ? `No frames from the camera. Retrying in ${secs}s.` : "No frames from the camera. Retrying.";
    if (stageMsg.dataset.kind === "lost") {
      stageMsg.querySelector("p").textContent = text;
      return;
    }
    stageMsg.replaceChildren(
      h("div", { class: "msg-lost", role: "alert" },
        h("h2", { text: "Camera lost" }),
        h("p", { text }),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => reconnect(true) }, h("span", { text: "Reconnect" }))));
    stageMsg.dataset.kind = "lost";
    stageMsg.hidden = false;
  } else if (state.conn === "live" && state.faces === 0 && state.noFacesSince && performance.now() - state.noFacesSince > 2000) {
    if (stageMsg.dataset.kind !== "empty") {
      stageMsg.replaceChildren(h("p", { class: "msg-empty", text: "No faces in view" }));
      stageMsg.dataset.kind = "empty";
    }
    stageMsg.hidden = false;
  } else {
    stageMsg.hidden = true;
    stageMsg.dataset.kind = "";
  }
}

function connect() {
  clearTimeout(state.retryTimer);
  if (state.ws) {
    state.ws.onclose = null;
    try { state.ws.close(); } catch {}
  }
  let ws;
  try {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  } catch {
    return scheduleRetry();
  }
  state.ws = ws;
  ws.onopen = () => { state.retry = 0; };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "detections") onDetections(msg);
    else if (msg.type === "transcript") onTranscript(msg);
    else if (msg.type === "session") session.message(msg);
  };
  ws.onclose = () => {
    setConn("lost");
    scheduleRetry();
  };
}

function scheduleRetry() {
  const wait = Math.min(8000, 1000 * 2 ** state.retry);
  state.retry += 1;
  state.retryAt = Date.now() + wait;
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => reconnect(false), wait);
}

function reconnect(manual) {
  if (manual) state.retry = 0;
  if (feed) feed.src = `/video.mjpg?t=${Date.now()}`;
  setConn("connecting");
  connect();
}

function onDetections(msg) {
  state.lastDetAt = performance.now();
  overlay.setDetections(msg);
  state.faces = (msg.faces || []).length;
  if (state.faces) state.noFacesSince = 0;
  else if (!state.noFacesSince) state.noFacesSince = performance.now();
  setConn(msg.live === false ? "lost" : "live");
  renderStageMsg();
  watchNames(msg.faces || []);
  if (mic) mic.sample(msg.faces || []);
  reconcile();
}

function reconcile() {
  const s = state.sel;
  if (!s) return;
  if (s.trackId != null && overlay.has(s.trackId)) {
    const f = overlay.face(s.trackId);
    if (f.personId !== s.personId) {
      s.personId = f.personId;
      showCard(true);
    }
    if (s.lostAt) reattach();
    return;
  }
  if (s.personId != null) {
    const tr = overlay.findPerson(s.personId);
    if (tr) {
      s.trackId = tr.id;
      reattach();
      return;
    }
  }
  if (!s.lostAt) {
    s.lostAt = performance.now();
    overlay.selected = null;
  }
}

function reattach() {
  const s = state.sel;
  s.lostAt = null;
  overlay.selected = s.trackId;
  card.classList.remove("is-faded");
  if (s.faded) {
    s.faded = false;
    showCard();
  }
  leader.draw();
}

function pick(trackId) {
  const f = overlay.face(trackId);
  if (!f) return;
  overlay.cursor = trackId;
  const s = state.sel;
  if (s && s.trackId === trackId && !s.faded && !s.lostAt) return;
  state.sel = { trackId, personId: f.personId, lostAt: null, faded: false, pendingAt: performance.now(), slow: false };
  overlay.selected = trackId;
  showCard();
  leader.draw();
}

let hideTimer = null;
function openCard() {
  clearTimeout(hideTimer);
  card.style.transform = "";
  card.classList.remove("is-faded");
  if (card.hidden) {
    card.hidden = false;
    card.getBoundingClientRect();
  }
  if (!card.classList.contains("is-open")) glitch();
  card.classList.add("is-open");
  document.body.classList.add("has-card");
}

function glitch() {
  card.classList.remove("is-glitch");
  card.getBoundingClientRect();
  card.classList.add("is-glitch");
  setTimeout(() => card.classList.remove("is-glitch"), 400);
}

function closeCard() {
  card.classList.remove("is-open");
  document.body.classList.remove("has-card");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!card.classList.contains("is-open")) card.hidden = true;
  }, 320);
}

function clearSel() {
  state.sel = null;
  state.cardCtx = null;
  overlay.selected = null;
  leader.hide();
  closeCard();
}

async function showCard(quiet) {
  const s = state.sel;
  if (!s) {
    state.cardCtx = null;
    return closeCard();
  }
  openCard();
  if (s.personId == null) {
    state.cardCtx = null;
    if (!s.snapshot) s.snapshot = cropFace(overlay, s.trackId, mock ? mock.video : feed);
    renderPending(cardBody, { snapshot: s.snapshot, slow: s.slow });
    return;
  }
  const id = s.personId;
  if (!quiet) renderLoading(cardBody);
  try {
    const p = await api.person(id);
    if (state.bustThumb) {
      p.thumbUrl = bust(p.thumbUrl);
      state.bustThumb = false;
    }
    if (!state.sel || state.sel.personId !== id || state.sel.faded) return;
    let ctx = state.cardCtx;
    if (!ctx || ctx.personId !== id) {
      ctx = {
        personId: id,
        tab: "data",
        tracking: true,
        refresh: (tab) => {
          if (tab) state.cardCtx.tab = tab;
          showCard(true);
        },
        renamed: () => {
          state.manual.add(id);
          loadPeople();
        },
        deleted: () => {
          clearSel();
          loadPeople();
        },
        onTracking: () => {},
      };
      state.cardCtx = ctx;
    }
    renderPerson(cardBody, p, ctx);
    updateCardStatus(true);
  } catch (err) {
    if (!state.sel || state.sel.personId !== id) return;
    cardBody.replaceChildren(
      h("div", { class: "card-error", role: "alert" },
        h("p", { class: "form-error", text: `Could not load this profile. ${err.message}` }),
        h("button", { type: "button", class: "btn", onclick: () => showCard() }, h("span", { text: "Try again" }))));
  }
}

function showCaption(parts) {
  caption.replaceChildren(...parts);
  caption.classList.add("is-on");
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => caption.classList.remove("is-on"), 4500);
}

function bust(url) {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

let liveTick = 0;
function updateLiveThumb(now) {
  const img = cardBody.querySelector("img[data-live]");
  const s = state.sel;
  if (!img || !s || s.trackId == null || now - liveTick < 400) return;
  liveTick = now;
  const url = cropFace(overlay, s.trackId, mock ? mock.video : feed);
  if (url) {
    img.src = url;
    if (state.cardCtx) state.cardCtx.liveThumb = url;
  }
}

function watchClear(faces) {
  for (const f of faces) {
    if (f.personId == null || typeof f.thumbClear !== "boolean") continue;
    const before = state.clear.get(f.personId);
    state.clear.set(f.personId, f.thumbClear);
    if (before === false && f.thumbClear && state.sel && state.sel.personId === f.personId) {
      state.bustThumb = true;
      showCard(true);
    }
  }
}

function watchNames(faces) {
  watchClear(faces);
  for (const f of faces) {
    if (f.personId == null || !f.name) continue;
    const before = state.names.get(f.personId);
    state.names.set(f.personId, f.name);
    if (before === undefined || before === f.name) continue;
    if (state.manual.has(f.personId)) {
      state.manual.delete(f.personId);
      continue;
    }
    showCaption([h("span", { class: "caption-who", text: "named:" }), h("span", { class: "caption-text", text: f.name })]);
    loadPeople();
    if (state.sel && state.sel.personId === f.personId) showCard(true);
  }
}

let statusTick = 0;
function updateCardStatus(force) {
  const ctx = state.cardCtx;
  const s = state.sel;
  if (!ctx || !ctx.setStatus || !s) return;
  const now = performance.now();
  if (!force && now - statusTick < 300) return;
  statusTick = now;
  const inView = s.trackId != null && !s.lostAt && overlay.has(s.trackId);
  ctx.setStatus(inView ? "Target in view" : "Target lost", inView);
}

async function loadPeople() {
  try {
    const list = await api.people();
    state.people = Array.isArray(list) ? list : [];
    session.setPeople(state.people.length);
  } catch {
    state.people = state.people || [];
  }
}

let captionTimer = null;
function onTranscript(m) {
  if (!m.text) return;
  const person = state.people.find((p) => p.id === m.personId);
  const parts = [h("span", { class: "caption-text", text: m.text })];
  if (person) parts.unshift(h("span", { class: "caption-who", text: person.name }));
  caption.replaceChildren(...parts);
  caption.classList.add("is-on");
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => caption.classList.remove("is-on"), 4500);
}

function isTyping(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!isTyping(e.target)) clearSel();
    return;
  }
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const keys = state.cardCtx && card.classList.contains("is-open") ? state.cardCtx.keys : null;
  if (keys) {
    const k = e.key.toLowerCase();
    if (k === "1" || k === "2" || k === "3") {
      e.preventDefault();
      return keys.tab(["data", "notes", "model"][Number(k) - 1]);
    }
    if (k === "r") {
      e.preventDefault();
      return keys.rename();
    }
    if (k === "e") {
      e.preventDefault();
      return keys.edit();
    }
    if (k === "x") {
      e.preventDefault();
      return keys.del();
    }
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const list = overlay.ordered();
    if (!list.length) return;
    e.preventDefault();
    let i = list.findIndex((t) => t.id === overlay.cursor);
    if (i < 0) i = e.key === "ArrowRight" ? -1 : list.length;
    i = (i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
    overlay.cursor = list[i].id;
    overlay.focus(list[i].id);
  } else if (e.key === "Enter" && e.target.tagName !== "BUTTON" && overlay.cursor != null) {
    e.preventDefault();
    pick(overlay.cursor);
  }
});

const grip = $("grip");
let drag = null;
grip.addEventListener("pointerdown", (e) => {
  drag = { y: e.clientY, dy: 0 };
  grip.setPointerCapture(e.pointerId);
  card.classList.add("is-dragging");
});
grip.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.dy = Math.max(0, e.clientY - drag.y);
  card.style.transform = `translateY(${drag.dy}px)`;
});
const endDrag = () => {
  if (!drag) return;
  card.classList.remove("is-dragging");
  const far = drag.dy > 90;
  drag = null;
  card.style.transform = "";
  if (far) clearSel();
};
grip.addEventListener("pointerup", endDrag);
grip.addEventListener("pointercancel", endDrag);

let last = performance.now();
let lastSec = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  overlay.frame(dt);
  const s = state.sel;
  if (s && s.personId == null && !s.slow && now - s.pendingAt > 6000) {
    s.slow = true;
    showCard();
  }
  if (s && s.lostAt && !s.pinned && !s.faded && now - s.lostAt > 2000) {
    if (s.personId == null) clearSel();
    else {
      card.classList.add("is-faded");
      if (now - s.lostAt > 2400) {
        s.faded = true;
        closeCard();
      }
    }
  }
  const tracking = !state.cardCtx || state.cardCtx.tracking !== false;
  overlay.targeting = tracking;
  const anchor = cardBody.querySelector("[data-anchor]");
  let ar = anchor && anchor.offsetParent ? anchor.getBoundingClientRect() : null;
  const head = s && s.trackId != null ? overlay.clientRect(s.trackId) : null;
  const cr = card.getBoundingClientRect();
  if (ar && phone.matches) ar = { left: ar.left, width: ar.width, top: cr.top + 4, height: 1, right: ar.right };
  if (head && !phone.matches && card.classList.contains("is-open")) {
    const cx = head.x + head.w / 2;
    const right = card.classList.contains("dock-right");
    if (cx > cr.left - 24 && cx < cr.right + 24) {
      card.classList.toggle("dock-right", !right);
      document.body.classList.toggle("dock-right", !right);
    }
  }
  const covered = head && (phone.matches ? head.y + head.h > cr.top - 8 : head.x + head.w / 2 > cr.left && head.x + head.w / 2 < cr.right);
  if (s && !s.faded && !s.lostAt && head && ar && ar.height && !drag && tracking && !covered && card.classList.contains("is-open")) {
    leader.update(head, ar, phone.matches, card.classList.contains("dock-right"));
  } else {
    leader.hide();
  }
  updateCardStatus(false);
  updateLiveThumb(now);
  if (state.conn === "live" && now - state.lastDetAt > 3000) {
    setConn("lost");
    scheduleRetry();
  }
  const sec = Math.floor(now / 1000);
  if (sec !== lastSec) {
    lastSec = sec;
    if (state.conn === "lost") renderStageMsg();
  }
  requestAnimationFrame(frame);
}

loadPeople();
session.refresh();
if (!params.has("nomic")) mic = startMic($("mic"));
setInterval(loadPeople, 15000);
connect();
requestAnimationFrame(frame);
