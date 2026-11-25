// The real WP-B2 modules satisfy the injection contract of AntigravityProxy. The `satisfies` checks
// are the test; type-check fails when a module drifts from `ProxySessionModules`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProxySessionModules, SessionStoreApi } from "../../src/contracts.ts";
import { classifyRequest, emittedHashes } from "../../src/fingerprint.ts";
import { createProfileApi } from "../../src/profile.ts";
import { buildSessionAppend, buildTurnPrompt } from "../../src/prompt.ts";
import { buildReplayPrompt } from "../../src/replay.ts";
import { MemorySessionStore, SessionStore } from "../../src/session-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function realModules(store: SessionStoreApi) {
  return {
    classify: classifyRequest,
    store,
    buildAppend: (input) => buildSessionAppend(input, "opencode"),
    buildReplay: buildReplayPrompt,
    buildTurnPrompt,
    hashes: emittedHashes,
    profile: createProfileApi({ agentName: "opencode-bridge", mcpServerName: "opencode" }),
  } satisfies ProxySessionModules;
}

describe("ProxySessionModules", () => {
  test("the real modules, with the file store or the memory store, satisfy the contract", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-modules-"));
    tempDirs.push(root);
    const fileStore = new SessionStore({
      dataDir: path.join(root, "data"),
      geminiDir: path.join(root, "gemini"),
      poolId: "pool",
      authEpoch: () => "1",
      isPluginOwnedProfile: () => true,
      sessionTtlDays: 14,
      maxStoredSessions: 500,
    }) satisfies SessionStoreApi;
    const memoryStore = new MemorySessionStore() satisfies SessionStoreApi;

    for (const modules of [realModules(fileStore), realModules(memoryStore)]) {
      const append = modules.buildAppend({ messages: [], tools: [], meta: true, config: { maxSystemPromptBytes: 100, maxToolsPromptBytes: 100 } });
      const result = modules.classify({
        binding: await modules.store.load("ses", "1"),
        request: { kind: "title", sessionKey: "ses", messages: [], tools: [], cwd: "/", authEpoch: "1", append },
        parkedTurn: null,
      });
      expect(result.plan).toEqual({ kind: "meta" });
    }
  });
});
