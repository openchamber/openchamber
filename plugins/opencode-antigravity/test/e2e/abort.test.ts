import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { SYSTEM, startHarness, toolRound, user, waitFor, type Harness } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function harness(scenario: string, options: Record<string, unknown> = {}): Promise<Harness> {
  const h = await startHarness({ scenario, options });
  open.push(h);
  return h;
}

/** Starts a streaming request, reads until `until` holds for the text so far, then aborts. */
async function abortWhen(h: Harness, messages: OpenAiMessage[], until: (soFar: string) => boolean): Promise<void> {
  const controller = new AbortController();
  const res = await h.fetchChat({ messages, signal: controller.signal });
  const reader = res.body?.getReader();
  let soFar = "";
  while (reader && !until(soFar)) {
    const { value, done } = await reader.read();
    if (done) break;
    soFar += new TextDecoder().decode(value);
  }
  controller.abort();
  await reader?.cancel().catch(() => {});
}

describe("client aborts and cancels (SR 3.5)", () => {
  test("abort during slow-start: no session is created and the lease is released (idle stop follows)", async () => {
    const h = await harness("slow-start=500", { idleShutdownMs: 150 });
    await abortWhen(h, [SYSTEM, user("hi")], (s) => s.includes(": ping") || s.includes("Starting Antigravity"));
    await waitFor(() => h.proxy.process.state === "stopped", 3000);
    expect(h.methods()).not.toContain("session/new");
  });

  test("abort mid-stream: session/cancel, lease released, idle stop follows", async () => {
    const h = await harness("stall", { idleShutdownMs: 150 });
    await abortWhen(h, [SYSTEM, user("hi")], (s) => s.includes("planning..."));
    await waitFor(() => h.methods().includes("session/cancel"));
    await waitFor(() => h.proxy.process.state === "stopped", 3000);
    expect(h.modules.store.records.get("ses_test")?.state).toBe("tainted");
  });

  test("interrupt while parked: session/cancel for the old id, the next request is fresh", async () => {
    const h = await harness("tools");
    const messages: OpenAiMessage[] = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    h.proxy.onSessionInterrupted("ses_test");
    await waitFor(() => h.methods().includes("session/cancel"));
    expect(h.journal().find((e) => e.method === "session/cancel")?.sessionId).toBe(
      h.journal().find((e) => e.method === "session/prompt")?.sessionId ?? "",
    );
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1)] });
    expect(r2.status).toBe(200);
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(2);
    expect(h.modules.classified.at(-1)).toEqual({ kind: "fresh", reason: "tainted" });
  });

  test("cancel-hang: after cancelSettleMs the binding is tainted, the next request is fresh; a second hang stops the process as wedged", async () => {
    const h = await harness("stall,cancel-hang", { stallTimeoutMs: 400, retryStallTimeoutMs: 400, cancelSettleMs: 300 });
    const r1 = await h.chat({ messages: [SYSTEM, user("one")] });
    expect(r1.error?.code).toBe(504);
    await waitFor(() => h.modules.store.records.get("ses_test")?.taintReason === "abandoned", 3000);
    expect(h.methods()).toContain("cancel-ignored");
    // Nothing waits on agy now, so its silence alone is not wedged.
    expect(h.proxy.process.state).toBe("ready");
    const r2 = await h.chat({ messages: [SYSTEM, user("one"), user("two")] });
    expect(r2.error?.code).toBe(504);
    expect(h.modules.classified.at(-1)).toEqual({ kind: "fresh", reason: "tainted" });
    await waitFor(() => h.logs.some((l) => l.includes("wedged")), 5000);
    await waitFor(() => h.proxy.process.state === "stopped", 3000);
    h.setScenario("text");
    const r3 = await h.chat({ messages: [SYSTEM, user("one"), user("two"), user("three")] });
    expect(r3.text).toBe("PLAIN_TEXT_OK");
    expect(new Set(h.journal().map((e) => e.pid)).size).toBe(2);
  });

  test("mcp-drop: the turn is cancelled and the later tool result goes through a fresh session", async () => {
    const h = await harness("mcp-drop");
    const messages: OpenAiMessage[] = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    await waitFor(() => h.methods().includes("session/cancel"));
    await waitFor(() => h.modules.store.records.get("ses_test")?.taintReason === "mcp-dropped");
    h.setScenario("text");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1)] });
    expect(r2.status).toBe(200);
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(2);
  });

  test("a second main request while the first streams cancels the first and runs fresh", async () => {
    const h = await harness("stall-on=FIRST");
    const first = h.chat({ messages: [SYSTEM, user("FIRST")] });
    await waitFor(() => h.methods().includes("session/prompt"));
    const second = await h.chat({ messages: [SYSTEM, user("second")] });
    expect(second.text).toBe("PLAIN_TEXT_OK");
    const firstResult = await first;
    expect(firstResult.finishReason).toBeNull();
    expect(firstResult.error).toBeNull();
    expect(h.methods()).toContain("session/cancel");
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(2);
  });

  test("an interrupt during session setup leaves the binding as it was: no prompt, no moved prefix", async () => {
    const h = await harness("slow-config=400");
    const first: OpenAiMessage[] = [SYSTEM, user("hello")];
    await h.chat({ messages: first, model: "gemini-3.8-flash" });
    await waitFor(() => h.modules.store.records.get("ses_test")?.prefixCount === 2);
    const input = user("second");
    h.modules.nextPlans.push({ kind: "append", input: [input], reminders: [] });
    const pending = h.chat({ messages: [...first, { role: "assistant", content: "PLAIN_TEXT_OK" }, input], model: "gemini-4-neon" });
    await waitFor(() => h.methods().filter((m) => m === "session/set_config_option").length === 2);
    h.proxy.onSessionInterrupted("ses_test");
    await pending;
    await new Promise((r) => setTimeout(r, 500));
    expect(h.methods().filter((m) => m === "session/prompt")).toHaveLength(1);
    expect(h.modules.store.records.get("ses_test")?.prefixCount).toBe(2);
  });

  test("non-streaming abort answers nothing useful and cancels the turn", async () => {
    const h = await harness("stall");
    const controller = new AbortController();
    const pending = h.fetchChat({ messages: [SYSTEM, user("hi")], stream: false, signal: controller.signal }).catch(() => null);
    await waitFor(() => h.methods().includes("session/prompt"));
    controller.abort();
    await pending;
    await waitFor(() => h.methods().includes("session/cancel"));
  });
});
