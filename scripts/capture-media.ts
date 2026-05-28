/**
 * Captures presentation media from the live app (public surfaces — no auth):
 * full-page screenshots of the landing, showcase (completed review + citation
 * audit), and the evals dashboard, plus a scroll-through video of the showcase
 * for a walkthrough GIF. Run:
 *
 *   PLAYWRIGHT_BASE_URL=https://thoth-slr.vercel.app pnpm tsx scripts/capture-media.ts
 *
 * Then convert the video to a GIF with ffmpeg (see scripts/make-gifs.sh).
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://thoth-slr.vercel.app";
const OUT = path.resolve("docs/assets/media");
const VIDEO_DIR = path.resolve("docs/assets/media/_video");

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // crisp retina screenshots
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();

  const shoot = async (route: string, name: string, fullPage = true) => {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(1800); // let fonts/animations settle
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
    console.log(`✓ ${name}.png  <-  ${route}`);
  };

  await shoot("/", "01-landing");
  await shoot("/showcase", "02-showcase");
  await shoot("/evals", "03-evals");

  // Scroll-through of the showcase (completed review + citation audit) for a GIF.
  await page.goto(`${BASE}/showcase`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1200);
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= height; y += 280) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "instant" as ScrollBehavior }), y);
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(600);

  await ctx.close(); // flushes the recorded video to VIDEO_DIR
  await browser.close();
  console.log(`\n✓ screenshots in ${OUT}\n✓ walkthrough video in ${VIDEO_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
