// Manual clock for timer tests: `advance(ms)` fires due timers in order, so 20 s, 180 s or 10 min
// timers run in microseconds.

import type { Clock } from "../../src/stall-watchdog.ts";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private nowMs: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start = 1_000_000) {
    this.nowMs = start;
  }

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: Timer = { id: this.nextId++, at: this.nowMs + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Moves time forward, firing every timer due on the way (including ones scheduled meanwhile). */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.nowMs = Math.max(this.nowMs, due.at);
      due.fn();
    }
    this.nowMs = target;
  }

  /** Jumps without firing anything, like a host that slept; the next `advance` fires late timers. */
  jump(ms: number): void {
    this.nowMs += ms;
  }

  /** Lets promise callbacks run between timer steps. */
  async flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}
