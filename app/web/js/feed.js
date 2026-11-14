import { h } from "../util.js";

export function createFeed({ mock, media, onLost }) {
  const w = { lastFrame: performance.now(), retry: 0, timer: null, sig: "", probe: null, checkedAt: 0 };
  let el = null;

  const reload = () => {
    if (el) el.src = `/video.mjpg?t=${Date.now()}`;
  };

  const failed = () => {
    w.lastFrame = 0;
    w.stallAt = performance.now();
    w.sig = "";
    clearTimeout(w.timer);
    const wait = Math.min(15000, 1000 * 2 ** w.retry);
    w.retry += 1;
    w.timer = setTimeout(() => {
      w.timer = null;
      reload();
    }, wait);
    onLost();
  };

  const healthy = (now) => (mock ? true : now - w.lastFrame < 3000);

  const check = (now) => {
    if (!el || now - w.checkedAt < 500) return;
    w.checkedAt = now;
    if (el.naturalWidth) {
      try {
        const c = w.probe || (w.probe = Object.assign(document.createElement("canvas"), { width: 12, height: 8 }));
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(el, 0, 0, 12, 8);
        const sig = Array.from(g.getImageData(0, 0, 12, 8).data.filter((_, i) => i % 4 !== 3)).join(",");
        if (sig !== w.sig) {
          w.sig = sig;
          w.lastFrame = now;
          w.retry = 0;
        }
      } catch {
        w.lastFrame = now;
      }
    }
    if (now - Math.max(w.lastFrame, w.stallAt || 0) > 10000 && !w.timer) {
      w.stallAt = now;
      failed();
    }
  };

  if (mock) media.append(mock.video);
  else {
    el = h("img", { src: "/video.mjpg", alt: "Live camera feed", decoding: "async" });
    el.addEventListener("error", failed);
    el.addEventListener("load", () => { w.lastFrame = performance.now(); });
    w.stallAt = performance.now();
    media.append(el);
  }

  return { el, reload, healthy, check, resetBackoff: () => { w.retry = 0; } };
}
