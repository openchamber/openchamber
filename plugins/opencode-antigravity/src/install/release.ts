// Managed releases under `<data>/bin/<dirKey>/` (IA 4, 6.7, 6.9): inspect, install, activate, prune.

import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadAsset, InstallError, type DownloadDeps } from "./download.ts";
import { copyExecutable, extractSingleExecutable, type ExtractLimits } from "./extract.ts";
import {
  defaultRename,
  errnoCode,
  getField,
  isInside,
  parseJsonObject,
  randomToken,
  readSmallRegularFile,
  removeTree,
  writeFileAtomic,
  type RenameFn,
} from "./fs-utils.ts";
import type { AgyManifest } from "./manifest.ts";
import type { ManagedDirs } from "./paths.ts";
import type { AgyTarget } from "./platform.ts";

export const RELEASE_ID_RE = /^[0-9a-f]{64}$/;
export const RECORD_NAME = ".install-complete.json";
const POINTER_MAX_BYTES = 8 * 1024;
const STAGING_PREFIX = ".install-";
export const STAGING_MAX_AGE_MS = 60 * 60_000;

export const ACTIVATION_FAILED_MESSAGE = "Could not activate Antigravity. The previous runtime is unchanged.";

export function symlinkMessage(dir: string): string {
  return `The managed Antigravity directory contains a symbolic link. Delete ${dir} and restart OpenCode to reinstall.`;
}

export class SymlinkError extends InstallError {
  constructor(dir: string, at: string) {
    super(symlinkMessage(dir), `symlink at ${path.basename(at)}`);
    this.name = "SymlinkError";
  }
}

export interface ReleaseRecord {
  releaseId: string;
  version: string;
  sha512?: string;
  url?: string;
  executable: { name: string; bytes: number };
  installedAt?: string;
}

export type ReleaseInspection =
  | { status: "valid"; releaseId: string; dir: string; executable: string; version: string }
  | { status: "missing" }
  | { status: "damaged"; reason: string }
  | { status: "symlink"; at: string };

export interface InspectOptions {
  executableName: string;
  platform?: NodeJS.Platform;
}

/** Reads a T3-compatible install record (IA 4); null when its shape is wrong. */
export function parseRecord(text: string): ReleaseRecord | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const exe = obj.executable;
  const name = getField(exe, "name");
  const bytes = getField(exe, "bytes");
  if (typeof obj.releaseId !== "string" || typeof obj.version !== "string") return null;
  if (typeof name !== "string" || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return {
    releaseId: obj.releaseId,
    version: obj.version,
    ...(typeof obj.sha512 === "string" ? { sha512: obj.sha512 } : {}),
    ...(typeof obj.url === "string" ? { url: obj.url } : {}),
    executable: { name, bytes },
    ...(typeof obj.installedAt === "string" ? { installedAt: obj.installedAt } : {}),
  };
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/**
 * Checks one release dir under `versionsDir` (IA 5 steps 3 and 4.1, 6.7): no symlink on the way,
 * a record of at most 8 KiB that names this release, an executable with exactly the recorded size
 * and the exec bit (POSIX), whose realpath stays inside `versionsDir`.
 */
export async function inspectReleaseDir(versionsDir: string, releaseId: string, opts: InspectOptions): Promise<ReleaseInspection> {
  const platform = opts.platform ?? process.platform;
  if (!RELEASE_ID_RE.test(releaseId)) return { status: "damaged", reason: "release id" };
  const platformDir = path.dirname(versionsDir);
  for (const p of [platformDir, versionsDir]) {
    const s = await lstatOrNull(p);
    if (s?.isSymbolicLink()) return { status: "symlink", at: p };
    if (!s) return { status: "missing" };
  }
  const dir = path.join(versionsDir, releaseId);
  const dirStat = await lstatOrNull(dir);
  if (!dirStat) return { status: "missing" };
  if (dirStat.isSymbolicLink()) return { status: "symlink", at: dir };
  if (!dirStat.isDirectory()) return { status: "damaged", reason: "release is not a dir" };

  const recordFile = path.join(dir, RECORD_NAME);
  const read = await readSmallRegularFile(recordFile, POINTER_MAX_BYTES);
  if (!read.ok) return read.reason === "symlink" ? { status: "symlink", at: recordFile } : { status: "damaged", reason: `record ${read.reason}` };
  const record = parseRecord(read.text);
  if (!record || record.releaseId !== releaseId) return { status: "damaged", reason: "record content" };
  if (record.executable.name !== opts.executableName) return { status: "damaged", reason: "executable name" };

  const executable = path.join(dir, record.executable.name);
  const exeStat = await lstatOrNull(executable);
  if (!exeStat) return { status: "damaged", reason: "executable missing" };
  if (exeStat.isSymbolicLink()) return { status: "symlink", at: executable };
  if (!exeStat.isFile()) return { status: "damaged", reason: "executable is not a file" };
  if (exeStat.size !== record.executable.bytes) return { status: "damaged", reason: "executable size changed" };
  if (platform !== "win32" && (exeStat.mode & 0o111) === 0) return { status: "damaged", reason: "executable bit" };
  try {
    if (!isInside(await realpath(versionsDir), await realpath(executable))) return { status: "symlink", at: executable };
  } catch {
    return { status: "damaged", reason: "realpath" };
  }
  return { status: "valid", releaseId, dir, executable, version: record.version };
}

export type PointerRead = { status: "ok"; releaseId: string } | { status: "missing" } | { status: "invalid" } | { status: "symlink" };

/** `active.json` and `previous.json`: `{ releaseId }` in a regular non-symlink file of at most 8 KiB. */
export async function readPointer(file: string): Promise<PointerRead> {
  const read = await readSmallRegularFile(file, POINTER_MAX_BYTES);
  if (!read.ok) {
    if (read.reason === "missing") return { status: "missing" };
    return read.reason === "symlink" ? { status: "symlink" } : { status: "invalid" };
  }
  const id = parseJsonObject(read.text)?.releaseId;
  return typeof id === "string" && RELEASE_ID_RE.test(id) ? { status: "ok", releaseId: id } : { status: "invalid" };
}

/** The active managed release. `missing` covers "no active.json" and "points at nothing". */
export async function inspectActive(dirs: ManagedDirs, opts: InspectOptions): Promise<ReleaseInspection> {
  const pointer = await readPointer(dirs.activeFile);
  if (pointer.status === "symlink") return { status: "symlink", at: dirs.activeFile };
  if (pointer.status === "missing") return { status: "missing" };
  if (pointer.status === "invalid") return { status: "damaged", reason: "active.json" };
  return inspectReleaseDir(dirs.versionsDir, pointer.releaseId, opts);
}

export interface InstallReleaseDeps {
  target: AgyTarget;
  /** Identity check with the manifest version (IA 6.5); throws to refuse. */
  verify: (executable: string, version: string) => Promise<void>;
  download?: DownloadDeps;
  extractLimits?: ExtractLimits;
  onPhase?: (phase: "downloading" | "verifying") => void;
  /** Test seam for the commit point (IA 17.1, activation failure). */
  rename?: RenameFn;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface InstalledRelease {
  releaseId: string;
  dir: string;
  executable: string;
  version: string;
  /** The release `active.json` named before this install; null when none. */
  previousActive: string | null;
}

async function ensurePlatformDirs(dirs: ManagedDirs): Promise<void> {
  for (const p of [dirs.platformDir, dirs.versionsDir]) {
    await mkdir(p, { recursive: true, mode: 0o700 });
    const s = await lstat(p);
    if (s.isSymbolicLink()) throw new SymlinkError(dirs.platformDir, p);
  }
}

/**
 * Installs and activates the release a manifest names (IA 6.7 steps 1 to 5). The caller holds the
 * platform lock, emits `onBinaryChanged`, and prunes.
 */
export async function installRelease(manifest: AgyManifest, dirs: ManagedDirs, deps: InstallReleaseDeps): Promise<InstalledRelease> {
  const platform = deps.platform ?? process.platform;
  const rename = deps.rename ?? defaultRename;
  const exeName = deps.target.executableName;
  await ensurePlatformDirs(dirs);
  const releaseId = manifest.sha512.slice(0, 64);
  const finalDir = path.join(dirs.versionsDir, releaseId);

  // Step 1: an existing valid release with the same version still gets the identity check.
  const existing = await inspectReleaseDir(dirs.versionsDir, releaseId, { executableName: exeName, platform });
  if (existing.status === "symlink") throw new SymlinkError(dirs.platformDir, existing.at);
  if (existing.status === "valid" && existing.version === manifest.version) {
    deps.onPhase?.("verifying");
    await deps.verify(existing.executable, manifest.version);
    const previousActive = await activateRelease(dirs, releaseId, { rename });
    return { releaseId, dir: finalDir, executable: existing.executable, version: manifest.version, previousActive };
  }

  const staging = path.join(dirs.versionsDir, `${STAGING_PREFIX}${randomToken()}`);
  let displaced: string | null = null;
  try {
    // Step 2: download, extract, identity check.
    deps.onPhase?.("downloading");
    const { file } = await downloadAsset(manifest, staging, deps.download);
    const runtimeDir = path.join(staging, "runtime");
    await mkdir(runtimeDir, { mode: 0o700 });
    const executable = path.join(runtimeDir, exeName);
    const { bytes } =
      deps.target.format === "tar.gz"
        ? await extractSingleExecutable(file, executable, exeName, deps.extractLimits)
        : await copyExecutable(file, executable);
    await rm(file, { force: true });
    if (platform !== "win32") await chmod(executable, 0o755);
    deps.onPhase?.("verifying");
    await deps.verify(executable, manifest.version);

    // Step 3: record, read-only modes, publish.
    const record: ReleaseRecord = {
      releaseId,
      version: manifest.version,
      sha512: manifest.sha512,
      url: manifest.url,
      executable: { name: exeName, bytes },
      installedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    };
    const recordFile = path.join(runtimeDir, RECORD_NAME);
    await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (platform !== "win32") {
      await chmod(executable, 0o555);
      await chmod(recordFile, 0o400);
    }
    if (existing.status !== "missing") {
      displaced = path.join(staging, "displaced");
      // Moving a dir to another parent rewrites its `..` entry, which needs write permission on it.
      if (platform !== "win32") await chmod(finalDir, 0o700).catch(() => {});
      await rename(finalDir, displaced);
    }
    try {
      await rename(runtimeDir, finalDir);
    } catch (err) {
      if (displaced) await rename(displaced, finalDir).catch(() => {});
      displaced = null;
      throw err;
    }
    if (platform !== "win32") await chmod(finalDir, 0o500);

    // Steps 4 and 5: the commit point, with rollback.
    let previousActive: string | null;
    try {
      previousActive = await activateRelease(dirs, releaseId, { rename });
    } catch {
      await removeTree(finalDir, platform).catch(() => {});
      if (displaced) await rename(displaced, finalDir).catch(() => {});
      displaced = null;
      throw new InstallError(ACTIVATION_FAILED_MESSAGE, "activation rename");
    }
    return { releaseId, dir: finalDir, executable: path.join(finalDir, exeName), version: manifest.version, previousActive };
  } finally {
    // Removes the staging dir, and with it a displaced damaged release once the new one is active.
    await removeTree(staging, platform).catch(() => {});
  }
}

/**
 * Points `active.json` at `releaseId` by temp file, fsync and rename: the only commit point. Then
 * records the release active before it in `previous.json`, when it differs. Returns that release id.
 */
export async function activateRelease(dirs: ManagedDirs, releaseId: string, opts: { rename?: RenameFn } = {}): Promise<string | null> {
  const before = await readPointer(dirs.activeFile);
  const previous = before.status === "ok" ? before.releaseId : null;
  await writeFileAtomic(dirs.activeFile, `${JSON.stringify({ releaseId })}\n`, { mode: 0o600, rename: opts.rename });
  if (previous !== null && previous !== releaseId) {
    await writeFileAtomic(dirs.previousFile, `${JSON.stringify({ releaseId: previous })}\n`, { mode: 0o600 }).catch(() => {});
  }
  return previous;
}

export interface PruneDeps {
  platform?: NodeJS.Platform;
  /** Test seam; default `removeTree`. */
  removeDir?: (dir: string) => Promise<void>;
}

/**
 * Removes every `versions/<64 hex>` not in `keep` (IA 6.9). Failures are ignored and retried on the
 * next prune. Returns the removed release ids.
 */
export async function pruneReleases(dirs: ManagedDirs, keep: ReadonlySet<string>, deps: PruneDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  const remove = deps.removeDir ?? ((dir: string) => removeTree(dir, platform));
  let names: string[];
  try {
    names = await readdir(dirs.versionsDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!RELEASE_ID_RE.test(name) || keep.has(name)) continue;
    const dir = path.join(dirs.versionsDir, name);
    const s = await lstatOrNull(dir);
    if (!s || s.isSymbolicLink()) continue;
    try {
      await remove(dir);
      removed.push(name);
    } catch {
      // retried on the next prune
    }
  }
  return removed;
}

/** Removes staging dirs `.install-*` older than `maxAgeMs` (IA 6.9). */
export async function removeStaleStaging(dirs: ManagedDirs, opts: { maxAgeMs?: number; now?: () => number; platform?: NodeJS.Platform } = {}): Promise<void> {
  const maxAge = opts.maxAgeMs ?? STAGING_MAX_AGE_MS;
  const now = (opts.now ?? Date.now)();
  let names: string[];
  try {
    names = await readdir(dirs.versionsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const dir = path.join(dirs.versionsDir, name);
    try {
      const s = await lstat(dir);
      if (now - s.mtimeMs > maxAge) await removeTree(dir, opts.platform);
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") continue;
    }
  }
}
