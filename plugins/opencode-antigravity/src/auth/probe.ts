// Signed-in probe and the account email (IA 12.3, 13.2).

import { ControlTimeoutError, spawnControl, withTimeout } from "../install/acp-control.ts";
import { agyArgsFor, buildAgyEnv, type AgyEnvConfig } from "../install/env.ts";
import { getField, parseJsonObject, readSmallRegularFile } from "../install/fs-utils.ts";
import { profilePaths } from "../install/paths.ts";
import { isSignInRequired } from "./errors.ts";

export type ProbeResult = "signed_in" | "signed_out" | "unknown";

export interface ProbeDeps {
  /** Null when no binary is installed: the answer is `unknown`. */
  binary: string | null;
  config: AgyEnvConfig;
  tmpDir: string;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGraceMs?: number;
}

/**
 * Spawns kind `probe`, sends `initialize` and `authenticate { methodId }`, kills the child. A result
 * is `signed_in`; a sign-in error (IA 15.1, including the auth-URL line) is `signed_out`; a timeout,
 * a crash, a missing binary or any other error is `unknown`.
 */
export async function probeAuth(deps: ProbeDeps): Promise<ProbeResult> {
  if (deps.binary === null) return "unknown";
  const env = buildAgyEnv({ kind: "probe", tmpDir: deps.tmpDir, config: deps.config, baseEnv: deps.baseEnv });
  const child = spawnControl({ binary: deps.binary, args: agyArgsFor("probe", deps.config.geminiDir), env, cwd: deps.tmpDir });
  try {
    await withTimeout(
      (async () => {
        await child.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "opencode-antigravity", version: "1" } }, deps.timeoutMs);
        await child.request("authenticate", { methodId: deps.config.authMethod }, deps.timeoutMs);
      })(),
      deps.timeoutMs,
      () => new ControlTimeoutError("authenticate"),
    );
    return "signed_in";
  } catch (err) {
    return isSignInRequired(err) ? "signed_out" : "unknown";
  } finally {
    await child.kill(deps.killGraceMs ?? 3_000);
  }
}

const TOKEN_FILE_MAX_BYTES = 64 * 1024;
const MAX_EMAIL_CHARS = 320;

/**
 * Isolated mode only: `id_token_email` from agy's `antigravity-oauth-token`, a regular file of at most
 * 64 KiB. Everything else in the file is dropped at once. Never logged.
 */
export async function readAccountEmail(geminiDir: string): Promise<string | undefined> {
  const read = await readSmallRegularFile(profilePaths(geminiDir).oauthTokenFile, TOKEN_FILE_MAX_BYTES);
  if (!read.ok) return undefined;
  const email = getField(parseJsonObject(read.text), "id_token_email");
  return typeof email === "string" && email.length > 0 && email.length < MAX_EMAIL_CHARS ? email : undefined;
}
