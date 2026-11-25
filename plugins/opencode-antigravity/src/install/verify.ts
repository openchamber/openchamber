// Identity check of an agy executable over ACP `initialize` (IA 5, 6.5).

import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlExitError, ControlTimeoutError, spawnControl, withTimeout } from "./acp-control.ts";
import { agyArgsFor, buildAgyEnv } from "./env.ts";
import { getField } from "./fs-utils.ts";

export const MIN_AGY_VERSION = "1.5.1";
export const AGENT_NAME = "Antigravity ACP Server";
const VERIFY_TIMEOUT_MS = 90_000;

/** Negative when a < b, 0 when equal, positive when a > b. Non-numeric parts count as 0. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type IdentityFailure = "ipv6" | "page-size" | "not-agy" | "version-mismatch" | "too-old" | "start-failed";

/** Where the binary came from decides the wording: a managed download or a user-chosen file. */
export type BinaryContext = { kind: "managed" } | { kind: "external"; path: string };

export class AgyIdentityError extends Error {
  readonly failure: IdentityFailure;

  constructor(failure: IdentityFailure, message: string) {
    super(message);
    this.name = "AgyIdentityError";
    this.failure = failure;
  }
}

export const IPV6_MESSAGE =
  "Antigravity needs IPv6 socket support. Enable IPv6 on this machine; on WSL remove ipv6.disable=1 from .wslconfig and run wsl --shutdown.";
export const PAGE_SIZE_MESSAGE =
  "Google's linux-arm64 Antigravity build needs a kernel with 4 KiB pages (Asahi Linux and Raspberry Pi 5 use larger ones). Set binaryPath to a compatible agy build.";
export const START_FAILED_MESSAGE = "The downloaded Antigravity runtime could not start on this machine.";

export function tooOldMessage(version: string, file: string): string {
  return `Antigravity ${version} at ${file} is too old; this plugin needs ${MIN_AGY_VERSION} or newer.`;
}

function failureMessage(failure: IdentityFailure, context: BinaryContext, version: string | null): string {
  if (failure === "ipv6") return IPV6_MESSAGE;
  if (failure === "page-size") return PAGE_SIZE_MESSAGE;
  if (context.kind === "external") {
    if (failure === "too-old" && version) return tooOldMessage(version, context.path);
    return `The file at ${context.path} did not answer as the Antigravity CLI. Fix binaryPath or remove it to use the managed download.`;
  }
  return START_FAILED_MESSAGE;
}

export interface VerifyDeps {
  context?: BinaryContext;
  timeoutMs?: number;
  /** Parent of the throwaway GEMINI_HOME; default `os.tmpdir()`. */
  tmpRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface VerifyResult {
  version: string;
}

const field = getField;

/**
 * Spawns `agy acp` in a throwaway profile, sends `initialize`, and requires Antigravity's name, the
 * expected version (when given) of at least `MIN_AGY_VERSION`, protocol 1 or 2, `auth.logout`, and an
 * `oauth-personal` method. Kills the child and removes the profile afterwards.
 */
export async function verifyAgy(executable: string, expectedVersion: string | null, deps: VerifyDeps = {}): Promise<VerifyResult> {
  const context = deps.context ?? { kind: "managed" };
  const timeoutMs = deps.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const fail = (failure: IdentityFailure, version: string | null = null): AgyIdentityError =>
    new AgyIdentityError(failure, failureMessage(failure, context, version));

  const tmp = await mkdtemp(path.join(deps.tmpRoot ?? tmpdir(), "opencode-antigravity-verify-"));
  const geminiDir = path.join(tmp, "gemini");
  const env = buildAgyEnv({
    kind: "verify",
    tmpDir: tmp,
    config: { geminiDir, isolatedAuth: true, authMethod: "oauth-personal", auth: {} },
    baseEnv: deps.baseEnv,
  });
  const child = spawnControl({ binary: executable, args: agyArgsFor("verify", geminiDir), env, cwd: tmp });
  try {
    let result: unknown;
    try {
      result = await withTimeout(
        child.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "opencode-antigravity", version: "1" } }, timeoutMs),
        timeoutMs,
        () => new ControlTimeoutError("initialize"),
      );
    } catch (err) {
      if (err instanceof ControlExitError || err instanceof ControlTimeoutError) {
        // Give stderr a moment to flush before classifying.
        await withTimeout(child.exited, 200, () => new Error("still running")).catch(() => {});
      }
      const tail = child.stderrTail();
      if (/AF_INET6|enforce_kernel_ipv6_support/.test(tail)) throw fail("ipv6");
      if (/page-size\.cc|Compile-time page size does not match/.test(tail)) throw fail("page-size");
      throw fail(context.kind === "external" ? "not-agy" : "start-failed");
    }

    const agentInfo = field(result, "agentInfo");
    const name = field(agentInfo, "name");
    const version = field(agentInfo, "version");
    const protocolVersion = field(result, "protocolVersion");
    const logout = field(field(field(result, "agentCapabilities"), "auth"), "logout");
    const methods = field(result, "authMethods");
    const hasPersonal = Array.isArray(methods) && methods.some((m) => field(m, "id") === "oauth-personal");

    if (name !== AGENT_NAME || typeof version !== "string") throw fail("not-agy");
    if (protocolVersion !== 1 && protocolVersion !== 2) throw fail("not-agy");
    if (logout === undefined || logout === null || !hasPersonal) throw fail("not-agy");
    if (expectedVersion !== null && version !== expectedVersion) throw fail("version-mismatch", version);
    if (compareSemver(version, MIN_AGY_VERSION) < 0) throw fail("too-old", version);
    return { version };
  } finally {
    await child.kill(1_000);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Key for the once-per-process identity cache of external binaries (IA 5). */
export async function identityKey(file: string): Promise<string> {
  const real = await realpath(file);
  const s = await stat(real);
  return `${real}\0${s.size}\0${s.mtimeMs}`;
}
