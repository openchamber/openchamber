// Spawn environment per kind and base args for every agy child (IA 9.1, 9.2).

import { AUTH_METHODS } from "../auth/methods.ts";
import type { RunDirKind } from "../contracts.ts";
import type { InstallAuthConfig } from "./config.ts";
import { APP_DATA_DIR } from "./paths.ts";
import { linuxCaBundle } from "./platform.ts";

export type AgySpawnKind = RunDirKind;

/**
 * Removed from the inherited env before agy starts, compared upper-cased (IA 9.2 step 1). The list
 * covers T3 Code's; `spawnEnv` of an auth method adds back what that method needs.
 */
export const STRIPPED_ENV_KEYS: readonly string[] = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
];

/** Makes a signed-out `authenticate` fail at once instead of opening a browser (IA 9.1). */
export const SSH_CONNECTION_VALUE = "127.0.0.1 0 127.0.0.1 0";

const LOGIN_STRIPPED = ["DISPLAY", "WAYLAND_DISPLAY"];
const QUICK_CHECK_KINDS: ReadonlySet<AgySpawnKind> = new Set(["verify", "probe", "logout"]);
const QUICK_CHECK_FLAGS = ["--include-default-customizations=false", "--disable-telemetry"];

export type AgyEnvConfig = Pick<InstallAuthConfig, "geminiDir" | "isolatedAuth" | "authMethod" | "auth">;

export interface BuildAgyEnvInput {
  kind: AgySpawnKind;
  tmpDir: string;
  config: AgyEnvConfig;
  /** Default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Default `existsSync`; used for the Linux CA bundle. */
  exists?: (p: string) => boolean;
}

export function buildAgyEnv(input: BuildAgyEnvInput): Record<string, string> {
  const source = input.baseEnv ?? process.env;
  const platform = input.platform ?? process.platform;
  const stripped = new Set(STRIPPED_ENV_KEYS);
  if (input.kind === "login") for (const key of LOGIN_STRIPPED) stripped.add(key);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || stripped.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  // Windows keys are case-insensitive: drop any spelling of the ones set below before setting them.
  if (platform === "win32") {
    for (const key of Object.keys(env)) {
      if (["TEMP", "TMP", "TMPDIR"].includes(key.toUpperCase())) delete env[key];
    }
  }

  env.GEMINI_HOME = input.config.geminiDir;
  if (platform === "win32") {
    env.TEMP = input.tmpDir;
    env.TMP = input.tmpDir;
  } else {
    env.TMPDIR = input.tmpDir;
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  env.PYTHONUNBUFFERED = "1";
  env.SSH_CONNECTION = SSH_CONNECTION_VALUE;
  if (input.config.isolatedAuth) env.AGY_ACP_FORCE_FILE_STORAGE = "1";

  if (platform === "linux") {
    const bundle = linuxCaBundle(source, input.exists);
    if (bundle) env.SSL_CERT_FILE = bundle;
  }

  Object.assign(env, AUTH_METHODS[input.config.authMethod].spawnEnv(input.config));
  return env;
}

/** `acp --gemini-dir <g> --app-data-dir antigravity-acp` (IA 9.2). */
export function agyBaseArgs(geminiDir: string): string[] {
  return ["acp", "--gemini-dir", geminiDir, "--app-data-dir", APP_DATA_DIR];
}

/**
 * Base args plus the flags of one spawn kind. `verify`, `probe` and `logout` load no default
 * customizations and send no telemetry; `login` adds only `--login`; `runtime` adds nothing here,
 * the runtime appends its own flags (SR 3.2 step 5).
 */
export function agyArgsFor(kind: AgySpawnKind, geminiDir: string): string[] {
  const args = agyBaseArgs(geminiDir);
  if (QUICK_CHECK_KINDS.has(kind)) args.push(...QUICK_CHECK_FLAGS);
  if (kind === "login") args.push("--login");
  return args;
}
