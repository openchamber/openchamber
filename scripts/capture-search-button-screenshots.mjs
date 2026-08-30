#!/usr/bin/env node
/**
 * Capture the 4 search-button screenshots (light/dark × closed/open).
 *
 * Runs against a local server where UI auth is DISABLED (no password
 * configured in OPENCHAMBER_DATA_DIR), so SessionAuthGate auto-authenticates
 * via { authenticated: true, disabled: true } and the Header renders.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3001 OUT_DIR=./screenshots node capture-search-button-screenshots.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3001";
const OUT_DIR = process.env.OUT_DIR ?? path.resolve("screenshots");
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORT = { width: 1280, height: 720 };

/** Find the search (magnifier) button in the header, or fail loudly. */
async function locateSearchButton(page) {
  // Try the explicit test-id first (kept in sync with Header.tsx).
  const byTestId = page.getByTestId("chat-header-search-button");
  if (await byTestId.count()) return byTestId.first();

  // Fallback: magnifier icon inside the header toolbar.
  const magnifier = page
    .locator("[data-chat-header] svg, header svg, [class*=\"header\"] svg")
    .filter({ has: page.locator("path") })
    .first();
  if (await magnifier.count()) return magnifier;

  throw new Error("Search button not found — Header did not render (auth gate still blocking?)");
}

async function captureVariant(browser, theme, open) {
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: theme });
  try {
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2500); // allow SPA mount + session check

    // Apply theme via localStorage before reload so the UI matches the requested variant.
    await page.evaluate((t) => {
      localStorage.setItem("theme", t);
    }, theme);
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2000);

    const button = await locateSearchButton(page);
    await button.scrollIntoViewIfNeeded();
    if (open) {
      await button.click();
      await page.waitForTimeout(1200); // panel/modal animation
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
console.log(`Done. Screenshots in ${OUT_DIR}`);
