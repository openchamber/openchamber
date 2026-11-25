import { describe, expect, test } from "bun:test";
import { resolveRuntimeConfig } from "../../src/config.ts";
import { DEFAULT_TIMINGS } from "../../src/constants.ts";

describe("resolveRuntimeConfig", () => {
  test("defaults from SR 10", () => {
    const { config, issues } = resolveRuntimeConfig(undefined, {});
    expect(issues).toEqual([]);
    expect(config.idleShutdownMs).toBe(600_000);
    expect(config.sessionIdleCloseMs).toBe(1_800_000);
    expect(config.parkedToolTtlMs).toBe(1_800_000);
    expect(config.cancelSettleMs).toBe(15_000);
    expect(config.stallTimeoutMs).toBe(180_000);
    expect(config.retryStallTimeoutMs).toBe(300_000);
    expect(config.statusNoteAfterMs).toBe(20_000);
    expect(config.statusNotes).toBe(true);
    expect(config.breakerCooldownMs).toBe(30_000);
    expect(config.processPerSession).toBe(false);
    expect(config.sessionStore).toBe(true);
    expect(config.resumeAfterRestart).toBe(true);
    expect(config.steering).toBe(true);
    expect(config.maxSystemPromptBytes).toBe(32_768);
    expect(config.maxToolsPromptBytes).toBe(49_152);
    expect(config.replayMaxChars).toBe(600_000);
    expect(config.toolGuardHook).toBe(true);
    expect(config.debug).toBe(false);
    expect(config.debugContent).toBe(false);
    expect(config.proxyPort).toBe(0);
    expect(config.timings).toEqual(DEFAULT_TIMINGS);
  });

  test("an option wins over its env var, which wins over the default", () => {
    const env = { OPENCODE_ANTIGRAVITY_IDLE_MS: "1000", OPENCODE_ANTIGRAVITY_STALL_MS: "5000", OPENCODE_ANTIGRAVITY_PROXY_PORT: "4100" };
    expect(resolveRuntimeConfig({}, env).config.idleShutdownMs).toBe(1000);
    expect(resolveRuntimeConfig({ idleShutdownMs: 0 }, env).config.idleShutdownMs).toBe(0);
    expect(resolveRuntimeConfig({}, env).config.proxyPort).toBe(4100);
    const { config } = resolveRuntimeConfig({ retryStallTimeoutMs: 10_000 }, env);
    expect(config.stallTimeoutMs).toBe(5000);
  });

  test("bad values keep the default and become issues; nothing throws", () => {
    const { config, issues } = resolveRuntimeConfig(
      { stallTimeoutMs: -1, statusNotes: "maybe", steering: "no", proxyPort: 70_000 },
      { OPENCODE_ANTIGRAVITY_IDLE_MS: "soon" },
    );
    expect(config.stallTimeoutMs).toBe(180_000);
    expect(config.statusNotes).toBe(true);
    expect(config.steering).toBe(false);
    expect(config.proxyPort).toBe(0);
    expect(config.idleShutdownMs).toBe(600_000);
    expect(issues).toHaveLength(4);
  });

  test("retryStallTimeoutMs never below stallTimeoutMs; debugContent implies debug", () => {
    const { config, issues } = resolveRuntimeConfig({ stallTimeoutMs: 10_000, retryStallTimeoutMs: 5_000, debugContent: true }, {});
    expect(config.retryStallTimeoutMs).toBe(10_000);
    expect(config.debug).toBe(true);
    expect(issues).toHaveLength(1);
  });
});
