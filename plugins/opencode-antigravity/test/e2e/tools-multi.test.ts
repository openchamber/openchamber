import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAiMessage } from "../../src/contracts.ts";
import { SYSTEM, sleep, startHarness, toolRound, user, type Harness } from "../fixtures/proxy-harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function harness(scenario: string): Promise<Harness> {
  const h = await startHarness({ scenario });
  open.push(h);
  return h;
}

describe("tools across HTTP requests (SR 3.5, 3.7)", () => {
  test("park, resume, second park, resume, end_turn inside one ACP prompt", async () => {
    const h = await harness("tools,tools=2");
    let messages: OpenAiMessage[] = [SYSTEM, user("read two files")];
    const r1 = await h.chat({ messages });
    expect(r1.finishReason).toBe("tool_calls");
    expect(r1.toolCalls).toHaveLength(1);
    expect(r1.toolCalls[0]?.id).toMatch(/^call_[0-9a-f]{20}$/);
    expect(JSON.parse(r1.toolCalls[0]?.arguments ?? "{}")).toEqual({ path: "file-0.ts" });
    messages = [...messages, ...toolRound(r1, () => "first result")];
    const r2 = await h.chat({ messages });
    expect(r2.text).toBe("TOOL_RESULT:first result");
    expect(r2.finishReason).toBe("tool_calls");
    messages = [...messages, ...toolRound(r2, () => "second result")];
    const r3 = await h.chat({ messages });
    expect(r3.text).toBe("TOOL_RESULT:second result");
    expect(r3.finishReason).toBe("stop");
    expect(h.methods().filter((m) => m === "session/prompt")).toHaveLength(1);
    expect(h.methods().filter((m) => m === "session/new")).toHaveLength(1);
    expect(h.modules.classified.map((p) => p.kind)).toEqual(["fresh", "resume", "resume"]);
  });

  test("reasoning and usage stream out; layer 3 rejects a built-in tool, also one that names the MCP server in its input (moved from e2e-proxy.test.ts)", async () => {
    // The real layer 3 (profile.ts matchMcpPermission), not the harness stub (N-14).
    const h = await startHarness({ scenario: "tools,builtin-permission", realModules: true });
    open.push(h);
    const messages: OpenAiMessage[] = [SYSTEM, user("read secret-canary.txt")];
    const r1 = await h.chat({ messages });
    expect(r1.reasoning).toContain("planning...");
    expect(r1.finishReason).toBe("tool_calls");
    expect(r1.toolCalls.map((c) => c.name)).toEqual(["read"]);
    expect(h.journal().find((e) => e.method === "builtin/permission")?.params).toEqual({ optionId: "deny" });
    expect(h.journal().find((e) => e.method === "builtin/injected-permission")?.params).toEqual({ optionId: "deny" });
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "CANARY_TOKEN_9482")] });
    expect(r2.text).toBe("TOOL_RESULT:CANARY_TOKEN_9482");
    expect(r2.finishReason).toBe("stop");
    const usage = r2.events.map((e) => e.data?.usage).find((u) => u !== undefined);
    expect(usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    });
  });

  test("late-call: the resume request answers with a tool_calls response for the late call", async () => {
    const h = await harness("late-call");
    let messages: OpenAiMessage[] = [SYSTEM, user("go")];
    const r1 = await h.chat({ messages });
    expect(r1.toolCalls).toHaveLength(1);
    await sleep(600); // the second call arrives while the turn is parked and unattached
    messages = [...messages, ...toolRound(r1, () => "one")];
    const r2 = await h.chat({ messages });
    expect(r2.finishReason).toBe("tool_calls");
    expect(r2.toolCalls).toHaveLength(1);
    expect(JSON.parse(r2.toolCalls[0]?.arguments ?? "{}")).toEqual({ path: "second.ts" });
    messages = [...messages, ...toolRound(r2, () => "two")];
    const r3 = await h.chat({ messages });
    expect(r3.text).toBe("TOOL_RESULT:one|TOOL_RESULT:two");
    expect(r3.finishReason).toBe("stop");
    expect(h.methods().filter((m) => m === "session/prompt")).toHaveLength(1);
  });

  test("partial results: the unanswered emitted call resolves with an error and the stream continues, no 409", async () => {
    const h = await harness("parallel");
    const messages: OpenAiMessage[] = [SYSTEM, user("go")];
    const r1 = await h.chat({ messages });
    expect(r1.toolCalls).toHaveLength(2);
    const round = toolRound(r1, () => "answered");
    const onlyFirst = round.slice(0, 2); // assistant + the first tool message
    const r2 = await h.chat({ messages: [...messages, ...onlyFirst] });
    expect(r2.status).toBe(200);
    expect(r2.finishReason).toBe("stop");
    expect(r2.text).toBe("TOOL_RESULT:answered|TOOL_RESULT:OpenCode returned no result for this tool call.");
    const results = h.journal().filter((e) => e.method === "mcp/result");
    expect(results.map((e) => e.params.isError)).toEqual([false, true]);
  });

  test("tool-media: OpenCode's media-only user message reaches agy as an MCP image item, with no steering prompt", async () => {
    const h = await harness("tools");
    const messages: OpenAiMessage[] = [SYSTEM, user("screenshot")];
    const r1 = await h.chat({ messages });
    const media: OpenAiMessage = {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }],
    };
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1, () => "took a screenshot"), media] });
    expect(r2.finishReason).toBe("stop");
    const result = h.journal().find((e) => e.method === "mcp/result");
    expect(result?.params.contentTypes).toEqual(["text", "image"]);
    expect(h.methods().filter((m) => m === "session/prompt")).toHaveLength(1);
  });

  test("non-streaming: tool_calls and the final message as JSON", async () => {
    const h = await harness("tools");
    const messages: OpenAiMessage[] = [SYSTEM, user("read")];
    const r1 = await h.chat({ messages, stream: false });
    expect(r1.status).toBe(200);
    expect(r1.finishReason).toBe("tool_calls");
    const r2 = await h.chat({ messages: [...messages, ...toolRound(r1)], stream: false });
    expect(r2.text).toBe("TOOL_RESULT:file contents");
    expect(r2.finishReason).toBe("stop");
  });

  test("a denied permission never reaches the MCP endpoint", async () => {
    const h = await harness("tools,tool-name=bash");
    const r = await h.chat({ messages: [SYSTEM, user("run")] });
    expect(r.finishReason).toBe("stop");
    expect(h.journal().find((e) => e.method === "mcp/denied")?.params.optionId).toBe("deny");
    expect(h.methods()).not.toContain("mcp/call");
  });
});
