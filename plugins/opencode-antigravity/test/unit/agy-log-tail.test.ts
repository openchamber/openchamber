import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgyLogTail, parseGoDuration, parseRetryLine, type RetryEvent } from "../../src/agy-log-tail.ts";
import { FakeClock } from "../fixtures/fake-clock.ts";

// Real formats from T3 Code's agy profile logs (SR 1).
const ATTEMPT_1 =
  "I1124 10:09:02.372424  669 run.go:308] Run: attempt 1 failed (transport error (Unavailable, HTTP 503): No capacity available for model gemini-4-hydrogen-xhigh on the server: x), retrying in 4s";
const ATTEMPT_2 =
  "I1124 10:09:02.372424  669 run.go:308] Run: attempt 2 failed (transport error (Unavailable, HTTP 503): No capacity available for model gemini-4-hydrogen-xhigh on the server: ...), retrying in 1m0.104941814s";
const STREAM_IDLE = "I1124 10:19:02.000001  669 run.go:308] Run: attempt 1 failed (stream idle timeout (10m0s)), retrying in 3.5s";
const RATE_LIMIT =
  "I1124 10:09:02.372424  669 run.go:308] Run: attempt 2 failed (rpc error: code = ResourceExhausted desc = RESOURCE_EXHAUSTED (code 429) for model gemini-4-neon-high.), retrying in 20s";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

describe("parseGoDuration", () => {
  test("Go duration strings", () => {
    expect(parseGoDuration("4s")).toBe(4000);
    expect(parseGoDuration("1m0.104941814s")).toBe(60105);
    expect(parseGoDuration("57.16798293s")).toBe(57168);
    expect(parseGoDuration("10m0s")).toBe(600_000);
    expect(parseGoDuration("1h2m")).toBe(3_720_000);
    expect(parseGoDuration("250ms")).toBe(250);
    expect(parseGoDuration("1500µs")).toBe(2); // U+00B5
    expect(parseGoDuration("1500μs")).toBe(2); // U+03BC
    expect(parseGoDuration("soon")).toBeNull();
    expect(parseGoDuration("4 s")).toBeNull();
  });
});

describe("parseRetryLine", () => {
  test("agy 1.5.15's 429 retry line from browser run 2 is a rate limit", () => {
    const line =
      "I1125 11:47:31.426033     458 run.go:308] Run: attempt 1 failed (transport error (ResourceExhausted, HTTP 429): Resource has been exhausted (e.g. check quota).: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).), retrying in 4s";
    expect(parseRetryLine(line, 5)).toEqual({ at: 5, attempt: 1, delayMs: 4000, kind: "rate_limit", httpStatus: 429, grpcStatus: "RESOURCE_EXHAUSTED" });
  });

  test("attempt 1 with 4s", () => {
    const e = parseRetryLine(ATTEMPT_1, 5);
    expect(e).toEqual({ at: 5, attempt: 1, delayMs: 4000, httpStatus: 503, grpcStatus: "UNAVAILABLE", model: "gemini-4-hydrogen-xhigh", kind: "capacity" });
  });

  test("attempt 2 with a long Go duration", () => {
    const e = parseRetryLine(ATTEMPT_2);
    expect(e?.attempt).toBe(2);
    expect(e?.delayMs).toBe(60105);
    expect(e?.model).toBe("gemini-4-hydrogen-xhigh");
  });

  test("stream idle timeout", () => {
    const e = parseRetryLine(STREAM_IDLE);
    expect(e?.kind).toBe("stream_idle");
    expect(e?.delayMs).toBe(3500);
    expect(e?.model).toBeUndefined();
  });

  test("rate limit, trailing punctuation never in the model", () => {
    const e = parseRetryLine(RATE_LIMIT);
    expect(e?.kind).toBe("rate_limit");
    expect(e?.httpStatus).toBe(429);
    expect(e?.grpcStatus).toBe("RESOURCE_EXHAUSTED");
    expect(e?.model).toBe("gemini-4-neon-high");
  });

  test("other lines yield null, the email line included", () => {
    expect(parseRetryLine("I1124 10:09:02.1 669 auth.go:12] applyAuthResult: email=someone@example.com")).toBeNull();
    expect(parseRetryLine("")).toBeNull();
    expect(parseRetryLine("Run: attempt 2 failed (x), retrying in 4s")).toBeNull();
  });

  test("never keeps the raw line", () => {
    const e = parseRetryLine(ATTEMPT_1);
    expect(JSON.stringify(e)).not.toContain("on the server");
  });
});

describe("AgyLogTail", () => {
  function setup(): { file: string; clock: FakeClock; events: RetryEvent[]; tail: AgyLogTail } {
    const dir = mkdtempSync(path.join(tmpdir(), "agy-tail-"));
    dirs.push(dir);
    const file = path.join(dir, "opencode.log");
    const clock = new FakeClock();
    const events: RetryEvent[] = [];
    const tail = new AgyLogTail({ file, clock, pollMs: 1000, onRetry: (e) => events.push(e) });
    return { file, clock, events, tail };
  }

  test("reads only bytes appended after activation, polling once per interval", () => {
    const { file, clock, events, tail } = setup();
    writeFileSync(file, `${ATTEMPT_1}\n`);
    tail.setActive(true);
    clock.advance(1000);
    expect(events).toHaveLength(0);
    appendFileSync(file, `${ATTEMPT_2}\nunrelated line\n`);
    clock.advance(999);
    expect(events).toHaveLength(0);
    clock.advance(1);
    expect(events.map((e) => e.attempt)).toEqual([2]);
    clock.advance(5000);
    expect(events).toHaveLength(1);
    tail.stop();
  });

  test("a line split across two polls is parsed once", () => {
    const { file, clock, events, tail } = setup();
    writeFileSync(file, "");
    tail.setActive(true);
    appendFileSync(file, ATTEMPT_2.slice(0, 40));
    clock.advance(1000);
    appendFileSync(file, `${ATTEMPT_2.slice(40)}\n`);
    clock.advance(1000);
    expect(events).toHaveLength(1);
    tail.stop();
  });

  test("survives truncation and a missing file", () => {
    const { file, clock, events, tail } = setup();
    tail.setActive(true);
    clock.advance(3000); // missing file: nothing, no throw
    writeFileSync(file, `${"x".repeat(500)}\n`);
    clock.advance(1000);
    writeFileSync(file, `${ATTEMPT_1}\n`); // shorter than the offset: truncated
    clock.advance(1000);
    expect(events.map((e) => e.attempt)).toEqual([1]);
    tail.stop();
  });

  test("stops polling while inactive", () => {
    const { file, clock, tail } = setup();
    writeFileSync(file, "");
    tail.setActive(true);
    tail.setActive(false);
    expect(clock.pending).toBe(0);
    tail.stop();
  });
});
