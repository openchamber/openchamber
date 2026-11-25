// Sign-in error classes, the sign-in classifier and the texts users see (IA 12.1, 13.3, 15.1).

/** agy prints this line, then the URL, when it wants an interactive sign-in. Checked on stdout and stderr. */
export const AUTH_URL_STDOUT_PREFIX = "Open the following link to authenticate the ACP server: ";

/** Request failure while signed out (401 `auth_required`, IA 12.1 step 2). */
export const SIGNED_OUT_MESSAGE = "Antigravity is signed out. Open Settings, Providers, Antigravity and connect again.";

/** Proxy check 2: a chat request without the `Bearer agy-managed` marker (IA 13.3). */
export const SIGN_IN_GATE_MESSAGE = "Sign in to Antigravity in Settings, Providers before using it.";

/** `needs_auth` message on every Antigravity connection while signed out (IA 12.1 step 3). */
export const NEEDS_AUTH_STATUS_MESSAGE = "Signed out of Antigravity. Connect again to sign in.";

const NO_BROWSER_PREFIX = "No browser is available here";
const LOGIN_COMMAND = "agy acp --login";
const ACP_UNAUTHENTICATED = -32000;
const ACP_INTERNAL_ERROR = -32603;

/**
 * agy printed `AUTH_URL_STDOUT_PREFIX` on stdout or stderr. The URL is never kept: it carries the
 * OAuth `state`. `AcpClient` rejects that generation's pending requests with this error.
 */
export class SignInUrlLineError extends Error {
  readonly code = "auth_required";
  readonly stream: "stdout" | "stderr";

  constructor(stream: "stdout" | "stderr") {
    super(SIGNED_OUT_MESSAGE);
    this.name = "SignInUrlLineError";
    this.stream = stream;
  }
}

/** `beforeSpawn()` while signed out after a logout with the auth epoch unchanged. */
export class SignInRequiredError extends Error {
  readonly code = "auth_required";

  constructor(message: string = SIGNED_OUT_MESSAGE) {
    super(message);
    this.name = "SignInRequiredError";
  }
}

function hasName(err: object, name: string): boolean {
  return "name" in err && err.name === name;
}

function numericCode(err: object): number | null {
  return "code" in err && typeof err.code === "number" ? err.code : null;
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "";
}

/**
 * True for an ACP error with code -32000; code -32603 whose message starts with
 * `No browser is available here`; any message containing `agy acp --login`; a SignInUrlLineError;
 * and a SignInRequiredError (IA 15.1).
 *
 * ACP errors are matched by shape (a numeric `code` and a string `message`), so this module does not
 * depend on acp-client.ts. Node system errors carry string codes and never match. Class checks fall
 * back to `name`, so an error from another copy of this module (a reloaded plugin) still matches.
 */
export function isSignInRequired(err: unknown): boolean {
  if (err instanceof SignInUrlLineError || err instanceof SignInRequiredError) return true;
  const message = messageOf(err);
  if (typeof err === "object" && err !== null) {
    if (hasName(err, "SignInUrlLineError") || hasName(err, "SignInRequiredError")) return true;
    const code = numericCode(err);
    if (code === ACP_UNAUTHENTICATED) return true;
    if (code === ACP_INTERNAL_ERROR && message.startsWith(NO_BROWSER_PREFIX)) return true;
  }
  return message.includes(LOGIN_COMMAND);
}

/** URLs of any scheme (the MCP URL agy is given is `http://127.0.0.1:<port>/mcp/<secret>/...`), the MCP
 *  path itself, auth headers (`Bearer`, `Authorization:`), OAuth parameters, tokens and anything with an
 *  `@` (emails). The bare word "authorization" stays: agy's "no authorization code was entered" is safe. */
const SENSITIVE_LINE = /[a-z][a-z0-9+.-]*:\/\/|\/mcp\/|\bbearer\b|\bauthorization\s*[:=]|state=|code=|token|@/i;
const MAX_REDACTED_LINE = 200;

/**
 * Makes agy output safe to put into an error (IA 10.2): drops every line containing a URL (`http://`,
 * `https://`, any scheme), `/mcp/`, `bearer`, `authorization:`, `state=`, `code=`, `token` (any case)
 * or `@`, and cuts the others to 200 code points. Lines are
 * trimmed; empty ones are dropped. Returns the kept lines joined with "\n", or "" when none is kept.
 */
export function redactAgyOutput(text: string): string {
  const kept: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || SENSITIVE_LINE.test(line)) continue;
    const chars = Array.from(line); // code points, so a cut never splits a surrogate pair
    kept.push(chars.length > MAX_REDACTED_LINE ? chars.slice(0, MAX_REDACTED_LINE).join("") : line);
  }
  return kept.join("\n");
}
