import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { CODE_INSTRUCTIONS, LOGIN_MESSAGES, MARKER_ACCESS, SHARED_READY, type AuthTimeouts } from "../src/auth/constants.ts";
import { AuthManager } from "../src/auth/manager.ts";
import type { OAuthAuthorization } from "../src/auth/methods.ts";
import { checkLoginResponse, mapLoginFailure, parseAuthUrl, REDIRECT_URI } from "../src/auth/login.ts";
import { profileIdFor } from "../src/session-store.ts";
import { BinaryManager } from "../src/install/binary-manager.ts";
import type { InstallAuthConfig } from "../src/install/config.ts";
import { acquireDirLock } from "../src/install/lock.ts";
import { authLockDir } from "../src/install/paths.ts";
import { readJournal } from "./fixtures/mock-agy.ts";
import {
  CANCELLED_LINE,
  GOOD_CODE,
  INVALID_GRANT_LINE,
  MOCK_AUTH_URL,
  MOCK_EMAIL,
  MOCK_STATE,
  SAFE_EXIT_LINE,
  writeMockLoginWrapper,
  type MockLoginScenario,
} from "./fixtures/mock-agy-login.ts";
import { FakeLocation, FakeRunDirs, FakeRuntime, TempDirs, isolatedEnv, messageOf, rejection, sleep, testConfig, waitFor } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
const managers: AuthManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) {
    m.dispose();
    await m.settle();
  }
  temps.cleanup();
});

interface LoginWorld {
  root: string;
  config: InstallAuthConfig;
  auth: AuthManager;
  runtime: FakeRuntime;
  runDirs: FakeRunDirs;
  location: FakeLocation;
  journal: string;
  lockDir: string;
}

const FAST: Partial<AuthTimeouts> = {
  urlMs: 3_000,
  exchangeMs: 3_000,
  verifyProbeMs: 3_000,
  probeMs: 3_000,
  killGraceMs: 300,
  credentialDebounceMs: 20,
};

function loginWorld(opts: { scenario?: MockLoginScenario[]; email?: string; options?: Record<string, unknown>; timeouts?: Partial<AuthTimeouts> } = {}): LoginWorld {
  const root = temps.make("oa-login-");
  const journal = path.join(root, "journal.jsonl");
  const binary = writeMockLoginWrapper(root, { scenario: opts.scenario, journal, email: opts.email });
  const env = isolatedEnv(root);
  const config = testConfig(root, { binaryPath: binary, ...opts.options });
  const runtime = new FakeRuntime();
  const runDirs = new FakeRunDirs(root);
  const auth = new AuthManager(config, {
    binary: new BinaryManager(config, { env, log: () => {} }),
    env,
    timeouts: { ...FAST, ...opts.timeouts },
    log: () => {},
    lockPollMs: 20,
  });
  auth.attachRuntime(runtime, runDirs.create);
  const location = new FakeLocation(root);
  auth.attach({ directory: root, integration: location });
  managers.push(auth);
  return { root, config, auth, runtime, runDirs, location, journal, lockDir: authLockDir(config.dataDir, profileIdFor(config.geminiDir)) };
}

function codeMode(a: OAuthAuthorization): Extract<OAuthAuthorization, { mode: "code" }> {
  if (a.mode !== "code") throw new Error(`expected code mode, got ${a.mode}`);
  return a;
}

function loginPids(journal: string): number[] {
  return readJournal(journal)
    .filter((e) => e.method === "process/start" && Array.isArray(e.params.argv) && e.params.argv.includes("--login"))
    .map((e) => e.pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stdinLines(journal: string): number {
  return readJournal(journal).filter((e) => e.method === "login/stdin").length;
}

/** Child gone, login RunDir released, hold released, auth lock free. */
async function expectReleased(w: LoginWorld): Promise<void> {
  expect(await waitFor(() => loginPids(w.journal).every((pid) => !alive(pid)))).toBe(true);
  expect(w.runDirs.releasedCount("login")).toBe(w.runDirs.createdCount("login"));
  expect(w.runtime.liveHolds).toBe(0);
  expect(existsSync(w.lockDir)).toBe(false);
}

describe("parseAuthUrl (IA 10.2 step 9)", () => {
  test("the real URL shape passes", () => {
    expect(parseAuthUrl(`  ${MOCK_AUTH_URL}  `)).toEqual({ url: MOCK_AUTH_URL, state: MOCK_STATE });
  });

  const bad: Array<[string, string]> = [
    ["/o/oauth2/v2/auth", MOCK_AUTH_URL.replace("/o/oauth2/auth", "/o/oauth2/v2/auth")],
    ["wrong redirect", MOCK_AUTH_URL.replace(encodeURIComponent(REDIRECT_URI), encodeURIComponent("https://evil.example/cb"))],
    ["two state params", `${MOCK_AUTH_URL}&state=second`],
    ["a hash", `${MOCK_AUTH_URL}#frag`],
    ["userinfo", MOCK_AUTH_URL.replace("https://", "https://user:pw@")],
    ["over 16384 chars", `${MOCK_AUTH_URL}&pad=${"x".repeat(16_400)}`],
    ["another host", MOCK_AUTH_URL.replace("accounts.google.com", "accounts.google.com.evil.example")],
    ["response_type token", MOCK_AUTH_URL.replace("response_type=code", "response_type=token")],
  ];
  for (const [name, url] of bad) {
    test(`fails: ${name}`, () => {
      expect(parseAuthUrl(url)).toBeNull();
    });
  }
});

describe("checkLoginResponse (IA 10.3 step 3)", () => {
  const pending = { state: MOCK_STATE };
  const callback = (q: string): string => `${REDIRECT_URI}?${q}`;

  test("a plain code and a callback URL with the matching state pass", () => {
    expect(checkLoginResponse(pending, " 4/0AeaYSHB-x_y.z~1 ")).toBe("4/0AeaYSHB-x_y.z~1");
    expect(checkLoginResponse(pending, callback(`code=abc&state=${MOCK_STATE}&scope=x`))).toBe(callback(`code=abc&state=${MOCK_STATE}&scope=x`));
  });

  const bad: Array<[string, string]> = [
    ["wrong state", callback("code=abc&state=other")],
    ["two code", callback(`code=a&code=b&state=${MOCK_STATE}`)],
    ["code\\nother", "code\nother"],
    ["embedded space", "abc def"],
    ["wrong origin", `https://evil.example/oauth-callback?code=abc&state=${MOCK_STATE}`],
    ["a hash", `${callback(`code=abc&state=${MOCK_STATE}`)}#x`],
    ["empty", "   "],
  ];
  for (const [name, value] of bad) {
    test(`fails: ${name}`, () => {
      expect(checkLoginResponse(pending, value)).toBeNull();
    });
  }

  test("mapLoginFailure", () => {
    expect(mapLoginFailure(INVALID_GRANT_LINE)).toBe(LOGIN_MESSAGES.invalidGrant);
    expect(mapLoginFailure("error: access_denied")).toBe(LOGIN_MESSAGES.notApproved);
    expect(mapLoginFailure(CANCELLED_LINE)).toBe(LOGIN_MESSAGES.notApproved);
    expect(mapLoginFailure("status SUBSCRIPTION_REQUIRED")).toBe(LOGIN_MESSAGES.subscription);
    expect(mapLoginFailure("something else")).toBe(LOGIN_MESSAGES.generic);
  });
});

describe("authorize and callback (IA 10.2, 10.3)", () => {
  test("success: marker credential, label, epoch, needs_auth cleared on two connections, everything released", async () => {
    const w = loginWorld();
    const a = w.location.addCredential("c1");
    const b = w.location.addCredential("c2");
    a.status = { status: "needs_auth", message: "Signed out of Antigravity. Connect again to sign in." };
    b.status = { status: "needs_auth", message: "Signed out of Antigravity. Connect again to sign in." };
    const events: string[] = [];
    w.auth.onAuthChanged((e) => events.push(`${e.reason}:${e.epoch}`));

    const auth = codeMode(await w.auth.authorize());
    expect(auth.url).toBe(MOCK_AUTH_URL);
    expect(auth.instructions).toBe(CODE_INSTRUCTIONS);
    expect(typeof auth.expiresAt).toBe("number");
    expect(w.auth.state.kind).toBe("login_pending");
    expect(w.runtime.liveHolds).toBe(1);
    expect(existsSync(w.lockDir)).toBe(true);

    const credential = await auth.callback(GOOD_CODE);
    expect(credential).toEqual({
      type: "oauth",
      methodID: "oauth-personal",
      access: MARKER_ACCESS,
      refresh: MARKER_ACCESS,
      expires: 0,
      metadata: { profile: "isolated" },
    });
    expect(w.auth.label(credential)).toBe(`Google (${MOCK_EMAIL})`);
    expect(events).toEqual(["login:1"]);
    expect(w.auth.authEpoch()).toBe("1");
    expect(w.auth.state.kind).toBe("signed_in");
    expect(w.location.statusCalls).toEqual([
      { id: "c1", status: undefined },
      { id: "c2", status: undefined },
    ]);
    expect(w.runDirs.createdCount("login")).toBe(1);
    expect(w.runDirs.releasedCount("login")).toBe(1);
    await expectReleased(w);
    const start = readJournal(w.journal).find((e) => e.method === "process/start" && Array.isArray(e.params.argv) && e.params.argv.includes("--login"));
    expect(start?.params.argv).toEqual(["acp", "--gemini-dir", w.config.geminiDir, "--app-data-dir", "antigravity-acp", "--login"]);
    expect(start?.params.display).toBeNull();
  });

  test("without the email in the token file, label returns undefined", async () => {
    const w = loginWorld({ email: "" });
    const credential = await codeMode(await w.auth.authorize()).callback(GOOD_CODE);
    expect(w.auth.label(credential)).toBeUndefined();
  });

  test("bad code: callback rejects with the invalid_grant message; child reaped", async () => {
    const w = loginWorld();
    const auth = codeMode(await w.auth.authorize());
    expect(messageOf(await rejection(auth.callback("bad-code")))).toBe(LOGIN_MESSAGES.invalidGrant);
    await expectReleased(w);
    expect(w.auth.state.kind).toBe("unknown");
  });

  test("bad paste: rejects, nothing written to stdin, all released, a new authorize succeeds at once", async () => {
    const w = loginWorld();
    const auth = codeMode(await w.auth.authorize());
    expect(messageOf(await rejection(auth.callback("two words")))).toBe(LOGIN_MESSAGES.badPaste);
    expect(stdinLines(w.journal)).toBe(0);
    await expectReleased(w);
    const again = codeMode(await w.auth.authorize());
    expect(again.url).toBe(MOCK_AUTH_URL);
    expect(messageOf(await rejection(auth.callback(GOOD_CODE)))).toBe(LOGIN_MESSAGES.replaced);
    await again.callback(GOOD_CODE);
    await expectReleased(w);
  });

  test("cancel then connect: the second authorize does not wait, and the first attempt's deadline does not free the second's lock or hold", async () => {
    const w = loginWorld({ timeouts: { pasteMs: 400 } });
    const first = codeMode(await w.auth.authorize());
    await sleep(200);
    const started = Date.now();
    const second = codeMode(await w.auth.authorize());
    expect(Date.now() - started < 2_000).toBe(true);
    await sleep(250); // past the first attempt's deadline, before the second's
    expect(existsSync(w.lockDir)).toBe(true);
    expect(w.runtime.liveHolds).toBe(1);
    expect(w.auth.state.kind).toBe("login_pending");
    expect(messageOf(await rejection(first.callback(GOOD_CODE)))).toBe(LOGIN_MESSAGES.replaced);
    await second.callback(GOOD_CODE);
    await expectReleased(w);
    expect(w.runtime.holds).toBe(1);
  });

  test("the child exits right before the code is written: no EPIPE, the stopped message", async () => {
    const w = loginWorld({ scenario: ["login-exit-before-code"] });
    const auth = codeMode(await w.auth.authorize());
    await sleep(250);
    expect(messageOf(await rejection(auth.callback(GOOD_CODE)))).toBe(LOGIN_MESSAGES.stopped);
    await expectReleased(w);
  });

  test("abandon timer: child killed, lock and hold released, state restored", async () => {
    const w = loginWorld({ timeouts: { pasteMs: 100 } });
    const auth = codeMode(await w.auth.authorize());
    expect(await waitFor(() => w.auth.state.kind === "unknown", 2_000)).toBe(true);
    await expectReleased(w);
    // O-10: a paste after the window says it expired, not that another sign-in replaced it.
    expect(messageOf(await rejection(auth.callback(GOOD_CODE)))).toBe(LOGIN_MESSAGES.expired);
  });

  test("a second authorize while pending kills the first child; the first callback says replaced", async () => {
    const w = loginWorld();
    const first = codeMode(await w.auth.authorize());
    const firstPid = loginPids(w.journal)[0] ?? 0;
    const second = codeMode(await w.auth.authorize());
    expect(await waitFor(() => !alive(firstPid))).toBe(true);
    expect(messageOf(await rejection(first.callback(GOOD_CODE)))).toBe(LOGIN_MESSAGES.replaced);
    await second.callback(GOOD_CODE);
    await expectReleased(w);
  });

  test("the child exits before the URL: early-exit text without sensitive lines; cleaned up", async () => {
    const w = loginWorld({ scenario: ["login-exit-early"] });
    const message = messageOf(await rejection(w.auth.authorize()));
    expect(message).toBe(`${LOGIN_MESSAGES.earlyExit(3)} ${SAFE_EXIT_LINE}`);
    for (const needle of ["https://", "state=", "code=", "token", "@"]) expect(message.includes(needle)).toBe(false);
    await expectReleased(w);
    expect(w.auth.state.kind).toBe("unknown");
  });

  test("no URL within the timeout: rejects and cleans up", async () => {
    const w = loginWorld({ scenario: ["login-no-url"], timeouts: { urlMs: 200 } });
    expect(messageOf(await rejection(w.auth.authorize()))).toBe(LOGIN_MESSAGES.urlTimeout);
    await expectReleased(w);
  });

  test("an unexpected sign-in link: rejects and cleans up", async () => {
    const w = loginWorld({ scenario: ["login-bad-url"] });
    expect(messageOf(await rejection(w.auth.authorize()))).toBe(LOGIN_MESSAGES.badUrl);
    await expectReleased(w);
  });

  test("auth lock held by another process: authorize rejects at once", async () => {
    const w = loginWorld();
    const other = await acquireDirLock(w.lockDir, { hostname: "other-host" });
    const started = Date.now();
    expect(messageOf(await rejection(w.auth.authorize()))).toBe(LOGIN_MESSAGES.otherWindow);
    expect(Date.now() - started < 1_000).toBe(true);
    expect(loginPids(w.journal).length).toBe(0);
    expect(w.runtime.liveHolds).toBe(0);
    other.releaseSync();
  });

  test("shared mode, probe signed in, no credential: auto mode with an empty URL; isolated mode runs the full login", async () => {
    const shared = loginWorld({ scenario: ["auth-ok"], options: { isolatedAuth: false } });
    const events: string[] = [];
    shared.auth.onAuthChanged((e) => events.push(e.reason));
    const auth = await shared.auth.authorize();
    expect(auth.mode).toBe("auto");
    expect(auth.url).toBe("");
    expect(auth.instructions).toBe(SHARED_READY);
    if (auth.mode !== "auto") throw new Error("unreachable");
    expect((await auth.callback).metadata).toEqual({ profile: "shared" });
    expect(shared.auth.state.kind).toBe("signed_in");
    expect(events).toEqual(["login"]);
    expect(existsSync(shared.lockDir)).toBe(false);
    expect(shared.runtime.liveHolds).toBe(0);
    expect(loginPids(shared.journal).length).toBe(0);

    const isolated = loginWorld({ scenario: ["auth-ok"] });
    expect((await isolated.auth.authorize()).mode).toBe("code");
  });

  test("a config issue rejects with the issue text", async () => {
    const w = loginWorld({ options: { authMethod: "gemini-api-key" } });
    expect(messageOf(await rejection(w.auth.authorize()))).toBe(
      'Antigravity sign-in method "gemini-api-key" is not available in this plugin version. Use "oauth-personal" or remove authMethod.',
    );
  });

  test("the code exchange hangs: rejects after the timeout and cleans up", async () => {
    const w = loginWorld({ scenario: ["login-hang-exchange"], timeouts: { exchangeMs: 200 } });
    const auth = codeMode(await w.auth.authorize());
    expect(messageOf(await rejection(auth.callback(GOOD_CODE)))).toBe(LOGIN_MESSAGES.exchangeTimeout);
    await expectReleased(w);
  });

  test("agy exits 0 but the probe cannot confirm: not-confirmed text; state restored", async () => {
    const w = loginWorld({ scenario: ["auth-signed-out"] });
    const auth = codeMode(await w.auth.authorize());
    expect(messageOf(await rejection(auth.callback(GOOD_CODE)))).toBe(LOGIN_MESSAGES.notConfirmed);
    expect(w.auth.state.kind).toBe("unknown");
    expect(w.auth.authEpoch()).toBe("0");
    await expectReleased(w);
  });

  test("a second sign-in with another email bumps the epoch with account-changed", async () => {
    const w = loginWorld();
    await codeMode(await w.auth.authorize()).callback(GOOD_CODE);
    const binary = writeMockLoginWrapper(w.root, { journal: w.journal, email: "other@example.com", name: "agy2" });
    const config = { ...w.config, binaryPath: binary };
    const env = isolatedEnv(w.root);
    const second = new AuthManager(config, { binary: new BinaryManager(config, { env, log: () => {} }), env, timeouts: FAST, log: () => {} });
    managers.push(second);
    const events: string[] = [];
    second.onAuthChanged((e) => events.push(e.reason));
    await codeMode(await second.authorize()).callback(GOOD_CODE);
    expect(events).toEqual(["account-changed"]);
    expect(second.authEpoch()).toBe("2");
  });

  test("two profiles in one data dir have their own auth lock and epoch (O-12)", async () => {
    const root = temps.make("oa-login-");
    const env = isolatedEnv(root);
    const binaryPath = writeMockLoginWrapper(root);
    const make = (name: string): AuthManager => {
      const config = testConfig(root, { binaryPath, geminiDir: path.join(root, name) });
      const m = new AuthManager(config, { binary: new BinaryManager(config, { env, log: () => {} }), env, timeouts: { ...FAST, epochRereadMs: 0 }, log: () => {} });
      managers.push(m);
      return m;
    };
    const x = make("gemini-x");
    const y = make("gemini-y");
    const pendingX = codeMode(await x.authorize());
    const pendingY = codeMode(await y.authorize()); // not "another OpenCode window"
    await pendingX.callback(GOOD_CODE);
    expect(x.authEpoch()).toBe("1");
    expect(y.authEpoch()).toBe("0");
    expect(messageOf(await rejection(pendingY.callback("two words")))).toBe(LOGIN_MESSAGES.badPaste);
  });
});
