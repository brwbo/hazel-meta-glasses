import { BRAND, DEMO_SRC } from "./config.js";
import { initFilm } from "./filmstrip.js";
import { initDemo } from "./demo.js";
import { initLens } from "./lens.js";

const root = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || new URLSearchParams(location.search).has("still");
root.classList.add("js", reduced ? "static" : "scrub");

document.querySelectorAll("[data-brand]").forEach((el) => {
  const text = BRAND[el.dataset.brand];
  if (!text) return;
  if (el.tagName === "META") el.setAttribute("content", text);
  else el.textContent = text;
});

const demo = initDemo(DEMO_SRC);
const film = initFilm({ reduced });
const lens = initLens({ reduced });

const video = document.getElementById("ad-video");
if (video) {
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting && !video.paused) video.pause();
  }).observe(video);
}

window.__hazel = { demo, film, lens, reduced };
