// In-memory InstallAuthBridge for runtime tests. No files, no network, no real auth.
// Knobs: signOut / signIn, blockSpawns (logout or login finalization in progress), holdResolve (download
// in progress), setBinaryMissing / setBinary (fires onBinaryChanged), changeAuth (bumps the epoch, fires
// onAuthChanged), simulateLogout (the AuthManager order: bump, await runtime.stop, signed out).

import { SignInRequiredError, isSignInRequired } from "../../src/auth/errors.ts";
import type {
  AuthChangeReason,
  AuthChangedEvent,
  BinaryNotFoundErrorShape,
  BinaryStatus,
  InstallAuthBridge,
  ResolvedBinary,
  RuntimeControl,
} from "../../src/contracts.ts";

export class FakeBinaryNotFoundError extends Error implements BinaryNotFoundErrorShape {
  readonly code = "binary_not_found";

  constructor(message: string) {
    super(message);
    this.name = "BinaryNotFoundError";
  }
}

export interface FakeBridgeOptions {
  geminiDir: string;
  /** The executable `resolveBinary` returns, usually from `writeMockAgyWrapper`. */
  binaryPath?: string;
  binaryVersion?: string;
  authMethod?: string;
  pluginOwnedProfile?: boolean;
  /** Default true. False leaves out `AGY_ACP_FORCE_FILE_STORAGE`, as shared auth does (IA 9.1). */
  isolatedAuth?: boolean;
  /** Extra variables merged into `buildSpawnEnv`. */
  env?: Record<string, string>;
  initialEpoch?: number;
}

export interface FakeBridgeCalls {
  beforeSpawn: number;
  resolveBinary: number;
  buildSpawnEnv: Array<{ tmpDir: string }>;
  reportAuthenticated: number;
  reportSignInRequired: string[];
  settingsPatches: Array<Record<string, unknown>>;
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function createGate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export class FakeInstallAuthBridge implements InstallAuthBridge {
  readonly geminiDir: string;
  readonly authMethod: string;
  readonly calls: FakeBridgeCalls = {
    beforeSpawn: 0,
    resolveBinary: 0,
    buildSpawnEnv: [],
    reportAuthenticated: 0,
    reportSignInRequired: [],
    settingsPatches: [],
  };
  /** Merged result of every `updateProfileSettings` patch. */
  readonly settings: Record<string, unknown> = {};
  /** `signed_in` after `reportAuthenticated`, `signed_out` after `reportSignInRequired` or a logout. */
  authState: "unknown" | "signed_in" | "signed_out" = "unknown";

  private epoch: number;
  private binary: ResolvedBinary | null;
  private missingMessage: string | null = null;
  private signedOutAfterLogout = false;
  private signedOutMessage: string | undefined;
  private spawnGate: Gate | null = null;
  private resolveGate: Gate | null = null;
  private heldStatus: BinaryStatus | null = null;
  private runtime: RuntimeControl | null = null;
  private readonly pluginOwned: boolean;
  private readonly isolatedAuth: boolean;
  private readonly extraEnv: Record<string, string>;
  private readonly authListeners = new Set<(e: AuthChangedEvent) => void>();
  private readonly binaryListeners = new Set<(e: ResolvedBinary) => void>();

  constructor(opts: FakeBridgeOptions) {
    this.geminiDir = opts.geminiDir;
    this.authMethod = opts.authMethod ?? "oauth-personal";
    this.pluginOwned = opts.pluginOwnedProfile ?? true;
    this.isolatedAuth = opts.isolatedAuth ?? true;
    this.extraEnv = opts.env ?? {};
    this.epoch = opts.initialEpoch ?? 1;
    this.binary = opts.binaryPath
      ? { path: opts.binaryPath, version: opts.binaryVersion ?? "1.5.15" }
      : null;
    if (!this.binary) this.missingMessage = "No Antigravity binary configured in the fake bridge.";
  }

  // --- InstallAuthBridge -------------------------------------------------------------

  async resolveBinary(_opts?: { waitMs?: number }): Promise<ResolvedBinary> {
    this.calls.resolveBinary++;
    if (this.resolveGate) await this.resolveGate.promise;
    if (this.missingMessage !== null || !this.binary) {
      throw new FakeBinaryNotFoundError(this.missingMessage ?? "No Antigravity binary.");
    }
    return { ...this.binary };
  }

  buildSpawnEnv(input: { tmpDir: string }): Record<string, string> {
    this.calls.buildSpawnEnv.push({ tmpDir: input.tmpDir });
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "SystemRoot"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return {
      ...env,
      GEMINI_HOME: this.geminiDir,
      TMPDIR: input.tmpDir,
      TEMP: input.tmpDir,
      TMP: input.tmpDir,
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      PYTHONUNBUFFERED: "1",
      SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
      ...(this.isolatedAuth ? { AGY_ACP_FORCE_FILE_STORAGE: "1" } : {}),
      ...this.extraEnv,
    };
  }

  authEpoch(): string {
    return String(this.epoch);
  }

  onAuthChanged(listener: (e: AuthChangedEvent) => void): () => void {
    this.authListeners.add(listener);
    return () => {
      this.authListeners.delete(listener);
    };
  }

  onBinaryChanged(listener: (e: ResolvedBinary) => void): () => void {
    this.binaryListeners.add(listener);
    return () => {
      this.binaryListeners.delete(listener);
    };
  }

  isSignInRequired(err: unknown): boolean {
    return isSignInRequired(err);
  }

  isPluginOwnedProfile(): boolean {
    return this.pluginOwned;
  }

  async beforeSpawn(): Promise<void> {
    this.calls.beforeSpawn++;
    if (this.spawnGate) await this.spawnGate.promise;
    if (this.signedOutAfterLogout) throw new SignInRequiredError(this.signedOutMessage);
  }

  reportAuthenticated(): void {
    this.calls.reportAuthenticated++;
    this.authState = "signed_in";
  }

  reportSignInRequired(message: string): void {
    this.calls.reportSignInRequired.push(message);
    this.authState = "signed_out";
    // AuthManager asks the runtime to stop after a classified sign-in error (IA 12.1 step 4).
    this.runtime?.stop("auth-changed").catch(() => {});
  }

  binaryStatus(): BinaryStatus {
    if (this.heldStatus) return this.heldStatus;
    if (this.missingMessage !== null || !this.binary) {
      return { phase: "missing", message: this.missingMessage ?? "No Antigravity binary." };
    }
    return { phase: "ready", source: "explicit", version: this.binary.version };
  }

  async updateProfileSettings(patch: Record<string, unknown>): Promise<void> {
    this.calls.settingsPatches.push({ ...patch });
    Object.assign(this.settings, patch);
  }

  // --- Knobs ---------------------------------------------------------------------------

  /** What `AuthManager.attachRuntime` receives; used by `reportSignInRequired` and `simulateLogout`. */
  attachRuntime(control: RuntimeControl): void {
    this.runtime = control;
  }

  /** Signed out after a logout: `beforeSpawn` rejects with SignInRequiredError until `signIn` or an epoch change. */
  signOut(message?: string): void {
    this.signedOutAfterLogout = true;
    this.signedOutMessage = message;
    this.authState = "signed_out";
  }

  signIn(): void {
    this.signedOutAfterLogout = false;
    this.signedOutMessage = undefined;
    this.authState = "unknown";
  }

  /** `beforeSpawn` waits until the returned function runs, as during logout or login finalization. */
  blockSpawns(): () => void {
    const gate = createGate();
    this.spawnGate = gate;
    return () => {
      if (this.spawnGate === gate) this.spawnGate = null;
      gate.open();
    };
  }

  /** `resolveBinary` waits and `binaryStatus` reports `status` until the returned function runs. */
  holdResolve(status: BinaryStatus = { phase: "downloading", bytes: 0, total: null }): () => void {
    const gate = createGate();
    this.resolveGate = gate;
    this.heldStatus = status;
    return () => {
      if (this.resolveGate === gate) {
        this.resolveGate = null;
        this.heldStatus = null;
      }
      gate.open();
    };
  }

  /** Updates the status a held `resolveBinary` reports, for download progress notes. */
  setHeldStatus(status: BinaryStatus): void {
    this.heldStatus = status;
  }

  setBinaryMissing(message: string): void {
    this.missingMessage = message;
  }

  /** New active binary; fires `onBinaryChanged` like an activated update. */
  setBinary(binaryPath: string, version: string): void {
    this.binary = { path: binaryPath, version };
    this.missingMessage = null;
    const event: ResolvedBinary = { path: binaryPath, version };
    for (const listener of [...this.binaryListeners]) listener(event);
  }

  /**
   * Bumps the epoch and fires `onAuthChanged` in a microtask, as the real AuthEpoch notifies epoch
   * changes. An epoch change clears a logout sign-out, as in IA 13.4. Await the returned event's
   * `delivered` to run after the listeners.
   */
  changeAuth(reason: AuthChangeReason): AuthChangedEvent & { delivered: Promise<void> } {
    this.epoch++;
    if (reason !== "logout") this.signIn();
    const event: AuthChangedEvent = { epoch: this.authEpoch(), reason };
    const listeners = [...this.authListeners];
    const delivered = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        for (const listener of listeners) listener(event);
        resolve();
      });
    });
    return { ...event, delivered };
  }

  /** AuthManager's logout order (IA 11.3): spawns wait, bump with `logout`, await `runtime.stop("auth-changed")`,
   *  then signed out even when the stop rejects (the rejection still reaches the caller). */
  async simulateLogout(): Promise<void> {
    const release = this.blockSpawns();
    try {
      // AuthManager's own bump notifies before it awaits runtime.stop.
      await this.changeAuth("logout").delivered;
      await this.runtime?.stop("auth-changed");
    } finally {
      this.signOut();
      release();
    }
  }

  listenerCounts(): { auth: number; binary: number } {
    return { auth: this.authListeners.size, binary: this.binaryListeners.size };
  }
}

export function createFakeBridge(opts: FakeBridgeOptions): FakeInstallAuthBridge {
  return new FakeInstallAuthBridge(opts);
}
