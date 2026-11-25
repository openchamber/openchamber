// Profile sign-out (IA 11.3): ACP `logout`, with token-file deletion as the fallback in a plugin-owned
// isolated profile.

import { lstat, unlink } from "node:fs/promises";
import { ControlTimeoutError, spawnControl, withTimeout, type ControlProcess } from "../install/acp-control.ts";
import { agyArgsFor, buildAgyEnv, type AgyEnvConfig } from "../install/env.ts";
import { errorMessage, getField } from "../install/fs-utils.ts";
import { profilePaths } from "../install/paths.ts";

export interface LogoutDeps {
  /** Null when no binary is installed: only the file fallback runs. */
  binary: string | null;
  config: AgyEnvConfig;
  tmpDir: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Whole ACP part. */
  timeoutMs: number;
  pluginOwned: boolean;
  killGraceMs?: number;
}

export type LogoutOutcome =
  | { method: "skipped-shared" }
  | { method: "acp" }
  | { method: "files"; removed: number; reason: string };

/**
 * Shared mode does nothing here (the OS keyring login stays, `docs/decisions.md`). Isolated mode:
 * `initialize`, then `logout {}` when `agentCapabilities.auth.logout` is present. No binary, no
 * capability, an error or the timeout: delete the token files when the profile is plugin-owned.
 */
export async function logoutProfile(deps: LogoutDeps): Promise<LogoutOutcome> {
  if (!deps.config.isolatedAuth) return { method: "skipped-shared" };
  let reason = "no binary";
  if (deps.binary !== null) {
    const env = buildAgyEnv({ kind: "logout", tmpDir: deps.tmpDir, config: deps.config, baseEnv: deps.baseEnv });
    const child = spawnControl({ binary: deps.binary, args: agyArgsFor("logout", deps.config.geminiDir), env, cwd: deps.tmpDir });
    try {
      const done = await withTimeout(acpLogout(child, deps.timeoutMs), deps.timeoutMs, () => new ControlTimeoutError("logout"));
      if (done) return { method: "acp" };
      reason = "agy has no logout capability";
    } catch (err) {
      reason = errorMessage(err);
    } finally {
      await child.kill(deps.killGraceMs ?? 3_000);
    }
  }
  const removed = deps.pluginOwned ? await deleteTokenFiles(deps.config.geminiDir) : 0;
  return { method: "files", removed, reason };
}

async function acpLogout(child: ControlProcess, timeoutMs: number): Promise<boolean> {
  const init = await child.request(
    "initialize",
    { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "opencode-antigravity", version: "1" } },
    timeoutMs,
  );
  const capability = getField(getField(getField(init, "agentCapabilities"), "auth"), "logout");
  if (capability === undefined || capability === null) return false;
  await child.request("logout", {}, timeoutMs);
  return true;
}

/** Unlinks each token file that is a regular file; never follows a symlink. Returns the count removed. */
export async function deleteTokenFiles(geminiDir: string): Promise<number> {
  let removed = 0;
  for (const file of profilePaths(geminiDir).tokenFiles) {
    try {
      if (!(await lstat(file)).isFile()) continue;
      await unlink(file);
      removed++;
    } catch {
      // missing or not removable
    }
  }
  return removed;
}
