// Streamable HTTP MCP endpoint with one tool registry per ACP session (SR 3.3, 4.4). agy reaches it at
// `/mcp/<token>/<scopeId>`; the proxy checks the token, this module the scope. A `tools/call` is handed
// to the dispatcher with the request's abort signal, so a call agy drops is noticed (SR 3.3).

import { randomBytes } from "node:crypto";
import type { OpenAiFunctionTool } from "./contracts.ts";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; blob: string } };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpScope {
  readonly id: string;
  /** Set once `session/new` or `session/resume` answered; the `conversation_id` cross-check uses it. */
  acpSessionId: string | null;
  readonly tools: ReadonlyMap<string, McpToolDefinition>;
}

export interface McpToolCall {
  scope: McpScope;
  name: string;
  arguments: Record<string, unknown>;
  argumentsJson: string;
}

export type McpDispatch = (call: McpToolCall, signal: AbortSignal) => Promise<McpCallResult>;

export const CONVERSATION_ID_META = "antigravity.google/conversation_id";

/**
 * The scope id of the pool endpoint the agent file names. A `tools/call` there must carry a conversation
 * id that belongs to an open scope; it then runs as a call on that scope.
 */
export const POOL_SCOPE_ID = "pool";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toMcpToolDefinitions(tools: readonly OpenAiFunctionTool[]): McpToolDefinition[] {
  const out: McpToolDefinition[] = [];
  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function.name) continue;
    const params = tool.function.parameters;
    out.push({
      name: tool.function.name,
      description: tool.function.description || `OpenCode tool ${tool.function.name}`,
      inputSchema: isRecord(params) ? { type: "object", ...params } : { type: "object", properties: {} },
    });
  }
  return out;
}

export function errorResult(text: string): McpCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

export class McpBridge {
  private readonly scopes = new Map<string, McpScope>();
  private readonly dispatch: McpDispatch;
  private readonly log: (message: string) => void;

  constructor(dispatch: McpDispatch, log: (message: string) => void = () => {}) {
    this.dispatch = dispatch;
    this.log = log;
  }

  openScope(tools: readonly OpenAiFunctionTool[]): McpScope {
    const registry = new Map<string, McpToolDefinition>();
    for (const def of toMcpToolDefinitions(tools)) registry.set(def.name, def);
    const scope: McpScope = { id: randomBytes(12).toString("hex"), acpSessionId: null, tools: registry };
    this.scopes.set(scope.id, scope);
    return scope;
  }

  closeScope(id: string): void {
    this.scopes.delete(id);
  }

  getScope(id: string): McpScope | null {
    return this.scopes.get(id) ?? null;
  }

  /** True for an open scope or the pool endpoint. */
  servesScope(id: string): boolean {
    return id === POOL_SCOPE_ID || this.scopes.has(id);
  }

  private scopeForConversation(conversationId: unknown): McpScope | null {
    if (typeof conversationId !== "string" || conversationId === "") return null;
    for (const scope of this.scopes.values()) if (scope.acpSessionId === conversationId) return scope;
    return null;
  }


  async handleRequest(req: Request, scopeId: string): Promise<Response> {
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response(null, { status: 405 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
    }
    const id = body.id;
    const method = typeof body.method === "string" ? body.method : "";
    const params = isRecord(body.params) ? body.params : {};
    if (id === undefined || id === null) return new Response(null, { status: 202 }); // notifications

    const pool = scopeId === POOL_SCOPE_ID;
    const meta = isRecord(params._meta) ? params._meta : {};
    const scope = pool ? this.scopeForConversation(meta[CONVERSATION_ID_META]) : (this.scopes.get(scopeId) ?? null);
    if (pool) this.log(`mcp pool endpoint ${method || "?"}${method === "tools/call" ? (scope ? " (scope found)" : " (no scope)") : ""}`);
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "opencode", version: "0.1.0" },
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        // Only the conversation's own tools: a session without a scope of its own (discovery, meta)
        // or another session never sees them (review L-6).
        if (pool) return rpcResult(id, { tools: scope ? [...scope.tools.values()] : [] });
        return rpcResult(id, { tools: scope ? [...scope.tools.values()] : [] });
      case "tools/call":
        return rpcResult(id, await this.call(scope, params, req.signal));
      default:
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  private async call(scope: McpScope | null, params: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    if (!scope) return errorResult("This OpenCode tool session has ended.");
    const name = typeof params.name === "string" ? params.name : "";
    const meta = isRecord(params._meta) ? params._meta : {};
    const conversationId = meta[CONVERSATION_ID_META];
    if (typeof conversationId === "string" && scope.acpSessionId !== null && conversationId !== scope.acpSessionId) {
      this.log("mcp tools/call conversation id does not match its scope");
      return errorResult("This tool call does not belong to this OpenCode session.");
    }
    if (!scope.tools.has(name)) return errorResult(`Tool "${name}" is not enabled for this turn.`);
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      return await this.dispatch({ scope, name, arguments: args, argumentsJson: JSON.stringify(args) }, signal);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : "The OpenCode tool call failed.");
    }
  }
}
