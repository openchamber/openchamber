// Minimal JSON-RPC over stdio for the short-lived agy children of the install and auth design:
// `verify`, `probe` and `logout` (IA 6.5, 11.3, 13.2). The runtime's long-lived process uses its own
// AcpClient. Like it, this client watches every non-JSON stdout line and every stderr line for the
// sign-in URL prefix and fails pending requests with SignInUrlLineError (IA 15.3 item 3).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { AUTH_URL_STDOUT_PREFIX, SignInUrlLineError } from "../auth/errors.ts";

/** An ACP error answer. Matched by `isSignInRequired` through its numeric `code`. */
export class AcpRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "AcpError";
    this.code = code;
  }
}

export class ControlTimeoutError extends Error {
  constructor(method: string) {
    super(`agy did not answer ${method} in time.`);
    this.name = "ControlTimeoutError";
  }
}

export class ControlExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: string | null;

  constructor(code: number | null, signal: string | null) {
    super(`agy exited (code ${code ?? "none"}, signal ${signal ?? "none"}).`);
    this.name = "ControlExitError";
    this.exitCode = code;
    this.signal = signal;
  }
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface ControlProcess {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  readonly exited: Promise<ExitInfo>;
  /** Last stderr lines, at most 4 KiB, for classifying a failed start. Never logged as is. */
  stderrTail(): string;
  /** SIGTERM, then SIGKILL after `graceMs`. Resolves when the child is gone. */
  kill(graceMs?: number): Promise<void>;
}

export interface SpawnControlInput {
  binary: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd?: string;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL_BYTES = 4096;

export function spawnControl(input: SpawnControlInput): ControlProcess {
  const child: ChildProcessWithoutNullStreams = spawn(input.binary, [...input.args], {
    env: input.env,
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {}); // EPIPE after the child exits; the exit decides
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let stderr = "";
  let exitInfo: ExitInfo | null = null;
  let failure: Error | null = null;

  const failAll = (err: Error): void => {
    failure ??= err;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  };

  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      failAll(new ControlExitError(code, signal));
      resolve(exitInfo);
    });
    child.once("error", (err) => {
      failAll(err);
      if (child.exitCode === null && child.pid === undefined) {
        exitInfo = { code: null, signal: null };
        resolve(exitInfo);
      }
    });
  });

  const onAuthLine = (stream: "stdout" | "stderr"): void => {
    failAll(new SignInUrlLineError(stream));
    if (exitInfo === null) child.kill("SIGKILL");
  };

  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith(AUTH_URL_STDOUT_PREFIX.trim())) onAuthLine("stdout");
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const id = "id" in msg ? msg.id : undefined;
    if (typeof id !== "number") return;
    const p = pending.get(id);
    if (!p || "method" in msg) return; // agent-to-client requests are not used by these children
    pending.delete(id);
    clearTimeout(p.timer);
    const error = "error" in msg ? msg.error : undefined;
    if (error !== undefined) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : -32603;
      const message =
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "";
      p.reject(new AcpRpcError(code, message));
    } else {
      p.resolve("result" in msg ? msg.result : undefined);
    }
  });

  const stderrLines = createInterface({ input: child.stderr });
  stderrLines.on("line", (line) => {
    stderr = `${stderr}${line}\n`.slice(-STDERR_TAIL_BYTES);
    if (line.trim().startsWith(AUTH_URL_STDOUT_PREFIX.trim())) onAuthLine("stderr");
  });

  return {
    request(method, params, timeoutMs) {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new ControlTimeoutError(method));
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    exited,
    stderrTail: () => stderr,
    async kill(graceMs = 3_000) {
      if (exitInfo !== null) return;
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (exitInfo === null) child.kill("SIGKILL");
      }, graceMs);
      timer.unref();
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Rejects with `onTimeout()` when `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
