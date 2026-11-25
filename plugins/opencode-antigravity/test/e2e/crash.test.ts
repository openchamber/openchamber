import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { SYSTEM, startHarness, toolRound, user, waitFor, type Harness } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

describe("crash recovery (SR 3.4)", () => {
  test("crash-mid-stream: error code 503; the next request spawns a new process and a fresh session", async () => {
    const h = await startHarness({ scenario: "crash-mid-stream" });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("hi")];
    const r1 = await h.chat({ messages });
    expect(r1.status).toBe(200);
    expect(r1.text).toBe("partial ");
    expect(r1.error?.code).toBe(503);
    expect(r1.error?.type).toBe("antigravity_exited");
    expect(r1.error?.message).toBe("Antigravity CLI stopped unexpectedly (exit 137). Retrying restarts it.");
    expect(r1.finishReason).toBeNull();

    h.setScenario("text");
    const r2 = await h.chat({ messages: [...messages, { role: "assistant", content: "partial " }, user("again")] });
    expect(r2.text).toBe("PLAIN_TEXT_OK");
    const pids = new Set(h.journal().map((e) => e.pid));
    expect(pids.size).toBe(2);
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(2);
    expect(h.modules.store.records.get("ses_test")?.state).toBe("dormant");
  });

  test("crash-parked: the tool result posted after the crash goes to a fresh session whose replay ends with the results", async () => {
    // Real classification and replay.ts (N-14).
    const h = await startHarness({ scenario: "crash-parked", realModules: true });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    await waitFor(() => h.methods().includes("crash") && h.proxy.process.state === "stopped");
    let record = await h.session.store.load("ses_test", h.bridge.authEpoch());
    for (let i = 0; i < 50 && record?.taintReason !== "crash"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      record = await h.session.store.load("ses_test", h.bridge.authEpoch());
    }
    expect(record?.state).toBe("tainted");
    expect(record?.taintReason).toBe("crash");

    h.setScenario("text");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "late result")] });
    expect(r2.text).toBe("PLAIN_TEXT_OK");
    const prompts = h.journal().filter((e) => e.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.sessionId).not.toBe(prompts[0]?.sessionId ?? "");
    const replay = prompts[1]?.promptText ?? "";
    expect(replay).toContain("<conversation_history>");
    expect(replay).toMatch(/<tool_results>\n[\s\S]*late result[\s\S]*\n<\/tool_results>\nContinue the task using these tool results\.$/);
  });

  test("three crashes right after start: the fourth request gets 503 with retry-after 30 and nothing spawns", async () => {
    const h = await startHarness({ scenario: "start-crash", options: { breakerCooldownMs: 30_000 }, timings: { earlySseMs: 5000 } });
    open.push(h);
    for (let i = 0; i < 3; i++) {
      const r = await h.chat({ messages: [SYSTEM, user(`try ${i}`)] });
      expect(r.status).toBe(503);
      expect(r.headers.get("x-should-retry")).toBe("true");
    }
    expect(h.proxy.process.state).toBe("broken");
    const r4 = await h.chat({ messages: [SYSTEM, user("try 4")] });
    expect(r4.status).toBe(503);
    expect(r4.headers.get("retry-after")).toBe("30");
    expect(r4.error?.message).toContain("keeps exiting right after start");
    expect(r4.error?.message).toContain(`${h.geminiDir}/antigravity-acp/log`);
    expect(h.methods().filter((m) => m === "start-crash")).toHaveLength(3);
  });
});
