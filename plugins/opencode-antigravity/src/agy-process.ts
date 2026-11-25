// One shared `agy acp` process per plugin pool (SR 3.1 to 3.5): spawn, leases, idle stop, drain on a
// binary change, crash handling, the early-exit breaker and the wedged check. At most one child at a
// time; every generation gets a new number, and anything tagged with an older one is dead.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { SIGNED_OUT_MESSAGE } from "./auth/errors.ts";
import { AcpClient, AgyExitedError, type AcpCapabilities } from "./acp-client.ts";
import type { RuntimeConfig } from "./config.ts";
import { AGENT_NAME } from "./constants.ts";
import type { CreateRunDir, InstallAuthBridge, Lease, PermissionRequestParams, RunDir } from "./contracts.ts";
import { systemClock, type Clock } from "./stall-watchdog.ts";

export type ProcessState = "stopped" | "starting" | "ready" | "draining" | "stopping" | "broken";
export type LeaseReason = "turn" | "discovery" | "login" | "close";
export type StopReason = "idle" | "auth-changed" | "binary-changed" | "wedged" | "shutdown";

export interface ExitInfo {
  generation: number;
  code: number | null;
  signal: string | null;
  /** True when a stop asked for it; `reason` says which. */
  expected: boolean;
  reason: StopReason | null;
  uptimeMs: number;
}

/** Requests during `broken` (SR 3.4). */
export class BreakerOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Antigravity CLI keeps exiting right after start.");
    this.name = "BreakerOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** A start cancelled by `stop` (SR 3.1: waiters get `agy_exited`, or the sign-in error after a logout). */
export class StartCancelledError extends AgyExitedError {
  constructor() {
    super(null, null);
    this.name = "StartCancelledError";
  }
}

/** The child as the manager uses it; `defaultSpawner` wraps `node:child_process`. Tests pass a fake. */
export interface AgyChild {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}

export type Spawner = (file: string, args: readonly string[], opts: { cwd: string; env: Record<string, string> }) => AgyChild;

export const defaultSpawner: Spawner = (file, args, opts) => {
  const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  const listeners: Array<(code: number | null, signal: string | null) => void> = [];
  const fire = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    for (const l of listeners) l(code, signal);
  };
  child.once("exit", (code, signal) => fire(code, signal));
  // A spawn failure (ENOENT, EACCES) has no exit event.
  child.once("error", () => fire(null, null));
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
    onExit: (listener) => {
      listeners.push(listener);
    },
  };
};

export interface Generation {
  readonly generation: number;
  readonly client: AcpClient;
  readonly capabilities: AcpCapabilities;
  readonly binaryVersion: string;
  readonly logFile: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
}

export interface AgyProcessManagerOptions {
  config: RuntimeConfig;
  install: InstallAuthBridge;
  /** `agyBaseArgs(geminiDir)` from the install design (`acp --gemini-dir <g> --app-data-dir antigravity-acp`). */
  baseArgs: (geminiDir: string) => string[];
  createRunDir: CreateRunDir;
  /** Child cwd; each session carries its own. */
  dataDir: string;
  /** `--agent`; the proxy passes its per-pool name (review L-1). Default `AGENT_NAME`. */
  agentName?: string;
  /** Layer 3; the generation lets the caller reject requests of an older process. */
  allowPermission: (p: PermissionRequestParams, generation: number) => boolean;
  onExit: (info: ExitInfo) => void;
  /** After each successful start (the proxy opens the log tail and may run discovery). */
  onReady?: (gen: Generation) => void;
  /** Sweep before each spawn (SR 3.6), awaited so retiring agy's own tmp never races the new child. Never throws. */
  sweep?: () => Promise<void>;
  /** True while some turn waits on agy; silence only counts toward the wedged check then (SR 3.5). */
  isAwaitingAgy?: () => boolean;
  clock?: Clock;
  spawner?: Spawner;
  log?: (message: string) => void;
}

interface LeaseRecord {
  generation: number;
  reason: LeaseReason;
}

interface Current {
  generation: number;
  child: AgyChild;
  client: AcpClient;
  runDir: RunDir;
  logFile: string;
  startedAt: number;
  binaryVersion: string;
  capabilities: AcpCapabilities | null;
  /** Set by `stop`; the exit is then expected. */
  stopReason: StopReason | null;
  /** The exit followed a classified sign-in error; it does not count toward the breaker. */
  signInFailure: boolean;
  /** `handleExit` ran (a real exit, or the forced cleanup after SIGKILL never produced one). */
  exitHandled: boolean;
  exited: Promise<void>;
}

function logStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class AgyProcessManager {
  private readonly opts: AgyProcessManagerOptions;
  private readonly clock: Clock;
  private readonly spawner: Spawner;
  private stateValue: ProcessState = "stopped";
  private generationValue = 0;
  private current: Current | null = null;
  private startPromise: Promise<Generation> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly leases = new Set<LeaseRecord>();
  private readonly holds = new Set<object>();
  private idleTimer: unknown = null;
  private breakerTimer: unknown = null;
  private brokenUntil = 0;
  private earlyExits: number[] = [];
  private drainAfterStart = false;
  /** Set by `stop` while `starting`; the start then tears down what it brought up. */
  private cancelledStart: StopReason | null = null;
  private abandoned: number[] = [];
  private lastRpcSettledAt = 0;
  private wedgedTimer: unknown = null;
  private drainTimer: unknown = null;
  private drainDeadlineAt: number | null = null;
  private readonly unsubscribeBinary: () => void;
  private disposed = false;

  constructor(opts: AgyProcessManagerOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.spawner = opts.spawner ?? defaultSpawner;
    this.unsubscribeBinary = opts.install.onBinaryChanged(() => this.onBinaryChanged());
  }

  get state(): ProcessState {
    return this.stateValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  /** The live generation, null unless `ready` or `draining`. */
  get live(): Generation | null {
    const c = this.current;
    if (!c || !c.capabilities || (this.stateValue !== "ready" && this.stateValue !== "draining")) return null;
    return this.view(c, c.capabilities);
  }

  get client(): AcpClient | null {
    return this.live?.client ?? null;
  }

  /** While draining with a request waiting: when the old child is stopped regardless of its leases. */
  get drainDeadline(): number | null {
    return this.stateValue === "draining" ? this.drainDeadlineAt : null;
  }

  /** Leases of the live generation plus login holds; exposed for tests and /health. */
  get activeLeases(): number {
    return this.countLeases(this.current?.generation ?? -1) + this.holds.size;
  }

  get abandonedTurns(): number {
    return this.abandoned.length;
  }

  /** Spawns when needed. One lease covers setup and prompt of a turn (SR 3.3). */
  async acquire(reason: LeaseReason): Promise<{ gen: Generation; lease: Lease }> {
    for (;;) {
      if (this.disposed) throw new AgyExitedError(null, null);
      switch (this.stateValue) {
        case "broken":
          throw new BreakerOpenError(Math.max(0, this.brokenUntil - this.clock.now()) || this.opts.config.breakerCooldownMs);
        case "ready": {
          const c = this.current;
          if (c?.capabilities) return { gen: this.view(c, c.capabilities), lease: this.lease(c.generation, reason) };
          break;
        }
        case "starting": {
          const gen = await (this.startPromise ?? Promise.reject(new AgyExitedError(null, null)));
          // Re-read through `live`: the await may have moved the state on.
          if (this.live?.generation === gen.generation && this.state !== "draining") {
            return { gen, lease: this.lease(gen.generation, reason) };
          }
          continue;
        }
        case "draining":
          // A parked turn holds its lease until OpenCode answers, which can take up to parkedToolTtlMs.
          // A request waiting here bounds that: after drainWaitMs the old child stops (O-6).
          this.armDrainDeadline();
          await (this.stopPromise ?? this.current?.exited ?? Promise.resolve());
          continue;
        case "stopping":
          await (this.stopPromise ?? this.current?.exited ?? Promise.resolve());
          continue;
        case "stopped":
          this.startPromise = this.start();
          continue;
      }
      // `ready` without capabilities cannot happen; let the loop re-read the state.
      await Promise.resolve();
    }
  }

  /** A lease only when the process is already `ready`; never spawns (idle session close, discovery). */
  tryAcquire(reason: LeaseReason): { gen: Generation; lease: Lease } | null {
    const c = this.current;
    if (this.stateValue !== "ready" || !c?.capabilities) return null;
    return { gen: this.view(c, c.capabilities), lease: this.lease(c.generation, reason) };
  }

  /** Keeps the process from idling out during a login; never spawns (SR 9). */
  hold(_reason: "login"): Lease {
    const token = {};
    this.holds.add(token);
    this.clearIdle();
    let released = false;
    return {
      generation: this.generationValue,
      release: () => {
        if (released) return;
        released = true;
        this.holds.delete(token);
        this.maybeArmIdle();
      },
    };
  }

  /** Idempotent and joinable (SR 3.1, IA 15.3 item 6). */
  stop(reason: StopReason): Promise<void> {
    switch (this.stateValue) {
      case "stopped":
      case "broken":
        return Promise.resolve();
      case "stopping":
        return this.stopPromise ?? Promise.resolve();
      case "starting": {
        const start = this.startPromise;
        this.cancelledStart = reason;
        if (!this.current) {
          // No child yet: the start may be waiting in `beforeSpawn` for the very logout that awaits this
          // stop (O-1). It checks `cancelledStart` before it spawns and ends as `stopped` by itself.
          return Promise.resolve();
        }
        this.stopPromise = (async () => {
          if (this.current) {
            // Do not wait out initialize (30 s) and authenticate (60 s): logout awaits this stop.
            this.current.stopReason = reason;
            this.current.child.kill("SIGTERM");
          }
          await start?.catch(() => {});
          // The start settled: stop what it brought up (it may have failed and stopped already).
          if (this.live) await this.stopChild(reason);
        })().finally(() => {
          this.stopPromise = null;
        });
        return this.stopPromise;
      }
      case "ready":
      case "draining":
        this.stopPromise = this.stopChild(reason).finally(() => {
          this.stopPromise = null;
        });
        return this.stopPromise;
    }
  }

  /** Pool shutdown: stops the child and detaches the bridge listener. */
  async dispose(): Promise<void> {
    await this.stop("shutdown");
    this.disposed = true;
    this.unsubscribeBinary();
    this.clearIdle();
    this.clock.clearTimeout(this.breakerTimer);
    this.clock.clearTimeout(this.wedgedTimer);
    this.clearDrainDeadline();
  }

  /** `process.once("exit")`: synchronous SIGTERM only (SR 3.4). */
  killSync(): void {
    this.current?.child.kill("SIGTERM");
  }

  /** A turn whose cancel never settled (SR 3.5). */
  reportAbandoned(generation: number): void {
    if (generation !== this.current?.generation) return;
    this.abandoned.push(this.clock.now());
    this.checkWedged();
    if (this.wedgedTimer === null) this.armWedgedCheck();
  }

  // --- internals -------------------------------------------------------------------------

  private view(c: Current, capabilities: AcpCapabilities): Generation {
    return {
      generation: c.generation,
      client: c.client,
      capabilities,
      binaryVersion: c.binaryVersion,
      logFile: c.logFile,
      pid: c.child.pid,
      startedAt: c.startedAt,
    };
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private setState(next: ProcessState): void {
    if (this.stateValue === next) return;
    this.log(`agy process ${this.stateValue} -> ${next} (generation ${this.generationValue})`);
    this.stateValue = next;
  }

  private countLeases(generation: number): number {
    let n = 0;
    for (const l of this.leases) if (l.generation === generation) n++;
    return n;
  }

  private lease(generation: number, reason: LeaseReason): Lease {
    const record: LeaseRecord = { generation, reason };
    this.leases.add(record);
    this.clearIdle();
    let released = false;
    return {
      generation,
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(record);
        if (generation !== this.current?.generation) return;
        if (this.stateValue === "draining" && this.countLeases(generation) === 0) {
          void this.stop("binary-changed");
          return;
        }
        this.maybeArmIdle();
      },
    };
  }

  private armDrainDeadline(): void {
    if (this.drainTimer !== null) return;
    const generation = this.current?.generation ?? -1;
    const waitMs = this.opts.config.timings.drainWaitMs;
    this.drainDeadlineAt = this.clock.now() + waitMs;
    this.log(`binary changed; a request waits for ${this.countLeases(generation)} lease(s), at most ${waitMs} ms`);
    this.drainTimer = this.clock.setTimeout(() => {
      this.drainTimer = null;
      this.drainDeadlineAt = null;
      if (this.stateValue === "draining" && this.current?.generation === generation) void this.stop("binary-changed");
    }, waitMs);
  }

  private clearDrainDeadline(): void {
    if (this.drainTimer !== null) this.clock.clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.drainDeadlineAt = null;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private maybeArmIdle(): void {
    if (this.stateValue !== "ready" || this.opts.config.idleShutdownMs <= 0) return;
    if (this.activeLeases > 0 || this.idleTimer !== null) return;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null;
      if (this.stateValue === "ready" && this.activeLeases === 0) void this.stop("idle");
    }, this.opts.config.idleShutdownMs);
  }

  private onBinaryChanged(): void {
    if (this.stateValue === "starting") {
      this.drainAfterStart = true;
      return;
    }
    if (this.stateValue !== "ready") return;
    if (this.countLeases(this.current?.generation ?? -1) === 0) void this.stop("binary-changed");
    else {
      this.clearIdle();
      this.setState("draining");
    }
  }

  private recordEarlyExit(now: number): void {
    const window = this.opts.config.timings.earlyExitWindowMs;
    this.earlyExits = this.earlyExits.filter((t) => now - t <= window);
    this.earlyExits.push(now);
    if (this.earlyExits.length < 3) return;
    this.earlyExits = [];
    const cooldown = this.opts.config.breakerCooldownMs;
    this.brokenUntil = now + cooldown;
    this.setState("broken");
    this.breakerTimer = this.clock.setTimeout(() => {
      this.breakerTimer = null;
      if (this.stateValue === "broken") this.setState("stopped");
    }, cooldown);
  }

  private armWedgedCheck(): void {
    this.wedgedTimer = this.clock.setTimeout(() => {
      this.wedgedTimer = null;
      if (this.abandoned.length === 0) return;
      this.checkWedged();
      if (this.abandoned.length > 0) this.armWedgedCheck();
    }, this.opts.config.timings.wedgedCheckMs);
  }

  /** SR 3.5: one abandoned turn and no RPC settled for `stallTimeoutMs`, or three within 10 min. */
  private checkWedged(): void {
    if (this.stateValue !== "ready" && this.stateValue !== "draining") return;
    const now = this.clock.now();
    const window = this.opts.config.timings.wedgedWindowMs;
    const recent = this.abandoned.filter((t) => now - t <= window).length;
    const silent = now - this.lastRpcSettledAt >= this.opts.config.stallTimeoutMs && (this.opts.isAwaitingAgy?.() ?? true);
    if (recent >= 3 || (this.abandoned.length >= 1 && silent)) {
      this.log(`agy process wedged (abandoned turns ${this.abandoned.length})`);
      void this.stop("wedged");
    }
  }

  private async start(): Promise<Generation> {
    const generation = ++this.generationValue;
    this.cancelledStart = null;
    this.drainAfterStart = false;
    this.abandoned = [];
    this.setState("starting");
    const startedAt = this.clock.now();
    let runDir: RunDir | null = null;
    let current: Current | null = null;
    try {
      await this.opts.install.beforeSpawn();
      if (this.cancelledStart) throw new StartCancelledError();
      const binary = await this.opts.install.resolveBinary();
      if (this.cancelledStart) throw new StartCancelledError();
      await this.opts.sweep?.();
      if (this.cancelledStart) throw new StartCancelledError();
      runDir = await this.opts.createRunDir("runtime");
      if (this.cancelledStart) throw new StartCancelledError();
      const env = this.opts.install.buildSpawnEnv({ tmpDir: runDir.path });
      const geminiDir = this.opts.install.geminiDir;
      const logDir = path.join(geminiDir, "antigravity-acp", "log");
      mkdirSync(logDir, { recursive: true });
      mkdirSync(this.opts.dataDir, { recursive: true });
      const logFile = path.join(logDir, `opencode-${logStamp(startedAt)}-${process.pid}-${generation}.log`);
      const args = [
        ...this.opts.baseArgs(geminiDir),
        "--include-default-customizations=false",
        "--disable-telemetry",
        "--agent",
        this.opts.agentName ?? AGENT_NAME,
        "--log-file",
        logFile,
        ...(this.opts.config.processPerSession ? ["--process-per-session"] : []),
      ];
      const child = this.spawner(binary.path, args, { cwd: this.opts.dataDir, env });
      let resolveExited = (): void => {};
      const exited = new Promise<void>((resolve) => {
        resolveExited = resolve;
      });
      const client = new AcpClient({
        transport: child,
        generation,
        clock: this.clock,
        timings: this.opts.config.timings,
        allowPermission: (p) => this.opts.allowPermission(p, generation),
        onSignInLine: () => {
          if (current) current.signInFailure = true;
          child.kill("SIGTERM");
        },
        onActivity: () => {
          this.lastRpcSettledAt = this.clock.now();
        },
        // An RPC timeout counts toward the wedged check like an abandoned turn (SR 3.2 step 7).
        onRpcTimeout: () => this.reportAbandoned(generation),
        log: this.opts.log,
      });
      current = {
        generation,
        child,
        client,
        runDir,
        logFile,
        startedAt,
        binaryVersion: binary.version,
        capabilities: null,
        stopReason: this.cancelledStart,
        signInFailure: false,
        exitHandled: false,
        exited,
      };
      const record = current;
      this.current = record;
      child.onExit((code, signal) => {
        this.handleExit(record, code, signal);
        resolveExited();
      });

      const capabilities = await client.initialize();
      await client.authenticate(this.opts.install.authMethod);
      this.opts.install.reportAuthenticated();
      if (this.cancelledStart || record.stopReason) throw new StartCancelledError();
      record.capabilities = capabilities;
      this.lastRpcSettledAt = this.clock.now();
      this.setState("ready");
      const view = this.view(record, capabilities);
      this.opts.onReady?.(view);
      if (this.drainAfterStart) this.onBinaryChanged();
      else this.maybeArmIdle();
      return view;
    } catch (err) {
      // Only errors from the child are reported; a `beforeSpawn` rejection is the auth manager's own state.
      const signIn = current !== null && this.opts.install.isSignInRequired(err);
      if (signIn) {
        if (current) current.signInFailure = true;
        this.opts.install.reportSignInRequired(SIGNED_OUT_MESSAGE);
      }
      if (current && this.current === current) {
        if (!current.stopReason) current.stopReason = this.cancelledStart;
        current.child.kill("SIGTERM");
        await this.waitExit(current);
      } else {
        await runDir?.release().catch(() => {});
        if (this.stateValue === "starting" && this.generationValue === generation) this.setState("stopped");
      }
      throw err;
    } finally {
      if (this.generationValue === generation) this.startPromise = null;
    }
  }

  private async waitExit(c: Current): Promise<void> {
    const grace = this.opts.config.timings.termExitGraceMs;
    const timedOut = await this.race(c.exited, grace);
    if (timedOut) {
      c.child.kill("SIGKILL");
      await this.race(c.exited, grace);
    }
  }

  /** True when `ms` elapsed first. */
  private race(p: Promise<void>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(true), ms);
      void p.then(() => {
        this.clock.clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private async stopChild(reason: StopReason): Promise<void> {
    const c = this.current;
    if (!c) {
      this.setState("stopped");
      return;
    }
    c.stopReason ??= reason;
    this.clearIdle();
    this.clearDrainDeadline();
    this.setState("stopping");
    const { stdinExitGraceMs, termExitGraceMs } = this.opts.config.timings;
    c.client.gracefulClose();
    if (await this.race(c.exited, stdinExitGraceMs)) {
      c.child.kill("SIGTERM");
      if (await this.race(c.exited, termExitGraceMs)) {
        c.child.kill("SIGKILL");
        // No exit event even after SIGKILL: clean up anyway, so `stopping` never sticks.
        if (await this.race(c.exited, termExitGraceMs)) this.handleExit(c, null, "SIGKILL");
      }
    }
  }

  private handleExit(c: Current, code: number | null, signal: string | null): void {
    if (c.exitHandled) return;
    c.exitHandled = true;
    const now = this.clock.now();
    const uptimeMs = now - c.startedAt;
    const expected = c.stopReason !== null;
    c.client.rejectAll(new AgyExitedError(code, signal));
    void c.runDir.release().catch(() => {});
    this.log(`agy generation ${c.generation} exited (code ${code ?? "none"}, signal ${signal ?? "none"}, expected ${expected})`);
    if (this.current === c) {
      this.current = null;
      this.clearIdle();
      this.clock.clearTimeout(this.wedgedTimer);
      this.wedgedTimer = null;
      this.abandoned = [];
      this.setState("stopped");
      if (!expected && !c.signInFailure && uptimeMs <= this.opts.config.timings.earlyExitWindowMs) this.recordEarlyExit(now);
    }
    this.opts.onExit({ generation: c.generation, code, signal, expected, reason: c.stopReason, uptimeMs });
  }
}
