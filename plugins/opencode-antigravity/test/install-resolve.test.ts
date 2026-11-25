import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BinaryManager, BinaryNotFoundError, describeBinaryStatus, LOCK_BUSY_MESSAGE } from "../src/install/binary-manager.ts";
import { acquireDirLock } from "../src/install/lock.ts";
import { resolveInstallAuthConfig } from "../src/install/config.ts";
import { explicitPathMessage, pathCandidates, PATH_NOT_FOUND_MESSAGE, T3_NOT_FOUND_MESSAGE } from "../src/install/resolve.ts";
import { tooOldMessage } from "../src/install/verify.ts";
import { MOCK_AGY_PATH, readJournal, writeMockAgyWrapper } from "./fixtures/mock-agy.ts";
import { TempDirs, messageOf, mockAgyScript, rejection, waitFor } from "./fixtures/install-helpers.ts";
import { assetHits, fakeRelease, hostTarget, releaseWorld, type ReleaseWorld } from "./fixtures/release-world.ts";

const temps = new TempDirs();
const worlds: ReleaseWorld[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()?.stop();
  temps.cleanup();
});

function world(options: Record<string, unknown> = {}, env: Record<string, string> = {}): ReleaseWorld {
  const w = releaseWorld(temps, options);
  Object.assign(w.env, env);
  worlds.push(w);
  return w;
}

function managerFor(w: ReleaseWorld, options: Record<string, unknown>, log: string[] = [], timeouts = {}): BinaryManager {
  const config = resolveInstallAuthConfig(options, w.env).config;
  return new BinaryManager(config, { fetch: w.fetch, env: w.env, log: (l) => log.push(l), timeouts: { lockPollMs: 20, ...timeouts } });
}

function binDir(w: ReleaseWorld, name: string): string {
  const dir = path.join(w.root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resolution order (IA 5)", () => {
  test("explicit option beats env beats source", async () => {
    const w = world();
    const optDir = binDir(w, "opt");
    const envDir = binDir(w, "env");
    const pathDir = binDir(w, "on-path");
    const optAgy = writeMockAgyWrapper(optDir);
    const envAgy = writeMockAgyWrapper(envDir);
    writeMockAgyWrapper(pathDir);
    w.env.PATH = pathDir;
    w.env.OPENCODE_ANTIGRAVITY_BIN = envAgy;
    const fromOption = await managerFor(w, { binaryPath: optAgy, binarySource: "path" }).resolveBinary();
    expect(fromOption).toEqual({ path: optAgy, version: "1.5.15", source: "explicit" });
    const fromEnv = await managerFor(w, { binarySource: "path" }).resolveBinary();
    expect(fromEnv.path).toBe(envAgy);
    delete w.env.OPENCODE_ANTIGRAVITY_BIN;
    const fromSource = await managerFor(w, { binarySource: "path" }).resolveBinary();
    expect(fromSource.source).toBe("path");
    expect(w.fetchCalls.length).toBe(0);
  });

  test("an explicit broken path throws with no fallback and no download", async () => {
    const w = world();
    const pathDir = binDir(w, "on-path");
    writeMockAgyWrapper(pathDir);
    w.env.PATH = pathDir;
    const missing = path.join(w.root, "nope", "agy");
    const err = await rejection(managerFor(w, { binaryPath: missing }).resolveBinary());
    expect(err instanceof BinaryNotFoundError).toBe(true);
    expect(messageOf(err)).toBe(explicitPathMessage(missing));
    expect(w.fetchCalls.length).toBe(0);
  });

  test("a relative binaryPath such as bin/agy fails with the step 1 message and never downloads", async () => {
    const w = world();
    w.publish(fakeRelease("1.5.16"));
    const err = await rejection(managerFor(w, { binaryPath: "bin/agy" }).resolveBinary());
    expect(messageOf(err)).toBe(explicitPathMessage("bin/agy"));
    expect(w.fetchCalls.length).toBe(0);
  });

  test("a non-agy file at binaryPath fails at once; too old gives the version text", async () => {
    const w = world();
    const wrong = writeMockAgyWrapper(binDir(w, "wrong"), { scenario: "wrong-name" });
    expect(messageOf(await rejection(managerFor(w, { binaryPath: wrong }).resolveBinary())).includes("did not answer as the Antigravity CLI")).toBe(true);
    const old = writeMockAgyWrapper(binDir(w, "old"), { agyVersion: "1.4.9" });
    expect(messageOf(await rejection(managerFor(w, { binaryPath: old }).resolveBinary()))).toBe(tooOldMessage("1.4.9", old));
  });

  test("the identity check runs once per (realpath, size, mtime) in this process", async () => {
    const w = world();
    const journal = path.join(w.root, "journal.jsonl");
    const agy = writeMockAgyWrapper(binDir(w, "j"), { journal });
    const m = managerFor(w, { binaryPath: agy });
    await m.resolveBinary();
    await m.resolveBinary();
    expect(readJournal(journal).filter((e) => e.method === "initialize").length).toBe(1);
  });
});

describe('binarySource: "path"', () => {
  test("finds a fake agy on an injected PATH; antigravity, a dir named agy and a failing agy are skipped", async () => {
    const w = world();
    const ideDir = binDir(w, "ide");
    writeMockAgyWrapper(ideDir, { name: "antigravity" });
    const dirAgy = binDir(w, "diragy");
    mkdirSync(path.join(dirAgy, "agy"));
    const failing = binDir(w, "failing");
    writeMockAgyWrapper(failing, { scenario: "wrong-name" });
    const good = binDir(w, "good");
    const goodAgy = writeMockAgyWrapper(good);
    w.env.PATH = [ideDir, dirAgy, failing, good].join(path.delimiter);
    const resolved = await managerFor(w, { binarySource: "path" }).resolveBinary();
    expect(resolved).toEqual({ path: goodAgy, version: "1.5.15", source: "path" });
  });

  test("none found gives the path text", async () => {
    const w = world();
    expect(messageOf(await rejection(managerFor(w, { binarySource: "path" }).resolveBinary()))).toBe(PATH_NOT_FOUND_MESSAGE);
  });

  test("Windows-style Path key is honored and agy.exe is searched", () => {
    const root = temps.make();
    const dir = path.join(root, "win");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "agy.exe"), "MZ");
    writeFileSync(path.join(dir, "agy"), "not this one");
    const found = pathCandidates({ Path: dir, HOME: root }, "win32");
    expect(found).toEqual([path.join(dir, "agy.exe")]);
  });
});

describe('binarySource: "t3code"', () => {
  function t3Tree(w: ReleaseWorld, opts: { releaseId?: string; recordId?: string; bytesDelta?: number; symlinkExe?: boolean } = {}): string {
    const target = hostTarget();
    const releaseId = opts.releaseId ?? "b03a84".padEnd(64, "0");
    const platformDir = path.join(w.root, "t3", "tools", "antigravity-acp", target.dirKey);
    const dir = path.join(platformDir, "versions", releaseId);
    mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, target.executableName);
    const script = mockAgyScript(MOCK_AGY_PATH, { version: "1.5.15" });
    if (opts.symlinkExe) {
      const real = path.join(w.root, "real-antigravity");
      writeFileSync(real, script, { mode: 0o755 });
      symlinkSync(real, exe);
    } else {
      writeFileSync(exe, script, { mode: 0o555 });
    }
    const bytes = statSync(exe).size + (opts.bytesDelta ?? 0);
    writeFileSync(path.join(platformDir, "active.json"), JSON.stringify({ releaseId }));
    writeFileSync(
      path.join(dir, ".install-complete.json"),
      JSON.stringify({ releaseId: opts.recordId ?? releaseId, version: "1.5.15", executable: { name: target.executableName, bytes } }),
    );
    return exe;
  }

  test("a valid tree resolves", async () => {
    const w = world();
    const exe = t3Tree(w);
    expect(await managerFor(w, { binarySource: "t3code" }).resolveBinary()).toEqual({ path: exe, version: "1.5.15", source: "t3code" });
  });

  for (const [name, opts] of [
    ["size mismatch", { bytesDelta: 1 }],
    ["non-hex releaseId", { releaseId: "z".repeat(64) }],
    ["record id mismatch", { recordId: "c".repeat(64) }],
    ["symlinked executable", { symlinkExe: true }],
  ] as const) {
    test(`refused: ${name}`, async () => {
      const w = world();
      t3Tree(w, opts);
      expect(messageOf(await rejection(managerFor(w, { binarySource: "t3code" }).resolveBinary()))).toBe(T3_NOT_FOUND_MESSAGE);
    });
  }
});

describe("managed fallbacks and updates (IA 5 step 4, 6.8)", () => {
  test("unreachable manifest with offlineFallback: PATH hit used, one log line; without: BinaryNotFoundError", async () => {
    const w = world();
    w.failManifest(503);
    const pathDir = binDir(w, "on-path");
    const agy = writeMockAgyWrapper(pathDir);
    w.env.PATH = pathDir;
    const log: string[] = [];
    const m = managerFor(w, {}, log);
    const first = await m.resolveBinary();
    expect(first).toEqual({ path: agy, version: "1.5.15", source: "path" });
    await m.resolveBinary();
    expect(log.length).toBe(1);
    expect(log[0]?.startsWith("[opencode-antigravity] Managed agy unavailable (")).toBe(true);
    expect(log[0]?.endsWith(`; using path at ${agy}.`)).toBe(true);

    const err = await rejection(managerFor(w, { offlineFallback: false }).resolveBinary());
    expect(err instanceof BinaryNotFoundError).toBe(true);
    expect(messageOf(err)).toBe("Google's Antigravity update service returned an unexpected answer. Try again later, or set binaryPath.");
  });

  test("offline: true makes no fetch call at all", async () => {
    const w = world();
    w.publish(fakeRelease("1.5.16"));
    const pathDir = binDir(w, "on-path");
    writeMockAgyWrapper(pathDir);
    w.env.PATH = pathDir;
    const resolved = await managerFor(w, { offline: true }, []).resolveBinary();
    expect(resolved.source).toBe("path");
    expect(w.fetchCalls.length).toBe(0);
    const err = await rejection(managerFor(w, { offline: true, offlineFallback: false }).resolveBinary());
    expect(err instanceof BinaryNotFoundError).toBe(true);
    expect(w.fetchCalls.length).toBe(0);
  });

  test("update: a newer manifest installs in the background and onBinaryChanged fires once; an older one installs nothing", async () => {
    const w = world();
    const r1 = fakeRelease("1.5.16");
    w.publish(r1);
    const m = managerFor(w, {}, [], { updateIntervalMs: 0 });
    const changes: string[] = [];
    m.onBinaryChanged((e) => changes.push(e.version));
    const first = await m.resolveBinary();
    expect(first.version).toBe("1.5.16");
    await m.idle();

    const r2 = fakeRelease("1.5.17");
    w.publish(r2);
    const during = await m.resolveBinary();
    expect(during.version).toBe("1.5.16"); // a request never waits on an update
    await m.idle();
    expect(changes).toEqual(["1.5.17"]);
    const after = await m.resolveBinary();
    expect(after.version).toBe("1.5.17");
    await m.idle();
    expect(changes).toEqual(["1.5.17"]);

    const hits = assetHits(w);
    w.publish(fakeRelease("1.5.10"));
    await m.resolveBinary();
    await m.idle();
    expect(assetHits(w)).toBe(hits);
    expect((await m.resolveBinary()).version).toBe("1.5.17");
  });

  test("autoUpdate: false fetches the manifest only when nothing is installed", async () => {
    const w = world();
    w.publish(fakeRelease("1.5.16"));
    const m = managerFor(w, { autoUpdate: false }, [], { updateIntervalMs: 0 });
    await m.resolveBinary();
    const calls = w.fetchCalls.length;
    w.publish(fakeRelease("1.5.17"));
    await m.resolveBinary();
    await m.idle();
    expect(w.fetchCalls.length).toBe(calls);
  });

  test("waitMs: a slow first download gives the progress text while the install continues", async () => {
    const w = world();
    w.publish(fakeRelease("1.5.16"));
    w.assetDelayMs = 400;
    const m = managerFor(w, {});
    const err = await rejection(m.resolveBinary({ waitMs: 50 }));
    expect(err instanceof BinaryNotFoundError).toBe(true);
    expect(messageOf(err)).toBe(describeBinaryStatus({ phase: "downloading", bytes: 0, total: null }));
    await m.idle();
    expect((await m.resolveBinary({ waitMs: 50 })).version).toBe("1.5.16");
    expect(assetHits(w)).toBe(1);
  });

  test("status reports ready with the source after a resolve", async () => {
    const w = world();
    const agy = writeMockAgyWrapper(binDir(w, "x"));
    const m = managerFor(w, { binaryPath: agy });
    await m.resolveBinary();
    expect(m.status()).toEqual({ phase: "ready", source: "explicit", version: "1.5.15" });
  });

  test("startBackground: installs when nothing is installed, without a request", async () => {
    const w = world();
    w.publish(fakeRelease("1.5.16"));
    const m = managerFor(w, {});
    m.startBackground();
    expect(await waitFor(() => assetHits(w) === 1, 4_000)).toBe(true);
    await m.idle();
    expect((await m.resolveBinary()).version).toBe("1.5.16");
    expect(assetHits(w)).toBe(1);
  });

  test("another process holds the install lock: waiting_for_lock with its progress, then the lock-busy text", async () => {
    const w = world();
    w.publish(fakeRelease("1.5.16"));
    mkdirSync(w.dirs.platformDir, { recursive: true });
    const other = await acquireDirLock(w.dirs.lockDir, { hostname: "other-host" });
    writeFileSync(w.dirs.progressFile, JSON.stringify({ bytes: 5, total: 10 }));
    const m = managerFor(w, {}, [], { lockWaitMs: 400 });
    const pending = rejection(m.resolveBinary({ waitMs: 2_000 }));
    expect(await waitFor(() => m.status().phase === "waiting_for_lock")).toBe(true);
    expect(m.status()).toEqual({ phase: "waiting_for_lock", bytes: 5, total: 10 });
    const err = await pending;
    expect(messageOf(err)).toBe(LOCK_BUSY_MESSAGE);
    expect(assetHits(w)).toBe(0);
    other.releaseSync();
  });
});
