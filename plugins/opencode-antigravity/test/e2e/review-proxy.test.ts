// Cases from docs/review-impl.opus.md (O-*) and docs/review-impl.neon.md (N-*) for src/proxy.ts and
// src/turn.ts. Each test fails on the code before its fix (docs/review-response-proxy.md).

import { afterEach, describe, expect, test } from "bun:test";
import { resolveRuntimeConfig } from "../../src/config.ts";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { Turn, type EmittedCall, type TurnHooks, type TurnSink } from "../../src/turn.ts";
import { FakeClock } from "../fixtures/fake-clock.ts";
import { SYSTEM, sleep, startHarness, toolRound, user, waitFor, type Harness, type HarnessOptions } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function harness(opts: HarnessOptions): Promise<Harness> {
  const h = await startHarness(opts);
  open.push(h);
  return h;
}

function count(h: Harness, method: string): number {
  return h.methods().filter((m) => m === method).length;
}

describe("review findings, proxy side", () => {
  test("O-2: an epoch change announced from inside authEpoch() does not detach the session mid-request", async () => {
    const h = await harness({ scenario: "tools" });
    // AuthManager.authEpoch() re-reads the epoch file and notifies synchronously when another window moved it.
    const read = h.bridge.authEpoch.bind(h.bridge);
    let armed = false;
    h.bridge.authEpoch = () => {
      if (armed) {
        armed = false;
        h.bridge.changeAuth("logout");
      }
      return read();
    };
    const first: OpenAiMessage[] = [SYSTEM, user("first")];
    const r0 = await h.chat({ messages: first });
    expect(r0.finishReason).toBe("tool_calls");
    const r0b = await h.chat({ messages: [...first, ...toolRound(r0)] });
    expect(r0b.finishReason).toBe("stop");

    armed = true;
    const second: OpenAiMessage[] = [SYSTEM, user("second, new epoch")];
    const r1 = await h.chat({ messages: second });
    expect(r1.finishReason).toBe("tool_calls");
    const r2 = await h.chat({ messages: [...second, ...toolRound(r1, () => "after the epoch change")] });
    expect(r2.text).toBe("TOOL_RESULT:after the epoch change");
    expect(h.modules.classified.at(-1)?.kind).toBe("resume");
    expect(count(h, "session/new")).toBe(2);
  });

  test("O-2: an epoch change delivered while the mutex holder awaits the store does not detach the session", async () => {
    const h = await harness({ scenario: "tools" });
    const first: OpenAiMessage[] = [SYSTEM, user("first")];
    const r0 = await h.chat({ messages: first });
    await h.chat({ messages: [...first, ...toolRound(r0)] });
    // A new process loads the persisted record of epoch 1 and takes the lock: the change lands during that await.
    await h.restart();
    const lock = h.modules.store.lock.bind(h.modules.store);
    let armed = true;
    h.modules.store.lock = async (key) => {
      if (armed) {
        armed = false;
        await Promise.resolve();
        h.bridge.changeAuth("logout");
      }
      return lock(key);
    };
    const r1 = await h.chat({ messages: first });
    expect(r1.finishReason).toBe("tool_calls");
    const before = count(h, "session/new");
    const r2 = await h.chat({ messages: [...first, ...toolRound(r1, () => "still bound")] });
    expect(r2.text).toBe("TOOL_RESULT:still bound");
    expect(h.modules.classified.at(-1)?.kind).toBe("resume");
    expect(count(h, "session/new")).toBe(before);
  });

  test("O-6 note: a request waiting on a drain after an update gets a status note", async () => {
    const h = await harness({ scenario: "tools", timings: { drainWaitMs: 800 } });
    const parked = await h.chat({ messages: [SYSTEM, user("park")], session: "ses_parked" });
    expect(parked.finishReason).toBe("tool_calls");
    h.bridge.setBinary(h.binary, "1.5.16");
    expect(h.proxy.process.state).toBe("draining");
    h.setScenario("text");
    const r = await h.chat({ messages: [SYSTEM, user("new")], session: "ses_new" });
    expect(r.reasoning).toContain("[Antigravity] Antigravity CLI was updated. Waiting up to");
    expect(r.text).toBe("PLAIN_TEXT_OK");
    expect(new Set(h.journal().map((e) => e.pid)).size).toBe(2);
  });

  test("O-8: a meta session cancelled while session/new runs is still closed and recorded", async () => {
    const h = await harness({ scenario: "slow-new=400" });
    const controller = new AbortController();
    const pending = h
      .fetchChat({ messages: [SYSTEM, user("Generate a title")], kind: "title", tools: [], stream: false, signal: controller.signal })
      .catch(() => null);
    await waitFor(() => h.methods().includes("session/new"));
    controller.abort();
    await pending;
    await waitFor(() => count(h, "session/close") === 1, 3000);
    expect(count(h, "session/prompt")).toBe(0);
    expect(h.modules.store.ephemeral).toHaveLength(1);
  });

  test("O-9: a non-streaming tool_calls response keeps the text streamed before the calls", async () => {
    const h = await harness({ scenario: "tools,tools=2" });
    const messages: OpenAiMessage[] = [SYSTEM, user("two files")];
    const r1 = await h.chat({ messages, stream: false });
    expect(r1.finishReason).toBe("tool_calls");
    expect(r1.reasoning).toBe("planning...");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "one")], stream: false });
    expect(r2.finishReason).toBe("tool_calls");
    expect(r2.text).toBe("TOOL_RESULT:one");
  });

  test("N-2: steering input that arrives with a late-call flush is not lost", async () => {
    const h = await harness({ scenario: "late-call" });
    const messages: OpenAiMessage[] = [SYSTEM, user("go")];
    const r1 = await h.chat({ messages });
    expect(r1.toolCalls).toHaveLength(1);
    await sleep(600); // the late call arrives while parked and unattached
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "one"), user("USER_STEER_MESSAGE")] });
    expect(r2.status).toBe(200);
    const prompts = h.journal().filter((e) => e.method === "session/prompt");
    expect(prompts.some((p) => (p.promptText ?? "").includes("USER_STEER_MESSAGE"))).toBe(true);
  });

  test("N-3: a steering request superseded while it retries does not replay over the newer turn", async () => {
    const h = await harness({ scenario: "echo,tools,hold,busy-steer", timings: { steerRetryMs: 400 } });
    const messages: OpenAiMessage[] = [SYSTEM, user("start")];
    const r1 = await h.chat({ messages });
    const a = h.chat({ messages: [...messages, ...toolRound(r1, () => "ok"), user("steer A")] });
    await waitFor(() => count(h, "session/prompt") === 2); // the busy steer attempt
    const b = await h.chat({ messages: [SYSTEM, user("a different request B")] });
    expect(b.status).toBe(200);
    const ra = await a;
    expect(ra.finishReason).not.toBe("stop");
    await sleep(300);
    expect(count(h, "session/new")).toBe(2);
    const last = h.journal().filter((e) => e.method === "session/prompt").at(-1);
    expect(last?.promptText ?? "").toContain("a different request B");
  });

  test("N-5: a redo keeps the input range of the failed turn", async () => {
    const h = await harness({ scenario: "stall-on=STALL" });
    const first: OpenAiMessage[] = [SYSTEM, user("hello")];
    await h.chat({ messages: first });
    const input = user("STALL now");
    const second = [...first, { role: "assistant" as const, content: "PLAIN_TEXT_OK" }, input];
    h.modules.nextPlans.push({ kind: "append", input: [input], reminders: [] });
    await h.chat({ messages: second });
    await waitFor(() => h.modules.store.records.get("ses_test")?.lastTurn?.plan === "append");
    const afterAppend = h.modules.store.records.get("ses_test")?.lastTurn;
    // The stub counts every message, the system one included: the input is message 3 of 4.
    expect([afterAppend?.inputFrom, afterAppend?.inputTo]).toEqual([3, 4]);
    h.modules.nextPlans.push({ kind: "redo", input: [input], reminders: [] });
    await h.chat({ messages: second });
    await waitFor(() => h.modules.store.records.get("ses_test")?.lastTurn?.plan === "redo");
    const afterRedo = h.modules.store.records.get("ses_test")?.lastTurn;
    expect([afterRedo?.outcome, afterRedo?.inputFrom, afterRedo?.inputTo]).toEqual(["failed_no_output", 3, 4]);
  });

  test("N-5 with the N-1 change: two clean failures in a row, then a redo carries both inputs (real modules)", async () => {
    const h = await harness({ scenario: "stall-on=STALL", realModules: true });
    const first: OpenAiMessage[] = [SYSTEM, user("hello")];
    const r1 = await h.chat({ messages: first });
    expect(r1.text).toBe("PLAIN_TEXT_OK");
    const withA: OpenAiMessage[] = [...first, { role: "assistant", content: "PLAIN_TEXT_OK" }, user("STALL a")];
    expect((await h.chat({ messages: withA })).error?.code).toBe(504);
    const withB: OpenAiMessage[] = [...withA, user("STALL b")];
    expect((await h.chat({ messages: withB })).error?.code).toBe(504);
    expect((await h.chat({ messages: withB })).error?.code).toBe(504);
    const prompts = h.journal().filter((e) => e.method === "session/prompt");
    expect(prompts).toHaveLength(4);
    expect(new Set(prompts.map((p) => p.sessionId)).size).toBe(1);
    const redo = prompts[3]?.promptText ?? "";
    expect(redo).toContain("STALL a");
    expect(redo).toContain("STALL b");
  }, 30_000);

  test("N-10: a streaming request aborted during setup never prompts agy", async () => {
    const h = await harness({ scenario: "slow-start=400", timings: { earlySseMs: 2000 } });
    const controller = new AbortController();
    const pending = h.fetchChat({ messages: [SYSTEM, user("hi")], signal: controller.signal }).catch(() => null);
    await sleep(100);
    controller.abort();
    await pending;
    await waitFor(() => h.proxy.process.state === "ready", 3000);
    await sleep(300);
    expect(h.methods()).not.toContain("session/prompt");
  });
});

describe("N-4: responseText counts only text written to a response", () => {
  function sink(): TurnSink & { texts: string[] } {
    let closed = false;
    const texts: string[] = [];
    return {
      texts,
      get closed() {
        return closed;
      },
      thought: () => {},
      text: (t) => texts.push(t),
      note: () => {},
      toolCalls: (_calls: readonly EmittedCall[]) => {
        closed = true;
      },
      finish: () => {
        closed = true;
      },
      fail: () => {
        closed = true;
      },
    };
  }

  test("late text while parked is not part of the parked response, and counts for the next one", async () => {
    const { config } = resolveRuntimeConfig({}, {});
    const clock = new FakeClock();
    const hooks: TurnHooks = {
      sendCancel: () => {},
      checkOutcome: async () => null,
      mapError: () => ({ kind: "provider_error", status: 502, message: null }),
      onToolCall: () => {},
      onParked: () => {},
      onMcpDropped: () => {},
      onEnded: () => {},
      onWaitingChanged: () => {},
      log: () => {},
    };
    const turn = new Turn({ sessionKey: "s", plan: "fresh", model: "m", allowTools: true, allowedToolNames: new Set(["read"]), streaming: true, config, clock, hooks });
    const first = sink();
    turn.attach(first);
    turn.startPrompt(() => new Promise(() => {}));
    turn.onUpdate("agent_message_chunk", "First chunk.");
    const scope = { id: "x", acpSessionId: null, tools: new Map() };
    void turn.onMcpCall({ scope, name: "read", arguments: {}, argumentsJson: "{}" }, new AbortController().signal);
    clock.advance(config.timings.toolSettleMs);
    expect(turn.phase).toBe("parked");
    expect(turn.responseText).toBe("First chunk.");
    turn.onUpdate("agent_message_chunk", "Late chunk while parked.");
    expect(turn.responseText).toBe("First chunk.");
    const id = turn.emittedParkedIds[0] ?? "";
    turn.resume(new Map([[id, [{ type: "text", text: "r" }]]]));
    const second = sink();
    turn.attach(second);
    expect(second.texts).toEqual(["Late chunk while parked."]);
    expect(turn.responseText).toBe("Late chunk while parked.");
  });
});
