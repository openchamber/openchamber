#!/usr/bin/env bun
// Fake agy for the install/auth flows: `acp --login`, the status probe and ACP `logout` (IA 17.1).
//
// Run:   bun test/fixtures/mock-agy-login.ts [--scenario a,b] [--journal <file>] [--email <e>] [--agy-version v] acp --gemini-dir <g> ...
// Tests: writeMockLoginWrapper(dir, opts) writes an executable that does exactly that.
//
// `--login` prints agy 1.5.15's exact text (IA 2.3), then reads one stdin line:
//   `good-code`, or a callback URL whose `code` is `good-code`: writes `antigravity-oauth-token` (with
//   `id_token_email` unless `--email` is empty) and `acp_token.json`, exits 0.
//   EOF without a line: `login cancelled: no authorization code was entered`, exit 1.
//   Anything else: the real `invalid_grant` line, exit 1.
// ACP mode answers `initialize` like mock-agy.ts, `authenticate` from the token file's presence
// (signed out: agy's real -32603 no-browser error), and `logout` by deleting the token files.
// Every stdin line and RPC goes to the journal in mock-agy.ts's `JournalEntry` shape.

import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AUTH_URL_STDOUT_PREFIX } from "../../src/auth/errors.ts";
import { baseInitializeResult, MOCK_AGY_DEFAULT_VERSION, MOCK_NO_BROWSER_MESSAGE } from "./mock-agy.ts";

export const MOCK_LOGIN_PATH = fileURLToPath(import.meta.url);
export const GOOD_CODE = "good-code";
export const MOCK_STATE = "mock-state-123";
export const MOCK_EMAIL = "someone@example.com";
export const MOCK_AUTH_URL =
  `https://accounts.google.com/o/oauth2/auth?client_id=mock.apps.googleusercontent.com&redirect_uri=${encodeURIComponent("https://antigravity.google/oauth-callback")}` +
  `&response_type=code&scope=openid&state=${MOCK_STATE}&code_challenge=abc&code_challenge_method=S256&access_type=offline&prompt=consent`;
export const INVALID_GRANT_LINE = `couldn't log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."`;
export const CANCELLED_LINE = "login cancelled: no authorization code was entered";
/** A line the early-exit text must never quote. */
export const SENSITIVE_EXIT_LINE = "debug: state=abc token=xyz user@example.com https://accounts.google.com/o";
export const SAFE_EXIT_LINE = "fatal: profile directory is not writable";

/**
 * Scenarios, comma-separated:
 * - login: `login-exit-early` (prints a sensitive and a safe line, exits 3 before the URL),
 *   `login-no-url` (prints nothing and waits), `login-bad-url` (a URL with another path),
 *   `login-exit-before-code` (exits 1 50 ms after the URL), `login-hang-exchange` (never exits after the code).
 * - authenticate: `auth-ok`, `auth-signed-out`, `auth-unauth` (-32000), `auth-url-line` (prints the
 *   sign-in URL line on stdout and never answers), `auth-hang`, `auth-crash` (exits 1).
 * - logout: `no-logout` (no `auth.logout` capability), `logout-hang`, `logout-error`.
 */
export type MockLoginScenario =
  | "login-exit-early"
  | "login-no-url"
  | "login-bad-url"
  | "login-exit-before-code"
  | "login-hang-exchange"
  | "auth-ok"
  | "auth-signed-out"
  | "auth-unauth"
  | "auth-url-line"
  | "auth-hang"
  | "auth-crash"
  | "no-logout"
  | "logout-hang"
  | "logout-error";

interface Args {
  scenarios: Set<string>;
  journal: string | null;
  email: string;
  agyVersion: string;
  agyArgv: string[];
  geminiDir: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let scenario = "";
  let journal: string | null = null;
  let email = MOCK_EMAIL;
  let agyVersion = MOCK_AGY_DEFAULT_VERSION;
  const agyArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--scenario" && next !== undefined) {
      scenario = next;
      i++;
    } else if (arg === "--journal" && next !== undefined) {
      journal = next;
      i++;
    } else if (arg === "--email" && next !== undefined) {
      email = next;
      i++;
    } else if (arg === "--agy-version" && next !== undefined) {
      agyVersion = next;
      i++;
    } else if (arg !== undefined) {
      agyArgv.push(arg);
    }
  }
  const at = agyArgv.indexOf("--gemini-dir");
  return {
    scenarios: new Set(scenario.split(",").map((s) => s.trim()).filter(Boolean)),
    journal,
    email,
    agyVersion,
    agyArgv,
    geminiDir: at >= 0 ? (agyArgv[at + 1] ?? null) : null,
  };
}

function appDir(args: Args): string {
  return path.join(args.geminiDir ?? ".", "antigravity-acp");
}

function tokenFile(args: Args): string {
  return path.join(appDir(args), "antigravity-oauth-token");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const has = (s: MockLoginScenario): boolean => args.scenarios.has(s);
  const journal = (method: string, params: Record<string, unknown> = {}, id: number | string | null = null): void => {
    if (!args.journal) return;
    appendFileSync(
      args.journal,
      `${JSON.stringify({ at: Date.now(), pid: process.pid, method, id, sessionId: null, promptText: null, params })}\n`,
    );
  };
  if (args.agyArgv[0] !== "acp") {
    process.stderr.write("mock-agy-login: only `acp` is implemented\n");
    process.exit(2);
  }
  journal("process/start", { argv: args.agyArgv, sshConnection: process.env.SSH_CONNECTION ?? null, display: process.env.DISPLAY ?? null });
  if (args.agyArgv.includes("--login")) runLogin(args, has, journal);
  else runAcp(args, has, journal);
}

type Has = (s: MockLoginScenario) => boolean;
type Journal = (method: string, params?: Record<string, unknown>, id?: number | string | null) => void;

function runLogin(args: Args, has: Has, journal: Journal): void {
  if (has("login-exit-early")) {
    process.stderr.write(`${SENSITIVE_EXIT_LINE}\n${SAFE_EXIT_LINE}\n`);
    setTimeout(() => process.exit(3), 10);
    return;
  }
  if (has("login-no-url")) {
    setInterval(() => {}, 1_000);
    return;
  }
  const url = has("login-bad-url") ? MOCK_AUTH_URL.replace("/o/oauth2/auth", "/o/oauth2/v2/auth") : MOCK_AUTH_URL;
  process.stdout.write(`Open this link in a browser to log in with Google:\n\n  ${url}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`);
  if (has("login-exit-before-code")) {
    setTimeout(() => process.exit(1), 50);
    return;
  }
  let answered = false;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (answered) return;
    answered = true;
    journal("login/stdin", { line });
    if (has("login-hang-exchange")) {
      setInterval(() => {}, 1_000);
      return;
    }
    let code = line.trim();
    if (code.startsWith("https://")) code = new URL(code).searchParams.get("code") ?? "";
    if (code === GOOD_CODE) {
      mkdirSync(appDir(args), { recursive: true });
      const token: Record<string, string> = { auth_method: "oauth-personal", token: "secret-token" };
      if (args.email) token.id_token_email = args.email;
      writeFileSync(tokenFile(args), JSON.stringify(token), { mode: 0o600 });
      writeFileSync(path.join(appDir(args), "acp_token.json"), JSON.stringify({ refresh_token: "r" }), { mode: 0o600 });
      process.stdout.write("Logged in.\n");
      setTimeout(() => process.exit(0), 10);
      return;
    }
    process.stderr.write(`${INVALID_GRANT_LINE}\n`);
    setTimeout(() => process.exit(1), 10);
  });
  rl.on("close", () => {
    if (answered) return;
    process.stderr.write(`${CANCELLED_LINE}\n`);
    setTimeout(() => process.exit(1), 10);
  });
}

function runAcp(args: Args, has: Has, journal: Journal): void {
  const send = (msg: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const reply = (id: number | string, result: unknown): void => send({ jsonrpc: "2.0", id, result });
  const error = (id: number | string, code: number, message: string): void => send({ jsonrpc: "2.0", id, error: { code, message } });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const method = "method" in msg && typeof msg.method === "string" ? msg.method : null;
    const id = "id" in msg && (typeof msg.id === "number" || typeof msg.id === "string") ? msg.id : null;
    const params = "params" in msg && typeof msg.params === "object" && msg.params !== null ? { ...msg.params } : {};
    if (method === null || id === null) return;
    journal(method, params, id);
    if (method === "initialize") {
      const result = baseInitializeResult(args.agyVersion);
      if (has("no-logout")) result.agentCapabilities.auth = {};
      reply(id, result);
      return;
    }
    if (method === "authenticate") {
      if (has("auth-crash")) process.exit(1);
      if (has("auth-hang")) return;
      if (has("auth-url-line")) {
        process.stdout.write(`${AUTH_URL_STDOUT_PREFIX}${MOCK_AUTH_URL}\n`);
        return;
      }
      if (has("auth-unauth")) return error(id, -32000, "Authentication required");
      if (has("auth-signed-out")) return error(id, -32603, MOCK_NO_BROWSER_MESSAGE);
      if (has("auth-ok") || existsSync(tokenFile(args))) return reply(id, {});
      return error(id, -32603, MOCK_NO_BROWSER_MESSAGE);
    }
    if (method === "logout") {
      if (has("logout-hang")) return;
      if (has("logout-error")) return error(id, -32603, "logout failed");
      for (const file of [tokenFile(args), path.join(appDir(args), "acp_token.json")]) rmSync(file, { force: true });
      reply(id, {});
      return;
    }
    error(id, -32601, `Method not found: ${method}`);
  });
  rl.on("close", () => process.exit(0));
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export interface MockLoginWrapperOptions {
  scenario?: readonly MockLoginScenario[];
  journal?: string;
  /** Empty string: the token file has no `id_token_email`. */
  email?: string;
  agyVersion?: string;
  /** File name, default `agy`. */
  name?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Writes an executable into `dir` that runs this fixture with the given options. Returns its path. */
export function writeMockLoginWrapper(dir: string, opts: MockLoginWrapperOptions = {}): string {
  const flags: string[] = [];
  if (opts.scenario && opts.scenario.length > 0) flags.push("--scenario", opts.scenario.join(","));
  if (opts.journal !== undefined) flags.push("--journal", opts.journal);
  if (opts.email !== undefined) flags.push("--email", opts.email);
  if (opts.agyVersion !== undefined) flags.push("--agy-version", opts.agyVersion);
  const file = path.join(dir, opts.name ?? "agy");
  const quoted = [process.execPath, MOCK_LOGIN_PATH, ...flags].map(shellQuote).join(" ");
  writeFileSync(file, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === MOCK_LOGIN_PATH;
}

if (isMainModule()) main();
