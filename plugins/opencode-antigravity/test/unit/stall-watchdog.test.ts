import { describe, expect, test } from "bun:test";
import type { RetryEvent } from "../../src/agy-log-tail.ts";
import { resolveRuntimeConfig } from "../../src/config.ts";
import type { ProviderFailure } from "../../src/contracts.ts";
import { formatElapsed, StallWatchdog } from "../../src/stall-watchdog.ts";
import { FakeClock } from "../fixtures/fake-clock.ts";

// Production defaults (20 s note, 60 s repeat, 180 s stall, 300 s with retries), on a fake clock.
function setup(options: Record<string, unknown> = {}) {
  const { config } = resolveRuntimeConfig(options, {});
  const clock = new FakeClock();
  const notes: Array<{ at: number; text: string }> = [];
  const stalls: Array<{ at: number; failure: ProviderFailure }> = [];
  const start = clock.now();
  const dog = new StallWatchdog({
    config,
    clock,
    model: "gemini-4-neon",
    onNote: (text) => notes.push({ at: clock.now() - start, text }),
    onStall: (failure) => stalls.push({ at: clock.now() - start, failure }),
  });
  return { clock, dog, notes, stalls };
}

const capacity = (at: number): RetryEvent => ({ at, attempt: 3, delayMs: 60_000, httpStatus: 503, grpcStatus: "UNAVAILABLE", model: "gemini-4-neon-high", kind: "capacity" });

describe("StallWatchdog", () => {
  test("note at 20 s, repeat at 80 s, stall at 180 s with 504", () => {
    const { clock, dog, notes, stalls } = setup();
    dog.start();
    clock.advance(19_999);
    expect(notes).toHaveLength(0);
    clock.advance(1);
    expect(notes[0]?.at).toBe(20_000);
    expect(notes[0]?.text).toBe("\n[Antigravity] Waiting for the model. No output for 20 s.\n");
    clock.advance(60_000);
    expect(notes[1]?.at).toBe(80_000);
    expect(notes[1]?.text).toContain("Still waiting. No output for 1 min 20 s.");
    clock.advance(100_000 - 1);
    expect(stalls).toHaveLength(0);
    clock.advance(1);
    expect(stalls).toEqual([{ at: 180_000, failure: { kind: "stalled", silenceMs: 180_000 } }]);
    clock.advance(600_000);
    expect(stalls).toHaveLength(1);
  });

  test("retry evidence moves the limit to 300 s and the failure to the retry kind", () => {
    const { clock, dog, notes, stalls } = setup();
    dog.start();
    clock.advance(30_000);
    dog.retry(capacity(clock.now()));
    clock.advance(5_000); // the 20 s note went out 10 s ago: the retry note waits for the 15 s gap
    expect(notes.at(-1)?.at).toBe(35_000);
    expect(notes.at(-1)?.text).toBe(
      "\n[Antigravity] Google answered HTTP 503 (no capacity for gemini-4-neon-high). Antigravity retries on its own: attempt 3, next try in about 1 min.\n",
    );
    clock.advance(145_000); // 180 s of silence: no stall with evidence
    expect(stalls).toHaveLength(0);
    clock.advance(120_000);
    expect(stalls).toEqual([{ at: 300_000, failure: { kind: "capacity", model: "gemini-4-neon-high", retryAfterMs: 60_000, agyRetried: true } }]);
  });

  test("a retry line attributed by guess lengthens the limit but leaves the stall retryable (review L-4)", () => {
    const { clock, dog, stalls } = setup();
    dog.start();
    dog.retry(capacity(clock.now()), false);
    clock.advance(300_000);
    expect(stalls[0]?.failure).toEqual({ kind: "capacity", model: "gemini-4-neon-high", retryAfterMs: 60_000 });
  });

  test("rate-limit evidence stalls with 429", () => {
    const { clock, dog, stalls } = setup();
    dog.start();
    dog.retry({ at: clock.now(), attempt: 2, delayMs: 20_000, httpStatus: 429, kind: "rate_limit" });
    clock.advance(300_000);
    expect(stalls[0]?.failure).toEqual({ kind: "rate_limited", retryAfterMs: 20_000, agyRetried: true });
  });

  test("activity resets silence and the evidence", () => {
    const { clock, dog, stalls, notes } = setup();
    dog.start();
    clock.advance(170_000);
    dog.retry(capacity(clock.now()));
    dog.activity();
    clock.advance(179_999);
    expect(stalls).toHaveLength(0);
    clock.advance(1);
    expect(stalls[0]?.failure.kind).toBe("stalled");
    expect(notes.filter((n) => n.text.includes("Waiting for the model")).length).toBe(2);
  });

  test("pause while parked stops the clock; resume starts silence over", () => {
    const { clock, dog, stalls, notes } = setup();
    dog.start();
    clock.advance(100_000);
    dog.pause();
    clock.advance(3_600_000);
    expect(stalls).toHaveLength(0);
    const before = notes.length;
    dog.resume();
    clock.advance(179_000);
    expect(stalls).toHaveLength(0);
    expect(notes.length).toBeGreaterThan(before);
    clock.advance(1_000);
    expect(stalls).toHaveLength(1);
  });

  test("a 75 s gap in a 60 s slice counts as host sleep", () => {
    const { clock, dog, stalls } = setup();
    dog.start();
    clock.advance(50_000);
    clock.jump(200_000); // the laptop lid: no timer fired for 200 s
    clock.advance(0);
    expect(stalls).toHaveLength(0);
    clock.advance(179_999);
    expect(stalls).toHaveLength(0);
    clock.advance(1);
    expect(stalls).toHaveLength(1);
  });

  test("at most one note per 15 s; a blocked retry note goes out when the gap ends", () => {
    const { clock, dog, notes } = setup();
    dog.start();
    clock.advance(20_000);
    dog.retry(capacity(clock.now()));
    expect(notes).toHaveLength(1);
    clock.advance(10_000);
    dog.retry({ ...capacity(clock.now()), attempt: 4 });
    expect(notes).toHaveLength(1);
    clock.advance(4_999);
    expect(notes).toHaveLength(1);
    clock.advance(1);
    expect(notes.map((n) => n.at)).toEqual([20_000, 35_000]);
    expect(notes[1]?.text).toContain("attempt 4");
  });

  test("statusNotes false: no notes, same stall decision", () => {
    const { clock, dog, notes, stalls } = setup({ statusNotes: false });
    dog.start();
    clock.advance(180_000);
    expect(notes).toHaveLength(0);
    expect(stalls).toHaveLength(1);
  });

  test("a stopped watchdog never fires", () => {
    const { clock, dog, notes, stalls } = setup();
    dog.start();
    dog.stop();
    dog.start();
    clock.advance(1_000_000);
    expect(notes).toHaveLength(0);
    expect(stalls).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  test("formatElapsed", () => {
    expect(formatElapsed(20_000)).toBe("20 s");
    expect(formatElapsed(80_000)).toBe("1 min 20 s");
    expect(formatElapsed(180_000)).toBe("3 min");
  });
});
