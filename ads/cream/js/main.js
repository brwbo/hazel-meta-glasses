import { DURATION, FPS, POSTER_TIME } from "./config.js";
import { clamp } from "./util.js";
import { createStage } from "./stage.js";
import { createFilm } from "./film.js";
import { createOverlay } from "./overlay.js";

const params = new URLSearchParams(location.search);
const exportMode = params.has("export");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
const stageEl = document.getElementById("stage");
const bigplay = document.getElementById("bigplay");
const bigLabel = document.getElementById("bigplay-label");
const controls = document.getElementById("controls");
const toggle = document.getElementById("toggle");
const replay = document.getElementById("replay");
const scrub = document.getElementById("scrub");

const stats = { frames: 0, total: 0, worst: 0 };
let time = 0;
let state = "static";
let last = 0;
let raf = 0;
let film;
let overlay;
let stage;

function draw() {
  film.update(time);
  overlay.update(time, film.anchors);
  scrub.value = time.toFixed(2);
}

function setState(next) {
  state = next;
  stageEl.dataset.state = next;
  toggle.setAttribute("aria-label", next === "playing" ? "Pause" : "Play");
  const labels = { poster: "Play film", paused: "Resume", ended: "Replay" };
  bigplay.hidden = exportMode || !labels[next];
  if (labels[next]) bigLabel.textContent = labels[next];
}

function tick(now) {
  if (state !== "playing") return;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  stats.frames++;
  stats.total += dt;
  stats.worst = Math.max(stats.worst, dt);
  time += dt;
  if (time >= DURATION) {
    time = DURATION;
    draw();
    setState("ended");
    return;
  }
  draw();
  raf = requestAnimationFrame(tick);
}

function play(from) {
  if (from !== undefined) time = from;
  if (time >= DURATION) time = 0;
  cancelAnimationFrame(raf);
  setState("playing");
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

function pause() {
  if (state !== "playing") return;
  cancelAnimationFrame(raf);
  setState("paused");
}

function seek(t) {
  time = clamp(t, 0, DURATION);
  draw();
}

function bind() {
  toggle.addEventListener("click", () => (state === "playing" ? pause() : play(state === "poster" ? 0 : undefined)));
  replay.addEventListener("click", () => play(0));
  bigplay.addEventListener("click", () => play(state === "paused" ? undefined : 0));
  scrub.addEventListener("input", () => {
    if (state === "playing") pause();
    seek(Number(scrub.value));
    if (state !== "paused") setState("paused");
  });
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.target.closest("button, input")) return;
    e.preventDefault();
    if (state === "playing") pause();
    else play(state === "paused" ? undefined : 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  addEventListener("resize", () => {
    stage.resize();
    if (state !== "playing") draw();
  });
}

async function boot() {
  root.classList.add("js");
  if (exportMode) root.classList.add("export");
  scrub.max = String(DURATION);
  await Promise.all(["400 80px 'Young Serif'", "400 40px 'Hanken Grotesk'", "600 40px 'Hanken Grotesk'", "500 70px Caveat"].map((f) => document.fonts.load(f)));
  stage = createStage(document.getElementById("scene"), { exportMode });
  film = createFilm(stage);
  overlay = createOverlay();
  controls.hidden = false;
  bind();
  if (exportMode) {
    setState("paused");
    seek(0);
  } else if (reduced) {
    setState("poster");
    seek(POSTER_TIME);
  } else {
    seek(0);
    play(0);
  }
}

const ready = boot();
window.__ad = {
  ready,
  duration: DURATION,
  fps: FPS,
  stats,
  seek: async (t) => {
    await ready;
    seek(t);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
  play: () => play(0),
  state: () => state,
};
