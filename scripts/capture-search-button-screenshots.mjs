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
  if (await byAria.count()) return byAria.first();

  // Strategy 2: explicit testid (future-proof if header gains one)
  const byTestId = page.getByTestId("chat-header-search-button");
  if (await byTestId.count()) return byTestId.first();

  // Strategy 3: SVG search icon in the header toolbar (last resort)
  const magnifier = page
    .locator("header button svg, [class*=header] button svg")
    .filter({ has: page.locator("[data-icon=search], path[d*=\"M15.5\"]") })
    .first();
  if (await magnifier.count()) return magnifier;

  throw new Error(
    "Search button not found — Header did not render (auth gate still blocking?)"
  );
}

async function captureVariant(browser, theme, open) {
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: theme });
  try {
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2500);

    // Set theme via localStorage before reload so the UI matches the requested variant.
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2000);

    const button = await locateSearchButton(page);
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
