import { describe, expect, test } from "bun:test";
import { AcpError, AcpTimeoutError, AgyExitedError } from "../../src/acp-client.ts";
import { BreakerOpenError } from "../../src/agy-process.ts";
import { SIGNED_OUT_MESSAGE, SignInRequiredError, SignInUrlLineError, isSignInRequired } from "../../src/auth/errors.ts";
import type { ProviderFailure } from "../../src/contracts.ts";
import { isRetryable, mapAcpError, toHttpError, toStreamError } from "../../src/errors.ts";

// From @opencode/ai@2.3.0 provider-error.js: texts that turn a 429 into QuotaExceeded, and the
// context-overflow phrases. A retryable failure must match none of them (SR 6.6).
const OPENCODE_QUOTA = /quota exceeded|usage limit|limit exhausted|insufficient quota/i;
const OPENCODE_OVERFLOW = /too many tokens|context length|context window|maximum context|prompt is too long/i;

interface Row {
  failure: ProviderFailure;
  status: number;
  shouldRetry: "true" | "false";
  retryAfter: string | null;
  streamCode: number | null;
}

const ROWS: Row[] = [
  { failure: { kind: "stalled", silenceMs: 180_000 }, status: 504, shouldRetry: "true", retryAfter: null, streamCode: 504 },
  { failure: { kind: "rate_limited", retryAfterMs: 20_000 }, status: 429, shouldRetry: "true", retryAfter: "20", streamCode: 429 },
  { failure: { kind: "capacity", model: "gemini-4-neon", retryAfterMs: 57_168 }, status: 503, shouldRetry: "true", retryAfter: "58", streamCode: 503 },
  // agy already retried (live test fix 5): not retried by OpenCode, before or after the stream starts.
  { failure: { kind: "rate_limited", retryAfterMs: null, agyRetried: true }, status: 429, shouldRetry: "false", retryAfter: null, streamCode: 429 },
  { failure: { kind: "capacity", model: "gemini-4-neon", retryAfterMs: 57_168, agyRetried: true }, status: 429, shouldRetry: "false", retryAfter: "58", streamCode: 429 },
  { failure: { kind: "quota_exhausted" }, status: 429, shouldRetry: "false", retryAfter: null, streamCode: 429 },
  { failure: { kind: "agy_exited", code: 137, signal: null }, status: 503, shouldRetry: "true", retryAfter: null, streamCode: 503 },
  { failure: { kind: "breaker_open", retryAfterMs: 30_000 }, status: 503, shouldRetry: "true", retryAfter: "30", streamCode: 503 },
  { failure: { kind: "auth_required", message: SIGNED_OUT_MESSAGE }, status: 401, shouldRetry: "false", retryAfter: null, streamCode: 401 },
  { failure: { kind: "auth_changed" }, status: 503, shouldRetry: "true", retryAfter: null, streamCode: 503 },
  { failure: { kind: "binary_not_found", message: "Antigravity CLI is not installed." }, status: 503, shouldRetry: "false", retryAfter: null, streamCode: 400 },
  { failure: { kind: "config_issue", message: "Unsupported sign-in method." }, status: 401, shouldRetry: "false", retryAfter: null, streamCode: 401 },
  { failure: { kind: "provider_error", status: 502, message: null }, status: 502, shouldRetry: "true", retryAfter: null, streamCode: 502 },
  { failure: { kind: "provider_error", status: 503, message: "x" }, status: 503, shouldRetry: "true", retryAfter: null, streamCode: 503 },
  { failure: { kind: "client_aborted" }, status: 499, shouldRetry: "false", retryAfter: null, streamCode: null },
];

describe("SR 6.6 table", () => {
  for (const row of ROWS) {
    test(`${row.failure.kind} ${row.status}`, async () => {
      const res = toHttpError(row.failure, { logDir: "/g/antigravity-acp/log" });
      expect(res.status).toBe(row.status);
      expect(res.headers.get("x-should-retry")).toBe(row.shouldRetry);
      expect(res.headers.get("retry-after")).toBe(row.retryAfter);
      const body: unknown = await res.json();
      expect(JSON.stringify(body)).toContain('"message"');
      const event = toStreamError(row.failure);
      if (row.streamCode === null) {
        expect(event).toBeNull();
        return;
      }
      expect(typeof event?.error.code).toBe("number");
      expect(event?.error.code).toBe(row.streamCode);
      expect(event?.error.message.length).toBeGreaterThan(0);
      if (isRetryable(row.failure)) {
        expect(OPENCODE_QUOTA.test(event?.error.message ?? "")).toBe(false);
        expect(OPENCODE_OVERFLOW.test(event?.error.message ?? "")).toBe(false);
      }
    });
  }

  test("a provider status outside 400 to 599 becomes 502 instead of throwing", () => {
    for (const status of [0, 100, 200, 600, 999]) {
      expect(toHttpError({ kind: "provider_error", status, message: null }).status).toBe(502);
      expect(toStreamError({ kind: "provider_error", status, message: null })?.error.code).toBe(502);
    }
  });

  test("texts the design names", () => {
    expect(toStreamError({ kind: "stalled", silenceMs: 180_000 })?.error).toEqual({
      code: 504,
      type: "antigravity_stalled",
      message: "Antigravity sent nothing for 3 minutes, so the turn was cancelled.",
    });
    expect(toStreamError({ kind: "agy_exited", code: 137, signal: null })?.error.message).toBe(
      "Antigravity CLI stopped unexpectedly (exit 137). Retrying restarts it.",
    );
    expect(toStreamError({ kind: "quota_exhausted" })?.error.message).toBe("Antigravity quota exceeded for this period.");
    expect(toStreamError({ kind: "binary_not_found", message: "m" })?.error.type).toBe("invalid_request_error");
    expect(toStreamError({ kind: "auth_changed" })?.error.message).toBe("Antigravity sign-in changed. Retrying with the new account.");
    expect(toStreamError({ kind: "breaker_open", retryAfterMs: 30_000 }, { logDir: "/g/antigravity-acp/log" })?.error.message).toContain(
      "/g/antigravity-acp/log",
    );
  });
});

describe("mapAcpError", () => {
  const map = (err: unknown): ProviderFailure => mapAcpError(err, isSignInRequired);

  test("sign-in errors are auth_required 401", () => {
    expect(map(new AcpError(-32000, "Authentication required")).kind).toBe("auth_required");
    expect(map(new SignInUrlLineError("stdout"))).toEqual({ kind: "auth_required", message: SIGNED_OUT_MESSAGE });
    expect(map(new SignInRequiredError())).toEqual({ kind: "auth_required", message: SIGNED_OUT_MESSAGE });
  });

  test("agy's sign-in error text never passes through; only the plugin's own sign-in errors keep theirs (N-9)", () => {
    const leaky = new AcpError(-32000, "Antigravity auth failed for alice@example.com: https://accounts.google.com/o/oauth2/auth?state=SECRET");
    expect(map(leaky)).toEqual({ kind: "auth_required", message: SIGNED_OUT_MESSAGE });
    const own = new SignInRequiredError("Antigravity is signed out after a logout. Connect again.");
    expect(map(own)).toEqual({ kind: "auth_required", message: "Antigravity is signed out after a logout. Connect again." });
  });

  test("an ACP error quoting the MCP URL or any URL keeps no part of it (N-9)", () => {
    const token = "deadbeef".repeat(6);
    const err = new AcpError(-32603, `MCP server opencode failed: Post "http://127.0.0.1:54321/mcp/${token}/cafebabe": dial tcp 127.0.0.1:54321: connection refused`);
    const failure = map(err);
    expect(failure).toEqual({ kind: "provider_error", status: 502, message: null });
    expect(JSON.stringify(failure)).not.toContain(token);
    expect(map(new AcpError(-32603, "bad Authorization: Bearer abc"))).toEqual({ kind: "provider_error", status: 502, message: null });
  });

  test("binary, breaker, exit, timeout", () => {
    const missing = Object.assign(new Error("Antigravity CLI is not installed."), { code: "binary_not_found" });
    expect(map(missing)).toEqual({ kind: "binary_not_found", message: "Antigravity CLI is not installed." });
    expect(map(new BreakerOpenError(30_000))).toEqual({ kind: "breaker_open", retryAfterMs: 30_000 });
    expect(map(new AgyExitedError(137, null))).toEqual({ kind: "agy_exited", code: 137, signal: null });
    expect(map(new AcpTimeoutError("session/new", 30_000))).toEqual({ kind: "provider_error", status: 504, message: "Antigravity did not answer session/new in time." });
  });

  test("an RPC failing with agy's transport error text is a rate limit or capacity, final only after agy's retries", () => {
    const tail = ": Resource has been exhausted (e.g. check quota).: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).";
    expect(map(new AcpError(-32603, `transport error (ResourceExhausted, HTTP 429)${tail}`))).toEqual({ kind: "rate_limited", retryAfterMs: null });
    const final = map(new AcpError(-32603, `API error (attempt 8): transport error (ResourceExhausted, HTTP 429)${tail}`));
    expect(final).toEqual({ kind: "rate_limited", retryAfterMs: null, agyRetried: true });
    expect(isRetryable(final)).toBe(false);
    expect(map(new AcpError(-32603, "transport error (Unavailable, HTTP 503): No capacity available"))).toEqual({ kind: "capacity", model: null, retryAfterMs: null });
  });

  test("agy's Unknown model ID is a 400 that names the model and is not retried (live test fix 4)", () => {
    const failure = map(new AcpError(-32603, "Unknown model ID: gemini-4-neon"));
    expect(failure).toEqual({ kind: "provider_error", status: 400, message: 'This Antigravity account has no model "gemini-4-neon". Pick another Antigravity model.' });
    expect(isRetryable(failure)).toBe(false);
  });

  test("other ACP errors are a retryable 502 without classifier phrases", () => {
    expect(map(new AcpError(-32603, "Failed to read session abc"))).toEqual({
      kind: "provider_error",
      status: 502,
      message: "Antigravity error: Failed to read session abc",
    });
    expect(map(new AcpError(-32603, "Quota exceeded for the day"))).toEqual({ kind: "provider_error", status: 502, message: null });
    expect(map(new AcpError(-32603, "see https://example.com/x?state=1"))).toEqual({ kind: "provider_error", status: 502, message: null });
    expect(map(new Error("boom"))).toEqual({ kind: "provider_error", status: 502, message: null });
  });
});
