// The one place that picks status codes and wording for failures (SR 6.6), tuned to OpenCode 2.3.0's
// classifier: mid-stream errors carry a numeric `code`, retryable texts never contain OpenCode's quota or
// context-overflow phrases, HTTP errors say `x-should-retry` explicitly.

import { redactAgyOutput, SignInRequiredError, SignInUrlLineError, SIGNED_OUT_MESSAGE } from "./auth/errors.ts";
import type { ProviderFailure } from "./contracts.ts";
import { AcpError, AcpTimeoutError, AgyExitedError } from "./acp-client.ts";
import { BreakerOpenError } from "./agy-process.ts";
import { parseAgyApiError } from "./turn-outcome.ts";

export interface ErrorContext {
  /** `<gemini>/antigravity-acp/log`, named in the breaker text (SR 3.4). */
  logDir?: string;
}

export interface StreamErrorEvent {
  error: { code: number; type: string; message: string };
}

interface FailureSpec {
  status: number;
  /** Mid-stream code; differs from `status` only where a retry must not happen (SR 6.6). */
  streamCode: number;
  type: string;
  message: string;
  retry: boolean;
  retryAfterMs: number | null;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** A status parsed from agy text could be anything 3-digit; `Response` throws outside 200 to 599. */
function errorStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

/**
 * agy already retried (an error step, or a stall after its retry lines): 429 with `x-should-retry: false`,
 * and a text OpenCode 2.3.0's classifier reads as a quota error ("limit exhausted"), so a mid-stream
 * error, which carries no headers, is not retried either.
 */
function exhausted(kind: "rate_limited" | "capacity", what: string, retryAfterMs: number | null): FailureSpec {
  return {
    status: 429,
    streamCode: 429,
    type: kind === "capacity" ? "antigravity_capacity_exhausted" : "antigravity_rate_limit_exhausted",
    message: `${what}, and Antigravity already retried on its own. Request limit exhausted for now: try again later or pick another model.`,
    retry: false,
    retryAfterMs,
  };
}

function spec(f: ProviderFailure, ctx: ErrorContext): FailureSpec {
  switch (f.kind) {
    case "stalled":
      return {
        status: 504,
        streamCode: 504,
        type: "antigravity_stalled",
        message: `Antigravity sent nothing for ${formatDuration(f.silenceMs)}, so the turn was cancelled.`,
        retry: true,
        retryAfterMs: null,
      };
    case "rate_limited":
      if (f.agyRetried) return exhausted("rate_limited", "Google is rate-limiting Antigravity requests (HTTP 429)", f.retryAfterMs);
      return {
        status: 429,
        streamCode: 429,
        type: "antigravity_rate_limited",
        message: "Google is rate-limiting Antigravity requests (HTTP 429).",
        retry: true,
        retryAfterMs: f.retryAfterMs,
      };
    case "capacity":
      if (f.agyRetried) return exhausted("capacity", `Google has no capacity for ${f.model ?? "this model"} (HTTP 503)`, f.retryAfterMs);
      return {
        status: 503,
        streamCode: 503,
        type: "antigravity_capacity",
        message: `Google has no capacity for ${f.model ?? "this model"} right now (HTTP 503).`,
        retry: true,
        retryAfterMs: f.retryAfterMs,
      };
    case "quota_exhausted":
      return {
        status: 429,
        streamCode: 429,
        type: "antigravity_quota",
        message: "Antigravity quota exceeded for this period.",
        retry: false,
        retryAfterMs: null,
      };
    case "agy_exited": {
      const exit = f.code !== null ? `exit ${f.code}` : f.signal ? `signal ${f.signal}` : "no exit code";
      return {
        status: 503,
        streamCode: 503,
        type: "antigravity_exited",
        message: `Antigravity CLI stopped unexpectedly (${exit}). Retrying restarts it.`,
        retry: true,
        retryAfterMs: null,
      };
    }
    case "breaker_open":
      return {
        status: 503,
        streamCode: 503,
        type: "antigravity_breaker_open",
        message: `Antigravity CLI keeps exiting right after start. Check the Antigravity sign-in and the log in ${ctx.logDir ?? "antigravity-acp/log"}.`,
        retry: true,
        retryAfterMs: f.retryAfterMs,
      };
    case "auth_required":
      return { status: 401, streamCode: 401, type: "auth_required", message: f.message, retry: false, retryAfterMs: null };
    case "auth_changed":
      return {
        status: 503,
        streamCode: 503,
        type: "antigravity_auth_changed",
        message: "Antigravity sign-in changed. Retrying with the new account.",
        retry: true,
        retryAfterMs: null,
      };
    case "binary_not_found":
      return { status: 503, streamCode: 400, type: "invalid_request_error", message: f.message, retry: false, retryAfterMs: null };
    case "config_issue":
      return { status: 401, streamCode: 401, type: "auth_required", message: f.message, retry: false, retryAfterMs: null };
    case "provider_error": {
      const status = errorStatus(f.status);
      return {
        status,
        streamCode: status,
        type: "antigravity_provider_error",
        message: f.message ?? `Antigravity reported an error (HTTP ${status}).`,
        retry: status >= 500 || status === 408 || status === 409,
        retryAfterMs: null,
      };
    }
    case "client_aborted":
      return { status: 499, streamCode: 499, type: "client_aborted", message: "Request aborted.", retry: false, retryAfterMs: null };
  }
}

/** HTTP response before the stream started. */
export function toHttpError(f: ProviderFailure, ctx: ErrorContext = {}): Response {
  const s = spec(f, ctx);
  const headers = new Headers({ "x-should-retry": s.retry ? "true" : "false" });
  if (s.retryAfterMs !== null && s.retryAfterMs > 0) headers.set("retry-after", String(Math.ceil(s.retryAfterMs / 1000)));
  return Response.json({ error: { message: s.message, type: s.type, code: s.type } }, { status: s.status, headers });
}

/** Mid-stream SSE error event; null for a client abort, which writes nothing. */
export function toStreamError(f: ProviderFailure, ctx: ErrorContext = {}): StreamErrorEvent | null {
  if (f.kind === "client_aborted") return null;
  const s = spec(f, ctx);
  return { error: { code: s.streamCode, type: s.type, message: s.message } };
}

/** True when OpenCode would retry this failure (used for logs and tests). */
export function isRetryable(f: ProviderFailure): boolean {
  return spec(f, {}).retry;
}

function shapeCode(err: unknown): string | null {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

const MAX_PROVIDER_MESSAGE = 300;

/** agy 1.5.15 answers `session/set_config_option` with this for a model the account lacks (live test). */
const UNKNOWN_MODEL = /Unknown model ID:?\s*"?([^\s",]*)/i;

/**
 * A second check after `redactAgyOutput`, independent of its pattern: any URL (agy echoes the MCP URL,
 * whose path carries the per-pool MCP token), an `/mcp/` path, a credential word or an email drops
 * the text (N-9).
 */
const UNSAFE_TEXT = /[a-z][a-z0-9+.-]*:\/\/|\/mcp\/|bearer\s|authorization|token|secret|password|state=|code=|@/i;

/** The sign-in error classes by name, so one made by another copy of the module (a reload) counts. */
function isOwnSignInError(err: unknown): boolean {
  const name = typeof err === "object" && err !== null && "name" in err ? err.name : null;
  return name === "SignInRequiredError" || name === "SignInUrlLineError";
}

/** OpenCode 2.3.0 `provider-error.js` reads these as quota or context overflow; a retryable 502 must not carry them. */
const CLASSIFIER_PHRASES =
  /quota exceeded|usage limit|limit exhausted|insufficient quota|too many tokens|context length|context window|maximum context|prompt is too long|exceeds the context/i;

/**
 * Any error from spawn, setup or an RPC to a failure. `isSignInRequired` is the bridge's classifier
 * (IA 15.1), passed in so this module never decides sign-in on its own.
 */
export function mapAcpError(err: unknown, isSignInRequired: (err: unknown) => boolean): ProviderFailure {
  if (isSignInRequired(err)) {
    // Only the plugin's own sign-in errors carry our text; agy's error messages can hold a sign-in URL,
    // its state or the account email, so they never pass through (N-9).
    const own = err instanceof SignInRequiredError || err instanceof SignInUrlLineError || isOwnSignInError(err);
    const message = errorMessage(err);
    return { kind: "auth_required", message: own && message.startsWith("Antigravity") ? message : SIGNED_OUT_MESSAGE };
  }
  if (shapeCode(err) === "binary_not_found") return { kind: "binary_not_found", message: errorMessage(err) };
  if (err instanceof BreakerOpenError) return { kind: "breaker_open", retryAfterMs: err.retryAfterMs };
  if (err instanceof AgyExitedError) return { kind: "agy_exited", code: err.exitCode, signal: err.signal };
  if (err instanceof AcpTimeoutError) {
    return { kind: "provider_error", status: 504, message: `Antigravity did not answer ${err.method} in time.` };
  }
  if (err instanceof AcpError) {
    // agy's API error text (`transport error (ResourceExhausted, HTTP 429)` or `Error 429, ...`) failing
    // the RPC itself: rate limit or capacity, final only when it says agy already retried.
    const api = parseAgyApiError(err.message);
    if (api) {
      const agyRetried = (api.attempt ?? 0) > 1;
      if (api.status === 429 || api.grpc === "RESOURCE_EXHAUSTED") {
        return agyRetried ? { kind: "rate_limited", retryAfterMs: null, agyRetried } : { kind: "rate_limited", retryAfterMs: null };
      }
      if (api.status === 503 || api.grpc === "UNAVAILABLE") {
        return agyRetried ? { kind: "capacity", model: null, retryAfterMs: null, agyRetried } : { kind: "capacity", model: null, retryAfterMs: null };
      }
    }
    // A model this account does not have (an id from an older catalog): a request error, never retried.
    const unknown = UNKNOWN_MODEL.exec(err.message);
    if (unknown) {
      const id = unknown[1] && /^[A-Za-z0-9._:-]{1,80}$/.test(unknown[1]) ? ` "${unknown[1]}"` : "";
      return { kind: "provider_error", status: 400, message: `This Antigravity account has no model${id}. Pick another Antigravity model.` };
    }
    // agy's own text, never prompt content; still redacted and cut, since it can echo paths or ids.
    const text = redactAgyOutput(err.message).split("\n")[0]?.slice(0, MAX_PROVIDER_MESSAGE) ?? "";
    const safe = text && !CLASSIFIER_PHRASES.test(text) && !UNSAFE_TEXT.test(text);
    return { kind: "provider_error", status: 502, message: safe ? `Antigravity error: ${text}` : null };
  }
  return { kind: "provider_error", status: 502, message: null };
}
