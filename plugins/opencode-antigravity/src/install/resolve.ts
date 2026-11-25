// External binary lookups (IA 5 steps 1 to 3): explicit path, PATH search, T3 Code's cache (read-only).

import { accessSync, constants as fsConstants, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { homeDir } from "./paths.ts";
import type { AgyTarget } from "./platform.ts";
import { inspectActive, type ReleaseInspection } from "./release.ts";

export function explicitPathMessage(file: string): string {
  return `The Antigravity executable at ${file} is missing or not executable. Fix binaryPath or remove it to use the managed download.`;
}

export const PATH_NOT_FOUND_MESSAGE = 'binarySource is "path" but no agy executable is on PATH.';
export const T3_NOT_FOUND_MESSAGE = 'binarySource is "t3code" but T3 Code has no Antigravity runtime installed.';

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Step 1: an explicit `binaryPath` must be absolute, exist, be a regular file and be executable on
 * POSIX. A relative path is refused, never resolved against the cwd (IA 3).
 */
export function checkExplicitBinary(file: string, platform: NodeJS.Platform = process.platform): { ok: true; path: string } | { ok: false; message: string } {
  if (!path.isAbsolute(file) || !isExecutableFile(file, platform)) return { ok: false, message: explicitPathMessage(file) };
  return { ok: true, path: file };
}

/** The `PATH` value, honoring a case-insensitive `Path` key on Windows. */
export function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === "PATH" && value) return value;
  return "";
}

/**
 * Step 2 candidates in order: every `agy` on PATH (`agy.exe` on Windows), then the usual install
 * locations. Only `agy`: an `antigravity` on PATH can be the IDE launcher. Each candidate is a regular
 * executable file; the identity check is the caller's.
 */
export function pathCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const name = platform === "win32" ? "agy.exe" : "agy";
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = pathValue(env, platform).split(delimiter).filter(Boolean);
  const home = homeDir(env);
  const extra =
    platform === "win32"
      ? [path.join(home, ".local", "bin", name), path.join(home, ".antigravity", "bin", name)]
      : [path.join(home, ".local", "bin", "agy"), path.join(home, ".antigravity", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [...dirs.map((d) => path.join(d, name)), ...extra]) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isExecutableFile(resolved, platform)) out.push(resolved);
  }
  return out;
}

export interface FoundBinary {
  path: string;
  version: string;
}

/**
 * Step 2: the first PATH candidate that passes `check` (the identity check). A failing candidate is
 * reported through `onSkip` and the search continues.
 */
export async function findOnPath(
  env: NodeJS.ProcessEnv,
  check: (file: string) => Promise<string>,
  opts: { platform?: NodeJS.Platform; onSkip?: (file: string, reason: string) => void } = {},
): Promise<FoundBinary | null> {
  for (const candidate of pathCandidates(env, opts.platform)) {
    try {
      return { path: candidate, version: await check(candidate) };
    } catch (err) {
      opts.onSkip?.(candidate, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

/** `${T3CODE_HOME:-~/.t3}/tools/antigravity-acp/<dirKey>`. */
export function t3PlatformDir(env: NodeJS.ProcessEnv, target: AgyTarget): string {
  const root = env.T3CODE_HOME || path.join(homeDir(env), ".t3");
  return path.join(root, "tools", "antigravity-acp", target.dirKey);
}

/**
 * Step 3: T3 Code's active release, read-only. Same checks as a managed release, plus no symlink
 * from `tools/` down. Returns null when nothing valid is there.
 */
export async function findT3Binary(
  env: NodeJS.ProcessEnv,
  target: AgyTarget,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string; version: string } | null> {
  const platformDir = t3PlatformDir(env, target);
  const toolsDir = path.dirname(path.dirname(platformDir));
  for (const p of [toolsDir, path.dirname(platformDir)]) {
    try {
      if (lstatSync(p).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  const inspection: ReleaseInspection = await inspectActive(
    {
      platformDir,
      versionsDir: path.join(platformDir, "versions"),
      activeFile: path.join(platformDir, "active.json"),
      lockDir: path.join(platformDir, ".lock"),
      previousFile: path.join(platformDir, "previous.json"),
      manifestFile: path.join(platformDir, "manifest.json"),
      progressFile: path.join(platformDir, "progress.json"),
    },
    { executableName: target.executableName, platform },
  );
  return inspection.status === "valid" ? { path: inspection.executable, version: inspection.version } : null;
}
