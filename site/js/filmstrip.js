import { CUT } from "./ad/config.js";
import { clamp, ease, lerp, seg } from "./ad/util.js";
import { createStage } from "./ad/stage.js";
import { createFilm } from "./ad/film.js";
import { createOverlay } from "./ad/overlay.js";

const INTRO = 0.95;
const KEYS = [[0, INTRO], [55, CUT.meet], [80, 2.6], [150, 3.9], [170, 4.1], [255, 6.85], [275, 7.05], [380, 9.85], [400, CUT.dissolve], [465, CUT.end]];
const LENGTH = KEYS[KEYS.length - 1][0];
const STILLS = [3.0, 6.6, 9.75];

function timeAt(y) {
  if (y <= 0) return KEYS[0][1];
  for (let i = 1; i < KEYS.length; i++) {
    if (y <= KEYS[i][0]) return lerp(KEYS[i - 1][1], KEYS[i][1], (y - KEYS[i - 1][0]) / (KEYS[i][0] - KEYS[i - 1][0]));
  }
  return KEYS[KEYS.length - 1][1];
}

export async function initFilm({ reduced }) {
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const wrap = $("film");
  const canvas = $("scene");
  const beats = [...document.querySelectorAll("#beats li")];
  await Promise.all(["400 80px 'Young Serif'", "400 40px 'Hanken Grotesk'", "600 40px 'Hanken Grotesk'", "500 70px Caveat"].map((f) => document.fonts.load(f).catch(() => null)));

  let stage;
  let film;
  try {
    root.classList.add(reduced ? "static" : "scrub");
    stage = createStage(canvas);
    film = createFilm(stage);
  } catch (err) {
    root.classList.remove("scrub", "static");
    root.classList.add("nogl");
    return null;
  }

  const wide = () => stage.size.w / stage.size.h > 1.15;
  const shift = (k) => (wide() ? { shiftX: 0.19 * k, shiftY: 0 } : { shiftX: 0, shiftY: 0.15 * k });

  if (reduced) {
    const paint = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      stage.renderer.setPixelRatio(dpr);
      stage.renderer.setSize(720, 540, false);
      stage.size.w = 720;
      stage.size.h = 540;
      beats.forEach((li, i) => {
        const still = li.querySelector("canvas");
        still.width = 720 * dpr;
        still.height = 540 * dpr;
        film.update(STILLS[i], { live: 2.4, px: 0, py: 0, shiftX: 0, shiftY: 0 });
        still.getContext("2d").drawImage(canvas, 0, 0, still.width, still.height);
      });
      stage.resize();
      film.update(INTRO, { live: 2.4, px: 0, py: 0, ...shift(1) });
    };
    paint();
    let timer = 0;
    addEventListener("resize", () => {
      clearTimeout(timer);
      timer = setTimeout(paint, 150);
    });
    return { mode: "static" };
  }

  wrap.style.setProperty("--film-length", String(LENGTH));
  const overlay = createOverlay({ veil: $("veil"), tag: $("chip-tag"), speech: $("chip-speech"), hero: $("hero"), beats, rail: $("rail") });
  const view = { live: 0, px: 0, py: 0, shiftX: 0, shiftY: 0 };
  const pointer = { x: 0, y: 0 };
  const stats = { frames: 0, total: 0, worst: 0 };
  let intro = 0;
  let time = 0;
  let last = 0;
  let raf = 0;
  let visible = true;
  let primed = false;

  const scrollY = () => (-wrap.getBoundingClientRect().top / window.innerHeight) * 100;

  function tick(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    stats.frames++;
    stats.total += dt;
    stats.worst = Math.max(stats.worst, dt);
    view.live += dt;
    intro = Math.min(INTRO, intro + dt);
    const y = clamp(scrollY(), 0, LENGTH);
    const target = timeAt(y) - (INTRO - intro) * (1 - clamp(y / 20));
    const damp = primed ? 1 - Math.exp(-dt * 9) : 1;
    primed = true;
    time += (target - time) * damp;
    view.px += (pointer.x - view.px) * (1 - Math.exp(-dt * 4));
    view.py += (pointer.y - view.py) * (1 - Math.exp(-dt * 4));
    Object.assign(view, shift(1 - ease.inOut(seg(time, INTRO, 1.6))));
    film.update(time, view);
    overlay.update(time, film.anchors);
    raf = requestAnimationFrame(tick);
  }

  function wake() {
    if (raf || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    wake();
  }).observe(wrap);
  document.addEventListener("visibilitychange", wake);
  addEventListener("resize", () => stage.resize());
  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  const jump = (vh) => window.scrollTo({ top: wrap.offsetTop + (vh / 100) * window.innerHeight, behavior: "smooth" });
  document.querySelectorAll('a[href="#how"]').forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    jump(110);
    history.replaceState(null, "", "#how");
  }));
  if (location.hash === "#how") jump(110);

  wake();
  return { mode: "scrub", stats, running: () => !!raf, state: () => ({ time, y: scrollY() }) };
}
