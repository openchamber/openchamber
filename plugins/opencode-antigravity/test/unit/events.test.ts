import { afterEach, describe, expect, test } from "bun:test";
import { runEventLoop, type EventSubscriber, type OpenCodeEventLike, type PoolHandlers } from "../../src/events.ts";
import { SYSTEM, startHarness, user, waitFor, type Harness } from "../fixtures/proxy-harness.ts";

/** OpenCode 2.3.0's shape: `subscribe(options)` returns an AsyncIterable; payload in `data`. */
class FakeEvents implements EventSubscriber {
  readonly subscriptions: Array<{ types: string[] }> = [];
  private readonly queues: Array<{ push: (e: OpenCodeEventLike) => void }> = [];

  subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<OpenCodeEventLike> {
    this.subscriptions.push({ types: options.types });
    const buffer: OpenCodeEventLike[] = [];
    let wake: (() => void) | null = null;
    this.queues.push({
      push: (e) => {
        buffer.push(e);
        wake?.();
      },
    });
    const { signal } = options;
    return {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = buffer.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
        }
      },
    };
  }

  emit(e: OpenCodeEventLike): void {
    for (const q of this.queues) q.push(e);
  }
}

function recorder(): PoolHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onSessionInterrupted: (id) => calls.push(`interrupted:${id}`),
    onSessionDeleted: (id) => calls.push(`deleted:${id}`),
  };
}

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

describe("runEventLoop", () => {
  test("subscribes with types and a signal; routes by type with sessionID from data", async () => {
    const events = new FakeEvents();
    const pool = recorder();
    const controller = new AbortController();
    const loop = runEventLoop(events, pool, controller.signal);
    events.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } });
    events.emit({ type: "session.execution.failed", data: { sessionID: "ses_2" } });
    events.emit({ type: "session.deleted", data: { sessionID: "ses_3" } });
    events.emit({ type: "session.deleted", data: {} });
    events.emit({ type: "session.updated", data: { sessionID: "ses_4" } });
    await waitFor(() => pool.calls.length >= 3);
    controller.abort();
    await loop;
    expect(events.subscriptions[0]?.types).toEqual(["session.deleted", "session.execution.interrupted", "session.execution.failed"]);
    expect(pool.calls).toEqual(["interrupted:ses_1", "interrupted:ses_2", "deleted:ses_3"]);
  });

  test("aborting the signal ends the loop; no subscriber is a no-op", async () => {
    const events = new FakeEvents();
    const controller = new AbortController();
    const loop = runEventLoop(events, recorder(), controller.signal);
    controller.abort();
    await loop;
    await runEventLoop(undefined, recorder(), new AbortController().signal);
  });

  test("a stream that throws ends the loop without throwing", async () => {
    const broken: EventSubscriber = {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("stream closed")) }),
      }),
    };
    const logs: string[] = [];
    await runEventLoop(broken, recorder(), new AbortController().signal, (m) => logs.push(m));
    expect(logs).toEqual(["event loop ended (Error)"]);
  });

  test("the same interrupt from two loops cancels the live turn once", async () => {
    const h = await startHarness({ scenario: "stall" });
    open.push(h);
    const events = new FakeEvents();
    const a = new AbortController();
    const b = new AbortController();
    const loops = [runEventLoop(events, h.proxy, a.signal), runEventLoop(events, h.proxy, b.signal)];
    const pending = h.chat({ messages: [SYSTEM, user("hi")], session: "ses_ev" });
    await waitFor(() => h.methods().includes("session/prompt"));
    events.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_ev" } });
    await pending;
    await new Promise((r) => setTimeout(r, 100));
    expect(h.methods().filter((m) => m === "session/cancel")).toHaveLength(1);
    a.abort();
    b.abort();
    await Promise.all(loops);
  });

  test("session.deleted deletes the record once", async () => {
    const h = await startHarness();
    open.push(h);
    await h.chat({ messages: [SYSTEM, user("hi")], session: "ses_del" });
    await waitFor(() => h.modules.store.records.has("ses_del"));
    const events = new FakeEvents();
    const a = new AbortController();
    const b = new AbortController();
    const loops = [runEventLoop(events, h.proxy, a.signal), runEventLoop(events, h.proxy, b.signal)];
    events.emit({ type: "session.deleted", data: { sessionID: "ses_del" } });
    await waitFor(() => !h.modules.store.records.has("ses_del"));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.modules.store.calls.remove).toBe(1);
    await waitFor(() => h.methods().includes("session/close"));
    a.abort();
    b.abort();
    await Promise.all(loops);
  });
});
