// Reads the error step agy writes when every retry failed (SR 6.5). Read-only, only the session's own
// conversation DB, with T3 Code's guards: plain id, no symlinks on the path, same file before and after.
// Any problem skips the check, so a changed agy schema ends the turn with `stop` as before.

import { lstatSync } from "node:fs";
import path from "node:path";
import { SIGNED_OUT_MESSAGE } from "./auth/errors.ts";
import type { ProviderFailure } from "./contracts.ts";

const SESSION_ID = /^[\w-]+$/;
const ERROR_STEP_TYPE = 17;
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
/** agy 1.5.15: `transport error (ResourceExhausted, HTTP 429): ...: RESOURCE_EXHAUSTED (code 429): ...`. */
const TRANSPORT_ERROR = /transport error \(([A-Za-z]+), HTTP (\d{3})\)/;
const STATUS_CODE = /\b([A-Z][A-Z_]+) \(code (\d{3})\)/;
const ATTEMPT = /API error \(attempt (\d+)\)/;
const QUOTA = /reason:QUOTA_EXHAUSTED/;
const THINKING_SIGNATURE = /messages\.\d+\.content\.\d+\.thinking\.signature: Field required|Invalid `signature` in `thinking` block/;
const PAYLOAD_LIMIT = 16_384;

/** The step index at turn start and the file identity it was read from. `index` is -1 for a new conversation. */
export interface StepMark {
  index: number;
  /** Null when the DB did not exist yet; then any file found after the turn is accepted. */
  file: { dev: number; ino: number } | null;
}

export interface TurnErrorStep {
  failure: ProviderFailure;
  /** Invalid thinking signature: the binding is tainted with `broken-history` (SR 6.5). */
  brokenHistory: boolean;
  /** `API error (attempt N)` in the step: agy's own attempt count, evidence that it retried when above 1. */
  attempt?: number;
}

export interface AgyApiError {
  status: number | null;
  /** gRPC status in upper snake case (`RESOURCE_EXHAUSTED`). */
  grpc: string | null;
  attempt: number | null;
}

/** Go's title-case status name (`ResourceExhausted`) in upper snake case. */
function upperSnake(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * The HTTP status, gRPC status and attempt number of an agy API error, in both formats agy writes:
 * `Error 429, Message: ..., Status: RESOURCE_EXHAUSTED` and agy 1.5.15's
 * `API error (attempt 8): transport error (ResourceExhausted, HTTP 429): ...: RESOURCE_EXHAUSTED (code 429): ...`.
 * Null when neither is in the text.
 */
export function parseAgyApiError(text: string): AgyApiError | null {
  const attemptText = ATTEMPT.exec(text)?.[1];
  const attempt = attemptText ? Number(attemptText) : null;
  const old = API_ERROR.exec(text);
  if (old) return { status: Number(old[1]), grpc: old[3] ?? null, attempt };
  const transport = TRANSPORT_ERROR.exec(text);
  const coded = STATUS_CODE.exec(text);
  if (!transport && !coded) return null;
  const status = transport?.[2] ? Number(transport[2]) : coded?.[2] ? Number(coded[2]) : null;
  const grpc = coded?.[1] ?? (transport?.[1] ? upperSnake(transport[1]) : null);
  return { status, grpc, attempt };
}

interface ReadOnlyDb {
  get(sql: string, ...params: unknown[]): unknown;
  close(): void;
}

function conversationPath(geminiDir: string, sessionId: string): string {
  return path.join(geminiDir, "antigravity-acp", "conversations", `${sessionId}.db`);
}

/** Null: the check is skipped. Otherwise the identity of the DB file, or null when it does not exist. */
function guardedIdentity(geminiDir: string, sessionId: string): { ok: true; file: { dev: number; ino: number } | null } | { ok: false } {
  if (!SESSION_ID.test(sessionId)) return { ok: false };
  const appDir = path.join(geminiDir, "antigravity-acp");
  const convDir = path.join(appDir, "conversations");
  for (const dir of [appDir, convDir]) {
    try {
      if (lstatSync(dir).isSymbolicLink()) return { ok: false };
    } catch {
      return { ok: true, file: null };
    }
  }
  try {
    const st = lstatSync(conversationPath(geminiDir, sessionId));
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false };
    return { ok: true, file: { dev: st.dev, ino: st.ino } };
  } catch {
    return { ok: true, file: null };
  }
}

async function openReadOnly(file: string): Promise<ReadOnlyDb> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(file, { readonly: true });
    db.run("PRAGMA busy_timeout = 100");
    return { get: (sql, ...params) => db.query(sql).get(...params), close: () => db.close() };
  }
  // Node names the option differently (`readOnly`), SR 6.5.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 100");
  return {
    get: (sql, ...params) => db.prepare(sql).get(...params.filter((p): p is number | string => typeof p === "number" || typeof p === "string")),
    close: () => db.close(),
  };
}

function hasStepsTable(db: ReadOnlyDb): boolean {
  const row = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'steps'");
  return typeof row === "object" && row !== null;
}

function numberField(row: unknown, key: string): number | null {
  if (typeof row !== "object" || row === null || !(key in row)) return null;
  const value: unknown = Reflect.get(row, key);
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function textField(row: unknown, key: string): string | null {
  if (typeof row !== "object" || row === null || !(key in row)) return null;
  const value: unknown = Reflect.get(row, key);
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

/** Step index at turn start (SR 6.5 step 1). Null: skip the check for this turn. */
export async function lastStepIndex(geminiDir: string, sessionId: string): Promise<StepMark | null> {
  const guard = guardedIdentity(geminiDir, sessionId);
  if (!guard.ok) return null;
  if (!guard.file) return { index: -1, file: null };
  let db: ReadOnlyDb | null = null;
  try {
    db = await openReadOnly(conversationPath(geminiDir, sessionId));
    if (!hasStepsTable(db)) return { index: -1, file: guard.file };
    const index = numberField(db.get("SELECT MAX(idx) AS idx FROM steps"), "idx");
    return { index: index ?? -1, file: guard.file };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Maps an error-step payload to a failure (SR 6.5 step 2). Exported for tests. */
export function classifyErrorPayload(payload: string): TurnErrorStep {
  if (QUOTA.test(payload)) return { failure: { kind: "quota_exhausted" }, brokenHistory: false };
  if (THINKING_SIGNATURE.test(payload)) {
    return { failure: { kind: "provider_error", status: 502, message: null }, brokenHistory: true };
  }
  const parsed = parseAgyApiError(payload);
  const status = parsed?.status ?? null;
  const grpc = parsed?.grpc ?? null;
  const attempt = parsed?.attempt ?? null;
  const withAttempt = (step: TurnErrorStep): TurnErrorStep => (attempt !== null ? { ...step, attempt } : step);
  // agy writes an error step after its retries failed; the proxy keeps `agyRetried` only with evidence:
  // a retry line attributed to the turn, or an attempt number above 1 in the step (review L-3).
  if (status === 429 || grpc === "RESOURCE_EXHAUSTED") {
    return withAttempt({ failure: { kind: "rate_limited", retryAfterMs: null, agyRetried: true }, brokenHistory: false });
  }
  if (status === 503 || grpc === "UNAVAILABLE") {
    return withAttempt({ failure: { kind: "capacity", model: null, retryAfterMs: null, agyRetried: true }, brokenHistory: false });
  }
  // A rejected credential: the sign-in path, never a retried 502 (N-7). The proxy's outcome hook reports it.
  if (status === 401 || grpc === "UNAUTHENTICATED") {
    return { failure: { kind: "auth_required", message: SIGNED_OUT_MESSAGE }, brokenHistory: false };
  }
  // Other 4xx keep their status, so errors.ts answers them as not retryable (N-7).
  if (status !== null && status >= 400) {
    return { failure: { kind: "provider_error", status, message: `Antigravity reported HTTP ${status} from Google.` }, brokenHistory: false };
  }
  return { failure: { kind: "provider_error", status: 502, message: null }, brokenHistory: false };
}

/**
 * After `end_turn`: the newest step after `mark.index`, when it is an error step. Null when there is
 * none or the check must be skipped (missing DB, changed schema, a different file than at turn start).
 */
export async function readTurnErrorStep(geminiDir: string, sessionId: string, mark: StepMark | null): Promise<TurnErrorStep | null> {
  if (!mark) return null;
  const guard = guardedIdentity(geminiDir, sessionId);
  if (!guard.ok || !guard.file) return null;
  if (mark.file && (mark.file.dev !== guard.file.dev || mark.file.ino !== guard.file.ino)) return null;
  let db: ReadOnlyDb | null = null;
  try {
    db = await openReadOnly(conversationPath(geminiDir, sessionId));
    if (!hasStepsTable(db)) return null;
    const row = db.get(
      `SELECT step_type, substr(step_payload, 1, ${PAYLOAD_LIMIT}) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      mark.index,
    );
    if (numberField(row, "step_type") !== ERROR_STEP_TYPE) return null;
    return classifyErrorPayload(textField(row, "payload") ?? "");
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
