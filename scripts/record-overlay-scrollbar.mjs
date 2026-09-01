#!/usr/bin/env node
/**
 * Record an interaction GIF for the overlay scrollbar (PR #3219).
 *
 * Captures: hover onto a scrollable container -> thumb fades in ->
 * mouse leaves -> thumb fades out (after hideDelayMs).
 *
 * Output: ./screenshots/overlay-scrollbar-hover.gif
 * Side-effects: the .webm from Playwright recordVideo is renamed to
 * overlay-scrollbar-hover.webm in the same directory. The .gif is
 * produced with ffmpeg if available; otherwise the script aborts
 * (the workflow's "Install ffmpeg" step must run first).
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync, renameSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const BASE_URL  = process.env.BASE_URL  ?? "http://127.0.0.1:3001";
const OUT_DIR   = process.env.OUT_DIR   ?? path.resolve("screenshots");
const VIDEO_DIR = process.env.VIDEO_DIR ?? path.join(OUT_DIR, ".video");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(VIDEO_DIR, { recursive: true });

const VIEWPORT = { width: 1280, height: 720 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureOverflow(page) {
  // Make sure at least one .overlay-scrollbar-target has scrollable content.
  // On a clean data dir the sidebar is empty; we inject filler children
  // until the container actually overflows. The injected content is
  // removed by the page close; it never reaches the user.
  await page.evaluate(() => {
    const targets = Array.from(
      document.querySelectorAll(".overlay-scrollbar-target")
    );
    for (const t of targets) {
      if (t.scrollHeight > t.clientHeight) continue;
      const filler = document.createElement("div");
      filler.style.height = `${Math.max(t.clientHeight * 2, 600)}px`;
      filler.style.width = "100%";
      filler.setAttribute("data-testid", "scrollbar-demo-filler");
      t.appendChild(filler);
    }
  });
}

// On a fresh data dir the web build can render onboarding modals
// (ChooserScreen / LocalSetupScreen / AboutDialog / ConfigUpdateOverlay)
// that float above the MainLayout with a blurred backdrop. They do NOT
// block the DOM the thumb is mounted on, so isThumbVisible() returns true
// while the GIF is being recorded, but the captured frame is dominated
// by the modal — the user sees "dialog in front, blurred background"
// instead of the scrollbar reveal. We hide every plausible overlay root
// before recording. Hidden overlays have no effect on the thumb's
// visibility (which is independent of its parents' display).
async function hideOverlayChrome(page) {
  await page.addStyleTag({
    content: `
      [data-slot="dialog-overlay"],
      [data-slot="dialog-content"],
      [role="dialog"],
      [data-state="open"][data-slot="dialog-overlay"],
      .oc-glass-backdrop,
      .fixed.inset-0.z-50,
      .fixed.inset-0.z-\\[9999\\] {
        display: none !important;
      }
      body * { animation: none !important; }
    `,
  });
  await page.evaluate(() => {
    try {
      const w = /** @type {any} */ (window);
      const store = w.__OPENCHAMBER_UI_STORE__;
      if (store && typeof store.setState === "function") {
        store.setState({
          isAboutDialogOpen: false,
          isHelpDialogOpen: false,
          isSettingsDialogOpen: false,
          isOpenCodeStatusDialogOpen: false,
          isSessionCreateDialogOpen: false,
          isScheduledTasksDialogOpen: false,
          isNewWorktreeDialogOpen: false,
          isTimelineDialogOpen: false,
        });
      }
    } catch { /* ignore */ }
  });
}

async function isThumbVisible(page) {
  return page.evaluate(() => {
    const thumb = document.querySelector(
      '[data-overlay-scrollbar-thumb="vertical"]'
    );
    return !!thumb && !thumb.hasAttribute("hidden");
  });
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();
  try {
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 60000 });
    await wait(1500);
    await ensureOverflow(page);
    await hideOverlayChrome(page);
    await wait(400);

    // Idle state: thumb should be hidden.
    const idleVisible = await isThumbVisible(page);
    console.log(`thumb visible at idle: ${idleVisible}`);

    // Hover-reveal is only meaningful on a container whose overlay thumb can
    // appear. Try each .overlay-scrollbar-target in DOM order until the thumb
    // shows; layout/hydration order can vary between runs, so this removes the
    // flakiness of "the first target is the wrong one".
    const targets = await page.locator(".overlay-scrollbar-target").all();
    if (targets.length === 0) {
      throw new Error("no .overlay-scrollbar-target mounted on the page");
    }

    let revealed = false;
    for (const t of targets) {
      const box = await t.boundingBox();
      if (!box) continue;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await wait(1500);
      if (await isThumbVisible(page)) {
        revealed = true;
        console.log(
          `hover revealed thumb on target ${targets.indexOf(t)} ` +
          `(box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)})`
        );
        break;
      }
    }

    const visibleAfterHover = revealed;
    console.log(`thumb visible after hover: ${visibleAfterHover}`);
    if (!visibleAfterHover) {
      throw new Error("hover did not reveal the thumb on any target — check selector");
    }

    // Hold the hover for a moment so the GIF has a "thumb-shown" plateau.
    await wait(900);

    // Move pointer OUT -> thumb fades (after hideDelayMs=1000).
    await page.mouse.move(20, 20, { steps: 8 });
    await wait(1500);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Rename the .webm to a stable filename.
  const vids = readdirSync(VIDEO_DIR).filter((f) => f.endsWith(".webm"));
  if (vids.length === 0) throw new Error("no .webm produced by Playwright");
  const webmOut = path.join(OUT_DIR, "overlay-scrollbar-hover.webm");
  renameSync(path.join(VIDEO_DIR, vids[0]), webmOut);
  console.log(`webm -> ${webmOut}`);

  // Convert webm to gif with ffmpeg. Two-pass: palettegen + paletteuse
  // for a clean 64-colour GIF.
  const gifOut = path.join(OUT_DIR, "overlay-scrollbar-hover.gif");
  const paletteFile = path.join(OUT_DIR, ".palette.png");
  try {
    execSync(
      `ffmpeg -y -i "${webmOut}" -vf "fps=15,scale=720:-1:flags=lanczos,palettegen=max_colors=64" "${paletteFile}"`,
      { stdio: "inherit" }
    );
    execSync(
      `ffmpeg -y -i "${webmOut}" -i "${paletteFile}" -lavfi "fps=15,scale=720:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4" "${gifOut}"`,
      { stdio: "inherit" }
    );
    console.log(`gif -> ${gifOut}`);
  } catch (e) {
    console.error("ffmpeg conversion failed — is ffmpeg installed on the runner?");
    throw e;
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});

