// The process-global auth owner (IA 10 to 13, 15): state, login, logout, connection status, and the
// InstallAuthBridge the runtime consumes.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { INTEGRATION_ID } from "../constants.ts";
import type {
  AuthChangeReason,
  AuthChangedEvent,
  CreateRunDir,
  InstallAuthBridge,
  Lease,
  RunDir,
  RunDirKind,
  RuntimeControl,
} from "../contracts.ts";
import type { BinaryManager, ResolvedBinaryWithSource } from "../install/binary-manager.ts";
import { getBinaryManager } from "../install/binary-manager.ts";
import { LOG_PREFIX, singletonKey, type InstallAuthConfig } from "../install/config.ts";
import { agyArgsFor, buildAgyEnv } from "../install/env.ts";
import { errorMessage, getField } from "../install/fs-utils.ts";
import { acquireDirLock, LockBusyError, type DirLock } from "../install/lock.ts";
import { authEpochFile, authLockDir } from "../install/paths.ts";
import { profileIdFor } from "../session-store.ts";
import { processSingleton } from "../install/singletons.ts";
import { withTimeout } from "../install/acp-control.ts";
import {
  CODE_INSTRUCTIONS,
  DEFAULT_AUTH_TIMEOUTS,
  LOGIN_MESSAGES,
  MARKER_ACCESS,
  OAUTH_METHOD_ID,
  SHARED_READY,
  type AuthTimeouts,
} from "./constants.ts";
import { AUTH_METHODS, type OAuthAuthorization, type OAuthCredential } from "./methods.ts";
import { AuthEpoch } from "./epoch.ts";
import { isSignInRequired, NEEDS_AUTH_STATUS_MESSAGE, redactAgyOutput, SIGNED_OUT_MESSAGE, SignInRequiredError } from "./errors.ts";
import { checkLoginResponse, LoginError, startCodeLogin, type CodeLoginChild } from "./login.ts";
import { logoutProfile } from "./logout.ts";
import { probeAuth, readAccountEmail, type ProbeResult } from "./probe.ts";
import { authSettingsPatch, ensureProfileDirs, isPluginOwnedProfile, updateProfileSettings } from "./settings.ts";

export type { RuntimeControl } from "../contracts.ts";

export type AuthState =
  | { kind: "unknown" }
  | { kind: "signed_in"; checkedAt: number; email?: string }
  | { kind: "signed_out"; checkedAt: number; message: string; epoch: string }
  | { kind: "login_pending"; deadline: number }
  | { kind: "login_finalizing" }
  | { kind: "logging_out" };

// ---------------------------------------------------------------------------
// OpenCode location shapes (IA 2.5, 11.1). Method syntax keeps them assignable from OpenCode's own
// `IntegrationDomain`, whose connection type is a branded union.
// ---------------------------------------------------------------------------

export interface ConnectionStatusValue {
  status: "needs_auth";
  message: string;
  url?: string;
}

export interface ConnectionLike {
  readonly type: string;
  readonly status?: ConnectionStatusValue;
}

export interface IntegrationDomainLike {
  get(input: { integrationID: string }): Promise<{ data: { connections: readonly ConnectionLike[] } }>;
  readonly connection: {
    active(integrationID: string): Promise<ConnectionLike | undefined>;
    status(input: { integrationID: string; connection: ConnectionLike; status: ConnectionStatusValue | undefined }): Promise<void>;
  };
}

export interface LocationHandle {
  directory: string;
  integration: IntegrationDomainLike;
}

/** What `AuthManager` needs from `BinaryManager`. */
export type BinarySource = Pick<BinaryManager, "resolveBinary" | "resolveExisting" | "useRunDirs">;

export interface AuthManagerDeps {
  binary: BinarySource;
  env?: NodeJS.ProcessEnv;
  timeouts?: Partial<AuthTimeouts>;
  now?: () => number;
  /** Lines that always print (logout failures). Default stderr. */
  log?: (line: string) => void;
  /** Debug lines. Default none. */
  debug?: (line: string) => void;
  /** Auth lock tuning, for tests. */
  lockStaleMs?: number;
  lockPollMs?: number;
}

interface Attempt {
  readonly id: number;
  readonly child: CodeLoginChild;
  readonly runDir: RunDir;
  readonly binaryPath: string;
  readonly previousEmail: string | undefined;
  timer: ReturnType<typeof setTimeout> | null;
  /** State to go back to when the attempt ends without success (IA 10.2 cleanup). */
  prevState: AuthState;
  cleaned: boolean;
  /** Set by the paste timer, so a late paste gets the expiry text, not "replaced". */
  expired: boolean;
}

function isIntegrationNotFound(err: unknown): boolean {
  return getField(err, "_tag") === "IntegrationNotFoundError" || getField(err, "name") === "IntegrationNotFoundError";
}

function sameStatus(a: ConnectionStatusValue | undefined, b: ConnectionStatusValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.status === b.status && a.message === b.message && a.url === b.url;
}

const BRAND = "opencode-antigravity.auth-manager.v1";

export class AuthManager {
  readonly brand = BRAND;
  readonly config: InstallAuthConfig;
  private readonly binary: BinarySource;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeouts: AuthTimeouts;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly debug: (line: string) => void;
  private readonly lockOpts: { staleMs?: number; pollMs?: number };
  private readonly epoch: AuthEpoch;
  /** This profile's login and logout lock dir. */
  private readonly authLock: string;

  private current: AuthState = { kind: "unknown" };
  /** True when `signed_out` came from a logout; `beforeSpawn` then refuses until the epoch moves. */
  private signedOutByLogout = false;
  private mutex: Promise<void> = Promise.resolve();
  private attempt: Attempt | null = null;
  private nextAttemptId = 1;
  /** Held from `authorize()` step 3 until the attempt chain ends. */
  private loginLock: DirLock | null = null;
  private loginHold: Lease | null = null;
  private readonly locations: LocationHandle[] = [];
  private runtime: RuntimeControl | null = null;
  private createRunDir: CreateRunDir | null = null;
  private email: string | undefined;
  private readonly authListeners = new Set<(e: AuthChangedEvent) => void>();
  private readonly stateWaiters = new Set<() => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private setupProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly background = new Set<Promise<unknown>>();
  private statusQueue: Promise<void> = Promise.resolve();
  private readonly onProcessExit = (): void => {
    this.attempt?.child.killSync();
  };

  constructor(config: InstallAuthConfig, deps: AuthManagerDeps) {
    this.config = config;
    this.binary = deps.binary;
    this.env = deps.env ?? process.env;
    this.timeouts = { ...DEFAULT_AUTH_TIMEOUTS, ...deps.timeouts };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.debug = deps.debug ?? (() => {});
    this.lockOpts = { staleMs: deps.lockStaleMs, pollMs: deps.lockPollMs };
    const profileId = profileIdFor(config.geminiDir);
    this.authLock = authLockDir(config.dataDir, profileId);
    this.epoch = new AuthEpoch(authEpochFile(config.dataDir, profileId), { rereadMs: this.timeouts.epochRereadMs, now: this.now });
    this.epoch.onExternalChange((epoch) => this.onExternalEpoch(epoch));
  }

  get state(): AuthState {
    return this.current;
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** One per `setup(ctx)`; the returned function detaches it in setup's cleanup (IA 11.1). */
  attach(handle: LocationHandle): () => void {
    this.locations.push(handle);
    if (this.current.kind === "signed_out") {
      const run = this.statusQueue.then(() => this.refreshLocation(handle));
      this.statusQueue = run.catch(() => {});
      this.track(run);
    }
    return () => {
      const at = this.locations.indexOf(handle);
      if (at >= 0) this.locations.splice(at, 1);
    };
  }

  /** From index.ts once the pool exists (IA 15.2). */
  attachRuntime(control: RuntimeControl, createRunDir: CreateRunDir): void {
    this.runtime = control;
    this.createRunDir = createRunDir;
    this.binary.useRunDirs(createRunDir);
  }

  /**
   * IA 13.2: once at setup, after `setupProbeDelayMs`, probe when a credential exists and the runtime
   * has not reported yet, so a stale credential shows "Sign in again" before any chat.
   */
  scheduleSetupProbe(): void {
    if (this.setupProbeTimer) return;
    this.setupProbeTimer = setTimeout(() => {
      this.track(this.setupProbe());
    }, this.timeouts.setupProbeDelayMs);
    this.setupProbeTimer.unref();
  }

  /** Waits for background status pushes and probes. For tests and shutdown. */
  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Stops timers. The instance stays usable. */
  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.setupProbeTimer) clearTimeout(this.setupProbeTimer);
    this.debounceTimer = null;
    this.setupProbeTimer = null;
  }

  // -------------------------------------------------------------------------
  // Bridge members (IA 15.1)
  // -------------------------------------------------------------------------

  authEpoch(): string {
    return this.epoch.read();
  }

  onAuthChanged(listener: (e: AuthChangedEvent) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  isPluginOwnedProfile(): boolean {
    return isPluginOwnedProfile(this.config.geminiDir);
  }

  /**
   * Before every spawn: waits while `login_finalizing` or `logging_out`; then rejects with
   * `SignInRequiredError` while signed out after a logout and the epoch file has not moved; then
   * writes `{ auth, gcp }` to the profile settings.
   */
  async beforeSpawn(): Promise<void> {
    while (this.current.kind === "login_finalizing" || this.current.kind === "logging_out") await this.nextStateChange();
    if (this.current.kind === "signed_out" && this.signedOutByLogout) {
      // Another process signed in since this logout: the state is unknown again. The listener that
      // reports it runs in a microtask, so decide from the value read here.
      const epoch = this.epoch.refresh();
      if (epoch === this.current.epoch) throw new SignInRequiredError();
      this.markEpochMoved(epoch);
    }
    await this.prepareProfile();
  }

  reportAuthenticated(): void {
    const next: AuthState = { kind: "signed_in", checkedAt: this.now(), ...(this.email ? { email: this.email } : {}) };
    if (this.attempt) {
      this.attempt.prevState = next;
      return;
    }
    // After a logout only a login (here or in another process) reopens spawns, never a late report.
    if (this.current.kind === "logging_out" || this.current.kind === "login_finalizing" || this.signedOutByLogout) return;
    const changed = this.current.kind !== "signed_in";
    this.signedOutByLogout = false;
    this.setState(next);
    if (changed) this.track(this.refreshStatuses());
  }

  reportSignInRequired(message: string): void {
    const next: AuthState = { kind: "signed_out", checkedAt: this.now(), message, epoch: this.epoch.read() };
    if (this.current.kind === "logging_out" || this.current.kind === "login_finalizing" || this.signedOutByLogout) return;
    if (this.attempt) {
      this.attempt.prevState = next;
    } else {
      this.signedOutByLogout = false;
      this.setState(next);
      this.track(this.refreshStatuses());
    }
    if (this.runtime) {
      const runtime = this.runtime;
      this.track(runtime.stop("auth-changed").catch((err: unknown) => this.debug(`runtime stop failed: ${errorMessage(err)}`)));
    }
  }

  // -------------------------------------------------------------------------
  // Login (IA 10)
  // -------------------------------------------------------------------------

  /** `authorize()` for the OAuth registration. One at a time; the newest supersedes a pending one. */
  authorize(): Promise<OAuthAuthorization> {
    return this.withMutex(() => this.authorizeLocked());
  }

  /** `Google (<email>)` when the email is known; otherwise OpenCode numbers the rows (IA 10.3). */
  label(_credential: OAuthCredential): string | undefined {
    return this.email ? `Google (${this.email})` : undefined;
  }

  private async authorizeLocked(): Promise<OAuthAuthorization> {
    // 1. config issue
    const issue = AUTH_METHODS[this.config.authMethod].configIssue(this.config);
    if (issue) throw new LoginError(issue);

    // 2. supersede a pending login in this process; its lock and hold pass on
    let prevState = this.current;
    const old = this.attempt;
    if (old) {
      prevState = old.prevState;
      this.supersede(old);
    }

    // 3. auth lock
    if (!this.loginLock) {
      try {
        this.loginLock = await acquireDirLock(this.authLock, { waitMs: 0, ...this.lockOpts });
      } catch (err) {
        this.releaseLoginResources();
        this.setState(prevState);
        if (err instanceof LockBusyError) throw new LoginError(LOGIN_MESSAGES.otherWindow);
        throw err;
      }
    }

    let runDir: RunDir | null = null;
    try {
      // 4. binary, waiting for a running first install
      const binary = await this.binary.resolveBinary({ waitMs: this.timeouts.binaryWaitMs });
      await this.prepareProfile();

      // 5. shared mode shortcut
      if (!this.config.isolatedAuth && (await this.hasCredentials()) === false) {
        const probe = await this.probeWith(binary.path, this.timeouts.probeMs);
        if (probe === "signed_in") {
          await this.bumpEpoch("login");
          this.signedOutByLogout = false;
          this.setState({ kind: "signed_in", checkedAt: this.now() });
          this.releaseLoginResources();
          this.track(this.refreshStatuses());
          return { mode: "auto", url: "", instructions: SHARED_READY, callback: Promise.resolve(this.markerCredential()) };
        }
      }

      // 6. run dir and hold
      const previousEmail = this.config.isolatedAuth ? await readAccountEmail(this.config.geminiDir) : undefined;
      runDir = await this.runDir("login");
      if (!this.loginHold && this.runtime) this.loginHold = this.runtime.hold("login");

      // 7 to 9. child, URL, URL check
      const env = buildAgyEnv({ kind: "login", tmpDir: runDir.path, config: this.config, baseEnv: this.env });
      const child = await startCodeLogin({
        binary: binary.path,
        args: agyArgsFor("login", this.config.geminiDir),
        env,
        cwd: runDir.path,
        urlTimeoutMs: this.timeouts.urlMs,
        killGraceMs: this.timeouts.killGraceMs,
      });

      // 10. pending
      const deadline = this.now() + this.timeouts.pasteMs;
      const attempt: Attempt = {
        id: this.nextAttemptId++,
        child,
        runDir,
        binaryPath: binary.path,
        previousEmail,
        timer: null,
        prevState,
        cleaned: false,
        expired: false,
      };
      runDir = null; // owned by the attempt now
      attempt.timer = setTimeout(() => {
        if (this.attempt !== attempt) return;
        attempt.expired = true;
        this.track(this.cleanupAttempt(attempt, true));
      }, this.timeouts.pasteMs);
      attempt.timer.unref();
      this.attempt = attempt;
      process.on("exit", this.onProcessExit);
      this.setState({ kind: "login_pending", deadline });

      // 11.
      return {
        mode: "code",
        url: child.authUrl.url,
        instructions: CODE_INSTRUCTIONS,
        expiresAt: deadline,
        callback: (code: string) => this.complete(attempt, code),
      };
    } catch (err) {
      if (runDir) await runDir.release().catch(() => {});
      this.releaseLoginResources();
      this.setState(prevState);
      throw err;
    }
  }

  /** IA 10.3. Every path ends the attempt. */
  private async complete(attempt: Attempt, code: string): Promise<OAuthCredential> {
    if (attempt.expired) throw new LoginError(LOGIN_MESSAGES.expired);
    if (this.attempt !== attempt) throw new LoginError(LOGIN_MESSAGES.replaced);
    let succeeded = false;
    try {
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.timer = null;
      const value = checkLoginResponse(attempt.child.authUrl, code);
      if (value === null) throw new LoginError(LOGIN_MESSAGES.badPaste);
      if (attempt.child.exited) throw new LoginError(LOGIN_MESSAGES.stopped);
      try {
        await attempt.child.submit(value, this.timeouts.exchangeMs);
      } catch (err) {
        if (this.attempt !== attempt) throw new LoginError(LOGIN_MESSAGES.replaced);
        throw err;
      }
      if (this.attempt !== attempt) throw new LoginError(LOGIN_MESSAGES.replaced);

      // 7. verify
      this.setState({ kind: "login_finalizing" });
      const probe = await this.probeWith(attempt.binaryPath, this.timeouts.verifyProbeMs);
      if (this.attempt !== attempt) throw new LoginError(LOGIN_MESSAGES.replaced);
      if (probe !== "signed_in") throw new LoginError(LOGIN_MESSAGES.notConfirmed);
      const email = this.config.isolatedAuth ? await readAccountEmail(this.config.geminiDir) : undefined;

      // 8. epoch and state
      const reason: AuthChangeReason =
        email !== undefined && attempt.previousEmail !== undefined && email !== attempt.previousEmail ? "account-changed" : "login";
      await this.bumpEpoch(reason);
      this.email = email;
      this.signedOutByLogout = false;
      this.setState({ kind: "signed_in", checkedAt: this.now(), ...(email ? { email } : {}) });
      succeeded = true;

      // 9. clear needs_auth everywhere
      await this.refreshStatuses();
      // 10.
      return this.markerCredential();
    } finally {
      if (this.attempt === attempt) await this.cleanupAttempt(attempt, !succeeded);
    }
  }

  private markerCredential(): OAuthCredential {
    return {
      type: "oauth",
      methodID: OAUTH_METHOD_ID,
      access: MARKER_ACCESS,
      refresh: MARKER_ACCESS,
      expires: 0,
      metadata: { profile: this.config.isolatedAuth ? "isolated" : "shared" },
    };
  }

  /** Kills the old child and frees its dir; the lock and hold stay for the new attempt. */
  private supersede(old: Attempt): void {
    old.cleaned = true;
    if (old.timer) clearTimeout(old.timer);
    old.timer = null;
    this.attempt = null;
    process.removeListener("exit", this.onProcessExit);
    this.track(
      (async () => {
        await old.child.kill(this.timeouts.killGraceMs);
        await old.runDir.release().catch(() => {});
      })(),
    );
  }

  /**
   * IA 10.2 cleanup, at most once per attempt. The lock, the hold and the state are released before
   * the first await, so a newer `authorize()` never sees them freed under it.
   */
  private async cleanupAttempt(attempt: Attempt, restoreState: boolean): Promise<void> {
    if (attempt.cleaned) return;
    attempt.cleaned = true;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    if (this.attempt === attempt) {
      this.attempt = null;
      process.removeListener("exit", this.onProcessExit);
      this.releaseLoginResources();
      if (restoreState) this.setState(attempt.prevState);
    }
    await attempt.child.kill(this.timeouts.killGraceMs);
    await attempt.runDir.release().catch(() => {});
  }

  private releaseLoginResources(): void {
    this.loginHold?.release();
    this.loginHold = null;
    this.loginLock?.releaseSync();
    this.loginLock = null;
  }

  // -------------------------------------------------------------------------
  // Logout (IA 11)
  // -------------------------------------------------------------------------

  /** `credential.updated` for this integration, from any attached location; debounced, process-global. */
  onCredentialChanged(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.track(this.handleCredentialChange());
    }, this.timeouts.credentialDebounceMs);
    this.debounceTimer.unref();
  }

  private isBusy(): boolean {
    const kind = this.current.kind;
    return kind === "login_pending" || kind === "login_finalizing" || kind === "logging_out";
  }

  private async handleCredentialChange(): Promise<void> {
    if (this.isBusy()) {
      await this.refreshStatuses();
      return;
    }
    const has = await this.hasCredentials();
    if (has === null) return; // no location answered: never sign out on a read failure
    if (has) {
      await this.refreshStatuses();
      return;
    }
    await this.logout("credential-removed");
  }

  /** IA 11.3. Ends in `signed_out` whatever agy does. */
  logout(reason: "credential-removed"): Promise<void> {
    return this.withMutex(() => this.logoutLocked(reason));
  }

  private async logoutLocked(reason: string): Promise<void> {
    if (this.isBusy()) return;
    let lock: DirLock;
    try {
      lock = await acquireDirLock(this.authLock, { waitMs: this.timeouts.logoutLockWaitMs, ...this.lockOpts });
    } catch (err) {
      this.log(`${LOG_PREFIX} Could not sign out of Antigravity (${reason}): ${err instanceof LockBusyError ? "another OpenCode window holds the sign-in lock" : redactAgyOutput(errorMessage(err))}.`);
      return;
    }
    try {
      this.setState({ kind: "logging_out" });
      await this.bumpEpoch("logout");
      if (this.runtime) await this.runtime.stop("auth-changed");
      if (this.config.isolatedAuth) await this.signOutProfile();
    } catch (err) {
      this.log(`${LOG_PREFIX} Antigravity logout did not finish (${redactAgyOutput(errorMessage(err)) || "error"}); OpenCode is signed out anyway.`);
    } finally {
      this.signedOutByLogout = true;
      this.setState({ kind: "signed_out", checkedAt: this.now(), message: SIGNED_OUT_MESSAGE, epoch: this.epoch.read() });
      lock.releaseSync();
      this.track(this.refreshStatuses());
    }
  }

  /**
   * The ACP part shares one `logoutMs` budget with finding the binary; the file fallback runs after it
   * whatever happened, so a hanging agy still ends with the tokens gone.
   */
  private async signOutProfile(): Promise<void> {
    const deadline = this.now() + this.timeouts.logoutMs;
    await this.prepareProfile().catch(() => {});
    const binary: ResolvedBinaryWithSource | null = await withTimeout(this.binary.resolveExisting(), this.timeouts.logoutMs, () => new Error("timeout")).catch(
      () => null,
    );
    const runDir = await this.runDir("logout");
    try {
      const outcome = await logoutProfile({
        binary: binary?.path ?? null,
        config: this.config,
        tmpDir: runDir.path,
        baseEnv: this.env,
        timeoutMs: Math.max(1, deadline - this.now()),
        pluginOwned: this.isPluginOwnedProfile(),
        killGraceMs: this.timeouts.killGraceMs,
      });
      if (outcome.method === "files") {
        this.log(`${LOG_PREFIX} Antigravity logout fell back to deleting token files (${redactAgyOutput(outcome.reason) || "error"}).`);
      }
    } finally {
      await runDir.release().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Status (IA 12, 13)
  // -------------------------------------------------------------------------

  private async setupProbe(): Promise<void> {
    if (this.current.kind !== "unknown") return;
    if ((await this.hasCredentials()) !== true) return;
    const binary = await this.binary.resolveExisting();
    if (!binary) return;
    await this.prepareProfile().catch(() => {});
    const result = await this.probeWith(binary.path, this.timeouts.probeMs);
    if (this.current.kind !== "unknown") return;
    if (result === "signed_in") this.reportAuthenticated();
    else if (result === "signed_out") this.reportSignInRequired(SIGNED_OUT_MESSAGE);
  }

  /**
   * IA 11.2 step 2, in attach order: true as soon as a location reports an active credential; false
   * when at least one location answered and none reported one (`IntegrationNotFoundError` answers
   * "none"); null when no location answered, so a read failure never reads as "signed out".
   */
  private async hasCredentials(): Promise<boolean | null> {
    let answered = false;
    for (const handle of [...this.locations]) {
      try {
        const active = await handle.integration.connection.active(INTEGRATION_ID);
        if (active !== undefined && active !== null) return true;
        answered = true;
      } catch (err) {
        if (isIntegrationNotFound(err)) answered = true;
        else this.debug(`connection.active failed in ${handle.directory}`);
      }
    }
    return answered ? false : null;
  }

  private desiredStatus(): { set: true; value: ConnectionStatusValue | undefined } | { set: false } {
    if (this.current.kind === "signed_out") return { set: true, value: { status: "needs_auth", message: NEEDS_AUTH_STATUS_MESSAGE } };
    if (this.current.kind === "signed_in") return { set: true, value: undefined };
    return { set: false };
  }

  /**
   * IA 13.3: `needs_auth` on every credential while signed out, cleared while signed in, in every
   * location. Runs one at a time, so a refresh reads the statuses the previous one wrote and skips
   * calls that already match.
   */
  private refreshStatuses(): Promise<void> {
    const run = this.statusQueue.then(() => Promise.all([...this.locations].map((handle) => this.refreshLocation(handle)))).then(() => {});
    this.statusQueue = run.catch(() => {});
    return run;
  }

  private async refreshLocation(handle: LocationHandle): Promise<void> {
    const desired = this.desiredStatus();
    if (!desired.set) return;
    let connections: readonly ConnectionLike[];
    try {
      connections = (await handle.integration.get({ integrationID: INTEGRATION_ID })).data.connections;
    } catch (err) {
      if (!isIntegrationNotFound(err)) this.debug(`integration.get failed in ${handle.directory}`);
      return;
    }
    for (const connection of connections) {
      if (connection.type !== "credential" || sameStatus(connection.status, desired.value)) continue;
      try {
        await handle.integration.connection.status({ integrationID: INTEGRATION_ID, connection, status: desired.value });
      } catch {
        this.debug(`connection.status failed in ${handle.directory}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async prepareProfile(): Promise<void> {
    await ensureProfileDirs(this.config.dataDir, this.config.geminiDir, { defaultGeminiDir: this.config.defaultGeminiDir });
    await updateProfileSettings(this.config.geminiDir, { ...authSettingsPatch(AUTH_METHODS[this.config.authMethod], this.config) });
  }

  private async probeWith(binaryPath: string, timeoutMs: number): Promise<ProbeResult> {
    const runDir = await this.runDir("probe");
    try {
      return await probeAuth({
        binary: binaryPath,
        config: this.config,
        tmpDir: runDir.path,
        baseEnv: this.env,
        timeoutMs,
        killGraceMs: this.timeouts.killGraceMs,
      });
    } finally {
      await runDir.release().catch(() => {});
    }
  }

  /** The runtime's sweeper-aware run dir when attached; before that a local `mkdtemp` (IA 15.2). */
  private async runDir(kind: RunDirKind): Promise<RunDir> {
    if (this.createRunDir) return this.createRunDir(kind);
    const dir = await mkdtemp(path.join(tmpdir(), `opencode-antigravity-${kind}-`));
    return { path: dir, release: () => rm(dir, { recursive: true, force: true }) };
  }

  private async bumpEpoch(reason: AuthChangeReason): Promise<void> {
    const epoch = await this.epoch.bump();
    this.emitAuthChanged({ epoch, reason });
  }

  private emitAuthChanged(event: AuthChangedEvent): void {
    for (const listener of [...this.authListeners]) {
      try {
        listener(event);
      } catch (err) {
        this.debug(`onAuthChanged listener failed: ${errorMessage(err)}`);
      }
    }
  }

  /** Another process moved the epoch (IA 13.4). Runs in a microtask after the read that saw it. */
  private onExternalEpoch(epoch: string): void {
    this.markEpochMoved(epoch);
    this.emitAuthChanged({ epoch, reason: "login" });
  }

  private markEpochMoved(epoch: string): void {
    if (this.current.kind === "signed_out" && this.current.epoch !== epoch) {
      this.signedOutByLogout = false;
      this.setState({ kind: "unknown" });
    }
  }

  private setState(next: AuthState): void {
    this.current = next;
    for (const wake of [...this.stateWaiters]) wake();
  }

  private nextStateChange(): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.stateWaiters.delete(wake);
        resolve();
      };
      this.stateWaiters.add(wake);
    });
  }

  private withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn);
    this.mutex = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((err: unknown) => this.debug(`background task failed: ${errorMessage(err)}`));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }
}

function isAuthManager(value: unknown): value is AuthManager {
  return getField(value, "brand") === BRAND;
}

/** The process-global instance for this profile config (IA 3, 10.4). */
export function getAuthManager(config: InstallAuthConfig, deps: Partial<AuthManagerDeps> = {}): AuthManager {
  return processSingleton(
    "auth",
    singletonKey(config),
    () => new AuthManager(config, { ...deps, binary: deps.binary ?? getBinaryManager(config, { env: deps.env, log: deps.log, debug: deps.debug }) }),
    isAuthManager,
    deps.log,
  );
}

/** The bridge the runtime consumes (IA 15.1). */
export function createInstallAuthBridge(
  binary: Pick<BinaryManager, "resolveBinary" | "onBinaryChanged" | "status">,
  auth: AuthManager,
  opts: { env?: NodeJS.ProcessEnv } = {},
): InstallAuthBridge {
  const config = auth.config;
  return {
    resolveBinary: async (o) => {
      const resolved = await binary.resolveBinary(o);
      return { path: resolved.path, version: resolved.version };
    },
    buildSpawnEnv: ({ tmpDir }) => buildAgyEnv({ kind: "runtime", tmpDir, config, baseEnv: opts.env }),
    geminiDir: config.geminiDir,
    authMethod: config.authMethod,
    authEpoch: () => auth.authEpoch(),
    onAuthChanged: (listener) => auth.onAuthChanged(listener),
    onBinaryChanged: (listener) => binary.onBinaryChanged(listener),
    isSignInRequired,
    isPluginOwnedProfile: () => auth.isPluginOwnedProfile(),
    beforeSpawn: () => auth.beforeSpawn(),
    reportAuthenticated: () => auth.reportAuthenticated(),
    reportSignInRequired: (message) => auth.reportSignInRequired(message),
    binaryStatus: () => binary.status(),
    updateProfileSettings: (patch) => updateProfileSettings(config.geminiDir, patch),
  };
}

/** The `credential.updated` loop each location runs (IA 11.2). Ends when `signal` aborts. */
export async function runCredentialEvents(
  events: AsyncIterable<{ data?: unknown }>,
  auth: Pick<AuthManager, "onCredentialChanged">,
): Promise<void> {
  for await (const event of events) {
    if (getField(event.data, "integrationID") !== INTEGRATION_ID) continue;
    auth.onCredentialChanged();
  }
}
