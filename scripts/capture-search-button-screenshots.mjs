#!/usr/bin/env node
/**
 * Capture the 4 search-button screenshots (light/dark x closed/open).
 *
 * Uses aria-label="Open message search" (English i18n) to locate the button.
 * Falls back to a broad SVG search inside the header if aria-label is missing.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3001";
const OUT_DIR  = process.env.OUT_DIR  ?? path.resolve("screenshots");
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORT = { width: 1280, height: 720 };

async function locateSearchButton(page) {
  // Strategy 1: aria-label from i18n (English "Open message search")
  const byAria = page.getByRole("button", { name: "Open message search" });
  try {
    await byAria.first().waitFor({ state: "visible", timeout: 20000 });
    return byAria.first();
  } catch (e) {
    console.log("[locate] aria strategy failed:", e.message.split("\n")[0]);
    const headerButtons = await page
      .locator("header button")
      .count()
      .catch(() => "ERR");
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "ERR");
    console.log("[locate] header button count:", headerButtons);
    console.log("[locate] body text (first 200):", bodyText.slice(0, 200));
  }

  // Strategy 2: explicit testid (future-proof if header gains one)
  const byTestId = page.getByTestId("chat-header-search-button");
  try {
    await byTestId.first().waitFor({ state: "visible", timeout: 5000 });
    return byTestId.first();
  } catch {}

  // Strategy 3: SVG search icon in the header toolbar (last resort)
  const magnifier = page
    .locator("header button svg, [class*=header] button svg")
    .filter({ has: page.locator("[data-icon=search], path[d*=\"M15.5\"]") })
    .first();
  try {
    await magnifier.waitFor({ state: "visible", timeout: 5000 });
    return magnifier;
  } catch {}

  throw new Error(
    "Search button not found — Header did not render (auth gate still blocking?)"
  );
}

async function captureVariant(browser, theme, open) {
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: theme });
  try {
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2500);

    // Reset theme + any persisted dialog state before reload so each capture
    // starts from a known-closed baseline (the dark/closed capture was
    // inheriting isTimelineDialogOpen=true from the prior light/open run).
    await page.evaluate((t) => {
      localStorage.setItem("theme", t);
      // zustand persist key is "ui-store"; force isTimelineDialogOpen=false
      // without nuking other persisted prefs.
      try {
        const raw = localStorage.getItem("ui-store");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.state) {
            parsed.state.isTimelineDialogOpen = false;
            localStorage.setItem("ui-store", JSON.stringify(parsed));
          }
        }
      } catch {}
    }, theme);
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(8000);

    let button = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        button = await locateSearchButton(page);
        break;
      } catch (err) {
        console.log(`[capture] attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) throw err;
        await page.reload({ waitUntil: "load", timeout: 60000 });
        await page.waitForTimeout(4000);
      }
    }
    await button.scrollIntoViewIfNeeded();
    if (open) {
      await button.click();
      await page.waitForTimeout(1200); // panel animation
    } else {
      await page.waitForTimeout(400);
    }

    const filename = `search-button-${theme}-${open ? "open" : "closed"}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, filename) });
    console.log(`OK ${filename}`);
  } catch (err) {
    console.error(`FAIL ${theme}/${open}:`, err.message);
    process.exitCode = 1;
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  await captureVariant(browser, theme, false);
  await captureVariant(browser, theme, true);
}
await browser.close();
console.log("Done. Screenshots in " + OUT_DIR);
