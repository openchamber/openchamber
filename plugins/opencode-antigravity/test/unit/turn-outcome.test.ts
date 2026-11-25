import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SIGNED_OUT_MESSAGE } from "../../src/auth/errors.ts";
import { isRetryable } from "../../src/errors.ts";
import { classifyErrorPayload, lastStepIndex, parseAgyApiError, readTurnErrorStep } from "../../src/turn-outcome.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

const ID = "5c1e0f8a-1111-4222-8333-944455556666";

function gemini(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-outcome-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "antigravity-acp", "conversations"), { recursive: true });
  return dir;
}

function dbPath(g: string, id = ID): string {
  return path.join(g, "antigravity-acp", "conversations", `${id}.db`);
}

function withSteps(g: string, rows: Array<[number, number, string]>, id = ID): void {
  const db = new Database(dbPath(g, id), { create: true });
  db.run("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)");
  for (const [idx, type, payload] of rows) db.run("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)", idx, type, payload);
  db.close();
}

describe("turn-outcome", () => {
  test("missing DB: index -1, then no error step without a file", async () => {
    const g = gemini();
    const mark = await lastStepIndex(g, ID);
    expect(mark).toEqual({ index: -1, file: null });
    expect(await readTurnErrorStep(g, ID, mark)).toBeNull();
  });

  test("a DB without a steps table gives null", async () => {
    const g = gemini();
    const db = new Database(dbPath(g), { create: true });
    db.run("CREATE TABLE other (x INTEGER)");
    db.close();
    const mark = await lastStepIndex(g, ID);
    expect(mark?.index).toBe(-1);
    expect(await readTurnErrorStep(g, ID, mark)).toBeNull();
  });

  test("type 17 with 429 gives rate_limited; rows at or before the start index are ignored", async () => {
    const g = gemini();
    withSteps(g, [[0, 17, "Error 503, Message: old, Status: UNAVAILABLE"], [1, 5, "input"]]);
    const mark = await lastStepIndex(g, ID);
    expect(mark?.index).toBe(1);
    expect(await readTurnErrorStep(g, ID, mark)).toBeNull();
    withSteps(g, [[2, 17, "Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED"]]);
    expect(await readTurnErrorStep(g, ID, mark)).toEqual({ failure: { kind: "rate_limited", retryAfterMs: null, agyRetried: true }, brokenHistory: false });
  });

  test("the newest step decides: a later non-error step means no failure", async () => {
    const g = gemini();
    withSteps(g, [[0, 17, "Error 429, Message: x, Status: RESOURCE_EXHAUSTED"], [1, 9, "model reply"]]);
    expect(await readTurnErrorStep(g, ID, { index: -1, file: null })).toBeNull();
  });

  test("agy 1.5.15's error step format: HTTP status, gRPC status and the attempt (browser run 2)", () => {
    const real =
      "API error (attempt 8): transport error (ResourceExhausted, HTTP 429): Resource has been exhausted (e.g. check quota).: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).";
    expect(parseAgyApiError(real)).toEqual({ status: 429, grpc: "RESOURCE_EXHAUSTED", attempt: 8 });
    expect(classifyErrorPayload(real)).toEqual({
      failure: { kind: "rate_limited", retryAfterMs: null, agyRetried: true },
      brokenHistory: false,
      attempt: 8,
    });
    const unavailable = "API error (attempt 3): transport error (Unavailable, HTTP 503): No capacity available for model gemini-3.8-flash-high on the server: UNAVAILABLE (code 503): No capacity";
    expect(classifyErrorPayload(unavailable)).toEqual({
      failure: { kind: "capacity", model: null, retryAfterMs: null, agyRetried: true },
      brokenHistory: false,
      attempt: 3,
    });
    expect(parseAgyApiError("transport error (Unauthenticated, HTTP 401): bad token")).toEqual({ status: 401, grpc: "UNAUTHENTICATED", attempt: null });
    expect(classifyErrorPayload("transport error (Unauthenticated, HTTP 401): bad token").failure.kind).toBe("auth_required");
    // The older format still parses, without an attempt.
    expect(parseAgyApiError("Error 429, Message: x, Status: RESOURCE_EXHAUSTED")).toEqual({ status: 429, grpc: "RESOURCE_EXHAUSTED", attempt: null });
    expect(parseAgyApiError("something else")).toBeNull();
  });

  test("payload classification", () => {
    expect(classifyErrorPayload("Error 429, Message: q reason:QUOTA_EXHAUSTED, Status: RESOURCE_EXHAUSTED").failure).toEqual({ kind: "quota_exhausted" });
    // An error step means agy's own retries failed: capacity, not retried again (live test fix 5).
    expect(classifyErrorPayload("Error 503, Message: No capacity, Status: UNAVAILABLE").failure).toEqual({
      kind: "capacity",
      model: null,
      retryAfterMs: null,
      agyRetried: true,
    });
    expect(classifyErrorPayload("Error 500, Message: internal, Status: INTERNAL").failure).toEqual({
      kind: "provider_error",
      status: 500,
      message: "Antigravity reported HTTP 500 from Google.",
    });
    expect(classifyErrorPayload("Error 400, Message: messages.3.content.0.thinking.signature: Field required, Status: INVALID_ARGUMENT")).toEqual({
      failure: { kind: "provider_error", status: 502, message: null },
      brokenHistory: true,
    });
    expect(classifyErrorPayload("Invalid `signature` in `thinking` block").brokenHistory).toBe(true);
    // N-7: a rejected credential is the sign-in path; other 4xx keep their status (not retried).
    expect(classifyErrorPayload("Error 401, Message: Request had invalid authentication credentials., Status: UNAUTHENTICATED").failure).toEqual({
      kind: "auth_required",
      message: SIGNED_OUT_MESSAGE,
    });
    for (const [status, grpc] of [[400, "INVALID_ARGUMENT"], [403, "PERMISSION_DENIED"], [404, "NOT_FOUND"]] as const) {
      const failure = classifyErrorPayload(`Error ${status}, Message: nope, Status: ${grpc}`).failure;
      expect(failure).toEqual({ kind: "provider_error", status, message: `Antigravity reported HTTP ${status} from Google.` });
      expect(isRetryable(failure)).toBe(false);
    }
    expect(classifyErrorPayload("something else").failure).toEqual({ kind: "provider_error", status: 502, message: null });
    // Messages span lines: API_ERROR is dotAll.
    expect(classifyErrorPayload("Error 429, Message: line one\nline two, Status: RESOURCE_EXHAUSTED").failure.kind).toBe("rate_limited");
  });

  test("a session id with a slash, or a symlinked DB, is skipped", async () => {
    const g = gemini();
    expect(await lastStepIndex(g, "../evil")).toBeNull();
    expect(await lastStepIndex(g, "a/b")).toBeNull();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "agy-outcome-other-"));
    dirs.push(elsewhere);
    mkdirSync(path.join(elsewhere, "antigravity-acp", "conversations"), { recursive: true });
    withSteps(elsewhere, [[0, 17, "Error 429, Message: x, Status: RESOURCE_EXHAUSTED"]], "x");
    symlinkSync(path.join(elsewhere, "antigravity-acp", "conversations", "x.db"), dbPath(g));
    expect(await lastStepIndex(g, ID)).toBeNull();
    expect(await readTurnErrorStep(g, ID, { index: -1, file: null })).toBeNull();
  });

});
