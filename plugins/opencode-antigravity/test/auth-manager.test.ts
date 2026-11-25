import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type AuthTimeouts } from "../src/auth/constants.ts";
import { AuthEpoch } from "../src/auth/epoch.ts";
import { NEEDS_AUTH_STATUS_MESSAGE, SIGNED_OUT_MESSAGE, SignInRequiredError } from "../src/auth/errors.ts";
import { AuthManager, createInstallAuthBridge, runCredentialEvents } from "../src/auth/manager.ts";
import type { InstallAuthBridge } from "../src/contracts.ts";
import { profileIdFor } from "../src/session-store.ts";
import { BinaryManager } from "../src/install/binary-manager.ts";
import type { InstallAuthConfig } from "../src/install/config.ts";
import { authEpochFile, profilePaths } from "../src/install/paths.ts";
import { GOOD_CODE, writeMockLoginWrapper, type MockLoginScenario } from "./fixtures/mock-agy-login.ts";
import { FakeLocation, FakeRunDirs, FakeRuntime, TempDirs, isolatedEnv, rejection, sleep, testConfig, waitFor } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
const managers: AuthManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) {
    m.dispose();
    await m.settle();
  }
  temps.cleanup();
});

const FAST: Partial<AuthTimeouts> = { killGraceMs: 200, probeMs: 3_000, verifyProbeMs: 3_000, logoutMs: 2_000, credentialDebounceMs: 30, epochRereadMs: 50 };
const NEEDS_AUTH = { status: "needs_auth" as const, message: NEEDS_AUTH_STATUS_MESSAGE };

interface World {
  root: string;
  config: InstallAuthConfig;
  auth: AuthManager;
  binary: BinaryManager;
  runtime: FakeRuntime;
  env: NodeJS.ProcessEnv;
}

function world(opts: { scenario?: MockLoginScenario[]; timeouts?: Partial<AuthTimeouts> } = {}): World {
  const root = temps.make("oa-manager-");
  const env = isolatedEnv(root);
  const binaryPath = writeMockLoginWrapper(root, { scenario: opts.scenario });
  const config = testConfig(root, { binaryPath });
  const binary = new BinaryManager(config, { env, log: () => {} });
  const auth = new AuthManager(config, { binary, env, timeouts: { ...FAST, ...opts.timeouts }, log: () => {} });
  const runtime = new FakeRuntime();
  auth.attachRuntime(runtime, new FakeRunDirs(root).create);
  managers.push(auth);
  return { root, config, auth, binary, runtime, env };
}

function location(w: World, name: string, credentials: number): { loc: FakeLocation; detach: () => void } {
  const loc = new FakeLocation(path.join(w.root, name));
  for (let i = 0; i < credentials; i++) loc.addCredential(`${name}-${i}`);
  return { loc, detach: w.auth.attach({ directory: loc.directory, integration: loc }) };
}

async function* oneEvent(integrationID: string): AsyncGenerator<{ data: { integrationID: string; credentialID: string } }> {
  yield { data: { integrationID, credentialID: "x" } };
}

describe("connection status (IA 12.1, 13.3)", () => {
  test("reportSignInRequired with two credentials marks both needs_auth; zero credentials: no call", async () => {
    const w = world();
    const two = location(w, "two", 2).loc;
    const none = location(w, "none", 0).loc;
    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    await w.auth.settle();
    expect(two.statusCalls).toEqual([
      { id: "two-0", status: NEEDS_AUTH },
      { id: "two-1", status: NEEDS_AUTH },
    ]);
    expect(none.statusCalls).toEqual([]);
    expect(w.auth.state.kind).toBe("signed_out");
    expect(w.runtime.stopCalls).toBe(1);
  });

  test("reportAuthenticated after that clears both", async () => {
    const w = world();
    const two = location(w, "two", 2).loc;
    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    await w.auth.settle();
    w.auth.reportAuthenticated();
    await w.auth.settle();
    expect(two.statusCalls.slice(2)).toEqual([
      { id: "two-0", status: undefined },
      { id: "two-1", status: undefined },
    ]);
    // Already matching: no repeat calls.
    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    await w.auth.settle();
    expect(two.statusCalls.length).toBe(6);
  });

  test("three locations: all get needs_auth, a throwing one does not stop the others, a detached one gets nothing, a late one gets it at once", async () => {
    const w = world();
    const a = location(w, "a", 1);
    const b = location(w, "b", 1);
    const c = location(w, "c", 1);
    b.loc.failStatus = true;
    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    await w.auth.settle();
    expect(a.loc.statusCalls.length).toBe(1);
    expect(c.loc.statusCalls.length).toBe(1);

    c.detach();
    w.auth.reportAuthenticated();
    await w.auth.settle();
    expect(a.loc.statusCalls.length).toBe(2);
    expect(c.loc.statusCalls.length).toBe(1);

    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    await w.auth.settle();
    const late = location(w, "late", 2).loc;
    await w.auth.settle();
    expect(late.statusCalls).toEqual([
      { id: "late-0", status: NEEDS_AUTH },
      { id: "late-1", status: NEEDS_AUTH },
    ]);
  });

  test("get is unwrapped from { location, data }; IntegrationNotFoundError counts as no connections", async () => {
    const w = world();
    const missing = location(w, "missing", 1).loc;
    missing.notFound = true;
    const ok = location(w, "ok", 1).loc;
    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    await w.auth.settle();
    expect(missing.statusCalls).toEqual([]);
    expect(ok.statusCalls).toEqual([{ id: "ok-0", status: NEEDS_AUTH }]);
  });
});

describe("credential.updated (IA 11.2)", () => {
  test("delivered to three locations with zero credentials left: one logout", async () => {
    const w = world();
    const locs = ["a", "b", "c"].map((n) => location(w, n, 0).loc);
    const reasons: string[] = [];
    w.auth.onAuthChanged((e) => reasons.push(e.reason));
    await Promise.all(locs.map(() => runCredentialEvents(oneEvent("antigravity"), w.auth)));
    expect(await waitFor(() => w.auth.state.kind === "signed_out")).toBe(true);
    await sleep(100);
    expect(reasons).toEqual(["logout"]);
    expect(w.runtime.stopCalls).toBe(1);
  });

  test("with one credential left: no logout; other integrations are ignored", async () => {
    const w = world();
    location(w, "a", 1);
    location(w, "b", 0);
    await runCredentialEvents(oneEvent("antigravity"), w.auth);
    await runCredentialEvents(oneEvent("openai"), w.auth);
    await sleep(100);
    await w.auth.settle();
    expect(w.runtime.stopCalls).toBe(0);
    expect(w.auth.state.kind).toBe("unknown");
  });

  test("connection.active throwing in every location: no logout", async () => {
    const w = world();
    const a = location(w, "a", 0).loc;
    const b = location(w, "b", 0).loc;
    a.failActive = true;
    b.failActive = true;
    w.auth.onCredentialChanged();
    await sleep(100);
    await w.auth.settle();
    expect(w.runtime.stopCalls).toBe(0);
    expect(w.auth.state.kind).toBe("unknown");
  });

  test("zero credentials while login_pending: no logout, and the login completes", async () => {
    const w = world();
    location(w, "a", 0);
    const auth = await w.auth.authorize();
    if (auth.mode !== "code") throw new Error("expected code mode");
    w.auth.onCredentialChanged();
    await sleep(100);
    await w.auth.settle();
    expect(w.runtime.stopCalls).toBe(0);
    expect(w.auth.state.kind).toBe("login_pending");
    await auth.callback(GOOD_CODE);
    expect(w.auth.state.kind).toBe("signed_in");
  });
});

describe("auth epoch (IA 13.4)", () => {
  test("a change by another process is picked up within the reread interval and fires onAuthChanged", async () => {
    const w = world();
    expect(w.auth.authEpoch()).toBe("0");
    const events: string[] = [];
    w.auth.onAuthChanged((e) => events.push(`${e.reason}:${e.epoch}`));
    await new AuthEpoch(authEpochFile(w.config.dataDir, profileIdFor(w.config.geminiDir))).bump();
    expect(await waitFor(() => w.auth.authEpoch() === "1", 1_000)).toBe(true);
    expect(events).toEqual(["login:1"]);
  });

  test("authEpoch() never runs listeners inside the call; they run in a microtask (O-2)", async () => {
    const w = world({ timeouts: { epochRereadMs: 0 } });
    const events: string[] = [];
    w.auth.onAuthChanged((e) => events.push(e.reason));
    await new AuthEpoch(authEpochFile(w.config.dataDir, profileIdFor(w.config.geminiDir))).bump();
    expect(w.auth.authEpoch()).toBe("1");
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(events).toEqual(["login"]);
    expect(w.auth.authEpoch()).toBe("1");
    await Promise.resolve();
    expect(events).toEqual(["login"]);
  });

  test("a signed_out state whose epoch differs from the file becomes unknown", async () => {
    const w = world();
    w.auth.reportSignInRequired(SIGNED_OUT_MESSAGE);
    await new AuthEpoch(authEpochFile(w.config.dataDir, profileIdFor(w.config.geminiDir))).bump();
    expect(await waitFor(() => (w.auth.authEpoch(), w.auth.state.kind === "unknown"), 1_000)).toBe(true);
  });
});

describe("setup probe (IA 13.2)", () => {
  test("with a credential and no runtime report, a signed-out probe marks needs_auth", async () => {
    const w = world({ scenario: ["auth-signed-out"], timeouts: { setupProbeDelayMs: 20 } });
    const { loc } = location(w, "a", 1);
    w.auth.scheduleSetupProbe();
    expect(await waitFor(() => loc.statusCalls.length === 1, 3_000)).toBe(true);
    expect(loc.statusCalls).toEqual([{ id: "a-0", status: NEEDS_AUTH }]);
  });

  test("a runtime report first makes the probe a no-op", async () => {
    const w = world({ scenario: ["auth-signed-out"], timeouts: { setupProbeDelayMs: 20 } });
    const { loc } = location(w, "a", 1);
    w.auth.reportAuthenticated();
    w.auth.scheduleSetupProbe();
    await sleep(300);
    await w.auth.settle();
    expect(loc.statusCalls).toEqual([]); // already clear: no call
    expect(w.auth.state.kind).toBe("signed_in");
  });
});

describe("createInstallAuthBridge (IA 15.1)", () => {
  test("satisfies InstallAuthBridge and wires each member", async () => {
    const w = world();
    const bridge: InstallAuthBridge = createInstallAuthBridge(w.binary, w.auth, { env: w.env });
    expect(bridge.geminiDir).toBe(w.config.geminiDir);
    expect(bridge.authMethod).toBe("oauth-personal");
    const resolved = await bridge.resolveBinary();
    expect(resolved).toEqual({ path: w.config.binaryPath ?? "", version: "1.5.15" });
    expect(bridge.binaryStatus()).toEqual({ phase: "ready", source: "explicit", version: "1.5.15" });
    const env = bridge.buildSpawnEnv({ tmpDir: "/tmp/run-x" });
    expect(env.GEMINI_HOME).toBe(w.config.geminiDir);
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expect(env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");

    await bridge.beforeSpawn();
    await bridge.updateProfileSettings({ toolPermission: "strict" });
    expect(JSON.parse(readFileSync(profilePaths(w.config.geminiDir).settingsFile, "utf8"))).toEqual({
      auth: { type: "oauth-personal" },
      toolPermission: "strict",
    });
    expect(bridge.isPluginOwnedProfile()).toBe(true);
    expect(bridge.isSignInRequired(new SignInRequiredError())).toBe(true);
    expect(bridge.authEpoch()).toBe("0");

    const seen: string[] = [];
    const off = bridge.onAuthChanged((e) => seen.push(e.reason));
    bridge.reportSignInRequired(SIGNED_OUT_MESSAGE);
    expect(w.auth.state.kind).toBe("signed_out");
    bridge.reportAuthenticated();
    expect(w.auth.state.kind).toBe("signed_in");
    off();
    expect(seen).toEqual([]);
    expect((await rejection(bridge.beforeSpawn())) === undefined).toBe(true);
  });
});
