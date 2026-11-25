// Persisted OpenCode session to ACP session bindings, cross-process binding locks and pruning (SR 4.8).
// Records hold hashes, counts and ids only; no prompt text reaches disk or the log.

import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname as osHostname, uptime } from "node:os";
import path from "node:path";
import type {
  BindingLock,
  BindingRecord,
  BindingState,
  EmittedToolCall,
  LastTurnRecord,
  PersistedPlanKind,
  SessionStoreApi,
  TaintReason,
  TurnOutcomeKind,
} from "./contracts.ts";
import { isRecord, sha256Hex } from "./prompt.ts";

const LOCK_TOUCH_MS = 60_000;
/** A lock is stale after this long without a touch (five missed heartbeats), on any host. */
const LOCK_HEARTBEAT_STALE_MS = 5 * 60_000;
/** Ephemeral conversations are deleted once older than this. */
const EPHEMERAL_TTL_MS = 60 * 60_000;
/** A takeover guard older than this was left by a crashed contender. */
const TAKEOVER_GUARD_STALE_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_FILE_RE = /^[0-9a-f]{32}\.json$/;

export function bindingIdFor(sessionKey: string): string {
  return sha256Hex(sessionKey).slice(0, 32);
}

/**
 * `sha256(realpath(geminiDir)).slice(0, 16)`. When the dir does not exist yet (the first start), the
 * nearest existing ancestor is resolved and the rest appended, so the id is the same before and after
 * the dir is created, also below a symlink such as macOS `/var` -> `/private/var`.
 */
export function profileIdFor(geminiDir: string): string {
  let existing = path.resolve(geminiDir);
  const rest: string[] = [];
  for (;;) {
    try {
      const resolved = realpathSync(existing);
      return sha256Hex(rest.length > 0 ? path.join(resolved, ...rest.reverse()) : resolved).slice(0, 16);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return sha256Hex(path.resolve(geminiDir)).slice(0, 16);
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

const STATES: readonly BindingState[] = ["live", "dormant", "tainted"];
const OUTCOMES: readonly TurnOutcomeKind[] = ["ok", "parked", "failed_no_output", "failed_with_output", "cancelled"];
const PLANS: readonly PersistedPlanKind[] = ["resume", "append", "redo", "fresh"];
const TAINT_REASONS: readonly TaintReason[] = [
  "crash",
  "broken-history",
  "cancelled",
  "abandoned",
  "failed",
  "mcp-dropped",
  "parked-expired",
  "steer-failed",
];

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  for (const item of allowed) if (item === value) return item;
  return null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseStringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

function parseToolCalls(value: unknown): EmittedToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const items: readonly unknown[] = value;
  const out: EmittedToolCall[] = [];
  for (const item of items) {
    if (!isRecord(item)) return null;
    const { id, name, argsHash } = item;
    if (typeof id !== "string" || typeof name !== "string" || typeof argsHash !== "string") return null;
    out.push({ id, name, argsHash });
  }
  return out;
}

/** `null` is a valid "no turn yet"; `undefined` means the field is malformed. */
function parseLastTurn(value: unknown): LastTurnRecord | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const outcome = oneOf(value.outcome, OUTCOMES);
  const plan = oneOf(value.plan, PLANS);
  const emittedToolCalls = parseToolCalls(value.emittedToolCalls);
  const { emittedTextHash, inputFrom, inputTo } = value;
  if (!outcome || !plan || !emittedToolCalls) return undefined;
  if (emittedTextHash !== null && typeof emittedTextHash !== "string") return undefined;
  if (!isCount(inputFrom) || !isCount(inputTo)) return undefined;
  return { outcome, plan, emittedToolCalls, emittedTextHash, inputFrom, inputTo };
}

/** A record read from disk, checked field by field; null when anything is off. */
function parseBindingRecord(value: unknown): BindingRecord | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const v = value;
  const {
    sessionKey,
    acpSessionId,
    authEpoch,
    agyVersion,
    cwd,
    model,
    systemHash,
    toolsSchemaHash,
    prefixHash,
    thoughtLevel,
    appendInPrompt,
    prefixCount,
    createdAt,
    updatedAt,
    turns,
  } = v;
  if (
    typeof sessionKey !== "string" ||
    typeof acpSessionId !== "string" ||
    typeof authEpoch !== "string" ||
    typeof agyVersion !== "string" ||
    typeof cwd !== "string" ||
    typeof model !== "string" ||
    typeof systemHash !== "string" ||
    typeof toolsSchemaHash !== "string" ||
    typeof prefixHash !== "string"
  ) {
    return null;
  }
  if (thoughtLevel !== null && typeof thoughtLevel !== "string") return null;
  if (typeof appendInPrompt !== "boolean") return null;
  if (!isCount(prefixCount) || !isCount(turns) || !isStamp(createdAt) || !isStamp(updatedAt)) return null;
  const toolsDescHashes = parseStringMap(v.toolsDescHashes);
  const state = oneOf(v.state, STATES);
  const taintReason = v.taintReason === null ? null : oneOf(v.taintReason, TAINT_REASONS);
  const lastTurn = parseLastTurn(v.lastTurn);
  if (!toolsDescHashes || !state || (v.taintReason !== null && taintReason === null) || lastTurn === undefined) {
    return null;
  }
  return {
    version: 1,
    sessionKey,
    acpSessionId,
    authEpoch,
    agyVersion,
    cwd,
    model,
    thoughtLevel,
    systemHash,
    toolsSchemaHash,
    toolsDescHashes,
    appendInPrompt,
    prefixCount,
    prefixHash,
    state: state === "live" ? "dormant" : state,
    taintReason,
    lastTurn,
    createdAt,
    updatedAt,
    turns,
  };
}

// ---------------------------------------------------------------------------
// Lock files
// ---------------------------------------------------------------------------

interface LockFile {
  pid: number;
  host: string;
  poolId: string;
  token: string;
  acquiredAt: number;
}

function parseLockFile(text: string): LockFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { pid, host, poolId, token, acquiredAt } = value;
  if (!isCount(pid) || typeof host !== "string" || typeof poolId !== "string" || typeof token !== "string" || !isStamp(acquiredAt)) {
    return null;
  }
  return { pid, host, poolId, token, acquiredAt };
}

function errorCode(err: unknown): string | null {
  return isRecord(err) && typeof err.code === "string" ? err.code : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists under another user.
    return errorCode(err) !== "ESRCH";
  }
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export interface SessionStoreOptions {
  /** `resolveDataDir()`; records live under `<dataDir>/sessions/v1/<profileId>/`. */
  dataDir: string;
  geminiDir: string;
  /** Random id of this plugin pool; lock files carry it. */
  poolId: string;
  /** Current auth epoch; prune removes records of other epochs. */
  authEpoch: () => string;
  /** Conversation files are deleted only in a plugin-owned profile. */
  isPluginOwnedProfile: () => boolean;
  sessionTtlDays: number;
  maxStoredSessions: number;
  now?: () => number;
  hostname?: string;
}

interface HeldLock {
  sessionKey: string;
  file: string;
  token: string;
  released: boolean;
}

interface EphemeralEntry {
  id: string;
  createdAt: number;
}

export class SessionStore implements SessionStoreApi {
  readonly dir: string;
  private readonly conversationsDir: string;
  private readonly now: () => number;
  private readonly host: string;
  private readonly held = new Map<string, HeldLock>();
  private touchTimer: ReturnType<typeof setInterval> | null = null;
  private ledger: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionStoreOptions) {
    this.dir = path.join(options.dataDir, "sessions", "v1", profileIdFor(options.geminiDir));
    this.conversationsDir = path.join(options.geminiDir, "antigravity-acp", "conversations");
    this.now = options.now ?? Date.now;
    this.host = options.hostname ?? osHostname();
  }

  private recordPath(sessionKey: string): string {
    return path.join(this.dir, `${bindingIdFor(sessionKey)}.json`);
  }

  private lockPath(sessionKey: string): string {
    return path.join(this.dir, `${bindingIdFor(sessionKey)}.lock`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Reads one record file; a corrupt one is renamed to `.corrupt-<ms>`. */
  private async readRecordFile(file: string): Promise<BindingRecord | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    const record = parseBindingRecord(value);
    if (!record) {
      await rename(file, `${file}.corrupt-${this.now()}`).catch(() => undefined);
    }
    return record;
  }

  async load(sessionKey: string, authEpoch: string): Promise<BindingRecord | null> {
    const record = await this.readRecordFile(this.recordPath(sessionKey));
    if (!record || record.sessionKey !== sessionKey || record.authEpoch !== authEpoch) return null;
    return record;
  }

  async save(record: BindingRecord): Promise<void> {
    await this.ensureDir();
    const file = this.recordPath(record.sessionKey);
    const onDisk: BindingRecord = { ...record, state: record.state === "live" ? "dormant" : record.state };
    const tmp = `${file}.tmp-${process.pid}-${randomHex(4)}`;
    try {
      await writeFile(tmp, `${JSON.stringify(onDisk)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async remove(sessionKey: string): Promise<BindingRecord | null> {
    const file = this.recordPath(sessionKey);
    const record = await this.readRecordFile(file);
    await unlink(file).catch(() => undefined);
    const own = this.held.get(sessionKey);
    if (own) await this.releaseHeld(own);
    if (record && record.sessionKey === sessionKey && !(await this.lockedElsewhere(sessionKey))) {
      await this.deleteConversation(record.acpSessionId);
    }
    return record && record.sessionKey === sessionKey ? record : null;
  }

  async lock(sessionKey: string): Promise<BindingLock | null> {
    const existing = this.held.get(sessionKey);
    if (existing && !existing.released) return this.handle(existing);
    await this.ensureDir();
    const file = this.lockPath(sessionKey);
    const token = randomHex(16);
    // Lock times are wall-clock times, compared with file mtimes; the injectable clock is for records only.
    const body: LockFile = { pid: process.pid, host: this.host, poolId: this.options.poolId, token, acquiredAt: Date.now() };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await writeFile(file, JSON.stringify(body), { flag: "wx", mode: 0o600 });
        const held: HeldLock = { sessionKey, file, token, released: false };
        this.held.set(sessionKey, held);
        this.startTouching();
        return this.handle(held);
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
      }
      if (!(await this.isStale(file))) return null;
      await this.takeOver(file);
    }
    return null;
  }

  /**
   * Removes a stale lock under a `<lock>.takeover` guard and re-checks staleness inside it. Without
   * the guard, a slow contender that judged the old lock stale could remove the lock a faster one
   * had just written, and both would hold the binding.
   */
  private async takeOver(file: string): Promise<void> {
    const guard = `${file}.takeover`;
    try {
      await writeFile(guard, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      // Another contender is taking over; a guard left by a crashed one expires.
      const info = await stat(guard).catch(() => null);
      if (info && Date.now() - info.mtimeMs > TAKEOVER_GUARD_STALE_MS) await unlink(guard).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return;
    }
    try {
      if (await this.isStale(file)) await unlink(file).catch(() => undefined);
    } finally {
      await unlink(guard).catch(() => undefined);
    }
  }

  private handle(held: HeldLock): BindingLock {
    return { sessionKey: held.sessionKey, release: () => this.releaseHeld(held) };
  }

  /** SR 4.8 stale rule, tightened for pid reuse (review O-3): an old heartbeat or a pre-boot lock is stale on this host too. */
  private async isStale(file: string): Promise<boolean> {
    let text: string | null = null;
    let mtimeMs: number;
    try {
      text = await readFile(file, "utf8");
      mtimeMs = (await stat(file)).mtimeMs;
    } catch (err) {
      // Gone between the `wx` and the read: free now.
      return errorCode(err) === "ENOENT";
    }
    const lock = parseLockFile(text);
    const heartbeatOld = Date.now() - mtimeMs > LOCK_HEARTBEAT_STALE_MS;
    if (!lock || lock.host !== this.host) return heartbeatOld;
    // A lock from before this boot, or from before this process for our own pid, belongs to a dead
    // holder whose pid was reused.
    if (lock.acquiredAt < Date.now() - uptime() * 1000) return true;
    if (lock.pid === process.pid) return lock.acquiredAt < Date.now() - process.uptime() * 1000;
    // A live holder touches the file every minute, so an old heartbeat also means its pid was reused.
    // Trade-off: right after the machine wakes from a long sleep, a contender can win before the
    // holder's next touch.
    return !pidAlive(lock.pid) || heartbeatOld;
  }

  private async lockedElsewhere(sessionKey: string): Promise<boolean> {
    if (this.held.has(sessionKey)) return false;
    const file = this.lockPath(sessionKey);
    try {
      await stat(file);
    } catch {
      return false;
    }
    return !(await this.isStale(file));
  }

  private ownsLockFile(held: HeldLock, text: string): boolean {
    const lock = parseLockFile(text);
    return lock !== null && lock.poolId === this.options.poolId && lock.token === held.token;
  }

  private async releaseHeld(held: HeldLock): Promise<void> {
    if (held.released) return;
    held.released = true;
    if (this.held.get(held.sessionKey) === held) this.held.delete(held.sessionKey);
    if (this.held.size === 0) this.stopTouching();
    try {
      const text = await readFile(held.file, "utf8");
      if (this.ownsLockFile(held, text)) await unlink(held.file);
    } catch {
      // Already gone, or taken over: nothing of ours to remove.
    }
  }

  private startTouching(): void {
    if (this.touchTimer) return;
    this.touchTimer = setInterval(() => {
      const at = new Date();
      for (const held of this.held.values()) void utimes(held.file, at, at).catch(() => undefined);
    }, LOCK_TOUCH_MS);
    this.touchTimer.unref();
  }

  private stopTouching(): void {
    if (this.touchTimer) clearInterval(this.touchTimer);
    this.touchTimer = null;
  }

  async recordEphemeral(acpSessionId: string): Promise<void> {
    const entry: EphemeralEntry = { id: acpSessionId, createdAt: this.now() };
    await this.withLedger(async () => {
      await this.ensureDir();
      await appendFile(path.join(this.dir, "ephemeral.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    });
  }

  private withLedger(fn: () => Promise<void>): Promise<void> {
    const run = this.ledger.then(fn);
    this.ledger = run.catch(() => undefined);
    return run;
  }

  async prune(): Promise<void> {
    try {
      await this.pruneRecords();
    } catch {
      // Never throws (SR 4.8); the next run tries again.
    }
    try {
      await this.withLedger(() => this.pruneEphemeral());
    } catch {
      // Same.
    }
  }

  private async pruneRecords(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const records: BindingRecord[] = [];
    for (const name of names) {
      if (!RECORD_FILE_RE.test(name)) continue;
      const record = await this.readRecordFile(path.join(this.dir, name));
      // A record under another binding's name (a copied file) is left alone: deleting by its
      // sessionKey would remove someone else's record and conversation.
      if (record && name === `${bindingIdFor(record.sessionKey)}.json`) records.push(record);
    }
    const now = this.now();
    const epoch = this.options.authEpoch();
    const ttlMs = this.options.sessionTtlDays * DAY_MS;
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    let kept = 0;
    for (const record of records) {
      const expired = now - record.updatedAt > ttlMs || record.authEpoch !== epoch;
      const overCount = !expired && kept >= this.options.maxStoredSessions;
      if (!expired && !overCount) {
        kept += 1;
        continue;
      }
      // A binding live in any process stays, record and conversation alike.
      if (this.held.has(record.sessionKey) || (await this.lockedElsewhere(record.sessionKey))) continue;
      await unlink(this.recordPath(record.sessionKey)).catch(() => undefined);
      await this.deleteConversation(record.acpSessionId);
    }
  }

  private async pruneEphemeral(): Promise<void> {
    const file = path.join(this.dir, "ephemeral.jsonl");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return;
    }
    const now = this.now();
    const keep: EphemeralEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(value) || typeof value.id !== "string" || !isStamp(value.createdAt)) continue;
      const entry: EphemeralEntry = { id: value.id, createdAt: value.createdAt };
      if (now - entry.createdAt <= EPHEMERAL_TTL_MS) {
        keep.push(entry);
        continue;
      }
      await this.deleteConversation(entry.id);
    }
    // Another process may have appended while the old entries were deleted; keep what it added.
    const latest = await readFile(file, "utf8").catch(() => text);
    const appended = latest.startsWith(text) ? latest.slice(text.length) : "";
    const tmp = `${file}.tmp-${process.pid}-${randomHex(4)}`;
    await writeFile(tmp, keep.map((entry) => `${JSON.stringify(entry)}\n`).join("") + appended, { mode: 0o600 });
    await rename(tmp, file);
  }

  /** SR 4.8 step 3: only in a plugin-owned profile, only UUID ids the plugin recorded. */
  private async deleteConversation(acpSessionId: string): Promise<void> {
    if (!UUID_RE.test(acpSessionId) || !this.options.isPluginOwnedProfile()) return;
    const base = path.join(this.conversationsDir, `${acpSessionId}.db`);
    for (const file of [base, `${base}-wal`, `${base}-shm`]) {
      try {
        const info = await lstat(file);
        if (info.isFile() || info.isSymbolicLink()) await unlink(file);
      } catch {
        // Missing or not ours to remove.
      }
    }
  }

  async close(): Promise<void> {
    this.stopTouching();
    await Promise.all([...this.held.values()].map((held) => this.releaseHeld(held)));
  }

  releaseLocksSync(): void {
    this.stopTouching();
    for (const held of this.held.values()) {
      held.released = true;
      try {
        if (this.ownsLockFile(held, readFileSync(held.file, "utf8"))) unlinkSync(held.file);
      } catch {
        // Already gone.
      }
    }
    this.held.clear();
  }
}

/** `sessionStore: false`: bindings live in memory only, so nothing is shared with other processes. */
export class MemorySessionStore implements SessionStoreApi {
  private readonly records = new Map<string, BindingRecord>();

  async load(sessionKey: string, authEpoch: string): Promise<BindingRecord | null> {
    const record = this.records.get(sessionKey);
    return record && record.authEpoch === authEpoch ? { ...record } : null;
  }

  async save(record: BindingRecord): Promise<void> {
    this.records.set(record.sessionKey, { ...record, state: record.state === "live" ? "dormant" : record.state });
  }

  async remove(sessionKey: string): Promise<BindingRecord | null> {
    const record = this.records.get(sessionKey) ?? null;
    this.records.delete(sessionKey);
    return record;
  }

  async lock(sessionKey: string): Promise<BindingLock | null> {
    return { sessionKey, release: async () => undefined };
  }

  async recordEphemeral(): Promise<void> {}

  async prune(): Promise<void> {}

  async close(): Promise<void> {}

  releaseLocksSync(): void {}
}
