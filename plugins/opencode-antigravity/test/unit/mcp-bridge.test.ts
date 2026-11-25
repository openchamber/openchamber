import { describe, expect, test } from "bun:test";
import type { OpenAiFunctionTool } from "../../src/contracts.ts";
import { McpBridge, POOL_SCOPE_ID, type McpCallResult, type McpToolCall } from "../../src/mcp-bridge.ts";

function tool(name: string, properties: Record<string, unknown>): OpenAiFunctionTool {
  return { type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties } } };
}

function rpc(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1/mcp/t/s", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
}

async function result(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("result" in body)) throw new Error("no result");
  const r: unknown = body.result;
  return typeof r === "object" && r !== null ? Object.fromEntries(Object.entries(r)) : {};
}

describe("McpBridge", () => {
  test("two scopes with different schemas for read each list their own", async () => {
    const bridge = new McpBridge(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const a = bridge.openScope([tool("read", { filePath: { type: "string" } })]);
    const b = bridge.openScope([tool("read", { path: { type: "string", minLength: 1 } }), tool("bash", {})]);
    const listA = await result(await bridge.handleRequest(rpc("tools/list"), a.id));
    const listB = await result(await bridge.handleRequest(rpc("tools/list"), b.id));
    expect(JSON.stringify(listA.tools)).toContain("filePath");
    expect(JSON.stringify(listA.tools)).not.toContain("minLength");
    expect(JSON.stringify(listB.tools)).toContain("minLength");
    expect(Array.isArray(listB.tools) ? listB.tools.length : 0).toBe(2);
  });

  test("a tool without parameters lists an empty object schema (moved from the prototype's plugin.test.ts)", async () => {
    const bridge = new McpBridge(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const scope = bridge.openScope([{ type: "function", function: { name: "bash", description: "Run shell" } }]);
    const list = await result(await bridge.handleRequest(rpc("tools/list"), scope.id));
    expect(list.tools).toEqual([{ name: "bash", description: "Run shell", inputSchema: { type: "object", properties: {} } }]);
  });

  test("the pool endpoint routes tools/call by conversation id; without a known one it is an error", async () => {
    const calls: string[] = [];
    const bridge = new McpBridge(async (call) => {
      calls.push(`${call.scope.id}:${call.name}`);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const a = bridge.openScope([tool("read", { path: { type: "string" } })]);
    a.acpSessionId = "conv-a";
    const b = bridge.openScope([tool("bash", {})]);
    b.acpSessionId = "conv-b";
    expect(bridge.servesScope(POOL_SCOPE_ID)).toBe(true);
    const meta = (id: string) => ({ "antigravity.google/conversation_id": id });
    const ok = await result(await bridge.handleRequest(rpc("tools/call", { name: "read", arguments: { path: "x" }, _meta: meta("conv-a") }), POOL_SCOPE_ID));
    expect(ok.isError).toBeUndefined();
    expect(calls).toEqual([`${a.id}:read`]);
    // A tool of another session's scope is not enabled for this conversation.
    const other = await result(await bridge.handleRequest(rpc("tools/call", { name: "bash", arguments: {}, _meta: meta("conv-a") }), POOL_SCOPE_ID));
    expect(other.isError).toBe(true);
    for (const params of [{ name: "read", arguments: {} }, { name: "read", arguments: {}, _meta: meta("conv-unknown") }]) {
      const denied = await result(await bridge.handleRequest(rpc("tools/call", params), POOL_SCOPE_ID));
      expect(denied.isError).toBe(true);
    }
    expect(calls).toHaveLength(1);
    // tools/list only shows the conversation's own tools; nothing without a known conversation (review L-6).
    const names = async (params: Record<string, unknown>): Promise<unknown> => {
      const list = await result(await bridge.handleRequest(rpc("tools/list", params), POOL_SCOPE_ID));
      return Array.isArray(list.tools) ? list.tools.map((t: { name?: string }) => t.name) : null;
    };
    expect(await names({ _meta: meta("conv-a") })).toEqual(["read"]);
    expect(await names({ _meta: meta("conv-unknown") })).toEqual([]);
    expect(await names({})).toEqual([]);
  });

  test("tools/call on a closed scope answers isError", async () => {
    let dispatched = 0;
    const bridge = new McpBridge(async () => {
      dispatched++;
      return { content: [{ type: "text", text: "ok" }] };
    });
    const scope = bridge.openScope([tool("read", {})]);
    bridge.closeScope(scope.id);
    const r = await result(await bridge.handleRequest(rpc("tools/call", { name: "read", arguments: {} }), scope.id));
    expect(r.isError).toBe(true);
    expect(dispatched).toBe(0);
  });

  test("a conversation id that differs from the scope's session answers isError", async () => {
    const calls: McpToolCall[] = [];
    const bridge = new McpBridge(async (call) => {
      calls.push(call);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const scope = bridge.openScope([tool("read", {})]);
    scope.acpSessionId = "acp-1";
    const wrong = await result(
      await bridge.handleRequest(rpc("tools/call", { name: "read", arguments: {}, _meta: { "antigravity.google/conversation_id": "acp-2" } }), scope.id),
    );
    expect(wrong.isError).toBe(true);
    const right = await result(
      await bridge.handleRequest(rpc("tools/call", { name: "read", arguments: { a: 1 }, _meta: { "antigravity.google/conversation_id": "acp-1" } }), scope.id),
    );
    expect(right.isError).toBeUndefined();
    expect(calls.map((c) => c.argumentsJson)).toEqual(['{"a":1}']);
  });

  test("a tool outside the scope's registry is rejected", async () => {
    const bridge = new McpBridge(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const scope = bridge.openScope([tool("read", {})]);
    const r = await result(await bridge.handleRequest(rpc("tools/call", { name: "bash", arguments: {} }), scope.id));
    expect(r).toEqual({ content: [{ type: "text", text: 'Tool "bash" is not enabled for this turn.' }], isError: true });
  });

  test("an aborted request reaches the parked call through its signal", async () => {
    let aborted = false;
    const bridge = new McpBridge(
      (_call, signal) =>
        new Promise<McpCallResult>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ content: [{ type: "text", text: "cancelled" }], isError: true });
          });
        }),
    );
    const scope = bridge.openScope([tool("read", {})]);
    const controller = new AbortController();
    const pending = bridge.handleRequest(rpc("tools/call", { name: "read", arguments: {} }, controller.signal), scope.id);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const r = await result(await pending);
    expect(aborted).toBe(true);
    expect(r.isError).toBe(true);
  });

  test("initialize, ping and notifications", async () => {
    const bridge = new McpBridge(async () => ({ content: [] }));
    const scope = bridge.openScope([]);
    const init = await result(await bridge.handleRequest(rpc("initialize", { protocolVersion: "2025-06-18" }), scope.id));
    expect(init.protocolVersion).toBe("2025-06-18");
    const note = await bridge.handleRequest(
      new Request("http://127.0.0.1/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      scope.id,
    );
    expect(note.status).toBe(202);
    expect((await bridge.handleRequest(new Request("http://127.0.0.1/mcp", { method: "GET" }), scope.id)).status).toBe(405);
  });
});
