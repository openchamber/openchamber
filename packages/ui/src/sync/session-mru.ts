/**
 * Session most-recently-used (MRU) tracker.
 *
 * Records the order in which sessions were active so keyboard shortcuts
 * (`cycle_session_mru_forward` / `cycle_session_mru_backward`) can switch
 * between them like browser tab cycling.
 *
 * Cycling model:
 * - `recordActiveSession(id)` is called whenever the active session changes
 *   (from any source — sidebar click, URL navigation, etc.). The previous
 *   active session is pushed to the top of the MRU stack.
 * - `cycle(direction)` returns the next session ID to switch to, walking
 *   the MRU stack without mutating it. A snapshot is taken on the first
 *   cycle call after a reset so successive presses walk a stable list.
 * - The cursor resets (committing the cycle) after `CURSOR_RESET_MS` of
 *   inactivity, or when `recordActiveSession` is called from outside the
 *   cycle (e.g., the user clicks a session in the sidebar mid-cycle).
 *
 * The tracker is framework-agnostic and does not know whether sessions
 * still exist. Callers must validate returned IDs against the live session
 * map (see `getAllSyncSessionMap` from `./sync-refs`) and call
 * `removeSession` for any IDs that are gone.
 */

const MAX_MRU_SIZE = 50;
const CURSOR_RESET_MS = 1500;

export type CycleDirection = 1 | -1;

class SessionMRU {
  private stack: string[] = [];
  private cyclingStack: string[] | null = null;
  private cursor: number = -1;
  private cursorResetTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSessionId: string | null = null;
  private cycleStartSessionId: string | null = null;

  recordActiveSession(sessionId: string | null): void {
    if (sessionId === this.currentSessionId) {
      return;
    }

    // If a cycle is in progress and the new session is the one the cycle
    // pointed at, this is the cycle-induced switch — update currentSessionId
    // but don't disturb the stack snapshot.
    if (
      this.cyclingStack !== null
      && this.cursor !== -1
      && sessionId !== null
      && this.cyclingStack[this.cursor] === sessionId
    ) {
      this.currentSessionId = sessionId;
      return;
    }

    // Any other active-session change commits the cycle and starts fresh.
    if (this.cyclingStack !== null) {
      this.commitCycle();
    }

    const previous = this.currentSessionId;
    this.currentSessionId = sessionId;

    if (previous && previous !== sessionId) {
      this.stack = this.stack.filter((id) => id !== previous);
      this.stack.unshift(previous);
    }
    if (sessionId) {
      this.stack = this.stack.filter((id) => id !== sessionId);
    }
    if (this.stack.length > MAX_MRU_SIZE) {
      this.stack.length = MAX_MRU_SIZE;
    }
    this.resetCursor();
  }

  cycle(direction: CycleDirection): string | null {
    if (this.cyclingStack === null) {
      this.cyclingStack = this.stack.filter((id) => id !== this.currentSessionId);
      this.cursor = -1;
      this.cycleStartSessionId = this.currentSessionId;
    }
    if (this.cyclingStack.length === 0) {
      return null;
    }

    const nextCursor = this.cursor === -1
      ? (direction === 1 ? 0 : this.cyclingStack.length - 1)
      : (this.cursor + direction + this.cyclingStack.length) % this.cyclingStack.length;

    this.cursor = nextCursor;
    this.armCursorReset();
    return this.cyclingStack[nextCursor] ?? null;
  }

  /**
   * Seed the MRU stack from a fallback list when the stack is empty.
   * Called by the keyboard handler before cycling so that Ctrl+Tab works
   * on a fresh app launch (before any sessions have been switched).
   *
   * `sessions` should be ordered most-recent-first (e.g., by `time.updated`
   * descending). The current session and archived sessions should already
   * be filtered out by the caller.
   */
  seedIfEmpty(sessions: string[]): void {
    if (this.stack.length > 0) {
      return;
    }
    this.stack = sessions.slice(0, MAX_MRU_SIZE);
  }

  removeSession(sessionId: string): void {
    this.stack = this.stack.filter((id) => id !== sessionId);
    if (this.cyclingStack) {
      const cyclingNext = this.cyclingStack.filter((id) => id !== sessionId);
      if (cyclingNext.length !== this.cyclingStack.length) {
        // Snapshot changed; reset the cycle so the next call takes a fresh snapshot.
        this.cyclingStack = null;
        this.cursor = -1;
        this.cycleStartSessionId = null;
        if (this.cursorResetTimer) {
          clearTimeout(this.cursorResetTimer);
          this.cursorResetTimer = null;
        }
      } else {
        this.cyclingStack = cyclingNext;
      }
    }
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
  }

  resetCursor(): void {
    if (this.cursorResetTimer) {
      clearTimeout(this.cursorResetTimer);
      this.cursorResetTimer = null;
    }
    if (this.cyclingStack !== null) {
      this.commitCycle();
      return;
    }
    this.cursor = -1;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** Snapshot for debugging/tests. Order: most-recent first. */
  getStackSnapshot(): string[] {
    return [...this.stack];
  }

  /** Whether a cycle is in progress. Exposed for tests. */
  isCycling(): boolean {
    return this.cyclingStack !== null;
  }

  private commitCycle(): void {
    if (this.cyclingStack === null) {
      return;
    }
    if (this.cursor !== -1) {
      const landedSessionId = this.cyclingStack[this.cursor];
      // Use cycleStartSessionId (the session that was active when cycling
      // began) — not currentSessionId, which has been updated during the cycle.
      const previousCurrent = this.cycleStartSessionId;

      this.stack = this.stack.filter((id) => id !== landedSessionId);

      if (previousCurrent && previousCurrent !== landedSessionId) {
        this.stack = this.stack.filter((id) => id !== previousCurrent);
        this.stack.unshift(previousCurrent);
      }
      if (this.stack.length > MAX_MRU_SIZE) {
        this.stack.length = MAX_MRU_SIZE;
      }
    }
    this.cyclingStack = null;
    this.cursor = -1;
    this.cycleStartSessionId = null;
    if (this.cursorResetTimer) {
      clearTimeout(this.cursorResetTimer);
      this.cursorResetTimer = null;
    }
  }

  private armCursorReset(): void {
    if (this.cursorResetTimer) {
      clearTimeout(this.cursorResetTimer);
    }
    this.cursorResetTimer = setTimeout(() => {
      this.cursorResetTimer = null;
      this.commitCycle();
    }, CURSOR_RESET_MS);
  }
}

export const sessionMRU = new SessionMRU();
