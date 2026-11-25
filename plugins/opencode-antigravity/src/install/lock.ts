// Cross-process directory lock with a heartbeat file (IA 6.6).
//
// Acquire: atomic `mkdir(lockDir)`, then `owner-<token>.json` opened `wx`. Heartbeat: `utimes` on the
// owner file. A same-host owner is stale when its pid is gone, when it was created before this boot
// (its pid now belongs to something else), or when its heartbeat is older than `sameHostStaleMs`
// (a pid reused within one boot). Another host's owner, or a lock dir without a readable owner file,
// is stale when its newest mtime is older than `staleMs`.
// Takeover renames the dir aside, so only one contender wins. Release removes only our own lock.

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname, uptime } from "node:os";
import path from "node:path";
import { errnoCode, sleep } from "./fs-utils.ts";

export interface DirLock {
  readonly token: string;
  releaseSync(): void;
}

export interface LockHolder {
  pid: number;
  hostname: string;
}

export interface AcquireDirLockOptions {
  /** Default 30 000. Other hosts and unreadable owners only. */
  staleMs?: number;
  /** Default 10 000. */
  heartbeatMs?: number;
  /** How long to wait for a holder. Default 0: fail at once. */
  waitMs?: number;
  /** Default 500. */
  pollMs?: number;
  onWait?: (holder: LockHolder | null) => void;
  signal?: AbortSignal;
  /** Test seam; default `os.hostname()`. */
  hostname?: string;
  /**
   * Default 30 min. A same-host owner whose live pid has not touched its heartbeat for this long is
   * stale. Far above `staleMs`, so a holder that slept with the laptop resumes its heartbeat first.
   */
  sameHostStaleMs?: number;
  /** Test seam: when this machine booted, in ms. Default `Date.now() - os.uptime() * 1000`. */
  bootTimeMs?: number;
}

export class LockBusyError extends Error {
  readonly code = "lock_busy";
  readonly holder: LockHolder | null;

  constructor(lockDir: string, holder: LockHolder | null) {
    super(`Lock ${path.basename(lockDir)} is held by another process.`);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

interface OwnerFile {
  pid: number;
  hostname: string;
  token: string;
  /** Null when the owner file does not say; the boot-time rule then does not apply. */
  createdAt: number | null;
}

const OWNER_PREFIX = "owner-";
const OWNER_SUFFIX = ".json";

function readOwners(lockDir: string): { owners: Array<{ owner: OwnerFile; mtimeMs: number }>; newestMtime: number | null } {
  const owners: Array<{ owner: OwnerFile; mtimeMs: number }> = [];
  let newestMtime: number | null = null;
  let names: string[] = [];
  try {
    names = readdirSync(lockDir);
  } catch {
    return { owners, newestMtime };
  }
  for (const name of names) {
    if (!name.startsWith(OWNER_PREFIX) || !name.endsWith(OWNER_SUFFIX)) continue;
    const file = path.join(lockDir, name);
    try {
      const mtimeMs = statSync(file).mtimeMs;
      newestMtime = newestMtime === null ? mtimeMs : Math.max(newestMtime, mtimeMs);
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const owner = toOwner(parsed);
      if (owner) owners.push({ owner, mtimeMs });
    } catch {
      // Unreadable or half-written owner file: only its mtime counts.
    }
  }
  return { owners, newestMtime };
}

function toOwner(value: unknown): OwnerFile | null {
  if (typeof value !== "object" || value === null) return null;
  const pid = "pid" in value ? value.pid : undefined;
  const host = "hostname" in value ? value.hostname : undefined;
  const token = "token" in value ? value.token : undefined;
  const createdAt = "createdAt" in value ? value.createdAt : undefined;
  if (typeof pid !== "number" || typeof host !== "string" || typeof token !== "string") return null;
  return { pid, hostname: host, token, createdAt: typeof createdAt === "number" ? createdAt : null };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) !== "ESRCH";
  }
}

function dirMtime(dir: string): number | null {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/** Decides whether the current lock at `lockDir` may be taken over. */
interface HolderView {
  stale: boolean;
  holder: LockHolder | null;
  /** Owner token seen when judged stale; null when there was no readable owner. */
  token: string | null;
}

interface StaleRules {
  host: string;
  staleMs: number;
  sameHostStaleMs: number;
  bootTimeMs: number;
}

/** Clock slack for comparing an owner's `createdAt` with the boot time. */
const BOOT_SLACK_MS = 60_000;

function inspectHolder(lockDir: string, rules: StaleRules, now: number): HolderView {
  const { owners, newestMtime } = readOwners(lockDir);
  const first = owners[0];
  if (first) {
    const holder = { pid: first.owner.pid, hostname: first.owner.hostname };
    const token = first.owner.token;
    const newest = Math.max(...owners.map((o) => o.mtimeMs));
    if (first.owner.hostname === rules.host) {
      const stale =
        !pidAlive(first.owner.pid) ||
        (first.owner.createdAt !== null && first.owner.createdAt < rules.bootTimeMs - BOOT_SLACK_MS) ||
        now - newest > rules.sameHostStaleMs;
      return { stale, holder, token };
    }
    return { stale: now - newest > rules.staleMs, holder, token };
  }
  const mtime = newestMtime ?? dirMtime(lockDir);
  if (mtime === null) return { stale: false, holder: null, token: null }; // vanished meanwhile; retry mkdir
  return { stale: now - mtime > rules.staleMs, holder: null, token: null };
}

function removeStaleLeftovers(lockDir: string): void {
  const parent = path.dirname(lockDir);
  const prefix = `${path.basename(lockDir)}.stale-`;
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix)) rmSync(path.join(parent, name), { recursive: true, force: true });
  }
}

function takeOver(lockDir: string, staleToken: string | null): void {
  const aside = `${lockDir}.stale-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockDir, aside);
  } catch {
    return; // another contender won the rename
  }
  // Between our inspection and the rename, another contender may have taken over and created a
  // fresh lock. If the dir we moved holds a different owner, put it back.
  const moved = readOwners(aside).owners.map((o) => o.owner.token);
  if (moved.some((token) => token !== staleToken)) {
    try {
      renameSync(aside, lockDir);
      return;
    } catch {
      // lockDir exists again; the moved holder will see ENOENT on release and never touch it
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

function tryCreate(lockDir: string, host: string, heartbeatMs: number): DirLock | null {
  try {
    mkdirSync(lockDir, { mode: 0o700 });
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return null;
    throw err;
  }
  const token = randomBytes(16).toString("hex");
  const ownerFile = path.join(lockDir, `${OWNER_PREFIX}${token}${OWNER_SUFFIX}`);
  const owner: OwnerFile = { pid: process.pid, hostname: host, token, createdAt: Date.now() };
  try {
    writeFileSync(ownerFile, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  } catch (err) {
    try {
      rmdirSync(lockDir);
    } catch {
      // leave it; it is stale by mtime later
    }
    throw err;
  }

  let released = false;
  const heartbeat = setInterval(() => {
    const now = new Date();
    try {
      utimesSync(ownerFile, now, now);
    } catch {
      // taken over or removed; release will notice
    }
  }, heartbeatMs);
  heartbeat.unref();

  const releaseSync = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    process.removeListener("exit", releaseSync);
    try {
      unlinkSync(ownerFile);
    } catch {
      return; // ENOENT: the lock was taken over; never touch the new holder's dir
    }
    try {
      rmdirSync(lockDir); // ENOTEMPTY when another owner file appeared: not ours to remove
    } catch {
      // ignore
    }
  };
  process.on("exit", releaseSync);
  return { token, releaseSync };
}

export async function acquireDirLock(lockDir: string, opts: AcquireDirLockOptions = {}): Promise<DirLock> {
  const rules: StaleRules = {
    host: opts.hostname ?? osHostname(),
    staleMs: opts.staleMs ?? 30_000,
    sameHostStaleMs: opts.sameHostStaleMs ?? 30 * 60_000,
    bootTimeMs: opts.bootTimeMs ?? Date.now() - uptime() * 1000,
  };
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const waitMs = opts.waitMs ?? 0;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + waitMs;

  mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  removeStaleLeftovers(lockDir);

  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Lock wait aborted.");
    const lock = tryCreate(lockDir, rules.host, heartbeatMs);
    if (lock) return lock;
    const { stale, holder, token } = inspectHolder(lockDir, rules, Date.now());
    if (stale) {
      takeOver(lockDir, token);
      continue;
    }
    if (Date.now() >= deadline) throw new LockBusyError(lockDir, holder);
    opts.onWait?.(holder);
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
