// The one writer of antigravity-acp/settings.json, plus profile dirs and the plugin marker (IA 9.3).

import { lstatSync } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { InstallAuthConfig } from "../install/config.ts";
import { errnoCode, parseJsonObject, readSmallRegularFile, writeFileAtomic } from "../install/fs-utils.ts";
import { acquireDirLock } from "../install/lock.ts";
import { profilePaths } from "../install/paths.ts";
import type { AuthMethodSpec, ProfileSettingsPatch } from "./methods.ts";

const SETTINGS_MAX_BYTES = 256 * 1024;
const SETTINGS_LOCK_NAME = ".settings.lock";
const SETTINGS_LOCK_WAIT_MS = 5_000;

/** Serializes writes per settings file in this process. */
const queues = new Map<string, Promise<void>>();

/**
 * Reads `settings.json`, merges `patch` over its top-level keys (a key set to `undefined` is removed),
 * and writes it back by temp file and rename, mode 0600. Calls for one file run one at a time in this
 * process and under a lock dir across processes.
 * An unreadable or corrupt file is replaced by the patch alone.
 */
export function updateProfileSettings(geminiDir: string, patch: Record<string, unknown>): Promise<void> {
  const file = profilePaths(geminiDir).settingsFile;
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(() => writeMerged(file, patch));
  const tail = next.catch(() => {});
  queues.set(file, tail);
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return next;
}

/**
 * Two OpenCode processes on one profile write different keys (`auth` before each spawn, `toolPermission`
 * at pool start), so the read-merge-write runs under a cross-process lock. When the lock cannot be had
 * within `SETTINGS_LOCK_WAIT_MS` the write goes ahead unlocked: a lost key is better than a failed spawn.
 */
async function writeMerged(file: string, patch: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = await acquireDirLock(path.join(path.dirname(file), SETTINGS_LOCK_NAME), {
    waitMs: SETTINGS_LOCK_WAIT_MS,
    pollMs: 10,
    staleMs: 10_000,
  }).catch(() => null);
  try {
    await mergeInto(file, patch);
  } finally {
    lock?.releaseSync();
  }
}

async function mergeInto(file: string, patch: Record<string, unknown>): Promise<void> {
  const current = await readSmallRegularFile(file, SETTINGS_MAX_BYTES);
  const merged: Record<string, unknown> = current.ok ? (parseJsonObject(current.text) ?? {}) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  await writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

/** `{ auth, gcp }` written before every login, logout, probe and runtime spawn (IA 9.3). */
export function authSettingsPatch(spec: AuthMethodSpec, config: Pick<InstallAuthConfig, "auth">): ProfileSettingsPatch {
  return spec.profileSettings(config);
}

export interface EnsureProfileResult {
  /** True when the gemini dir carries the plugin marker after this call. */
  pluginOwned: boolean;
}

/**
 * Creates `<data>`, `<gemini>` and `<gemini>/antigravity-acp` with mode 0700 and, on POSIX, `chmod`s
 * them to 0700 every time (they hold tokens and conversation databases). Writes the marker when
 * this call created the gemini dir, or when it is the plugin's own `<data>/gemini`.
 */
export async function ensureProfileDirs(
  dataDir: string,
  geminiDir: string,
  opts: { defaultGeminiDir?: boolean; platform?: NodeJS.Platform } = {},
): Promise<EnsureProfileResult> {
  const platform = opts.platform ?? process.platform;
  const paths = profilePaths(geminiDir);
  const geminiExisted = await exists(geminiDir);
  for (const dir of [dataDir, geminiDir, paths.appDataDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (platform !== "win32") await chmod(dir, 0o700);
  }
  if (!geminiExisted || opts.defaultGeminiDir) await writeMarker(paths.markerFile);
  return { pluginOwned: isPluginOwnedProfile(geminiDir) };
}

async function writeMarker(file: string): Promise<void> {
  try {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile("opencode-antigravity\n", "utf8");
    await handle.close();
  } catch (err) {
    if (errnoCode(err) !== "EEXIST") throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** True when the marker exists as a regular file, never through a symlink. */
export function isPluginOwnedProfile(geminiDir: string): boolean {
  try {
    return lstatSync(profilePaths(geminiDir).markerFile).isFile();
  } catch {
    return false;
  }
}
