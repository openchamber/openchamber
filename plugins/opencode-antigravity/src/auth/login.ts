// `agy acp --login` code flow (IA 10.2, 10.3): the child, the sign-in URL check, the paste check and
// the failure texts. `AuthManager` owns attempts, timers, the lock and cleanup.
//
// Never logged or put into an error: the URL, its `state`, the pasted code, agy's raw output.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { redactAgyOutput } from "./errors.ts";
import { LOGIN_MESSAGES } from "./constants.ts";

const GOOGLE_AUTH_ORIGIN = "https://accounts.google.com";
const GOOGLE_AUTH_PATH = "/o/oauth2/auth";
export const REDIRECT_URI = "https://antigravity.google/oauth-callback";
const MAX_URL_CHARS = 16_384;
const CODE_RE = /^[\w./~-]{1,2048}$/;
const OUTPUT_TAIL_LINES = 20;

export interface AuthUrl {
  url: string;
  state: string;
}

/** IA 2.2: Google's auth endpoint, one `state` of 1 to 512 chars, Antigravity's redirect, `response_type=code`. */
export function parseAuthUrl(line: string): AuthUrl | null {
  const raw = line.trim();
  if (raw.length === 0 || raw.length > MAX_URL_CHARS || raw.includes("#") || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== GOOGLE_AUTH_ORIGIN || url.pathname !== GOOGLE_AUTH_PATH) return null;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  const states = url.searchParams.getAll("state");
  const redirects = url.searchParams.getAll("redirect_uri");
  const types = url.searchParams.getAll("response_type");
  const state = states[0];
  if (states.length !== 1 || state === undefined || state.length < 1 || state.length > 512) return null;
  if (redirects.length !== 1 || redirects[0] !== REDIRECT_URI) return null;
  if (types.length !== 1 || types[0] !== "code") return null;
  return { url: raw, state };
}

/**
 * The value to write to agy's stdin, or null (IA 10.3 step 3): a bare code, or Antigravity's callback
 * URL with one `code` and the pending `state`. Anything with whitespace inside is refused, so a paste
 * can never put a second line on stdin.
 */
export function checkLoginResponse(pending: { state: string }, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_CHARS || /\s/.test(trimmed)) return null;
  if (CODE_RE.test(trimmed)) return trimmed;
  if (trimmed.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (`${url.origin}${url.pathname}` !== REDIRECT_URI) return null;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  const codes = url.searchParams.getAll("code");
  const states = url.searchParams.getAll("state");
  if (codes.length !== 1 || !codes[0] || states.length !== 1 || states[0] !== pending.state) return null;
  return trimmed;
}

/** IA 10.3 step 6: the user text for agy's last output after a non-zero exit. */
export function mapLoginFailure(text: string): string {
  if (text.includes("invalid_grant")) return LOGIN_MESSAGES.invalidGrant;
  if (text.includes("SUBSCRIPTION_REQUIRED")) return LOGIN_MESSAGES.subscription;
  if (text.includes("access_denied") || /cancell?ed/i.test(text)) return LOGIN_MESSAGES.notApproved;
  return LOGIN_MESSAGES.generic;
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export interface CodeLoginChild {
  readonly authUrl: AuthUrl;
  readonly exited: boolean;
  /** Writes `value + "\n"`, ends stdin and waits for exit. Exit 0 resolves; anything else throws a mapped `LoginError`. */
  submit(value: string, timeoutMs: number): Promise<void>;
  /** SIGTERM, then SIGKILL after `graceMs`. */
  kill(graceMs: number): Promise<void>;
  /** For `process.on("exit")`. */
  killSync(): void;
}

export interface StartCodeLoginDeps {
  binary: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd?: string;
  urlTimeoutMs: number;
  killGraceMs: number;
}

/** Spawns the login child and waits for the sign-in URL on stdout (IA 10.2 steps 7 to 9). */
export async function startCodeLogin(deps: StartCodeLoginDeps): Promise<CodeLoginChild> {
  const child: ChildProcessWithoutNullStreams = spawn(deps.binary, [...deps.args], {
    env: deps.env,
    cwd: deps.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {}); // EPIPE when the child is gone; the exit code decides

  const tail: string[] = [];
  const remember = (line: string): void => {
    tail.push(line);
    if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
  };
  let exitInfo: { code: number | null } | null = null;
  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once("exit", (code) => {
      exitInfo = { code };
      resolve(exitInfo);
    });
    child.once("error", () => {
      if (child.pid === undefined) {
        exitInfo = { code: null };
        resolve(exitInfo);
      }
    });
  });

  let onUrlLine: ((line: string) => void) | null = null;
  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    if (onUrlLine && line.trim().startsWith(`${GOOGLE_AUTH_ORIGIN}/`)) {
      onUrlLine(line);
      return; // the URL never goes into the tail
    }
    remember(line);
  });
  createInterface({ input: child.stderr }).on("line", remember);

  const lastLine = (): string => {
    const kept = redactAgyOutput(tail.join("\n")).split("\n").filter(Boolean);
    return kept[kept.length - 1] ?? "";
  };

  const killSync = (): void => {
    if (exitInfo === null) child.kill("SIGKILL");
  };
  const kill = async (graceMs: number): Promise<void> => {
    if (exitInfo !== null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = setTimeout(killSync, graceMs);
    timer.unref();
    await exited;
    clearTimeout(timer);
  };

  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      onUrlLine = null;
      reject(new LoginError(LOGIN_MESSAGES.urlTimeout));
    }, deps.urlTimeoutMs);
    onUrlLine = (l) => {
      clearTimeout(timer);
      onUrlLine = null;
      resolve(l);
    };
    void exited.then(async ({ code }) => {
      if (onUrlLine === null) return;
      clearTimeout(timer);
      onUrlLine = null;
      // Let the last lines of output arrive before quoting one.
      await new Promise((r) => setTimeout(r, 20));
      const last = lastLine();
      reject(new LoginError(last ? `${LOGIN_MESSAGES.earlyExit(code)} ${last}` : LOGIN_MESSAGES.earlyExit(code)));
    });
  }).catch(async (err: unknown) => {
    await kill(deps.killGraceMs);
    throw err;
  });

  const authUrl = parseAuthUrl(line);
  if (!authUrl) {
    await kill(deps.killGraceMs);
    throw new LoginError(LOGIN_MESSAGES.badUrl);
  }

  return {
    authUrl,
    get exited() {
      return exitInfo !== null;
    },
    async submit(value, timeoutMs) {
      if (exitInfo !== null) throw new LoginError(LOGIN_MESSAGES.stopped);
      child.stdin.write(`${value}\n`);
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const result = await Promise.race([exited, timeout]);
      clearTimeout(timer);
      if (result === "timeout") {
        await kill(deps.killGraceMs);
        throw new LoginError(LOGIN_MESSAGES.exchangeTimeout);
      }
      if (result.code === 0) return;
      await new Promise((r) => setTimeout(r, 20));
      const last = tail.filter((l) => l.trim() !== "").pop() ?? "";
      throw new LoginError(mapLoginFailure(last));
    },
    kill,
    killSync,
  };
}
