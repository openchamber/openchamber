import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OwnerRegistry, UnsafeRunRootError, createRunDir, defaultRunRoot, isLiveRunDir, isPidAlive, sweepStaleRunDirs } from "../../src/tmp-sweeper.ts";

const dirs: string[] = [];
const children: Array<{ kill: () => void }> = [];
afterEach(() => {
  while (children.length) children.pop()?.kill();
  while (dirs.length) {
    const d = dirs.pop() ?? "";
    try {
      chmodSync(d, 0o700);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(r.stdout.toString());
}

function livePid(): number {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push({ kill: () => child.kill("SIGKILL") });
  return child.pid ?? -1;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

describe("createRunDir", () => {
  test("mode 0700, owner.json, in the live set until release", async () => {
    const root = temp("agy-run-");
    const dir = await createRunDir("login", { root, poolId: "pool1" });
    expect(path.basename(dir.path)).toMatch(new RegExp(`^run-${process.pid}-\\d+-[0-9a-f]{6}$`));
    expect(statSync(dir.path).mode & 0o777).toBe(0o700);
    const owner: unknown = JSON.parse(readFileSync(path.join(dir.path, "owner.json"), "utf8"));
    expect(owner).toEqual({ pid: process.pid, startedAt: expect.any(Number), poolId: "pool1", kind: "login" });
    expect(isLiveRunDir(dir.path)).toBe(true);
    await dir.release();
    expect(isLiveRunDir(dir.path)).toBe(false);
    expect(existsSync(dir.path)).toBe(false);
    await dir.release(); // idempotent
  });
});

describe("sweepStaleRunDirs", () => {
  test("removes a dead pid's dir, keeps a live one, removes trash", async () => {
    const root = temp("agy-run-");
    const now = Date.now();
    const dead = path.join(root, `run-${deadPid()}-${now}-abcdef`);
    const live = path.join(root, `run-${livePid()}-${now}-abcdef`);
    const trash = path.join(root, "trash-123");
    for (const d of [dead, live, trash]) mkdirSync(d);
    const { removed } = await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-") });
    expect(removed).toContain(dead);
    expect(removed).toContain(trash);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    await settle();
    expect(readdirSync(root).filter((n) => n.startsWith("trash-"))).toEqual([]);
  });

  test("our own pid: a leftover is removed, a live login dir survives until release", async () => {
    const root = temp("agy-run-");
    const leftover = path.join(root, `run-${process.pid}-${Date.now()}-0a0a0a`);
    mkdirSync(leftover);
    const login = await createRunDir("login", { root });
    await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-") });
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(login.path)).toBe(true);
    await login.release();
    await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-") });
    expect(existsSync(login.path)).toBe(false);
  });

  test("older than 7 days is removed whatever the pid says", async () => {
    const root = temp("agy-run-");
    const old = path.join(root, `run-${livePid()}-${Date.now() - 8 * 24 * 3600_000}-abcdef`);
    mkdirSync(old);
    await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-") });
    expect(existsSync(old)).toBe(false);
  });

  test("prototype leftovers older than 24 h are removed, fresh ones kept", async () => {
    const root = temp("agy-run-");
    const legacy = temp("legacy-");
    const oldRun = path.join(legacy, "opencode-agy-run-old");
    const oldLogin = path.join(legacy, "opencode-agy-login-old");
    const fresh = path.join(legacy, "opencode-agy-run-fresh");
    const other = path.join(legacy, "something-else");
    for (const d of [oldRun, oldLogin, fresh, other]) mkdirSync(d);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
    for (const d of [oldRun, oldLogin, other]) utimesSync(d, twoDaysAgo, twoDaysAgo);
    await sweepStaleRunDirs({ root, legacyRoot: legacy });
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(oldLogin)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  test("never throws: unreadable root, missing root", async () => {
    const root = temp("agy-run-");
    mkdirSync(path.join(root, `run-${deadPid()}-${Date.now()}-abcdef`));
    chmodSync(root, 0o000);
    await sweepStaleRunDirs({ root, legacyRoot: root });
    chmodSync(root, 0o700);
    await sweepStaleRunDirs({ root: path.join(root, "missing"), legacyRoot: path.join(root, "missing") });
  });

  test("agy's own tmp is retired only when no other live process owns the profile", async () => {
    const root = temp("agy-run-");
    const data = temp("agy-data-");
    const g = temp("agy-gemini-");
    const agyTmp = path.join(g, "antigravity-acp", "tmp");
    mkdirSync(agyTmp, { recursive: true });
    const owners = new OwnerRegistry(data, "poolA");
    await owners.register();
    // Another live process on this host owns the gemini dir.
    const other = livePid();
    writeFileSync(path.join(data, "owners", `${other}.json`), JSON.stringify({ pid: other, host: (await import("node:os")).hostname(), poolId: "poolB", token: "t" }));
    await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-"), geminiDir: g, owners });
    expect(existsSync(agyTmp)).toBe(true);
    // The other one dies: its entry is removed and the tmp retired.
    const dead = deadPid();
    rmSync(path.join(data, "owners", `${other}.json`));
    writeFileSync(path.join(data, "owners", `${dead}.json`), JSON.stringify({ pid: dead, host: (await import("node:os")).hostname(), poolId: "poolC", token: "t" }));
    await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-"), geminiDir: g, owners });
    expect(existsSync(agyTmp)).toBe(false);
    expect(existsSync(path.join(data, "owners", `${dead}.json`))).toBe(false);
    await owners.unregister();
    expect(existsSync(path.join(data, "owners", `${process.pid}.json`))).toBe(false);
  });
});

describe("run root safety (O-4)", () => {
  test("the default root is per user on POSIX", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    expect(defaultRunRoot()).toBe(path.join(tmpdir(), `opencode-antigravity-${process.getuid()}`));
  });

  test("an existing world-writable root of ours is tightened to 0700; a symlinked root is refused", async () => {
    if (process.platform === "win32") return;
    const base = temp("agy-root-");
    const root = path.join(base, "root");
    mkdirSync(root, { mode: 0o777 });
    chmodSync(root, 0o777);
    const dir = await createRunDir("runtime", { root });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    await dir.release();
    const target = path.join(base, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    const link = path.join(base, "link");
    symlinkSync(target, link);
    let err: unknown = null;
    await createRunDir("runtime", { root: link }).catch((e: unknown) => {
      err = e;
    });
    expect(err).toBeInstanceOf(UnsafeRunRootError);
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("agy tmp and this pool's own children (O-11)", () => {
  test("agy's tmp is not retired while this pool's login dir is live; it is after the release", async () => {
    const root = temp("agy-run-");
    const data = temp("agy-data-");
    const g = temp("agy-gemini-");
    const agyTmp = path.join(g, "antigravity-acp", "tmp");
    mkdirSync(agyTmp, { recursive: true });
    const owners = new OwnerRegistry(data, "poolA");
    await owners.register();
    const login = await createRunDir("login", { root, poolId: "poolA" });
    // Another pool's live dir does not hold this profile's tmp.
    const foreign = await createRunDir("probe", { root, poolId: "poolZ" });
    await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-"), geminiDir: g, owners });
    expect(existsSync(agyTmp)).toBe(true);
    await login.release();
    await sweepStaleRunDirs({ root, legacyRoot: temp("legacy-"), geminiDir: g, owners });
    expect(existsSync(agyTmp)).toBe(false);
    await foreign.release();
    await owners.unregister();
  });
});

describe("OwnerRegistry", () => {
  test("unregister leaves a file another pool took over", async () => {
    const data = temp("agy-data-");
    const a = new OwnerRegistry(data, "poolA");
    await a.register();
    const b = new OwnerRegistry(data, "poolB");
    await b.register(); // same pid, newer pool overwrote the file
    a.unregisterSync();
    expect(existsSync(path.join(data, "owners", `${process.pid}.json`))).toBe(true);
    await b.unregister();
    expect(existsSync(path.join(data, "owners", `${process.pid}.json`))).toBe(false);
  });

  test("isPidAlive: ESRCH is dead, EPERM counts as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(deadPid())).toBe(false);
    expect(isPidAlive(1)).toBe(true); // launchd/init: EPERM
    expect(isPidAlive(-5)).toBe(false);
  });
});
