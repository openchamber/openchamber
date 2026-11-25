// Per-turn silence timer, status notes and the stall decision (SR 6.3, 6.4). Runs while the turn is in
// `awaiting_model` or `streaming`; paused while OpenCode runs a tool. Retry evidence from agy's log moves
// the limit from `stallTimeoutMs` to `retryStallTimeoutMs` but never counts as activity.

import type { RuntimeConfig } from "./config.ts";
import { NOTE_PREFIX } from "./constants.ts";
import type { ProviderFailure } from "./contracts.ts";
import type { RetryEvent } from "./agy-log-tail.ts";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

class SystemTimer {
  constructor(readonly id: ReturnType<typeof setTimeout>) {}
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => new SystemTimer(setTimeout(fn, ms)),
  clearTimeout: (handle) => {
    if (handle instanceof SystemTimer) clearTimeout(handle.id);
  },
};

export interface StallWatchdogOptions {
  config: Pick<RuntimeConfig, "stallTimeoutMs" | "retryStallTimeoutMs" | "statusNoteAfterMs" | "statusNotes" | "timings">;
  clock: Clock;
  /** The turn's model id, for the capacity text when the retry line names none. */
  model: string;
  onNote(text: string): void;
  onStall(failure: ProviderFailure): void;
}

/** "20 s", "1 min 20 s", "3 min". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec === 0 ? `${min} min` : `${min} min ${sec} s`;
}

export function noteText(body: string): string {
  return `\n${NOTE_PREFIX} ${body}\n`;
}

/** Only status code, gRPC word, model id, attempt and delay go into a note (SR 6.3). */
export function retryNote(e: RetryEvent, turnModel: string): string {
  const next = `Antigravity retries on its own: attempt ${e.attempt}, next try in about ${formatElapsed(e.delayMs)}.`;
  switch (e.kind) {
    case "rate_limit":
      return noteText(`Google is rate-limiting requests (HTTP ${e.httpStatus ?? 429}). ${next}`);
    case "capacity":
      return noteText(`Google answered HTTP ${e.httpStatus ?? 503} (no capacity for ${e.model ?? turnModel}). ${next}`);
    case "stream_idle":
      return noteText(`The model stream went idle. ${next}`);
    case "other": {
      const status = [e.httpStatus !== undefined ? `HTTP ${e.httpStatus}` : null, e.grpcStatus ?? null].filter(Boolean).join(", ");
      return noteText(`The model request failed${status ? ` (${status})` : ""}. ${next}`);
    }
  }
}

export class StallWatchdog {
  private readonly opts: StallWatchdogOptions;
  private running = false;
  private lastActivity = 0;
  private lastRetry: RetryEvent | null = null;
  /** An attributed retry line arrived since the last activity. */
  private attributedRetry = false;
  private nextNoteAt = 0;
  private lastNoteAt = Number.NEGATIVE_INFINITY;
  /** A retry note that hit the 15 s gap goes out when the gap ends; a newer one replaces it. */
  private deferredNote: string | null = null;
  private timer: unknown = null;
  private expectedFireAt = 0;
  private stopped = false;

  constructor(opts: StallWatchdogOptions) {
    this.opts = opts;
  }

  /** Phase `awaiting_model`: silence starts now. */
  start(): void {
    if (this.stopped) return;
    this.running = true;
    this.markActivity(this.opts.clock.now());
    this.schedule();
  }

  /** Model progress resets silence and the note ladder. */
  activity(): void {
    if (!this.running) return;
    this.markActivity(this.opts.clock.now());
    this.schedule();
  }

  /** Retry evidence: a note and the longer limit, no reset. */
  /**
   * `attributed`: the line names this turn's model, or this was the only waiting turn. Only then does a
   * stall count as "agy already retried" (not retried by OpenCode); a guessed attribution still lengthens
   * the limit and gets the note (review L-4).
   */
  retry(e: RetryEvent, attributed = true): void {
    if (!this.running) return;
    this.lastRetry = e;
    if (attributed) this.attributedRetry = true;
    this.emitNote(retryNote(e, this.opts.model), true);
    this.schedule();
  }

  /** Parked on OpenCode: the clock stops. */
  pause(): void {
    this.running = false;
    this.clear();
  }

  /** Tool results resolved, back to `awaiting_model`. */
  resume(): void {
    this.start();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.clear();
  }

  /** Seen by tests: the silence the decision uses. */
  silenceMs(): number {
    return this.opts.clock.now() - this.lastActivity;
  }

  private markActivity(now: number): void {
    this.lastActivity = now;
    this.lastRetry = null;
    this.attributedRetry = false;
    this.deferredNote = null;
    this.nextNoteAt = now + this.opts.config.statusNoteAfterMs;
  }

  private limitMs(): number {
    return this.lastRetry ? this.opts.config.retryStallTimeoutMs : this.opts.config.stallTimeoutMs;
  }

  private clear(): void {
    if (this.timer !== null) this.opts.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clear();
    if (!this.running) return;
    const now = this.opts.clock.now();
    const { timings } = this.opts.config;
    const deadline = this.lastActivity + this.limitMs();
    let at = Math.min(deadline, now + timings.watchdogSliceMs);
    if (this.opts.config.statusNotes) at = Math.min(at, this.nextNoteAt);
    if (this.deferredNote !== null) at = Math.min(at, this.lastNoteAt + timings.noteMinGapMs);
    const delay = Math.max(0, at - now);
    this.expectedFireAt = now + delay;
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  private tick(): void {
    if (!this.running) return;
    const now = this.opts.clock.now();
    const { timings } = this.opts.config;
    if (now - this.expectedFireAt > timings.hostSleepSlackMs) {
      // The host slept through a slice: a laptop lid must not fail every turn (SR 6.4).
      this.markActivity(now);
      this.schedule();
      return;
    }
    const silence = now - this.lastActivity;
    if (silence >= this.limitMs()) {
      this.running = false;
      this.clear();
      this.opts.onStall(this.failure(silence));
      return;
    }
    if (this.deferredNote !== null && now - this.lastNoteAt >= timings.noteMinGapMs) {
      const text = this.deferredNote;
      this.deferredNote = null;
      this.emitNote(text);
    }
    if (this.opts.config.statusNotes && now >= this.nextNoteAt) {
      const first = this.nextNoteAt === this.lastActivity + this.opts.config.statusNoteAfterMs;
      this.emitNote(
        noteText(first ? `Waiting for the model. No output for ${formatElapsed(silence)}.` : `Still waiting. No output for ${formatElapsed(silence)}.`),
      );
      this.nextNoteAt += timings.noteRepeatMs;
    }
    this.schedule();
  }

  private emitNote(text: string, deferIfBusy = false): void {
    if (!this.opts.config.statusNotes) return;
    const now = this.opts.clock.now();
    if (now - this.lastNoteAt < this.opts.config.timings.noteMinGapMs) {
      if (deferIfBusy) this.deferredNote = text;
      return;
    }
    this.lastNoteAt = now;
    this.opts.onNote(text);
  }

  private failure(silenceMs: number): ProviderFailure {
    const retry = this.lastRetry;
    if (!retry) return { kind: "stalled", silenceMs };
    switch (retry.kind) {
      // agy logged its own retries before going silent: OpenCode must not start another round of them.
      case "rate_limit":
        return this.attributedRetry
          ? { kind: "rate_limited", retryAfterMs: retry.delayMs, agyRetried: true }
          : { kind: "rate_limited", retryAfterMs: retry.delayMs };
      case "capacity": {
        const model = retry.model ?? this.opts.model;
        return this.attributedRetry
          ? { kind: "capacity", model, retryAfterMs: retry.delayMs, agyRetried: true }
          : { kind: "capacity", model, retryAfterMs: retry.delayMs };
      }
      case "stream_idle":
        return { kind: "stalled", silenceMs };
      case "other":
        return {
          kind: "provider_error",
          status: retry.httpStatus !== undefined && retry.httpStatus >= 500 ? retry.httpStatus : 503,
          message: `Antigravity kept retrying the model request for ${formatElapsed(silenceMs)}, so the turn was cancelled.`,
        };
    }
  }
}
