// Private TMPDIR per agy run and cleanup after crashes (SR 3.6). Every RunDir not yet released is in a
// process-global live set, so a sweep run by this process never deletes a live login, probe or runtime
// dir. Deletion is rename-then-delete, so a respawn never waits on removing a large unpacked runtime.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { RUN_DIRS_GLOBAL_KEY } from "./constants.ts";
import type { RunDir, RunDirKind } from "./contracts.ts";

const RUN_PREFIX = "run-";
const TRASH_PREFIX = "trash-";
const LEGACY_PREFIXES = ["opencode-agy-run-", "opencode-agy-login-"];
const RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Process-global, shared by every copy of this module (a reloaded plugin instance included). */
function live(): Set<unknown> {
  const existing: unknown = Reflect.get(globalThis, RUN_DIRS_GLOBAL_KEY);
  if (existing instanceof Set) return existing;
  const set = new Set<unknown>();
  Reflect.set(globalThis, RUN_DIRS_GLOBAL_KEY, set);
  return set;
}

/**
 * The default root: `<os.tmpdir()>/opencode-antigravity-<uid>` on POSIX, where `os.tmpdir()` (`/tmp` on
 * Linux) is shared by every user, so one user's root never blocks or hosts another's (O-4). Windows'
 * temp dir is already per user.
 */
export function defaultRunRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return path.join(tmpdir(), uid === null ? "opencode-antigravity" : `opencode-antigravity-${uid}`);
}

export class UnsafeRunRootError extends Error {
  constructor(root: string, reason: string) {
    super(`The Antigravity temp dir ${root} is not safe to use: ${reason}.`);
    this.name = "UnsafeRunRootError";
  }
}

/**
 * Creates the root (0700) or checks an existing one: a real directory, not a symlink, owned by this
 * user. A group- or world-accessible root of ours is tightened to 0700 (O-4). POSIX only.
 */
export async function ensureRunRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new UnsafeRunRootError(root, "it is a symlink");
  if (!info.isDirectory()) throw new UnsafeRunRootError(root, "it is not a directory");
  if (info.uid !== process.getuid()) throw new UnsafeRunRootError(root, "another user owns it");
  if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
}

function rand(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists and belongs to someone else.
    return typeof err === "object" && err !== null && "code" in err && err.code === "EPERM";
  }
}

/** Renames into a `trash-*` sibling in `root`, then deletes in the background. Never throws. */
async function retire(dir: string, root: string): Promise<void> {
  const trash = path.join(root, `${TRASH_PREFIX}${rand(6)}`);
  try {
    await rename(dir, trash);
  } catch {
    // Already gone, or in use on Windows; the next sweep retries.
    return;
  }
  void rm(trash, { recursive: true, force: true }).catch(() => {});
}

export interface RunDirOptions {
  root?: string;
  poolId?: string;
}

/** SR 3.6: `run-<pid>-<startMs>-<rand6>` (mode 0700) with `owner.json`; in the live set until `release()`. */
export async function createRunDir(kind: RunDirKind, opts: RunDirOptions = {}): Promise<RunDir> {
  const root = opts.root ?? defaultRunRoot();
  await ensureRunRoot(root);
  const startedAt = Date.now();
  const dir = path.join(root, `${RUN_PREFIX}${process.pid}-${startedAt}-${rand(3)}`);
  await mkdir(dir, { mode: 0o700 });
  live().add(dir);
  try {
    await writeFile(
      path.join(dir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt, poolId: opts.poolId ?? null, kind })}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    live().delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  let released: Promise<void> | null = null;
  return {
    path: dir,
    release: () => {
      released ??= (async () => {
        live().delete(dir);
        await retire(dir, root);
      })();
      return released;
    },
  };
}

/** True while `dir` is an unreleased RunDir of this process. */
export function isLiveRunDir(dir: string): boolean {
  return live().has(dir);
}

export interface SweepOptions {
  root?: string;
  /** Where the prototype left `opencode-agy-run-*` dirs; default `os.tmpdir()`. */
  legacyRoot?: string;
  /** agy's own `<gemini>/antigravity-acp/tmp` is retired when no other live process uses this profile. */
  geminiDir?: string;
  owners?: OwnerRegistry;
  now?: number;
}

export interface SweepResult {
  removed: string[];
}

function parseRunName(name: string): { pid: number; startMs: number } | null {
  const m = /^run-(\d+)-(\d+)-[0-9a-f]+$/.exec(name);
  if (!m) return null;
  return { pid: Number(m[1]), startMs: Number(m[2]) };
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** SR 3.6. Runs before each spawn, in the background, and never throws. */
export async function sweepStaleRunDirs(opts: SweepOptions = {}): Promise<SweepResult> {
  const root = opts.root ?? defaultRunRoot();
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  try {
    for (const name of await readdir(root).catch(() => [])) {
      const full = path.join(root, name);
      if (name.startsWith(TRASH_PREFIX)) {
        await rm(full, { recursive: true, force: true }).catch(() => {});
        removed.push(full);
        continue;
      }
      const run = parseRunName(name);
      if (!run) continue;
      let stale: boolean;
      if (now - run.startMs > RUN_MAX_AGE_MS) stale = true; // pid reuse
      else if (run.pid === process.pid) stale = !live().has(full); // a reloaded plugin instance's leftover
      else stale = !isPidAlive(run.pid);
      if (!stale) continue;
      await retire(full, root);
      removed.push(full);
    }

    const legacyRoot = opts.legacyRoot ?? tmpdir();
    for (const name of await readdir(legacyRoot).catch(() => [])) {
      if (!LEGACY_PREFIXES.some((p) => name.startsWith(p))) continue;
      const full = path.join(legacyRoot, name);
      const mtime = await mtimeOf(full);
      if (mtime === null || now - mtime <= LEGACY_MAX_AGE_MS) continue;
      await rm(full, { recursive: true, force: true }).catch(() => {});
      removed.push(full);
    }

    // agy's own tmp is shared by every child on this profile: also wait for this pool's own login, probe,
    // logout or still-draining runtime children (O-11).
    if (opts.geminiDir && opts.owners && !(await poolHasLiveRunDir(opts.owners.id)) && !(await opts.owners.othersAlive())) {
      const agyTmp = path.join(opts.geminiDir, "antigravity-acp", "tmp");
      if (existsSync(agyTmp)) {
        const old = `${agyTmp}.old-${rand(4)}`;
        try {
          await rename(agyTmp, old);
          void rm(old, { recursive: true, force: true }).catch(() => {});
          removed.push(agyTmp);
        } catch {
          // In use; the next sweep retries.
        }
      }
    }
  } catch {
    // Never throws.
  }
  return { removed };
}

/** True while an unreleased RunDir of this process carries `poolId` in its `owner.json`. */
async function poolHasLiveRunDir(poolId: string): Promise<boolean> {
  for (const dir of live()) {
    if (typeof dir !== "string") continue;
    const text = await readFile(path.join(dir, "owner.json"), "utf8").catch(() => "");
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && Reflect.get(value, "poolId") === poolId) return true;
    } catch {
      // A dir being created writes owner.json right after mkdir; count it to stay on the safe side.
      return true;
    }
  }
  return false;
}

interface OwnerEntry {
  pid: number;
  host: string;
  poolId: string;
  token: string;
}

function parseOwner(text: string): OwnerEntry | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const pid: unknown = Reflect.get(value, "pid");
    const host: unknown = Reflect.get(value, "host");
    const poolId: unknown = Reflect.get(value, "poolId");
    const token: unknown = Reflect.get(value, "token");
    if (typeof pid !== "number" || typeof host !== "string" || typeof poolId !== "string" || typeof token !== "string") return null;
    return { pid, host, poolId, token };
  } catch {
    return null;
  }
}

/** `<dataDir>/owners/<pid>.json`: which live processes use this data dir and its gemini dir (SR 3.6, 4.8). */
export class OwnerRegistry {
  private readonly dir: string;
  private readonly poolId: string;
  private readonly token = rand(16);

  constructor(dataDir: string, poolId: string) {
    this.dir = path.join(dataDir, "owners");
    this.poolId = poolId;
  }

  /** The pool this registry entry belongs to. */
  get id(): string {
    return this.poolId;
  }

  private file(pid: number = process.pid): string {
    return path.join(this.dir, `${pid}.json`);
  }

  async register(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const entry: OwnerEntry = { pid: process.pid, host: hostname(), poolId: this.poolId, token: this.token };
    await writeFile(this.file(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  private ours(text: string): boolean {
    const entry = parseOwner(text);
    return entry !== null && entry.poolId === this.poolId && entry.token === this.token;
  }

  /** Pool stop: removes the file only when it is still ours. */
  async unregister(): Promise<void> {
    try {
      if (this.ours(await readFile(this.file(), "utf8"))) await unlink(this.file());
    } catch {
      // Already gone.
    }
  }

  /** `process.once("exit")`: synchronous, same ownership check. */
  unregisterSync(): void {
    try {
      if (this.ours(readFileSync(this.file(), "utf8"))) unlinkSync(this.file());
    } catch {
      // Already gone.
    }
  }

  /**
   * The first 8 hex characters of every live pool's id, this one included: the tags of the per-pool
   * agent files to keep. Entries with dead pids are removed.
   */
  async livePoolTags(): Promise<Set<string>> {
    const tags = new Set<string>([this.poolId.slice(0, 8)]);
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(this.dir, name);
      const entry = parseOwner(await readFile(full, "utf8").catch(() => ""));
      if (!entry) continue;
      if (entry.host !== hostname() || entry.pid === process.pid || isPidAlive(entry.pid)) tags.add(entry.poolId.slice(0, 8));
      else await unlink(full).catch(() => {});
    }
    return tags;
  }

  /** True when another live process on this host is registered. Entries with dead pids are removed. */
  async othersAlive(): Promise<boolean> {
    let alive = false;
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(this.dir, name);
      const entry = parseOwner(await readFile(full, "utf8").catch(() => ""));
      if (!entry) continue;
      if (entry.pid === process.pid && entry.poolId === this.poolId) continue;
      // Another host sharing the dir, or another pool in this process: alive.
      if (entry.host !== hostname() || entry.pid === process.pid || isPidAlive(entry.pid)) alive = true;
      else await unlink(full).catch(() => {});
    }
    return alive;
  }
}
