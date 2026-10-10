// Renders the video stage frame by frame. Every frame is a pure function of time, so the
// output is identical on every run. Usage: node video/render-frames.mjs <frames-dir> [fps]
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(new URL("../../demo-form/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const [outDir, fpsArg] = process.argv.slice(2);
if (outDir === undefined) throw new Error("Usage: node video/render-frames.mjs <frames-dir> [fps]");
const fps = Number(fpsArg ?? 30);
const base = process.env.SITE_URL ?? "http://127.0.0.1:4321";

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${base}/video/stage.html`);
await page.waitForFunction(() => window.ready === true);
const duration = await page.evaluate(() => window.DURATION);
const total = Math.round(duration * fps);
for (let frame = 0; frame < total; frame += 1) {
  await page.evaluate((t) => window.render(t), frame / fps);
  await page.screenshot({ path: path.join(outDir, `${String(frame).padStart(5, "0")}.png`) });
  if (frame % 150 === 0) console.log(`frame ${frame}/${total}`);
}
await browser.close();
console.log(`Rendered ${total} frames at ${fps} fps.`);
