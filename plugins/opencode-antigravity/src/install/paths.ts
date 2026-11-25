// Where the plugin keeps binaries, the agy profile, the auth epoch and its locks (IA 3, 4).

import { homedir } from "node:os";
import path from "node:path";

/** Marker file: this gemini dir was created by the plugin (IA 4, 9.3). */
export const PROFILE_MARKER = ".opencode-antigravity-profile";
/** `--app-data-dir` for every spawn (IA 9.1). */
export const APP_DATA_DIR = "antigravity-acp";

export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Expands a leading `~/` or `~\` against the user's home; anything else is returned as given (IA 3). */
export function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~") return homeDir(env);
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir(env), value.slice(2));
  return value;
}

/** `OPENCODE_ANTIGRAVITY_DATA_DIR`, else `$XDG_DATA_HOME/opencode-antigravity`, else `~/.local/share/opencode-antigravity`, on every OS. */
export function resolveDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  if (explicit) return path.resolve(expandHome(explicit, env));
  const xdg = env.XDG_DATA_HOME;
  if (xdg) return path.join(path.resolve(expandHome(xdg, env)), "opencode-antigravity");
  return path.join(homeDir(env), ".local", "share", "opencode-antigravity");
}

export function defaultGeminiDir(dataDir: string): string {
  return path.join(dataDir, "gemini");
}

/** `geminiDir` option, else `OPENCODE_ANTIGRAVITY_GEMINI_DIR`, else `<data>/gemini`. */
export function resolveGeminiDir(options: { geminiDir?: string | null }, env: NodeJS.ProcessEnv, dataDir: string): string {
  const explicit = options.geminiDir || env.OPENCODE_ANTIGRAVITY_GEMINI_DIR;
  if (explicit) return path.resolve(expandHome(explicit, env));
  return defaultGeminiDir(dataDir);
}

export interface ManagedDirs {
  /** `<data>/bin/<dirKey>` */
  platformDir: string;
  lockDir: string;
  activeFile: string;
  previousFile: string;
  manifestFile: string;
  progressFile: string;
  versionsDir: string;
}

export function managedDirs(dataDir: string, target: { dirKey: string }): ManagedDirs {
  const platformDir = path.join(dataDir, "bin", target.dirKey);
  return {
    platformDir,
    lockDir: path.join(platformDir, ".lock"),
    activeFile: path.join(platformDir, "active.json"),
    previousFile: path.join(platformDir, "previous.json"),
    manifestFile: path.join(platformDir, "manifest.json"),
    progressFile: path.join(platformDir, "progress.json"),
    versionsDir: path.join(platformDir, "versions"),
  };
}

export interface ProfilePaths {
  geminiDir: string;
  appDataDir: string;
  settingsFile: string;
  markerFile: string;
  /** agy-written token files in isolated mode (IA 4, 11.3). */
  tokenFiles: readonly string[];
  oauthTokenFile: string;
}

export function profilePaths(geminiDir: string): ProfilePaths {
  const appDataDir = path.join(geminiDir, APP_DATA_DIR);
  const oauthTokenFile = path.join(appDataDir, "antigravity-oauth-token");
  return {
    geminiDir,
    appDataDir,
    settingsFile: path.join(appDataDir, "settings.json"),
    markerFile: path.join(geminiDir, PROFILE_MARKER),
    tokenFiles: [path.join(appDataDir, "acp_token.json"), oauthTokenFile],
    oauthTokenFile,
  };
}

/**
 * Login and logout lock of one profile. Keyed by `profileId` (session-store.ts `profileIdFor(geminiDir)`)
 * like the session store, so two profiles in one data dir never block each other.
 */
export function authLockDir(dataDir: string, profileId: string): string {
  return path.join(dataDir, "locks", `auth-${profileId}.lock`);
}

/** Auth epoch counter of one profile (IA 13.4), keyed like `authLockDir`. */
export function authEpochFile(dataDir: string, profileId: string): string {
  return path.join(dataDir, "auth", profileId, "auth-epoch");
}
