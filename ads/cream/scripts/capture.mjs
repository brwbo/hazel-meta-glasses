import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const url = arg("url", "http://127.0.0.1:8934/");
const out = arg("out", "out/frames");
const width = Number(arg("width", 1920));
const height = Number(arg("height", 1080));
const times = arg("times", "");
const quality = Number(arg("quality", 95));
const live = process.argv.includes("--live");

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));

await page.goto(live ? url : `${url}${url.includes("?") ? "&" : "?"}export=1`, { waitUntil: "load" });
await page.evaluate(() => window.__ad.ready);

if (live) {
  await page.waitForFunction(() => window.__ad.state() === "ended", null, { timeout: 60000 });
  const s = await page.evaluate(() => window.__ad.stats);
  console.log(JSON.stringify({ frames: s.frames, avgFps: +(s.frames / s.total).toFixed(1), worstFrameMs: +(s.worst * 1000).toFixed(1) }));
  await page.screenshot({ path: join(out, "live-ended.png") });
} else {
  const { duration, fps } = await page.evaluate(() => ({ duration: window.__ad.duration, fps: window.__ad.fps }));
  const list = times ? times.split(",").map(Number) : Array.from({ length: Math.round(duration * fps) }, (_, i) => i / fps);
  for (let i = 0; i < list.length; i++) {
    await page.evaluate((t) => window.__ad.seek(t), list[i]);
    const name = times ? `t${list[i].toFixed(2)}.jpg` : `f${String(i).padStart(5, "0")}.jpg`;
    await page.screenshot({ path: join(out, name), type: "jpeg", quality });
    if (!times && i % 60 === 0) console.log(`frame ${i}/${list.length}`);
  }
  console.log(`captured ${list.length} frames at ${width}x${height}`);
}
console.log(problems.length ? problems.join("\n") : "console: clean");
await browser.close();
