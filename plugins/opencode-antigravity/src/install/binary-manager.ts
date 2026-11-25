// The process-global binary owner (IA 5, 6): resolution order, background install, updates, status.

import { mkdir, readFile, rm } from "node:fs/promises";
import type { BinaryNotFoundErrorShape, BinaryOrigin, BinaryStatus, CreateRunDir, ResolvedBinary } from "../contracts.ts";
import { LOG_PREFIX, singletonKey, type InstallAuthConfig } from "./config.ts";
import { InstallError, type DownloadDeps, type FetchLike } from "./download.ts";
import type { ExtractLimits } from "./extract.ts";
import { errorMessage, getField, parseJsonObject, writeFileAtomic, type RenameFn } from "./fs-utils.ts";
import { acquireDirLock, LockBusyError, type DirLock } from "./lock.ts";
import { readManifestCache, refreshManifest, type AgyManifest } from "./manifest.ts";
import { managedDirs, type ManagedDirs } from "./paths.ts";
import { agyTarget, detectMusl, unsupportedPlatformMessage, type AgyTarget } from "./platform.ts";
import {
  inspectActive,
  installRelease,
  pruneReleases,
  readPointer,
  removeStaleStaging,
  SymlinkError,
  symlinkMessage,
  type InstalledRelease,
} from "./release.ts";
import { checkExplicitBinary, findOnPath, findT3Binary, PATH_NOT_FOUND_MESSAGE, T3_NOT_FOUND_MESSAGE } from "./resolve.ts";
import { processSingleton } from "./singletons.ts";
import { compareSemver, identityKey, MIN_AGY_VERSION, verifyAgy, type BinaryContext } from "./verify.ts";

export type { BinaryStatus } from "../contracts.ts";

export const LOCK_BUSY_MESSAGE = "Another OpenCode window is installing Antigravity. Try again in a minute.";
const MIB = 1024 * 1024;

/** `resolveBinary()` failure (IA 8). The runtime classifies it by `code`. */
export class BinaryNotFoundError extends Error implements BinaryNotFoundErrorShape {
  readonly code = "binary_not_found";

  constructor(message: string) {
    super(message);
    this.name = "BinaryNotFoundError";
  }
}

export interface ResolvedBinaryWithSource extends ResolvedBinary {
  source: BinaryOrigin;
}

export interface InstallTimeouts {
  /** Waiting for another process's install (download plus verify). */
  lockWaitMs: number;
  lockPollMs: number;
  lockStaleMs: number;
  lockHeartbeatMs: number;
  /** Background manifest check interval. */
  updateIntervalMs: number;
  /** Next check after a failed one. */
  updateRetryMs: number;
  verifyMs: number;
  /** `progress.json` rewrite interval. */
  progressWriteMs: number;
}

export const DEFAULT_INSTALL_TIMEOUTS: InstallTimeouts = {
  lockWaitMs: 35 * 60_000,
  lockPollMs: 500,
  lockStaleMs: 30_000,
  lockHeartbeatMs: 10_000,
  updateIntervalMs: 6 * 60 * 60_000,
  updateRetryMs: 30 * 60_000,
  verifyMs: 90_000,
  progressWriteMs: 1_000,
};

export interface BinaryManagerDeps {
  /** Test seam; production uses global `fetch`. Hosts are still checked by `safeFetch`. */
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
  now?: () => number;
  /** Lines that always print (fallback notice). Default stderr. */
  log?: (line: string) => void;
  /** Debug lines (skipped candidates, background failures). Default none. */
  debug?: (line: string) => void;
  timeouts?: Partial<InstallTimeouts>;
  download?: Omit<DownloadDeps, "fetch" | "onProgress" | "signal">;
  extractLimits?: ExtractLimits;
  /** Test seam for the activation commit point. */
  rename?: RenameFn;
}

export interface BinaryChange {
  path: string;
  version: string;
}

/** Status texts without the runtime's `[Antigravity]` prefix (IA 8, 15.3 item 2). */
export function describeBinaryStatus(status: BinaryStatus): string {
  switch (status.phase) {
    case "downloading": {
      const n = Math.round(status.bytes / MIB);
      return status.total === null
        ? `Downloading Google's Antigravity CLI (${n} MB). This happens once.`
        : `Downloading Google's Antigravity CLI (${n} of ${Math.round(status.total / MIB)} MB). This happens once.`;
    }
    case "waiting_for_lock":
      return "Another OpenCode window is installing Antigravity. Waiting for it.";
    case "verifying":
      return "Checking the downloaded Antigravity CLI.";
    case "missing":
      return status.message;
    case "ready":
      return `Antigravity ${status.version} is ready.`;
  }
}

const BRAND = "opencode-antigravity.binary-manager.v1";

export class BinaryManager {
  readonly brand = BRAND;
  readonly config: InstallAuthConfig;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly target: AgyTarget | null;
  private readonly dirs: ManagedDirs | null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly debug: (line: string) => void;
  private readonly timeouts: InstallTimeouts;
  private readonly deps: BinaryManagerDeps;

  private phase: BinaryStatus = { phase: "missing", message: "Antigravity has not been located yet." };
  private installing: Promise<InstalledRelease> | null = null;
  private updating: Promise<void> | null = null;
  private lastResolved: ResolvedBinaryWithSource | null = null;
  private readonly resolvedReleaseIds = new Set<string>();
  private readonly identityCache = new Map<string, string>();
  private readonly listeners = new Set<(e: BinaryChange) => void>();
  private fallbackLogged = false;
  private lastProgressWrite = 0;
  private createRunDir: CreateRunDir | null = null;

  constructor(config: InstallAuthConfig, deps: BinaryManagerDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.fetchImpl = deps.fetch;
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    const arch = deps.arch ?? process.arch;
    this.target = agyTarget(this.platform, arch, deps.musl ?? detectMusl(this.platform));
    this.dirs = this.target ? managedDirs(config.dataDir, this.target) : null;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.debug = deps.debug ?? (() => {});
    this.timeouts = { ...DEFAULT_INSTALL_TIMEOUTS, ...deps.timeouts };
  }

  /** Identity checks then take their temp dir from the runtime's sweeper-aware `createRunDir`. */
  useRunDirs(createRunDir: CreateRunDir): void {
    this.createRunDir = createRunDir;
  }

  status(): BinaryStatus {
    return this.phase;
  }

  onBinaryChanged(listener: (e: BinaryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * IA 5. May download; with `waitMs`, gives up waiting after that long and throws the progress text
   * while the install continues. Rejects with `BinaryNotFoundError`.
   */
  async resolveBinary(opts: { waitMs?: number } = {}): Promise<ResolvedBinaryWithSource> {
    try {
      const resolved = await this.resolveInner(opts.waitMs);
      this.lastResolved = resolved;
      this.phase = { phase: "ready", source: resolved.source, version: resolved.version };
      return resolved;
    } catch (err) {
      const message = errorMessage(err);
      if (!this.installing) this.phase = { phase: "missing", message };
      throw err instanceof BinaryNotFoundError ? err : new BinaryNotFoundError(message);
    }
  }

  /** IA 11.3: like `resolveBinary` but never downloads and never throws. */
  async resolveExisting(): Promise<ResolvedBinaryWithSource | null> {
    try {
      if (this.config.binaryPath !== null) return await this.resolveExplicit(this.config.binaryPath);
      if (this.config.binarySource === "path") return await this.resolveFromPath();
      if (this.config.binarySource === "t3code") return await this.resolveFromT3();
      const active = await this.activeRelease();
      if (active) return active;
      if (this.config.offlineFallback) return (await this.fallback()) ?? null;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * At plugin setup (IA 6.8, 6.9): removes stale staging dirs, then starts the first install when
   * nothing is installed, or an update check when one is due. Never throws.
   */
  startBackground(): void {
    if (!this.managedActive()) return;
    const dirs = this.dirs;
    void (async () => {
      if (dirs) await removeStaleStaging(dirs, { now: this.now, platform: this.platform }).catch(() => {});
      const active = await this.activeRelease().catch(() => null);
      if (active) {
        this.maybeScheduleUpdate();
        return;
      }
      if (this.config.offline) return;
      await this.install().catch((err: unknown) => this.debug(`background install failed: ${errorMessage(err)}`));
    })();
  }

  /** The managed install, shared by concurrent callers in this process. */
  install(): Promise<InstalledRelease> {
    this.installing ??= this.runInstall(null).finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  /** Resolves once a running background update check, if any, has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.updating || this.installing) {
      await Promise.allSettled([this.updating, this.installing]);
    }
  }

  // -------------------------------------------------------------------------

  private managedActive(): boolean {
    return this.config.binaryPath === null && this.config.binarySource === "managed";
  }

  private async resolveInner(waitMs: number | undefined): Promise<ResolvedBinaryWithSource> {
    if (this.config.binaryPath !== null) return this.resolveExplicit(this.config.binaryPath);
    if (this.config.binarySource === "path") return this.resolveFromPath();
    if (this.config.binarySource === "t3code") return this.resolveFromT3();

    const target = this.target;
    let failure: string;
    if (!target) {
      failure = unsupportedPlatformMessage(this.platform, this.deps.arch ?? process.arch);
    } else {
      const active = await this.activeRelease();
      if (active) {
        this.maybeScheduleUpdate();
        return active;
      }
      if (this.config.offline) {
        failure = "offline is set and no managed Antigravity is installed";
      } else {
        try {
          const installed = await this.waitForInstall(waitMs);
          return this.trackManaged(installed.releaseId, installed.executable, installed.version);
        } catch (err) {
          if (err instanceof WaitTimeoutError) throw new BinaryNotFoundError(describeBinaryStatus(this.phase));
          failure = errorMessage(err);
        }
      }
    }
    if (this.config.offlineFallback) {
      const found = await this.fallback();
      if (found) {
        if (!this.fallbackLogged) {
          this.fallbackLogged = true;
          this.log(`${LOG_PREFIX} Managed agy unavailable (${failure.replace(/\.$/, "")}); using ${found.source} at ${found.path}.`);
        }
        return found;
      }
    }
    throw new BinaryNotFoundError(failure);
  }

  private async waitForInstall(waitMs: number | undefined): Promise<InstalledRelease> {
    const install = this.install();
    if (waitMs === undefined) return install;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WaitTimeoutError()), waitMs);
    });
    try {
      return await Promise.race([install, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fallback(): Promise<ResolvedBinaryWithSource | null> {
    const onPath = await findOnPath(this.env, (file) => this.identity(file), {
      platform: this.platform,
      onSkip: (file, reason) => this.debug(`skipping ${file}: ${reason}`),
    });
    if (onPath) return { ...onPath, source: "path" };
    if (!this.target) return null;
    const t3 = await findT3Binary(this.env, this.target, this.platform);
    if (!t3) return null;
    try {
      return { path: t3.path, version: await this.identity(t3.path), source: "t3code" };
    } catch (err) {
      this.debug(`skipping T3 Code's agy: ${errorMessage(err)}`);
      return null;
    }
  }

  private async resolveExplicit(file: string): Promise<ResolvedBinaryWithSource> {
    const checked = checkExplicitBinary(file, this.platform);
    if (!checked.ok) throw new BinaryNotFoundError(checked.message);
    return { path: checked.path, version: await this.identity(checked.path), source: "explicit" };
  }

  private async resolveFromPath(): Promise<ResolvedBinaryWithSource> {
    const found = await findOnPath(this.env, (file) => this.identity(file), {
      platform: this.platform,
      onSkip: (file, reason) => this.debug(`skipping ${file}: ${reason}`),
    });
    if (!found) throw new BinaryNotFoundError(PATH_NOT_FOUND_MESSAGE);
    return { ...found, source: "path" };
  }

  private async resolveFromT3(): Promise<ResolvedBinaryWithSource> {
    if (!this.target) throw new BinaryNotFoundError(unsupportedPlatformMessage(this.platform, this.deps.arch ?? process.arch));
    const found = await findT3Binary(this.env, this.target, this.platform);
    if (!found) throw new BinaryNotFoundError(T3_NOT_FOUND_MESSAGE);
    return { path: found.path, version: await this.identity(found.path), source: "t3code" };
  }

  /** External binaries: the identity check once per (realpath, size, mtime) in this process (IA 5). */
  private async identity(file: string): Promise<string> {
    const key = await identityKey(file);
    const cached = this.identityCache.get(key);
    if (cached !== undefined) return cached;
    const { version } = await this.verify(file, null, { kind: "external", path: file });
    this.identityCache.set(key, version);
    return version;
  }

  private async verify(file: string, expected: string | null, context: BinaryContext): Promise<{ version: string }> {
    const runDir = this.createRunDir ? await this.createRunDir("verify").catch(() => null) : null;
    try {
      return await verifyAgy(file, expected, { context, timeoutMs: this.timeouts.verifyMs, tmpRoot: runDir?.path, baseEnv: this.env });
    } finally {
      await runDir?.release().catch(() => {});
    }
  }

  private async activeRelease(): Promise<ResolvedBinaryWithSource | null> {
    if (!this.dirs || !this.target) return null;
    const active = await inspectActive(this.dirs, { executableName: this.target.executableName, platform: this.platform });
    if (active.status === "symlink") throw new SymlinkError(this.dirs.platformDir, active.at);
    if (active.status !== "valid") return null;
    return this.trackManaged(active.releaseId, active.executable, active.version);
  }

  private trackManaged(releaseId: string, file: string, version: string): ResolvedBinaryWithSource {
    this.resolvedReleaseIds.add(releaseId);
    return { path: file, version, source: "managed" };
  }

  private setPhase(phase: BinaryStatus): void {
    this.phase = phase;
  }

  private async runInstall(updateTo: AgyManifest | null): Promise<InstalledRelease> {
    const target = this.target;
    const dirs = this.dirs;
    if (!target || !dirs) throw new InstallError(unsupportedPlatformMessage(this.platform, this.deps.arch ?? process.arch), "platform");
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(dirs.platformDir, { recursive: true, mode: 0o700 });

    let lock: DirLock;
    try {
      lock = await acquireDirLock(dirs.lockDir, {
        waitMs: this.timeouts.lockWaitMs,
        pollMs: this.timeouts.lockPollMs,
        staleMs: this.timeouts.lockStaleMs,
        heartbeatMs: this.timeouts.lockHeartbeatMs,
        onWait: () => void this.readHolderProgress(dirs),
      });
    } catch (err) {
      if (err instanceof LockBusyError) throw new InstallError(LOCK_BUSY_MESSAGE, "lock busy");
      throw err;
    }
    try {
      await removeStaleStaging(dirs, { now: this.now, platform: this.platform });
      const active = await inspectActive(dirs, { executableName: target.executableName, platform: this.platform });
      if (active.status === "symlink") throw new InstallError(symlinkMessage(dirs.platformDir), "symlink");
      if (active.status === "valid") {
        // Another process installed meanwhile, or an update is no longer newer.
        if (updateTo === null || compareSemver(active.version, updateTo.version) >= 0) {
          return { releaseId: active.releaseId, dir: active.dir, executable: active.executable, version: active.version, previousActive: null };
        }
      }
      const manifest = updateTo ?? (await refreshManifest(dirs.manifestFile, target, { fetch: this.fetchImpl, now: this.now }));
      if (compareSemver(manifest.version, MIN_AGY_VERSION) < 0) {
        throw new InstallError(
          `Google's update service offers Antigravity ${manifest.version}, but this plugin needs ${MIN_AGY_VERSION} or newer. Set binaryPath to a newer agy.`,
          "manifest too old",
        );
      }
      this.setPhase({ phase: "downloading", bytes: 0, total: null });
      const result = await installRelease(manifest, dirs, {
        target,
        verify: async (file, version) => {
          await this.verify(file, version, { kind: "managed" });
        },
        download: {
          ...this.deps.download,
          fetch: this.fetchImpl,
          onProgress: (p) => {
            this.setPhase({ phase: "downloading", bytes: p.bytes, total: p.total });
            void this.writeProgress(dirs, p.bytes, p.total);
          },
        },
        extractLimits: this.deps.extractLimits,
        onPhase: (phase) => {
          if (phase === "verifying") this.setPhase({ phase: "verifying" });
        },
        rename: this.deps.rename,
        platform: this.platform,
        now: this.now,
      });
      await rm(dirs.progressFile, { force: true }).catch(() => {});
      this.resolvedReleaseIds.add(result.releaseId);
      const previous = this.lastResolved;
      if (previous !== null && previous.path !== result.executable) {
        for (const listener of this.listeners) {
          try {
            listener({ path: result.executable, version: result.version });
          } catch (err) {
            this.debug(`onBinaryChanged listener failed: ${errorMessage(err)}`);
          }
        }
      }
      await this.prune(dirs, result.releaseId);
      return result;
    } catch (err) {
      this.setPhase({ phase: "missing", message: errorMessage(err) });
      throw err;
    } finally {
      lock.releaseSync();
    }
  }

  private async prune(dirs: ManagedDirs, activeId: string): Promise<void> {
    const keep = new Set<string>([activeId, ...this.resolvedReleaseIds]);
    const previous = await readPointer(dirs.previousFile);
    if (previous.status === "ok") keep.add(previous.releaseId);
    await pruneReleases(dirs, keep, { platform: this.platform }).catch(() => {});
  }

  private async writeProgress(dirs: ManagedDirs, bytes: number, total: number | null): Promise<void> {
    const now = this.now();
    if (now - this.lastProgressWrite < this.timeouts.progressWriteMs) return;
    this.lastProgressWrite = now;
    await writeFileAtomic(dirs.progressFile, JSON.stringify({ bytes, total })).catch(() => {});
  }

  private async readHolderProgress(dirs: ManagedDirs): Promise<void> {
    let bytes: number | null = null;
    let total: number | null = null;
    try {
      const obj = parseJsonObject(await readFile(dirs.progressFile, "utf8"));
      const b = getField(obj, "bytes");
      const t = getField(obj, "total");
      if (typeof b === "number") bytes = b;
      if (typeof t === "number") total = t;
    } catch {
      // no progress yet
    }
    this.setPhase({ phase: "waiting_for_lock", bytes, total });
  }

  /** IA 6.8: at most every 6 h (30 min after a failure), only with `autoUpdate` and not `offline`. */
  private maybeScheduleUpdate(): void {
    if (!this.config.autoUpdate || this.config.offline || !this.managedActive()) return;
    if (this.updating || this.installing || !this.dirs || !this.target) return;
    const dirs = this.dirs;
    const target = this.target;
    this.updating = (async () => {
      const cache = await readManifestCache(dirs.manifestFile, target);
      if (cache) {
        const interval = cache.error !== undefined ? this.timeouts.updateRetryMs : this.timeouts.updateIntervalMs;
        if (this.now() - cache.checkedAt < interval) return;
      }
      const manifest = await refreshManifest(dirs.manifestFile, target, { fetch: this.fetchImpl, now: this.now });
      const active = await inspectActive(dirs, { executableName: target.executableName, platform: this.platform });
      if (active.status !== "valid") return;
      if (compareSemver(manifest.version, active.version) <= 0 || compareSemver(manifest.version, MIN_AGY_VERSION) < 0) return;
      this.installing ??= this.runInstall(manifest).finally(() => {
        this.installing = null;
      });
      await this.installing;
    })()
      .catch((err: unknown) => this.debug(`update check failed: ${errorMessage(err)}`))
      .finally(() => {
        this.updating = null;
        if (this.lastResolved) this.phase = { phase: "ready", source: this.lastResolved.source, version: this.lastResolved.version };
      });
  }
}

class WaitTimeoutError extends Error {}

function isBinaryManager(value: unknown): value is BinaryManager {
  return getField(value, "brand") === BRAND;
}

/** The process-global instance for this profile config (IA 3, 6.6). */
export function getBinaryManager(config: InstallAuthConfig, deps?: BinaryManagerDeps): BinaryManager {
  return processSingleton("binary", singletonKey(config), () => new BinaryManager(config, deps), isBinaryManager, deps?.log);
}

/** IA 11.3: never downloads. */
export function resolveExistingBinary(manager: BinaryManager): Promise<ResolvedBinaryWithSource | null> {
  return manager.resolveExisting();
}
