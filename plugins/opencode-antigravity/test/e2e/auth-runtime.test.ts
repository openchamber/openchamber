// The real AuthManager wired to the real AgyProcessManager (O-1). Every other runtime test uses the
// fake bridge and every auth test a fake runtime, so the two halves only meet here.

import { afterEach, describe, expect, test } from "bun:test";
import { AgyProcessManager, type Spawner } from "../../src/agy-process.ts";
import { AuthManager, createInstallAuthBridge } from "../../src/auth/manager.ts";
import { resolveRuntimeConfig } from "../../src/config.ts";
import { BinaryManager } from "../../src/install/binary-manager.ts";
import { writeMockLoginWrapper } from "../fixtures/mock-agy-login.ts";
import { FakeRunDirs, TempDirs, isolatedEnv, rejection, testConfig, waitFor } from "../fixtures/install-helpers.ts";

const temps = new TempDirs();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  temps.cleanup();
});

describe("auth manager and process manager together", () => {
  test("a spawn that starts while a logout is in progress neither deadlocks the logout nor spawns (O-1)", async () => {
    const root = temps.make("oa-auth-runtime-");
    const env = isolatedEnv(root);
    const binaryPath = writeMockLoginWrapper(root, {});
    const config = testConfig(root, { binaryPath });
    const binary = new BinaryManager(config, { env, log: () => {} });
    const auth = new AuthManager(config, {
      binary,
      env,
      timeouts: { killGraceMs: 200, logoutMs: 2_000, probeMs: 2_000, epochRereadMs: 50 },
      log: () => {},
    });
    const bridge = createInstallAuthBridge(binary, auth, { env });
    let spawned = 0;
    const spawner: Spawner = () => {
      spawned++;
      throw new Error("the runtime must not spawn during or after a logout");
    };
    const { config: runtime } = resolveRuntimeConfig({}, {});
    const runDirs = new FakeRunDirs(root);
    const manager = new AgyProcessManager({
      config: runtime,
      install: bridge,
      baseArgs: (g) => ["acp", "--gemini-dir", g],
      createRunDir: runDirs.create,
      dataDir: root,
      allowPermission: () => false,
      onExit: () => {},
      spawner,
    });
    auth.attachRuntime({ stop: (r) => manager.stop(r), hold: (r) => manager.hold(r) }, runDirs.create);
    cleanups.push(async () => {
      await manager.dispose();
      auth.dispose();
      await auth.settle();
    });

    // A chat request arrives in the window between "logging_out" and the runtime stop: the epoch bump
    // of the logout fires onAuthChanged before AuthManager awaits runtime.stop.
    let turn: Promise<unknown> | null = null;
    auth.onAuthChanged((e) => {
      if (e.reason === "logout" && !turn) turn = rejection(manager.acquire("turn"));
    });
    const logout = auth.logout("credential-removed");
    let settled = false;
    void logout.then(() => {
      settled = true;
    });
    expect(await waitFor(() => settled, 4_000)).toBe(true);
    expect(turn).not.toBeNull();
    expect(auth.state.kind).toBe("signed_out");
    const err = await turn;
    expect(bridge.isSignInRequired(err)).toBe(true);
    expect(manager.state).toBe("stopped");
    expect(spawned).toBe(0);
  }, 10_000);
});
