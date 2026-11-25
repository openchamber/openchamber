import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { SYSTEM, startHarness, toolRound, user, waitFor, type Harness } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

describe("one process, many sessions (SR 3.7)", () => {
  test("two sessions parked at once; results posted in reverse order each continue their own turn", async () => {
    const h = await startHarness({ scenario: "tools" });
    open.push(h);
    const a: OpenAiMessage[] = [SYSTEM, user("session A")];
    const b: OpenAiMessage[] = [SYSTEM, user("session B")];
    const [ra, rb] = await Promise.all([h.chat({ messages: a, session: "ses_a" }), h.chat({ messages: b, session: "ses_b" })]);
    expect(ra.finishReason).toBe("tool_calls");
    expect(rb.finishReason).toBe("tool_calls");
    expect(ra.toolCalls[0]?.id).not.toBe(rb.toolCalls[0]?.id);
    const rb2 = await h.chat({ messages: [...b, ...toolRound(rb, () => "result for B")], session: "ses_b" });
    const ra2 = await h.chat({ messages: [...a, ...toolRound(ra, () => "result for A")], session: "ses_a" });
    expect(rb2.text).toBe("TOOL_RESULT:result for B");
    expect(ra2.text).toBe("TOOL_RESULT:result for A");
    const prompts = h.journal().filter((e) => e.method === "session/prompt");
    expect(new Set(prompts.map((p) => p.sessionId)).size).toBe(2);
    expect(new Set(h.journal().map((e) => e.pid)).size).toBe(1);
  });

  test("tool results plus a new user message steer the running prompt on the same session", async () => {
    const h = await startHarness({ scenario: "echo,tools,hold" });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("start")];
    const r1 = await h.chat({ messages });
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "ok"), user("also check the tests")] });
    expect(r2.finishReason).toBe("stop");
    expect(r2.text).toContain("ECHO:also check the tests");
    const prompts = h.journal().filter((e) => e.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.sessionId).toBe(prompts[1]?.sessionId ?? "");
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(1);
  });

  test("busy-steer: the retry after the busy answer succeeds", async () => {
    const h = await startHarness({ scenario: "echo,tools,hold,busy-steer" });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("start")];
    const r1 = await h.chat({ messages });
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "ok"), user("steer me")] });
    expect(r2.text).toContain("ECHO:steer me");
    expect(h.journal().filter((e) => e.method === "session/prompt")).toHaveLength(3);
  });

  test("steering off: the turn is cancelled and the request replays into a fresh session", async () => {
    const h = await startHarness({ scenario: "echo,tools,hold", options: { steering: false } });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("start")];
    const r1 = await h.chat({ messages });
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "ok"), user("new input")] });
    expect(h.methods()).toContain("session/cancel");
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(2);
    // The fresh session's replay carries the new input; the fake runs its tool again there.
    const prompts = h.journal().filter((e) => e.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.promptText).toContain("new input");
    expect(prompts[1]?.sessionId).not.toBe(prompts[0]?.sessionId ?? "");
    expect(r2.finishReason).toBe("tool_calls");
  });

  test("a meta title request while a turn is parked runs in its own session, closed after; the parked turn resumes", async () => {
    const h = await startHarness({ scenario: "tools" });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("work")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    const title = await h.chat({ messages: [SYSTEM, user("Generate a title")], kind: "title", tools: [] });
    expect(title.finishReason).toBe("stop");
    await waitFor(() => h.methods().includes("session/close"));
    const news = h.journal().filter((e) => e.method === "session/new");
    expect(news).toHaveLength(2);
    expect(news[1]?.params.mcpServers).toEqual([]);
    const closed = h.journal().find((e) => e.method === "session/close");
    const titlePrompt = h.journal().filter((e) => e.method === "session/prompt")[1];
    expect(closed?.sessionId).toBe(titlePrompt?.sessionId ?? "");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "parked result")] });
    expect(r2.text).toBe("TOOL_RESULT:parked result");
    expect(h.modules.store.ephemeral).toHaveLength(1);
  });

  test("a non-streaming title request answers one JSON completion (moved from e2e-proxy.test.ts)", async () => {
    const h = await startHarness({ scenario: "text" });
    open.push(h);
    const r = await h.chat({ messages: [user("title this chat")], kind: "title", tools: [], stream: false });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");
    expect(r.text).toBe("PLAIN_TEXT_OK");
    expect(r.finishReason).toBe("stop");
    expect(r.toolCalls).toEqual([]);
  });
});
