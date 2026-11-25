import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LockBusyError, acquireDirLock } from "../src/install/lock.ts";
import { TempDirs, rejection, waitFor } from "./fixtures/install-helpers.ts";

const LOCK_MODULE = fileURLToPath(new URL("../src/install/lock.ts", import.meta.url));
const temps = new TempDirs();
const children: ChildProcess[] = [];
afterEach(() => {
  while (children.length) children.pop()?.kill("SIGKILL");
  temps.cleanup();
});

function lockPath(): string {
  return path.join(temps.make(), "bin", ".lock");
}

function writeOwner(lockDir: string, owner: { pid: number; hostname: string }, ageMs: number, createdAt = Date.now()): void {
  mkdirSync(lockDir, { recursive: true });
  const file = path.join(lockDir, "owner-feedfeed.json");
  writeFileSync(file, JSON.stringify({ ...owner, token: "feedfeed", createdAt }));
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (typeof r.pid !== "number") throw new Error("no pid");
  return r.pid;
}

function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `import { acquireDirLock } from ${JSON.stringify(LOCK_MODULE)};\n${body}\n`);
  return file;
}

function runChild(script: string, args: string[] = []): Promise<number | null> {
  const child = spawn(process.execPath, [script, ...args], { stdio: "ignore" });
  children.push(child);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

describe("acquireDirLock (IA 6.6)", () => {
  test("a second acquire with waitMs 0 fails while the first holds", async () => {
    const dir = lockPath();
    const first = await acquireDirLock(dir);
    const err = await rejection(acquireDirLock(dir, { waitMs: 0 }));
    expect(err instanceof LockBusyError).toBe(true);
    expect(err instanceof LockBusyError ? err.holder : null).toEqual({ pid: process.pid, hostname: hostname() });
    first.releaseSync();
    expect(existsSync(dir)).toBe(false);
    (await acquireDirLock(dir)).releaseSync();
  });

  test("two child processes race: exactly one holds at a time, both finish", async () => {
    const root = temps.make();
    const dir = path.join(root, ".lock");
    const log = path.join(root, "log.txt");
    const script = writeScript(
      root,
      "racer.ts",
      `import { appendFileSync } from "node:fs";
const [lockDir, log] = process.argv.slice(2);
const lock = await acquireDirLock(lockDir, { waitMs: 10_000, pollMs: 20 });
appendFileSync(log, "start " + process.pid + "\\n");
await new Promise((r) => setTimeout(r, 150));
appendFileSync(log, "end " + process.pid + "\\n");
lock.releaseSync();`,
    );
    const codes = await Promise.all([runChild(script, [dir, log]), runChild(script, [dir, log])]);
    expect(codes).toEqual([0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBe(4);
    const [s1, e1, s2, e2] = lines.map((l) => l.split(" "));
    expect(s1?.[0]).toBe("start");
    expect(e1).toEqual(["end", s1?.[1] ?? ""]);
    expect(s2?.[0]).toBe("start");
    expect(e2).toEqual(["end", s2?.[1] ?? ""]);
    expect(s1?.[1] === s2?.[1]).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("same host, dead pid: taken over", async () => {
    const dir = lockPath();
    writeOwner(dir, { pid: deadPid(), hostname: hostname() }, 0);
    const lock = await acquireDirLock(dir, { waitMs: 0 });
    expect(readdirSync(dir)).toEqual([`owner-${lock.token}.json`]);
    lock.releaseSync();
  });

  test("same host, live pid, a heartbeat older than staleMs but under sameHostStaleMs (laptop sleep): not taken over", async () => {
    const dir = lockPath();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    children.push(sleeper);
    if (typeof sleeper.pid !== "number") throw new Error("no pid");
    writeOwner(dir, { pid: sleeper.pid, hostname: hostname() }, 10 * 60_000);
    const err = await rejection(acquireDirLock(dir, { waitMs: 0, staleMs: 100 }));
    expect(err instanceof LockBusyError).toBe(true);
    sleeper.kill("SIGKILL");
    await new Promise((r) => sleeper.once("exit", r));
    (await acquireDirLock(dir, { waitMs: 0 })).releaseSync();
  });

  test("another hostname: taken over when older than staleMs, kept when fresh", async () => {
    const dir = lockPath();
    writeOwner(dir, { pid: 1, hostname: "other-host" }, 0);
    expect((await rejection(acquireDirLock(dir, { waitMs: 0, staleMs: 5_000 }))) instanceof LockBusyError).toBe(true);
    writeOwner(dir, { pid: 1, hostname: "other-host" }, 10_000);
    const lock = await acquireDirLock(dir, { waitMs: 0, staleMs: 5_000 });
    lock.releaseSync();
  });

  test("a lock dir without an owner file: kept while fresh, taken over when older than staleMs", async () => {
    const dir = lockPath();
    mkdirSync(dir, { recursive: true });
    expect((await rejection(acquireDirLock(dir, { waitMs: 0, staleMs: 5_000 }))) instanceof LockBusyError).toBe(true);
    const old = new Date(Date.now() - 10_000);
    utimesSync(dir, old, old);
    (await acquireDirLock(dir, { waitMs: 0, staleMs: 5_000 })).releaseSync();
  });

  test("waits for a holder and gets the lock when it frees", async () => {
    const dir = lockPath();
    const first = await acquireDirLock(dir);
    let waits = 0;
    setTimeout(() => first.releaseSync(), 100);
    const second = await acquireDirLock(dir, { waitMs: 2_000, pollMs: 20, onWait: () => waits++ });
    expect(waits > 0).toBe(true);
    second.releaseSync();
  });

  test("release only removes its own lock: ENOENT after a takeover, ENOTEMPTY with a foreign owner", async () => {
    const dir = lockPath();
    const old = await acquireDirLock(dir, { hostname: "sleeping-laptop" });
    const ownerFile = path.join(dir, `owner-${old.token}.json`);
    const past = new Date(Date.now() - 10_000);
    utimesSync(ownerFile, past, past);
    const fresh = await acquireDirLock(dir, { waitMs: 0, staleMs: 1_000 });
    old.releaseSync();
    expect(readdirSync(dir)).toEqual([`owner-${fresh.token}.json`]);
    // A second owner file appears (another contender mid-takeover): rmdir fails and the dir stays.
    writeFileSync(path.join(dir, "owner-other.json"), "{}");
    fresh.releaseSync();
    expect(readdirSync(dir)).toEqual(["owner-other.json"]);
  });

  test("a leftover .lock.stale-* is removed when seen", async () => {
    const dir = lockPath();
    const leftover = `${dir}.stale-abc`;
    mkdirSync(path.join(leftover, "x"), { recursive: true });
    (await acquireDirLock(dir)).releaseSync();
    expect(existsSync(leftover)).toBe(false);
  });

  test("releaseSync runs from a child's process.on('exit')", async () => {
    const root = temps.make();
    const dir = path.join(root, ".lock");
    const marker = path.join(root, "held");
    const script = writeScript(
      root,
      "exiter.ts",
      `import { writeFileSync } from "node:fs";
const [lockDir, marker] = process.argv.slice(2);
await acquireDirLock(lockDir);
writeFileSync(marker, "1");
process.exit(0);`,
    );
    expect(await runChild(script, [dir, marker])).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("acquiring and releasing 20 times leaves no extra exit listeners", async () => {
    const dir = lockPath();
    const before = process.listenerCount("exit");
    for (let i = 0; i < 20; i++) (await acquireDirLock(dir)).releaseSync();
    expect(process.listenerCount("exit")).toBe(before);
    expect(await waitFor(() => !existsSync(dir))).toBe(true);
  });

  test("same host, pid reused after a reboot: an owner created before boot is taken over (O-3)", async () => {
    const dir = lockPath();
    // Our own pid is alive; the owner file says it was created an hour before this boot.
    writeOwner(dir, { pid: process.pid, hostname: hostname() }, 0, Date.now() - 2 * 60 * 60_000);
    const lock = await acquireDirLock(dir, { waitMs: 0, bootTimeMs: Date.now() - 60 * 60_000 });
    lock.releaseSync();
  });

  test("same host, live pid with a 3-day-old heartbeat (pid 1): taken over with the default rules (O-3)", async () => {
    const dir = lockPath();
    writeOwner(dir, { pid: 1, hostname: hostname() }, 3 * 24 * 60 * 60_000, Date.now());
    const lock = await acquireDirLock(dir, { waitMs: 0 });
    lock.releaseSync();
  });
});
