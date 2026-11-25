import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import path from "node:path";
import { SessionStore, bindingIdFor } from "../../src/session-store.ts";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stores(count: number): SessionStore[] {
  const root = mkdtempSync(path.join(tmpdir(), "agy-lock-"));
  tempDirs.push(root);
  const geminiDir = path.join(root, "gemini");
  mkdirSync(geminiDir, { recursive: true });
  return Array.from(
    { length: count },
    (_, i) =>
      new SessionStore({
        dataDir: path.join(root, "data"),
        geminiDir,
        poolId: `pool-${i}`,
        authEpoch: () => "1",
        isPluginOwnedProfile: () => true,
        sessionTtlDays: 14,
        maxStoredSessions: 500,
      }),
  );
}

function pair(): { a: SessionStore; b: SessionStore } {
  const root = mkdtempSync(path.join(tmpdir(), "agy-lock-"));
  tempDirs.push(root);
  const geminiDir = path.join(root, "gemini");
  mkdirSync(geminiDir, { recursive: true });
  const make = (poolId: string): SessionStore =>
    new SessionStore({
      dataDir: path.join(root, "data"),
      geminiDir,
      poolId,
      authEpoch: () => "1",
      isPluginOwnedProfile: () => true,
      sessionTtlDays: 14,
      maxStoredSessions: 500,
    });
  return { a: make("pool-a"), b: make("pool-b") };
}

function lockFile(store: SessionStore, sessionKey: string): string {
  return path.join(store.dir, `${bindingIdFor(sessionKey)}.lock`);
}

function writeForeignLock(store: SessionStore, sessionKey: string, lock: { pid: number; host: string }, ageMs: number): string {
  mkdirSync(store.dir, { recursive: true });
  const file = lockFile(store, sessionKey);
  writeFileSync(file, JSON.stringify({ ...lock, poolId: "pool-x", token: "ab".repeat(16), acquiredAt: Date.now() - ageMs }));
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
  return file;
}

function sleeper(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  return child.pid ?? 0;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return pid;
}

function holder(file: string): string {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof value === "object" && value !== null && "poolId" in value && typeof value.poolId === "string" ? value.poolId : "";
}

const HOUR = 60 * 60 * 1000;

describe("cross-process binding locks", () => {
  test("same host, live pid, fresh heartbeat: not stolen", async () => {
    const { a } = pair();
    const file = writeForeignLock(a, "ses", { pid: sleeper(), host: hostname() }, 60_000);
    expect(await a.lock("ses")).toBeNull();
    expect(holder(file)).toBe("pool-x");
  });

  test("O-3: same host, live pid (reused), heartbeat 1 h old: stolen", async () => {
    const { a } = pair();
    const file = writeForeignLock(a, "ses", { pid: sleeper(), host: hostname() }, HOUR);
    expect((await a.lock("ses"))?.sessionKey).toBe("ses");
    expect(holder(file)).toBe("pool-a");
  });

  test("O-3: same host, live pid, acquired before this boot: stolen even with a fresh heartbeat", async () => {
    const { a } = pair();
    const file = writeForeignLock(a, "ses", { pid: sleeper(), host: hostname() }, 0);
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const bootedAt = Date.now() - uptime() * 1000;
    writeFileSync(file, JSON.stringify({ ...(typeof value === "object" && value !== null ? value : {}), acquiredAt: bootedAt - HOUR }));
    expect((await a.lock("ses"))?.sessionKey).toBe("ses");
    expect(holder(file)).toBe("pool-a");
  });

  test("same host, dead pid: stolen", async () => {
    const { a } = pair();
    const file = writeForeignLock(a, "ses", { pid: await deadPid(), host: hostname() }, 0);
    expect((await a.lock("ses"))?.sessionKey).toBe("ses");
    expect(holder(file)).toBe("pool-a");
  });

  test("other host: stolen after 5 min without a touch, respected before", async () => {
    const { a } = pair();
    writeForeignLock(a, "fresh", { pid: 1, host: "other-host" }, 60_000);
    expect(await a.lock("fresh")).toBeNull();
    const file = writeForeignLock(a, "old", { pid: 1, host: "other-host" }, 6 * 60_000);
    expect((await a.lock("old"))?.sessionKey).toBe("old");
    expect(holder(file)).toBe("pool-a");
  });

  test("an unreadable lock is judged by its mtime", async () => {
    const { a } = pair();
    mkdirSync(a.dir, { recursive: true });
    const file = lockFile(a, "ses");
    writeFileSync(file, "");
    expect(await a.lock("ses")).toBeNull();
    const at = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, at, at);
    expect((await a.lock("ses"))?.sessionKey).toBe("ses");
  });

  test("another pool in this process holds its lock", async () => {
    const { a, b } = pair();
    const lock = await a.lock("ses");
    expect(lock?.sessionKey).toBe("ses");
    expect(await b.lock("ses")).toBeNull();
    await lock?.release();
    expect((await b.lock("ses"))?.sessionKey).toBe("ses");
  });

  test("release leaves a lock that someone else took over", async () => {
    const { a } = pair();
    const lock = await a.lock("ses");
    const file = lockFile(a, "ses");
    // Another pool took the lock over (for example after judging ours stale).
    writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), poolId: "pool-b", token: "cd".repeat(16), acquiredAt: Date.now() }));
    await lock?.release();
    expect(existsSync(file)).toBe(true);
    expect(holder(file)).toBe("pool-b");
  });

  test("release with our pool id but another token leaves the file", async () => {
    const { a } = pair();
    const lock = await a.lock("ses");
    const file = lockFile(a, "ses");
    writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), poolId: "pool-a", token: "ee".repeat(16), acquiredAt: Date.now() }));
    await lock?.release();
    expect(existsSync(file)).toBe(true);
  });

  test("exit cleanup removes only this pool's own locks", async () => {
    const { a, b } = pair();
    await a.lock("mine-1");
    await a.lock("mine-2");
    await b.lock("theirs");
    const takenOver = await a.lock("taken");
    expect(takenOver?.sessionKey).toBe("taken");
    writeFileSync(lockFile(a, "taken"), JSON.stringify({ pid: process.pid, host: hostname(), poolId: "pool-b", token: "cd".repeat(16), acquiredAt: Date.now() }));
    a.releaseLocksSync();
    expect(existsSync(lockFile(a, "mine-1"))).toBe(false);
    expect(existsSync(lockFile(a, "mine-2"))).toBe(false);
    expect(existsSync(lockFile(a, "theirs"))).toBe(true);
    expect(existsSync(lockFile(a, "taken"))).toBe(true);
    await b.close();
    expect(existsSync(lockFile(b, "theirs"))).toBe(false);
  });

  test("contenders racing for one stale lock: exactly one wins", async () => {
    const dead = await deadPid();
    for (let round = 0; round < 20; round += 1) {
      const contenders = stores(6);
      const file = writeForeignLock(contenders[0], `ses-${round}`, { pid: dead, host: hostname() }, 0);
      const locks = await Promise.all(contenders.map((store) => store.lock(`ses-${round}`)));
      const winners = locks.filter((lock) => lock !== null);
      expect(winners.length).toBe(1);
      const winner = contenders[locks.findIndex((lock) => lock !== null)];
      expect(holder(file)).toBe(`pool-${contenders.indexOf(winner)}`);
      expect(existsSync(`${file}.takeover`)).toBe(false);
    }
  });
});
