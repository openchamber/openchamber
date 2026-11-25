// OpenCode session event loop (SR 8.3). OpenCode 2.3.0's `ctx.event.subscribe(options)` returns an
// AsyncIterable and each event carries its payload in `data`; the prototype's callback form with
// `event.properties` never fired. `setup()` runs once per OpenCode location, so several loops deliver
// the same event: the pool handlers are idempotent.

export const SESSION_EVENT_TYPES = ["session.deleted", "session.execution.interrupted", "session.execution.failed"] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export interface OpenCodeEventLike {
  type: string;
  data?: unknown;
}

/** The part of `ctx.event` this module uses (`@opencode/plugin` 2.3.0 `promise/event.d.ts`). */
export interface EventSubscriber {
  subscribe(options: { types: SessionEventType[]; signal: AbortSignal }): AsyncIterable<OpenCodeEventLike>;
}

export interface PoolHandlers {
  /** `session.execution.interrupted` and `session.execution.failed`: cancel a live turn, once. */
  onSessionInterrupted(sessionId: string): void;
  /** `session.deleted`: delete the binding, once. */
  onSessionDeleted(sessionId: string): void;
}

function sessionIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("sessionID" in data)) return null;
  const id: unknown = data.sessionID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Runs until `signal` aborts or the stream ends. Never throws: a broken stream is logged (metadata
 * only) and the loop ends; the next `setup()` starts a new one.
 */
export async function runEventLoop(
  events: EventSubscriber | undefined,
  pool: PoolHandlers,
  signal: AbortSignal,
  log: (message: string) => void = () => {},
): Promise<void> {
  if (!events || signal.aborted) return;
  try {
    for await (const event of events.subscribe({ types: [...SESSION_EVENT_TYPES], signal })) {
      if (signal.aborted) break;
      const id = sessionIdOf(event.data);
      if (!id) continue;
      if (event.type === "session.deleted") pool.onSessionDeleted(id);
      else if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed") pool.onSessionInterrupted(id);
    }
  } catch (err) {
    if (!signal.aborted) log(`event loop ended (${err instanceof Error ? err.name : "error"})`);
  }
}
