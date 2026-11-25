// Follows the `--log-file` of one agy generation for retry lines (SR 6.2). Polls with fs.stat while a
// turn waits on the model; no fs.watch (unreliable on macOS for appends). Only parsed fields are kept,
// never the raw line, which can carry request details or the account email.

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Clock } from "./stall-watchdog.ts";

export type RetryKind = "rate_limit" | "capacity" | "stream_idle" | "other";

export interface RetryEvent {
  /** `clock.now()` when the line was read; glog stamps carry no year or zone. */
  at: number;
  attempt: number;
  delayMs: number;
  httpStatus?: number;
  grpcStatus?: string;
  model?: string;
  kind: RetryKind;
}

const RETRY_LINE =
  /\] Run: attempt (\d+) failed \((.*)\), retrying in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+)\s*$/;
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g;
const DURATION_FULL = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3, // U+00B5
  "μs": 1e-3, // U+03BC
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};
const GRPC_STATUSES = [
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "UNKNOWN",
  "ABORTED",
  "CANCELLED",
  "FAILED_PRECONDITION",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
];

/** Go `time.Duration.String()` text to milliseconds, rounded: "1m0.104941814s" gives 60105. */
export function parseGoDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!DURATION_FULL.test(trimmed)) return null;
  let total = 0;
  for (const m of trimmed.matchAll(DURATION_PART)) {
    const unit = UNIT_MS[m[2] ?? ""];
    if (unit === undefined) return null;
    total += Number(m[1]) * unit;
  }
  return Math.round(total);
}

function grpcStatusOf(reason: string): string | undefined {
  const upper = reason.toUpperCase();
  for (const status of GRPC_STATUSES) if (upper.includes(status)) return status;
  // agy writes `(Unavailable, HTTP 503)`: Go's status names in title case.
  const titled = /\((Unavailable|ResourceExhausted|DeadlineExceeded|Internal)\b/.exec(reason)?.[1];
  if (titled === "Unavailable") return "UNAVAILABLE";
  if (titled === "ResourceExhausted") return "RESOURCE_EXHAUSTED";
  if (titled === "DeadlineExceeded") return "DEADLINE_EXCEEDED";
  if (titled === "Internal") return "INTERNAL";
  return undefined;
}

export function parseRetryLine(line: string, now: number = Date.now()): RetryEvent | null {
  const m = RETRY_LINE.exec(line);
  if (!m) return null;
  const attempt = Number(m[1]);
  const reason = m[2] ?? "";
  const delayMs = parseGoDuration(m[3] ?? "");
  if (!Number.isFinite(attempt) || delayMs === null) return null;

  const statusText = /HTTP (\d{3})/.exec(reason)?.[1] ?? /code (\d{3})/.exec(reason)?.[1];
  const httpStatus = statusText ? Number(statusText) : undefined;
  const grpcStatus = grpcStatusOf(reason);
  // Trailing dots or dashes are punctuation, never part of the id.
  const model = /for model ([\w.-]+)/.exec(reason)?.[1]?.replace(/[.-]+$/, "");

  let kind: RetryKind = "other";
  if (/stream idle timeout/i.test(reason)) kind = "stream_idle";
  else if (httpStatus === 429 || grpcStatus === "RESOURCE_EXHAUSTED") kind = "rate_limit";
  else if (httpStatus === 503 || /No capacity available/i.test(reason)) kind = "capacity";

  const event: RetryEvent = { at: now, attempt, delayMs, kind };
  if (httpStatus !== undefined) event.httpStatus = httpStatus;
  if (grpcStatus !== undefined) event.grpcStatus = grpcStatus;
  if (model) event.model = model;
  return event;
}

export interface AgyLogTailOptions {
  file: string;
  clock: Clock;
  pollMs: number;
  onRetry: (event: RetryEvent) => void;
}

/** Longest partial line kept between polls; a longer line is dropped (it is never a retry line). */
const MAX_PARTIAL = 64 * 1024;
const READ_CHUNK = 64 * 1024;

export class AgyLogTail {
  private readonly opts: AgyLogTailOptions;
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  private timer: unknown = null;
  private active = false;
  private stopped = false;

  constructor(opts: AgyLogTailOptions) {
    this.opts = opts;
  }

  /** Polls while true. Turning it on skips bytes written while no turn waited, so old retries never count. */
  setActive(active: boolean): void {
    if (this.stopped || active === this.active) return;
    this.active = active;
    if (active) {
      this.offset = this.currentSize() ?? 0;
      this.partial = "";
      this.decoder = new StringDecoder("utf8");
      this.schedule();
    } else if (this.timer !== null) {
      this.opts.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.setActive(false);
    this.stopped = true;
  }

  /** Reads what was appended since the last poll. Exposed for tests; the timer calls it. */
  poll(): void {
    let fd: number | null = null;
    try {
      fd = openSync(this.opts.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // Truncated or replaced: start over.
        this.offset = 0;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
      }
      const buffer = Buffer.alloc(READ_CHUNK);
      while (this.offset < size) {
        const n = readSync(fd, buffer, 0, Math.min(READ_CHUNK, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.consume(this.decoder.write(buffer.subarray(0, n)));
      }
    } catch {
      // Missing file or a changed format: the watchdog still works on silence alone.
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  private consume(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    if (this.partial.length > MAX_PARTIAL) this.partial = "";
    for (const line of lines) {
      const event = parseRetryLine(line, this.opts.clock.now());
      if (event) this.opts.onRetry(event);
    }
  }

  private currentSize(): number | null {
    try {
      return statSync(this.opts.file).size;
    } catch {
      return null;
    }
  }

  private schedule(): void {
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = null;
      if (!this.active) return;
      this.poll();
      if (this.active) this.schedule();
    }, this.opts.pollMs);
  }
}
