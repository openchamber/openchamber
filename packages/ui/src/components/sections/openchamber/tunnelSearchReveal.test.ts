import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { displayedTunnelMode, isTunnelSearchRevealMode, tunnelSearchRevealModeForResult } from "./tunnelSearchReveal";

// Oracle: the acceptance criteria of #1764 — picking either managed tunnel
// search result reveals its section, and the reveal never persists a mode
// change the user did not confirm.
describe("tunnel search reveal (#1764)", () => {
  test("maps both managed search results to the mode their section renders under", () => {
    expect(tunnelSearchRevealModeForResult("tunnel.managed-remote")).toBe("managed-remote");
    expect(tunnelSearchRevealModeForResult("tunnel.managed-local-config")).toBe("managed-local");
  });

  test("leaves every other tunnel result (and every other page) unrevealed", () => {
    for (const id of ["tunnel.provider", "tunnel.type", "tunnel.start", "tunnel.ttl", "providers.classification", "agents.create"]) {
      expect(tunnelSearchRevealModeForResult(id)).toBeNull();
    }
  });

  test("the displayed mode is the revealed mode, whatever the saved mode is", () => {
    for (const saved of ["quick", "managed-remote", "managed-local"]) {
      expect(displayedTunnelMode(saved, "managed-remote")).toBe("managed-remote");
      expect(displayedTunnelMode(saved, "managed-local")).toBe("managed-local");
    }
  });

  test("with no reveal pending the displayed mode is the saved mode (no behaviour change)", () => {
    for (const saved of ["quick", "managed-remote", "managed-local"]) {
      expect(displayedTunnelMode(saved, null)).toBe(saved);
    }
  });

  test("only the two managed modes are valid reveal values from the store", () => {
    expect(isTunnelSearchRevealMode("managed-remote")).toBe(true);
    expect(isTunnelSearchRevealMode("managed-local")).toBe(true);
    expect(isTunnelSearchRevealMode("quick")).toBe(false);
    expect(isTunnelSearchRevealMode(null)).toBe(false);
  });

  // Source pins, in the style of the #325 anchor guard in search.test.ts:
  // the disposition chain search -> store flag -> page consumption must
  // stay wired, and the persistence paths must keep reading the saved
  // mode, never the displayed one.
  test("preparation, the store flag, and the Tunnel page stay wired together", () => {
    const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const settingsView = readFileSync(join(uiRoot, "components/views/SettingsView.tsx"), "utf-8");
    const tunnelSettings = readFileSync(join(uiRoot, "components/sections/openchamber/TunnelSettings.tsx"), "utf-8");
    const uiStore = readFileSync(join(uiRoot, "stores/useUIStore.ts"), "utf-8");

    expect(settingsView).toContain("tunnelSearchRevealModeForResult(result.id)");
    expect(settingsView).toContain("setSettingsTunnelModeRequested(tunnelRevealMode)");
    expect(uiStore).toContain("settingsTunnelModeRequested: string | null");
    expect(tunnelSettings).toContain("displayedTunnelMode(tunnelMode, revealedTunnelMode)");
    // Both anchored sections render under the displayed (reveal-aware) mode.
    expect(tunnelSettings).toContain("displayTunnelMode === \x27managed-remote\x27");
    expect(tunnelSettings).toContain("displayTunnelMode === \x27managed-local\x27");
    // The provider save derives its mode from the saved tunnelMode only:
    // a viewed-but-unconfirmed mode must not ride along into a save.
    expect(tunnelSettings).toContain("mode.key === tunnelMode");
    expect(tunnelSettings).not.toContain("mode.key === displayTunnelMode");
  });
});
