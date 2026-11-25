// Install and auth options, env overrides and validation (IA 3).
// A set option wins over its env var, which wins over the default. Never throws: problems are issues.

import path from "node:path";
import { expandHome, resolveDataDir, resolveGeminiDir } from "./paths.ts";

export type AuthMethodId = "oauth-personal" | "oauth-business" | "gemini-api-key" | "agent-platform";
export type BinarySource = "managed" | "path" | "t3code";

export const AUTH_METHOD_IDS: readonly AuthMethodId[] = ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"];
export const BINARY_SOURCES: readonly BinarySource[] = ["managed", "path", "t3code"];
export const DEFAULT_AUTH_METHOD: AuthMethodId = "oauth-personal";

export interface InstallAuthOptions {
  /** Explicit executable; wins over everything. */
  binaryPath?: string;
  /** Default "managed". */
  binarySource?: BinarySource;
  /** Default true. */
  autoUpdate?: boolean;
  /** Default false; true never touches the network. */
  offline?: boolean;
  /** Default true; PATH, then the T3 cache, when managed is missing and install fails. */
  offlineFallback?: boolean;
  /** Default true. */
  isolatedAuth?: boolean;
  /** GEMINI_HOME override; default <data>/gemini. */
  geminiDir?: string;
  /** Default "oauth-personal". */
  authMethod?: AuthMethodId;
  /** Reserved for later methods, ignored by oauth-personal. */
  auth?: { gcpProject?: string; gcpLocation?: string };
}

export interface InstallAuthConfig {
  /** Expanded for `~/`; a relative path is kept as given and fails at resolve time (IA 3, 5 step 1). */
  binaryPath: string | null;
  binarySource: BinarySource;
  autoUpdate: boolean;
  offline: boolean;
  offlineFallback: boolean;
  isolatedAuth: boolean;
  dataDir: string;
  geminiDir: string;
  /** True when `geminiDir` is the plugin's default `<data>/gemini`. */
  defaultGeminiDir: boolean;
  authMethod: AuthMethodId;
  auth: { gcpProject?: string; gcpLocation?: string };
}

export interface ResolvedInstallAuthConfig {
  config: InstallAuthConfig;
  issues: string[];
}

export const LOG_PREFIX = "[opencode-antigravity]";

export function unsupportedMethodIssue(id: string): string {
  return `Antigravity sign-in method "${id}" is not available in this plugin version. Use "oauth-personal" or remove authMethod.`;
}

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no"]);

/** `1`, `true`, `yes` / `0`, `false`, `no`, any case. Anything else is `null` (an issue). Shared with the runtime's config.ts. */
export function parseEnvBoolean(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthMethodId(value: string): value is AuthMethodId {
  return (AUTH_METHOD_IDS as readonly string[]).includes(value);
}

function isBinarySource(value: string): value is BinarySource {
  return (BINARY_SOURCES as readonly string[]).includes(value);
}

export function resolveInstallAuthConfig(options: unknown, env: NodeJS.ProcessEnv): ResolvedInstallAuthConfig {
  const opts = isRecord(options) ? options : {};
  const issues: string[] = [];

  const bool = (key: string, envKey: string | null, fallback: boolean): boolean => {
    const value = opts[key];
    if (value !== undefined) {
      if (typeof value === "boolean") return value;
      issues.push(`Option ${key} must be true or false; using ${fallback}.`);
      return fallback;
    }
    const raw = envKey ? env[envKey] : undefined;
    if (raw === undefined || raw === "") return fallback;
    const parsed = parseEnvBoolean(raw);
    if (parsed === null) {
      issues.push(`${envKey} must be 1, true, yes, 0, false or no; using ${fallback}.`);
      return fallback;
    }
    return parsed;
  };

  const str = (key: string, envKey: string | null): string | null => {
    const value = opts[key];
    if (value !== undefined) {
      if (typeof value === "string" && value !== "") return value;
      issues.push(`Option ${key} must be a non-empty string; ignoring it.`);
    }
    const raw = envKey ? env[envKey] : undefined;
    return raw ? raw : null;
  };

  const rawBinaryPath = str("binaryPath", "OPENCODE_ANTIGRAVITY_BIN");
  const binaryPath = rawBinaryPath === null ? null : expandHome(rawBinaryPath, env);

  let binarySource: BinarySource = "managed";
  const rawSource = str("binarySource", "OPENCODE_ANTIGRAVITY_BINARY_SOURCE");
  if (rawSource !== null) {
    if (isBinarySource(rawSource)) binarySource = rawSource;
    else issues.push(`Unknown binarySource "${rawSource}"; using "managed".`);
  }

  let authMethod: AuthMethodId = DEFAULT_AUTH_METHOD;
  const rawMethod = str("authMethod", null);
  if (rawMethod !== null) {
    if (!isAuthMethodId(rawMethod)) {
      issues.push(`Unknown authMethod "${rawMethod}"; using "${DEFAULT_AUTH_METHOD}".`);
    } else {
      authMethod = rawMethod;
      if (rawMethod !== DEFAULT_AUTH_METHOD) issues.push(unsupportedMethodIssue(rawMethod));
    }
  }

  const auth: { gcpProject?: string; gcpLocation?: string } = {};
  if (opts.auth !== undefined) {
    if (!isRecord(opts.auth)) {
      issues.push("Option auth must be an object; ignoring it.");
    } else {
      for (const key of ["gcpProject", "gcpLocation"] as const) {
        const value = opts.auth[key];
        if (value === undefined) continue;
        if (typeof value === "string" && value !== "") auth[key] = value;
        else issues.push(`Option auth.${key} must be a non-empty string; ignoring it.`);
      }
    }
  }

  const dataDir = resolveDataDir(env);
  const rawGeminiDir = str("geminiDir", null);
  const geminiDir = resolveGeminiDir({ geminiDir: rawGeminiDir }, env, dataDir);

  const config: InstallAuthConfig = {
    binaryPath,
    binarySource,
    autoUpdate: bool("autoUpdate", "OPENCODE_ANTIGRAVITY_AUTO_UPDATE", true),
    offline: bool("offline", "OPENCODE_ANTIGRAVITY_OFFLINE", false),
    offlineFallback: bool("offlineFallback", null, true),
    isolatedAuth: bool("isolatedAuth", "OPENCODE_ANTIGRAVITY_ISOLATED_AUTH", true),
    dataDir,
    geminiDir,
    defaultGeminiDir: path.resolve(geminiDir) === path.resolve(dataDir, "gemini"),
    authMethod,
    auth,
  };
  return { config, issues };
}

/** Key of the process-global singletons (IA 3). */
export function singletonKey(config: InstallAuthConfig): string {
  return JSON.stringify([config.dataDir, config.geminiDir, config.isolatedAuth, config.binarySource, config.binaryPath]);
}

/** Logs each issue once to stderr with the plugin prefix (IA 3). */
export function logIssues(issues: readonly string[], write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): void {
  for (const issue of issues) write(`${LOG_PREFIX} ${issue}`);
}
