import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { SYSTEM, startHarness, user, waitFor, type Harness } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function harness(scenario: string, options: Record<string, unknown> = {}): Promise<Harness> {
  const h = await startHarness({ scenario, options });
  open.push(h);
  return h;
}

describe("silence, retries and error steps (SR 6)", () => {
  test("stall: waiting note in reasoning, session/cancel, error code 504", async () => {
    const h = await harness("stall");
    const r = await h.chat({ messages: [SYSTEM, user("think")] });
    expect(r.reasoning).toContain("planning...");
    expect(r.reasoning).toMatch(/\n\[Antigravity\] Waiting for the model\. No output for \d+ s\.\n/);
    expect(r.error?.code).toBe(504);
    expect(r.error?.type).toBe("antigravity_stalled");
    expect(r.finishReason).toBeNull();
    await waitFor(() => h.methods().includes("session/cancel"));
    // A fresh turn that streamed a thought is tainted: the retry replays into a fresh session.
    await waitFor(() => h.modules.store.records.get("ses_test")?.state === "tainted");
  });

  test("a clean no-output stall of an append turn keeps the binding; the redo prompts the same ACP session", async () => {
    // Real classification decides append and redo here; no queued plans (N-14).
    const h = await startHarness({ scenario: "stall-on=STALL", realModules: true });
    open.push(h);
    const first: OpenAiMessage[] = [SYSTEM, user("hello")];
    const r1 = await h.chat({ messages: first });
    expect(r1.text).toBe("PLAIN_TEXT_OK");
    const input = user("STALL now");
    const second = [...first, { role: "assistant" as const, content: "PLAIN_TEXT_OK" }, input];
    const r2 = await h.chat({ messages: second });
    expect(r2.error?.code).toBe(504);
    expect(r2.reasoning).toContain("[Antigravity] Waiting for the model.");
    let record = await h.session.store.load("ses_test", h.bridge.authEpoch());
    for (let i = 0; i < 100 && record?.lastTurn?.outcome !== "failed_no_output"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      record = await h.session.store.load("ses_test", h.bridge.authEpoch());
    }
    expect(record?.lastTurn?.outcome).toBe("failed_no_output");
    expect(record?.lastTurn?.plan).toBe("append");
    expect(record?.state).toBe("dormant"); // live in memory, written as dormant
    // OpenCode retries the same request.
    const r3 = await h.chat({ messages: second });
    expect(r3.error?.code).toBe(504);
    const prompts = h.journal().filter((e) => e.method === "session/prompt");
    expect(prompts).toHaveLength(3);
    expect(new Set(prompts.map((p) => p.sessionId)).size).toBe(1);
    expect(prompts[2]?.promptText).toBe("STALL now");
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(1);
  });

  test("retry-log: the note names HTTP 503 and the attempt; the stall after agy's retries is a 429 not retried", async () => {
    const h = await harness("retry-log");
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.reasoning).toContain(
      "[Antigravity] Google answered HTTP 503 (no capacity for gemini-3.8-flash-low). Antigravity retries on its own: attempt 3, next try in about 1 min.",
    );
    expect(r.error?.code).toBe(429);
    expect(r.error?.message).toBe(
      "Google has no capacity for gemini-3.8-flash-low (HTTP 503), and Antigravity already retried on its own. Request limit exhausted for now: try again later or pick another model.",
    );
  });

  test("error-step: code 429 and no finish_reason stop; the text agy streamed stays", async () => {
    const h = await harness("error-step");
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.text).toBe("Error: Resource has been exhausted");
    expect(r.error?.code).toBe(429);
    // No retry line before the error step: agy did not retry this turn, so OpenCode may (review L-3).
    expect(r.error?.message).toBe("Google is rate-limiting Antigravity requests (HTTP 429).");
    expect(r.finishReason).toBeNull();
  });

  test("quota-step: code 429 with the quota message", async () => {
    const h = await harness("quota-step");
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(429);
    expect(r.error?.message).toBe("Antigravity quota exceeded for this period.");
  });

  test("refusal without an error step is quota_exhausted", async () => {
    const h = await harness("refusal");
    const r = await h.chat({ messages: [SYSTEM, user("go")] });
    expect(r.error?.code).toBe(429);
    expect(r.error?.type).toBe("antigravity_quota");
  });

  test("non-streaming requests use the same limits and answer 504", async () => {
    const h = await harness("stall");
    const r = await h.chat({ messages: [SYSTEM, user("think")], stream: false });
    expect(r.status).toBe(504);
    expect(r.headers.get("x-should-retry")).toBe("true");
  });
});
