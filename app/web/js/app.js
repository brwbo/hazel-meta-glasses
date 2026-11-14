import { h, api, reducedMotion } from "../util.js";
import { setupSession } from "../session.js";
import { startMic } from "../mic.js";
import { cropFace } from "../crop.js";
import { setupControls } from "../controls.js";
import { Lips } from "../lips.js";
import { CreamOverlay } from "./overlay.js";
import { renderPerson, renderLoading, renderPending, hear } from "./card.js";
import { createWorld } from "./gl/world.js";
import { createFlakes } from "./gl/flakes.js";
import { createBrackets } from "./gl/brackets.js";
import { createCardRig } from "./gl/card-rig.js";
import { createFeed } from "./feed.js";
import { initLibrary } from "./library.js";

document.documentElement.classList.add("js");
const params = new URLSearchParams(location.search);
let mock = null;
if (params.get("mock") === "1") {
  mock = (await import("../mock.js")).installMock({ lost: params.has("lost"), empty: params.has("empty"), room: params.has("room"), faces: Number(params.get("faces")) || 0, mouth: params.get("mouth"), talk: params.get("talk"), stt: params.get("stt") });
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

const overlay = new CreamOverlay({ stage, layer: $("faces"), onPick: pick, onMiss: () => state.sel && clearSel() });
await Promise.all(["600 15px 'Hanken Grotesk'", "400 16px 'Hanken Grotesk'", "400 28px 'Young Serif'", "500 26px Caveat"].map((f) => document.fonts.load(f).catch(() => null)));
const world = createWorld({ canvas: $("gl"), layer: $("css3d") });
const flakes = createFlakes(world.scene);
const bracketFlakes = new Proxy(flakes, { get: (t, k) => (k === "scatter" && reducedMotion() ? () => {} : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
const brackets = createBrackets({ world, overlay, flakes: bracketFlakes });
const rig = createCardRig({ world, flakes, wrapper: $("card3d"), card });
window.__cream = { world, flakes };
const session = setupSession({
  indicator: $("session-dot"),
  slot: $("session-pop"),
  onInfo: showStt,
  onWiped: () => {
    clearSel();
    loadPeople();
  },
});
$("card-close").addEventListener("click", () => clearSel());

function showStt(info) {
  let chip = $("stt");
  if (!chip) {
    chip = h("span", { id: "stt", class: "stt-chip", hidden: true, tabindex: 0 });
    Object.assign(chip.style, { fontSize: "var(--text-xs, 12px)", fontWeight: "600", color: "var(--color-muted)", paddingLeft: "8px", marginLeft: "2px", borderLeft: "1px solid currentColor", lineHeight: "1", whiteSpace: "nowrap", cursor: "help" });
    live.append(chip);
  }
  if (!info) return;
  const where = info.stt === "gemini" || info.cloudSpeech === true ? "cloud" : info.stt === "local" || info.cloudSpeech === false ? "local" : null;
  chip.hidden = !where;
  if (!where) return;
  chip.textContent = `speech: ${where}`;
  chip.setAttribute("aria-label", `Speech is transcribed ${where === "cloud" ? "in the cloud" : "on this machine"}`);
  placeCorner();
  chip.title = where === "cloud"
    ? "Short clips of speech from the person in view are sent to a cloud speech service (Gemini) to be transcribed. Video stays on this device."
    : "Speech is transcribed on this machine. Audio does not leave it.";
}

function placeCorner() {
  const corner = document.querySelector(".corner");
  if (!corner) return;
  corner.style.left = `${Math.round(live.getBoundingClientRect().right + 8)}px`;
}
addEventListener("resize", placeCorner);

const feedCtl = createFeed({ mock, media: $("media"), onLost: () => setConn("lost") });
const feed = feedCtl.el;
const reloadFeed = feedCtl.reload;
const feedHealthy = feedCtl.healthy;
const checkFeed = feedCtl.check;

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
      stageMsg.replaceChildren(h("div", { class: "msg-empty" }, h("h2", { text: "No one in view" }), h("p", { text: "Look towards someone and their card is one tap away." })));
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
  ws.onopen = () => {
    clearTimeout(state.stableTimer);
    state.stableTimer = setTimeout(() => { if (state.ws === ws && ws.readyState === 1) state.retry = 0; }, 5000);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "detections") onDetections(msg);
    else if (msg.type === "transcript") onTranscript(msg);
    else if (msg.type === "session") session.message(msg);
  };
  ws.onclose = () => {
    clearTimeout(state.stableTimer);
    setConn("lost");
    scheduleRetry();
  };
}

function scheduleRetry() {
  const wait = Math.min(15000, 1000 * 2 ** state.retry);
  state.retry += 1;
  state.retryAt = Date.now() + wait;
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => reconnect(false), wait);
}

function reconnect(manual) {
  if (manual) {
    state.retry = 0;
    feedCtl.resetBackoff();
  }
  reloadFeed();
  setConn("connecting");
  connect();
}

function onDetections(msg) {
  state.lastDetAt = performance.now();
  overlay.setDetections(msg);
  state.faces = (msg.faces || []).length;
  if (state.faces) state.noFacesSince = 0;
  else if (!state.noFacesSince) state.noFacesSince = performance.now();
  setConn(msg.live === false || !feedHealthy(performance.now()) ? "lost" : "live");
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
    const now = performance.now();
    if (f.personId != null && f.personId !== s.personId) {
      if (s.personId == null) {
        s.personId = f.personId;
        s.swap = null;
        showCard(true);
      } else if (!s.swap || s.swap.id !== f.personId) {
        s.swap = { id: f.personId, since: now };
      } else if (now - s.swap.since > 1500) {
        s.personId = f.personId;
        s.swap = null;
        showCard(true);
      }
    } else s.swap = null;
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
}

function pick(trackId) {
  const f = overlay.face(trackId);
  if (!f) return;
  overlay.cursor = trackId;
  const s = state.sel;
  if (s && s.trackId === trackId && !s.faded && !s.lostAt) return;
  rig.dissolve();
  state.sel = { trackId, personId: f.personId, lostAt: null, faded: false, pendingAt: performance.now(), slow: false };
  overlay.selected = trackId;
  state.replay = true;
  state.returnTo = trackId;
  showCard();
  requestAnimationFrame(() => {
    if (!card.hidden && !card.contains(document.activeElement)) $("card-close").focus({ preventScroll: true });
  });
}

const library = initLibrary();

function openCard() {
  rig.open({ replay: state.replay });
  state.replay = false;
}

function closeCard() {
  rig.close();
}

function clearSel() {
  const back = state.returnTo;
  const hadFocus = card.contains(document.activeElement);
  state.sel = null;
  state.cardCtx = null;
  state.returnTo = null;
  overlay.selected = null;
  closeCard();
  if (hadFocus && back != null && overlay.has(back)) overlay.focus(back);
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
        tracking: true,
        refresh: () => showCard(true),
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
  ctx.setStatus(inView ? "In view" : "Out of view", inView);
}

async function loadPeople() {
  try {
    const list = await api.people();
    state.people = Array.isArray(list) ? list : [];
    session.setPeople(state.people.length);
    try { library.refresh(); } catch {}
    const ids = new Set(state.people.map((p) => String(p.id)));
    try {
      for (const k of Object.keys(localStorage)) {
        const m = /^fc\.[a-z]+\.(\d+)$/.exec(k);
        if (m && !ids.has(m[1])) localStorage.removeItem(k);
      }
    } catch {}
  } catch {
    state.people = state.people || [];
  }
}

let captionTimer = null;
let heardTimer = null;
function onTranscript(m) {
  if (!m.text) return;
  const ctx = state.cardCtx;
  if (ctx && m.personId != null && m.personId === ctx.personId && card.classList.contains("is-open")) {
    hear(ctx, m.text);
    clearTimeout(heardTimer);
    heardTimer = setTimeout(() => {
      if (state.cardCtx === ctx && !ctx.editing && !card.contains(document.activeElement)) showCard(true);
    }, 3000);
  }
  const person = state.people.find((p) => p.id === m.personId);
  const parts = [h("span", { class: "caption-text", text: m.text })];
  if (person) parts.unshift(h("span", { class: "caption-who", text: person.name }));
  caption.replaceChildren(...parts);
  caption.classList.add("is-on");
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => caption.classList.remove("is-on"), 4500);
}

const controls = setupControls({ overlay, card, grip: $("grip"), getKeys: () => (state.cardCtx && card.classList.contains("is-open") ? state.cardCtx.keys : null), pick, clearSel });

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
  const head = s && s.trackId != null && !s.lostAt ? overlay.clientRect(s.trackId) : null;
  world.setPhone(phone.matches);
  world.frame(dt, now);
  brackets.update(dt, now);
  rig.update(dt, now, { head, isPhone: phone.matches, dragging: controls.dragging() });
  flakes.update(now);
  world.render(dt);
  updateCardStatus(false);
  updateLiveThumb(now);
  checkFeed(now);
  if (state.conn === "live" && !feedHealthy(now)) setConn("lost");
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
if (!params.has("nomic")) {
  const lips = new Lips({ overlay, source: mock ? mock.video : feed, measure: mock ? mock.mouth : null });
  mic = startMic($("mic"), { lips });
  window.__lips = params.has("debug") ? lips : undefined;
}
setInterval(loadPeople, 15000);
connect();
requestAnimationFrame(frame);
