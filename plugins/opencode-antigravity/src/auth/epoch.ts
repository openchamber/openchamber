// Auth epoch counter file `<data>/auth-epoch` (IA 13.4). A decimal counter, bumped on login, logout
// and account change. Other OpenCode processes see a bump within `rereadMs`.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../install/fs-utils.ts";

export interface AuthEpochOptions {
  /** `read()` re-reads the file at most this often. Default 1000. */
  rereadMs?: number;
  now?: () => number;
}

export class AuthEpoch {
  private readonly file: string;
  private readonly rereadMs: number;
  private readonly now: () => number;
  private cached: string;
  private readAt: number;
  private readonly listeners = new Set<(epoch: string) => void>();

  constructor(file: string, opts: AuthEpochOptions = {}) {
    this.file = file;
    this.rereadMs = opts.rereadMs ?? 1_000;
    this.now = opts.now ?? Date.now;
    this.cached = this.readFile();
    this.readAt = this.now();
  }

  /** The cached value; re-reads the file when the cache is older than `rereadMs`. */
  read(): string {
    if (this.now() - this.readAt >= this.rereadMs) this.refresh();
    return this.cached;
  }

  /**
   * Reads the file now. A value written by another process notifies `onExternalChange` in a microtask,
   * never inside this call: callers read the epoch in the middle of their own work (the proxy does it
   * under its session mutex), and a listener that runs there would change state under them.
   */
  refresh(): string {
    const value = this.readFile();
    this.readAt = this.now();
    if (value !== this.cached) {
      this.cached = value;
      queueMicrotask(() => {
        if (this.cached !== value) return; // superseded by a later change or our own bump
        for (const listener of [...this.listeners]) listener(value);
      });
    }
    return this.cached;
  }

  /** Increments the file's value and writes it by temp file and rename. The caller holds the auth lock. */
  async bump(): Promise<string> {
    const current = BigInt(this.readFile());
    const next = (current + 1n).toString();
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, `${next}\n`, { mode: 0o600 });
    this.cached = next;
    this.readAt = this.now();
    return next;
  }

  /** Called when `read()` or `refresh()` sees a value this instance did not write. */
  onExternalChange(listener: (epoch: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readFile(): string {
    try {
      const text = readFileSync(this.file, "utf8").trim();
      return /^\d{1,30}$/.test(text) ? BigInt(text).toString() : "0";
    } catch {
      return "0";
    }
  }
}
