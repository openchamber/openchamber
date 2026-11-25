import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AuthTimeouts } from "../src/auth/constants.ts";
import { AuthEpoch } from "../src/auth/epoch.ts";
import { SignInRequiredError } from "../src/auth/errors.ts";
import { AuthManager } from "../src/auth/manager.ts";
import { profileIdFor } from "../src/session-store.ts";
import { BinaryManager } from "../src/install/binary-manager.ts";
import type { InstallAuthConfig } from "../src/install/config.ts";
import { acquireDirLock } from "../src/install/lock.ts";
import { authEpochFile, authLockDir, profilePaths } from "../src/install/paths.ts";
import { readJournal } from "./fixtures/mock-agy.ts";
import { writeMockLoginWrapper, type MockLoginScenario } from "./fixtures/mock-agy-login.ts";
import { FakeLocation, FakeRunDirs, FakeRuntime, TempDirs, isolatedEnv, rejection, sleep, testConfig, waitFor, writeTokenFiles } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
const managers: AuthManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) {
    m.dispose();
    await m.settle();
  }
  temps.cleanup();
});

const FAST: Partial<AuthTimeouts> = { killGraceMs: 200, probeMs: 3_000, logoutMs: 3_000, logoutLockWaitMs: 300, credentialDebounceMs: 20 };

class OrderedRuntime extends FakeRuntime {
  constructor(private readonly order: Array<[string, number]>) {
    super();
  }

  override async stop(reason: "auth-changed"): Promise<void> {
    this.order.push(["stop-start", Date.now()]);
    await super.stop(reason);
    this.order.push(["stopped", Date.now()]);
  }
}

interface LogoutWorld {
  root: string;
  config: InstallAuthConfig;
  auth: AuthManager;
  runtime: OrderedRuntime;
  journal: string;
  logs: string[];
  order: Array<[string, number]>;
  location: FakeLocation;
  fetchCalls: string[];
}

function logoutWorld(opts: { scenario?: MockLoginScenario[]; options?: Record<string, unknown>; noBinary?: boolean; timeouts?: Partial<AuthTimeouts> } = {}): LogoutWorld {
  const root = temps.make("oa-logout-");
  const journal = path.join(root, "journal.jsonl");
  const env = isolatedEnv(root);
  const binaryPath = opts.noBinary ? undefined : writeMockLoginWrapper(root, { scenario: opts.scenario, journal });
  const config = testConfig(root, { ...(binaryPath ? { binaryPath } : {}), ...opts.options });
  const order: Array<[string, number]> = [];
  const runtime = new OrderedRuntime(order);
  runtime.stopDelayMs = 100;
  const logs: string[] = [];
  const fetchCalls: string[] = [];
  const auth = new AuthManager(config, {
    binary: new BinaryManager(config, {
      env,
      log: () => {},
      fetch: async (url) => {
        fetchCalls.push(url);
        throw new Error("no network in tests");
      },
    }),
    env,
    timeouts: { ...FAST, ...opts.timeouts },
    log: (l) => logs.push(l),
    lockPollMs: 20,
  });
  auth.attachRuntime(runtime, new FakeRunDirs(root).create);
  auth.onAuthChanged((e) => order.push([`bump:${e.reason}`, Date.now()]));
  const location = new FakeLocation(root);
  auth.attach({ directory: root, integration: location });
  managers.push(auth);
  return { root, config, auth, runtime, journal, logs, order, location, fetchCalls };
}

function tokensLeft(config: InstallAuthConfig): number {
  return profilePaths(config.geminiDir).tokenFiles.filter((f) => existsSync(f)).length;
}

describe("logout (IA 11.3)", () => {
  test("mock with logout: epoch bump, runtime.stop awaited, then the logout request; signed_out", async () => {
    const w = logoutWorld();
    writeTokenFiles(w.config.geminiDir, "a@b.c");
    await w.auth.logout("credential-removed");
    const logoutAt = readJournal(w.journal).find((e) => e.method === "logout")?.at ?? 0;
    const names = w.order.map(([n]) => n);
    expect(names).toEqual(["bump:logout", "stop-start", "stopped"]);
    const stoppedAt = w.order.find(([n]) => n === "stopped")?.[1] ?? Infinity;
    expect(logoutAt >= stoppedAt).toBe(true);
    expect(w.runtime.stopCalls).toBe(1);
    expect(w.auth.state.kind).toBe("signed_out");
    expect(w.auth.authEpoch()).toBe("1");
    expect(tokensLeft(w.config)).toBe(0);
    expect(w.logs).toEqual([]);
    expect(existsSync(authLockDir(w.config.dataDir, profileIdFor(w.config.geminiDir)))).toBe(false);
  });

  test("mock without auth.logout: token files deleted in an isolated plugin-owned profile", async () => {
    const w = logoutWorld({ scenario: ["no-logout"] });
    writeTokenFiles(w.config.geminiDir);
    await w.auth.logout("credential-removed");
    expect(tokensLeft(w.config)).toBe(0);
    expect(readJournal(w.journal).some((e) => e.method === "logout")).toBe(false);
    expect(w.logs.length).toBe(1);
  });

  test("nothing deleted in shared mode", async () => {
    const w = logoutWorld({ scenario: ["no-logout"], options: { isolatedAuth: false } });
    writeTokenFiles(w.config.geminiDir);
    await w.auth.logout("credential-removed");
    expect(tokensLeft(w.config)).toBe(2);
    expect(readJournal(w.journal).some((e) => e.method === "initialize")).toBe(false);
    expect(w.auth.state.kind).toBe("signed_out");
    expect(w.runtime.stopCalls).toBe(1);
  });

  test("nothing deleted in a profile without the marker", async () => {
    const root = temps.make();
    const userGemini = path.join(root, "user-gemini");
    mkdirSync(userGemini);
    const w = logoutWorld({ scenario: ["no-logout"], options: { geminiDir: userGemini } });
    writeTokenFiles(userGemini);
    await w.auth.logout("credential-removed");
    expect(w.auth.isPluginOwnedProfile()).toBe(false);
    expect(tokensLeft(w.config)).toBe(2);
  });

  test("a token path that is a symlink is not followed", async () => {
    const w = logoutWorld({ scenario: ["no-logout"] });
    const real = path.join(w.root, "real-token");
    writeFileSync(real, "keep me");
    const { tokenFiles, appDataDir } = profilePaths(w.config.geminiDir);
    mkdirSync(appDataDir, { recursive: true });
    for (const file of tokenFiles) symlinkSync(real, file);
    await w.auth.logout("credential-removed");
    expect(existsSync(real)).toBe(true);
  });

  test("a hanging logout ends in signed_out within the budget, with a logged failure", async () => {
    const w = logoutWorld({ scenario: ["logout-hang"], timeouts: { logoutMs: 200 } });
    writeTokenFiles(w.config.geminiDir);
    const started = Date.now();
    await w.auth.logout("credential-removed");
    expect(Date.now() - started < 2_500).toBe(true);
    expect(w.auth.state.kind).toBe("signed_out");
    expect(w.logs.length).toBe(1);
    expect(w.logs[0]?.startsWith("[opencode-antigravity]")).toBe(true);
    expect(tokensLeft(w.config)).toBe(0);
  });

  test("no installed binary: logout does not download and uses the file fallback", async () => {
    const w = logoutWorld({ noBinary: true });
    writeTokenFiles(w.config.geminiDir);
    await w.auth.logout("credential-removed");
    expect(w.fetchCalls).toEqual([]);
    expect(tokensLeft(w.config)).toBe(0);
    expect(w.auth.state.kind).toBe("signed_out");
  });

  test("auth lock held by another process past the wait: state unchanged, beforeSpawn does not block", async () => {
    const w = logoutWorld();
    w.auth.reportAuthenticated();
    const other = await acquireDirLock(authLockDir(w.config.dataDir, profileIdFor(w.config.geminiDir)), { hostname: "other-host" });
    await w.auth.logout("credential-removed");
    expect(w.auth.state.kind).toBe("signed_in");
    expect(w.runtime.stopCalls).toBe(0);
    expect(w.logs.length).toBe(1);
    await w.auth.beforeSpawn();
    other.releaseSync();
  });

  test("runtime.stop is called exactly once per logout", async () => {
    const w = logoutWorld();
    await w.auth.logout("credential-removed");
    expect(w.runtime.stopCalls).toBe(1);
    w.auth.reportAuthenticated();
    await w.auth.logout("credential-removed");
    expect(w.runtime.stopCalls).toBe(2);
  });

  test("beforeSpawn waits during logout, then rejects; after another process bumps auth-epoch it resolves", async () => {
    const w = logoutWorld();
    w.runtime.stopDelayMs = 300;
    const logout = w.auth.logout("credential-removed");
    expect(await waitFor(() => w.auth.state.kind === "logging_out")).toBe(true);
    let settled = false;
    const spawn = w.auth.beforeSpawn().finally(() => {
      settled = true;
    });
    await sleep(100);
    expect(settled).toBe(false);
    await logout;
    expect((await rejection(spawn)) instanceof SignInRequiredError).toBe(true);
    expect((await rejection(w.auth.beforeSpawn())) instanceof SignInRequiredError).toBe(true);

    const events: string[] = [];
    w.auth.onAuthChanged((e) => events.push(e.reason));
    await new AuthEpoch(authEpochFile(w.config.dataDir, profileIdFor(w.config.geminiDir))).bump();
    await w.auth.beforeSpawn();
    expect(w.auth.state.kind).toBe("unknown");
    expect(events).toEqual(["login"]);
  });

  test("a late runtime report after logout does not reopen spawns", async () => {
    const w = logoutWorld();
    await w.auth.logout("credential-removed");
    w.auth.reportSignInRequired("late");
    w.auth.reportAuthenticated();
    expect(w.auth.state.kind).toBe("signed_out");
    expect((await rejection(w.auth.beforeSpawn())) instanceof SignInRequiredError).toBe(true);
  });
});
