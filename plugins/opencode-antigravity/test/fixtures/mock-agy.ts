#!/usr/bin/env bun
// Fake `agy acp`: newline-delimited JSON-RPC (ACP) on stdio.
//
// Run:   bun test/fixtures/mock-agy.ts [--scenario a,b] [--journal <file>] [--agy-version 1.5.15] acp --gemini-dir <g> ...
// Tests: writeMockAgyWrapper(dir, { scenario, journal }) writes an executable that does exactly that, so a
//        scenario never leaks between parallel tests through global env (SR 11). `MOCK_AGY_SCENARIO`,
//        `MOCK_AGY_JOURNAL` and `MOCK_AGY_VERSION` are read when the flags are absent.
//
// Base protocol: `initialize` (identity fields of IA 15.3 item 8 and SR 9), `authenticate`, `session/new`,
// `session/resume`, `session/close`, `session/set_config_option`, `session/prompt` (streams
// `session/update` chunks), `session/cancel` (the running prompt replies `stopReason: "cancelled"`). A
// prompt on a session that is still running supersedes it: the older prompt replies `cancelled` first,
// then the newer one starts. Sessions persist to `<gemini-dir>/mock-sessions.json`, so a new fake process
// can resume them; an unknown id answers agy's real `Failed to read session` error. Unknown methods
// answer -32601.
//
// MCP: tool scenarios call the URL from `session/new` `mcpServers` (never an agent file): a
// `session/request_permission` for `call_mcp_tool`, then `tools/call` over HTTP. The journal gets
// `mcp/call` (scope path, tool name), `mcp/result` (text, isError, content item types) or `mcp/error`. Every request, notification and client response is appended to the journal as one
// JSON line (`JournalEntry`); scenarios add their own lines with `ctx.record`.
//
// Adding a scenario: add an entry to `SCENARIOS`. `--scenario a,b` composes left to right, and nothing
// is dropped silently. `--scenario name=value` passes a parameter (`ctx.args.scenarioParams[name]`).
// Unknown scenario names exit 2.
// - `initialize(result, ctx)`: synchronous rewrite of the base `initialize` result; rewrites chain.
// - `methods[name](req, ctx, next)`: wraps the handler of the scenarios before it, and the base handler
//   innermost. Call `await next()` to delegate (for example sleep, then `next()` for `slow-start`), or
//   answer yourself. A method the base lacks (`session/resume`, `session/close`) has the -32601 answer
//   as its innermost handler.
// - `notifications[name](params, ctx, next)`: same, for notifications.
// - `prompt(input, ctx, next)`: wraps the prompt body; `next()` runs the earlier body and returns its reply.
// - `onStart(ctx)`: runs before stdin is read, for example to exit at once (`start-crash`).

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AUTH_URL_STDOUT_PREFIX } from "../../src/auth/errors.ts";

export const MOCK_AGY_PATH = fileURLToPath(import.meta.url);
export const MOCK_AGY_DEFAULT_VERSION = "1.5.15";
export const MOCK_AGENT_NAME = "Antigravity ACP Server";
export const MOCK_DEFAULT_MODEL = "gemini-3.8-flash";
export const MOCK_THOUGHT_TEXT = "planning...";
export const MOCK_REPLY_TEXT = "PLAIN_TEXT_OK";
/** agy 1.5.15's real answer (-32603) to `authenticate` on a signed-out profile with SSH_CONNECTION set (IA 2.3),
 *  as test/real-agy.smoke.test.ts recorded it. */
export const MOCK_NO_BROWSER_MESSAGE =
  "No browser is available here (this is a remote (SSH) session, so the browser's sign-in redirect can't reach this machine). Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key.";
/** Journal method name of a client's response to an agent-to-client request. */
export const JOURNAL_CLIENT_RESPONSE = "client/response";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string;
type JsonObject = Record<string, unknown>;

export interface IncomingRequest {
  id: JsonRpcId;
  method: string;
  params: JsonObject;
}

export interface JournalEntry {
  at: number;
  pid: number;
  /** The RPC method, `client/response`, or a scenario's own label. */
  method: string;
  /** Null for notifications and scenario records. */
  id: JsonRpcId | null;
  sessionId: string | null;
  /** Text blocks of a `session/prompt`, joined with "". */
  promptText: string | null;
  params: JsonObject;
}

export interface MockInitializeResult {
  protocolVersion: number;
  agentInfo: { name: string; version: string };
  agentCapabilities: {
    loadSession: boolean;
    sessionCapabilities: { resume?: JsonObject; close?: JsonObject; list?: JsonObject; fork?: JsonObject };
    mcpCapabilities: { http: boolean; sse: boolean };
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
    auth: { logout?: JsonObject };
    _meta: { antigravity: { tier: boolean; systemPrompt: { append: boolean } } };
  };
  authMethods: Array<{ id: string; name: string; description?: string }>;
}

export interface MockConfigOption {
  id: string;
  category: string;
  currentValue: string;
  options: Array<{ value: string; name?: string }>;
}

export interface RunningPrompt {
  readonly requestId: JsonRpcId;
  readonly controller: AbortController;
  /** Settles after this prompt's reply was written. */
  readonly done: Promise<void>;
}

export interface MockSession {
  readonly id: string;
  readonly cwd: string;
  readonly mcpServers: unknown[];
  /** `_meta.antigravity.systemPrompt.append` from `session/new`, null when absent. */
  readonly systemPromptAppend: string | null;
  model: string;
  thoughtLevel: string;
  running: RunningPrompt | null;
}

export interface MockArgs {
  scenarios: string[];
  /** `--scenario slow-start=200` gives `{ "slow-start": "200" }`. A scenario reads its own entry. */
  scenarioParams: Record<string, string>;
  journal: string | null;
  agyVersion: string;
  /** Everything after the fixture's own flags, as agy would receive it. */
  agyArgv: string[];
  geminiDir: string | null;
  logFile: string | null;
}

export interface MockUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  totalTokens: number;
}

export interface PromptInput {
  session: MockSession;
  requestId: JsonRpcId;
  blocks: unknown[];
  text: string;
  /** Aborted by `session/cancel` or a newer prompt on the same session. */
  signal: AbortSignal;
}

export interface PromptReply {
  stopReason: "end_turn" | "cancelled" | "refusal" | "max_tokens" | "max_turn_requests";
  usage?: MockUsage;
}

export type ClientResponse = { ok: true; result: unknown } | { ok: false; error: unknown };

export interface MockContext {
  readonly args: MockArgs;
  readonly sessions: Map<string, MockSession>;
  reply(id: JsonRpcId, result: unknown): void;
  replyError(id: JsonRpcId, code: number, message: string, data?: unknown): void;
  /** `session/update` notification. */
  update(sessionId: string, update: JsonObject): void;
  notify(method: string, params: JsonObject): void;
  /** Agent-to-client request, for example `session/request_permission`. */
  request(method: string, params: JsonObject): Promise<ClientResponse>;
  /** Appends a scenario's own line to the journal, in order with the RPC lines. */
  record(method: string, params?: JsonObject, sessionId?: string | null): void;
  /** A raw, non-JSON line, as agy prints for interactive sign-in. */
  writeStdout(line: string): void;
  writeStderr(line: string): void;
  exit(code: number): never;
}

export type Next = () => Promise<void>;
export type MethodHandler = (req: IncomingRequest, ctx: MockContext, next: Next) => void | Promise<void>;
export type NotificationHandler = (params: JsonObject, ctx: MockContext, next: () => void) => void;
export type PromptHandler = (input: PromptInput, ctx: MockContext, next: () => Promise<PromptReply>) => Promise<PromptReply>;

export interface Scenario {
  description: string;
  initialize?: (result: MockInitializeResult, ctx: MockContext) => MockInitializeResult;
  methods?: Readonly<Record<string, MethodHandler>>;
  notifications?: Readonly<Record<string, NotificationHandler>>;
  prompt?: PromptHandler;
  onStart?: (ctx: MockContext) => void;
}

type BoundMethod = (req: IncomingRequest, ctx: MockContext) => Promise<void>;
type BoundNotification = (params: JsonObject, ctx: MockContext) => void;
type BoundPrompt = (input: PromptInput, ctx: MockContext) => Promise<PromptReply>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

/** Own-property lookup, so a method named `constructor` never resolves to `Object.prototype`. */
function ownEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function promptText(blocks: unknown[]): string {
  let text = "";
  for (const block of blocks) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const USAGE: MockUsage = { inputTokens: 10, cachedReadTokens: 2, outputTokens: 5, thoughtTokens: 1, totalTokens: 17 };

export function baseInitializeResult(version: string): MockInitializeResult {
  return {
    protocolVersion: 1,
    agentInfo: { name: MOCK_AGENT_NAME, version },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, close: {}, list: {}, fork: {} },
      mcpCapabilities: { http: true, sse: false },
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      auth: { logout: {} },
      _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
    },
    authMethods: [
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "oauth-business", name: "Log in with Google (business)" },
      { id: "gemini-api-key", name: "Gemini API key" },
      { id: "agent-platform", name: "Agent Platform" },
    ],
  };
}

function configOptions(session: MockSession): MockConfigOption[] {
  return [
    {
      id: "model",
      category: "model",
      currentValue: session.model,
      options: [
        { value: MOCK_DEFAULT_MODEL, name: "Gemini 3.8 Flash" },
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
      ],
    },
    {
      id: "thought_level",
      category: "thought_level",
      currentValue: session.thoughtLevel,
      options: [{ value: "low" }, { value: "high" }],
    },
  ];
}

export function sessionFor(req: IncomingRequest, ctx: MockContext): MockSession | null {
  const id = asString(req.params.sessionId);
  const session = id ? ctx.sessions.get(id) : undefined;
  if (session) return session;
  ctx.replyError(req.id, -32603, `Session not found: ${id ?? "<missing>"}`);
  return null;
}

// ---------------------------------------------------------------------------
// Session persistence (SR 11: a new fake process can session/resume)
// ---------------------------------------------------------------------------

interface StoredSession {
  cwd: string;
  systemPromptAppend: string | null;
}

function sessionsFile(ctx: MockContext): string | null {
  return ctx.args.geminiDir ? path.join(ctx.args.geminiDir, "mock-sessions.json") : null;
}

function readStoredSessions(ctx: MockContext): Record<string, StoredSession> {
  const file = sessionsFile(ctx);
  if (!file || !existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isObject(parsed)) return {};
    const out: Record<string, StoredSession> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const v = asObject(value);
      out[id] = { cwd: asString(v.cwd) ?? "", systemPromptAppend: asString(v.systemPromptAppend) };
    }
    return out;
  } catch {
    return {};
  }
}

function storeSession(ctx: MockContext, session: MockSession): void {
  const file = sessionsFile(ctx);
  if (!file) return;
  const all = readStoredSessions(ctx);
  all[session.id] = { cwd: session.cwd, systemPromptAppend: session.systemPromptAppend };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all));
  } catch {
    // The journal still records the call.
  }
}

function appendOf(params: JsonObject): string | null {
  return asString(asObject(asObject(asObject(params._meta).antigravity).systemPrompt).append);
}

// ---------------------------------------------------------------------------
// Base protocol
// ---------------------------------------------------------------------------

const basePrompt: BoundPrompt = async ({ session }, ctx) => {
  ctx.update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: MOCK_THOUGHT_TEXT } });
  ctx.update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: MOCK_REPLY_TEXT } });
  return { stopReason: "end_turn", usage: USAGE };
};

const methodNotFound: BoundMethod = async (req, ctx) => {
  ctx.replyError(req.id, -32601, `Method not found: ${req.method}`);
};

function baseMethods(scenarios: readonly Scenario[], prompt: BoundPrompt): Map<string, BoundMethod> {
  const methods = new Map<string, BoundMethod>();
  methods.set("initialize", async (req, ctx) => {
    let result = baseInitializeResult(ctx.args.agyVersion);
    for (const s of scenarios) if (s.initialize) result = s.initialize(result, ctx);
    ctx.reply(req.id, result);
  });
  methods.set("authenticate", async (req, ctx) => {
    ctx.reply(req.id, {});
  });
  methods.set("session/new", async (req, ctx) => {
    const session: MockSession = {
      id: randomUUID(),
      cwd: asString(req.params.cwd) ?? "",
      mcpServers: Array.isArray(req.params.mcpServers) ? req.params.mcpServers : [],
      systemPromptAppend: appendOf(req.params),
      model: MOCK_DEFAULT_MODEL,
      thoughtLevel: "low",
      running: null,
    };
    ctx.sessions.set(session.id, session);
    storeSession(ctx, session);
    ctx.reply(req.id, { sessionId: session.id, configOptions: configOptions(session) });
  });
  methods.set("session/resume", async (req, ctx) => {
    const id = asString(req.params.sessionId) ?? "";
    const stored = readStoredSessions(ctx)[id];
    if (!stored) {
      ctx.replyError(req.id, -32603, `Failed to read session ${id}; retry, or load it with session/load`);
      return;
    }
    const session: MockSession = {
      id,
      cwd: asString(req.params.cwd) ?? stored.cwd,
      mcpServers: Array.isArray(req.params.mcpServers) ? req.params.mcpServers : [],
      systemPromptAppend: appendOf(req.params),
      model: MOCK_DEFAULT_MODEL,
      thoughtLevel: "low",
      running: null,
    };
    ctx.sessions.set(id, session);
    ctx.reply(req.id, { configOptions: configOptions(session) });
  });
  methods.set("session/close", async (req, ctx) => {
    const id = asString(req.params.sessionId) ?? "";
    const session = ctx.sessions.get(id);
    session?.running?.controller.abort();
    ctx.sessions.delete(id);
    ctx.reply(req.id, {});
  });
  methods.set("session/set_config_option", async (req, ctx) => {
    const session = sessionFor(req, ctx);
    if (!session) return;
    const configId = asString(req.params.configId);
    const value = asString(req.params.value);
    if (value && configId === "model") session.model = value;
    if (value && configId === "thought_level") session.thoughtLevel = value;
    ctx.reply(req.id, { configOptions: configOptions(session) });
  });
  methods.set("session/prompt", async (req, ctx) => {
    const session = sessionFor(req, ctx);
    if (!session) return;
    const controller = new AbortController();
    const done = deferred();
    const running: RunningPrompt = { requestId: req.id, controller, done: done.promise };
    // Claim the session first, so a third prompt arriving meanwhile supersedes this one, not the first.
    const previous = session.running;
    session.running = running;
    try {
      if (previous) {
        previous.controller.abort();
        await previous.done; // the superseded prompt replies before this one starts
      }
      if (controller.signal.aborted) {
        ctx.reply(req.id, { stopReason: "cancelled" });
        return;
      }
      const blocks = Array.isArray(req.params.prompt) ? req.params.prompt : [];
      const reply = await prompt({ session, requestId: req.id, blocks, text: promptText(blocks), signal: controller.signal }, ctx);
      ctx.reply(req.id, controller.signal.aborted ? { stopReason: "cancelled", usage: reply.usage } : reply);
    } catch (err) {
      ctx.replyError(req.id, -32603, errorText(err));
    } finally {
      if (session.running === running) session.running = null;
      done.resolve();
    }
  });
  return methods;
}

function baseNotifications(): Map<string, BoundNotification> {
  const notifications = new Map<string, BoundNotification>();
  notifications.set("session/cancel", (params, ctx) => {
    const id = asString(params.sessionId);
    const session = id ? ctx.sessions.get(id) : undefined;
    session?.running?.controller.abort();
  });
  return notifications;
}

/** Wraps `base` with each scenario's handler for `method`, left to right (the last scenario is outermost). */
function composeMethod(method: string, base: BoundMethod, scenarios: readonly Scenario[]): BoundMethod {
  let chain = base;
  for (const scenario of scenarios) {
    const handler = ownEntry(scenario.methods, method);
    if (!handler) continue;
    const inner = chain;
    chain = async (req, ctx) => {
      await handler(req, ctx, () => inner(req, ctx));
    };
  }
  return chain;
}

function composeNotification(name: string, base: BoundNotification, scenarios: readonly Scenario[]): BoundNotification {
  let chain = base;
  for (const scenario of scenarios) {
    const handler = ownEntry(scenario.notifications, name);
    if (!handler) continue;
    const inner = chain;
    chain = (params, ctx) => handler(params, ctx, () => inner(params, ctx));
  }
  return chain;
}

function composePrompt(scenarios: readonly Scenario[]): BoundPrompt {
  let chain = basePrompt;
  for (const scenario of scenarios) {
    const handler = scenario.prompt;
    if (!handler) continue;
    const inner = chain;
    chain = (input, ctx) => handler(input, ctx, () => inner(input, ctx));
  }
  return chain;
}

// ---------------------------------------------------------------------------
// MCP tool calls (SR 3.5, 4.4)
// ---------------------------------------------------------------------------

export const MOCK_TOOL_RESULT_PREFIX = "TOOL_RESULT:";

export interface MockToolOutcome {
  text: string;
  isError: boolean;
  contentTypes: string[];
}

function mcpUrlOf(session: MockSession): string | null {
  for (const server of session.mcpServers) {
    const url = asString(asObject(server).url);
    if (url) return url;
  }
  return null;
}

async function mcpPost(url: string, method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
    signal,
  });
  if (res.status === 202) return {};
  const body: unknown = await res.json().catch(() => ({}));
  return asObject(body);
}

/** First tool `tools/list` returns, unless `--scenario tool-name=<n>` names one. */
async function pickTool(ctx: MockContext, session: MockSession): Promise<string> {
  const named = ctx.args.scenarioParams["tool-name"];
  if (named) return named;
  const url = mcpUrlOf(session);
  if (!url) return "read";
  const list = asObject((await mcpPost(url, "tools/list", {})).result);
  const tools = Array.isArray(list.tools) ? list.tools : [];
  return asString(asObject(tools[0]).name) ?? "read";
}

/** Permission request, then `tools/call` on the session's MCP URL. `abortAfterMs` drops the HTTP request (`mcp-drop`). */
export async function callMcpTool(
  ctx: MockContext,
  session: MockSession,
  toolName: string,
  args: JsonObject,
  opts: { abortAfterMs?: number } = {},
): Promise<MockToolOutcome> {
  const permission = await ctx.request("session/request_permission", {
    sessionId: session.id,
    // The shape agy 1.5.15 sends for an MCP call (live smoke test): name call_mcp_tool, kind execute,
    // the same three keys in args and rawInput.
    toolCall: {
      toolCallId: `tc_${randomUUID().slice(0, 8)}`,
      name: "call_mcp_tool",
      kind: "execute",
      title: "call_mcp_tool",
      args: { ServerName: "opencode", ToolName: toolName, Arguments: args },
      rawInput: { ServerName: "opencode", ToolName: toolName, Arguments: args },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  const outcome = permission.ok ? asObject(asObject(permission.result).outcome) : {};
  if (outcome.optionId !== "allow") {
    ctx.record("mcp/denied", { toolName, optionId: asString(outcome.optionId) }, session.id);
    return { text: "denied", isError: true, contentTypes: [] };
  }
  const url = mcpUrlOf(session);
  if (!url) {
    ctx.record("mcp/error", { toolName, reason: "no mcp server" }, session.id);
    return { text: "no mcp server", isError: true, contentTypes: [] };
  }
  ctx.record("mcp/call", { toolName, scopePath: new URL(url).pathname.split("/").slice(3).join("/") }, session.id);
  const controller = new AbortController();
  const timer = opts.abortAfterMs !== undefined ? setTimeout(() => controller.abort(), opts.abortAfterMs) : null;
  try {
    const body = await mcpPost(
      url,
      "tools/call",
      { name: toolName, arguments: args, _meta: { "antigravity.google/conversation_id": session.id } },
      controller.signal,
    );
    const result = asObject(body.result);
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map((c) => asString(asObject(c).text) ?? "").join("");
    const contentTypes = content.map((c) => asString(asObject(c).type) ?? "?");
    const isError = result.isError === true;
    ctx.record("mcp/result", { toolName, text, isError, contentTypes }, session.id);
    return { text, isError, contentTypes };
  } catch (err) {
    ctx.record("mcp/error", { toolName, reason: errorText(err) }, session.id);
    return { text: "", isError: true, contentTypes: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The error step agy 1.5.15 writes after its 429 retries (browser test run 2). */
export function agy15ErrorStep(attempt: number): string {
  return `API error (attempt ${attempt}): transport error (ResourceExhausted, HTTP 429): Resource has been exhausted (e.g. check quota).: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).`;
}

function thought(ctx: MockContext, session: MockSession): void {
  ctx.update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: MOCK_THOUGHT_TEXT } });
}

function message(ctx: MockContext, session: MockSession, text: string): void {
  ctx.update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

function numberParam(ctx: MockContext, name: string, fallback: number): number {
  const value = Number(ctx.args.scenarioParams[name] ?? String(fallback));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Writes agy's error step (`step_type = 17`) into the conversation DB, as agy 1.5.x does (SR 6.5). */
async function writeErrorStep(ctx: MockContext, session: MockSession, payload: string): Promise<void> {
  if (!ctx.args.geminiDir) return;
  const dir = path.join(ctx.args.geminiDir, "antigravity-acp", "conversations");
  mkdirSync(dir, { recursive: true });
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(dir, `${session.id}.db`), { create: true });
  db.run("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)");
  const row = db.query("SELECT COUNT(*) AS n FROM steps").get();
  const n = Number(asObject(row).n ?? 0);
  db.run("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)", n, 5, "user input");
  db.run("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)", n + 1, 17, payload);
  db.close();
}

/** agy's retry line format, from T3 Code's profile logs (SR 1). */
export function mockRetryLine(attempt: number, model: string, delay: string): string {
  return `I1124 10:09:02.372424  669 run.go:308] Run: attempt ${attempt} failed (transport error (Unavailable, HTTP 503): No capacity available for model ${model} on the server: try later), retrying in ${delay}`;
}

const STEER_BUSY_TEXT = "the running prompt is being cancelled; wait for it to finish, then send this prompt again";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function withCapabilities(
  r: MockInitializeResult,
  patch: Partial<MockInitializeResult["agentCapabilities"]>,
): MockInitializeResult {
  return { ...r, agentCapabilities: { ...r.agentCapabilities, ...patch } };
}

let busySteerUsed = false;
const toolSessions = new Set<string>();

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  text: {
    description: "Default. One thought chunk, one message chunk, end_turn.",
  },

  // Identity switches for the install design's check (IA 6.5, 15.3 item 8) and the runtime's flags (SR 3.2).
  "wrong-name": {
    description: "agentInfo.name is not Antigravity's.",
    initialize: (r) => ({ ...r, agentInfo: { ...r.agentInfo, name: "Some Other ACP Server" } }),
  },
  "no-logout": {
    description: "agentCapabilities.auth.logout is absent.",
    initialize: (r) => withCapabilities(r, { auth: {} }),
  },
  "no-oauth-personal": {
    description: "authMethods lacks oauth-personal.",
    initialize: (r) => ({ ...r, authMethods: r.authMethods.filter((m) => m.id !== "oauth-personal") }),
  },
  "no-load-session": {
    description: "loadSession is false.",
    initialize: (r) => withCapabilities(r, { loadSession: false }),
  },
  "no-resume": {
    description: "sessionCapabilities.resume is absent.",
    initialize: (r) => {
      const { resume: _resume, ...rest } = r.agentCapabilities.sessionCapabilities;
      return withCapabilities(r, { sessionCapabilities: rest });
    },
  },
  "no-close": {
    description: "sessionCapabilities.close is absent.",
    initialize: (r) => {
      const { close: _close, ...rest } = r.agentCapabilities.sessionCapabilities;
      return withCapabilities(r, { sessionCapabilities: rest });
    },
  },
  "no-append": {
    description: "_meta.antigravity.systemPrompt.append is false.",
    initialize: (r) =>
      withCapabilities(r, { _meta: { antigravity: { ...r.agentCapabilities._meta.antigravity, systemPrompt: { append: false } } } }),
  },

  // Sign-in failures.
  unauth: {
    description: "authenticate answers ACP -32000.",
    methods: {
      authenticate(req, ctx) {
        ctx.replyError(req.id, -32000, "Authentication required");
      },
    },
  },
  "signed-out": {
    description: "authenticate answers -32603 with agy's real no-browser text (IA 2.3).",
    methods: {
      authenticate(req, ctx) {
        ctx.replyError(req.id, -32603, MOCK_NO_BROWSER_MESSAGE);
      },
    },
  },

  // Process behaviors.
  "slow-start": {
    description: "Waits before answering initialize: `slow-start=<ms>`, default 3000 ms (SR 11).",
    methods: {
      async initialize(req, ctx, next) {
        const ms = Number(ctx.args.scenarioParams["slow-start"] ?? "3000");
        await sleep(Number.isFinite(ms) && ms >= 0 ? ms : 3000);
        await next();
      },
    },
  },

  // Prompt behaviors.
  stall: {
    description: "One thought chunk, then silence until session/cancel.",
    prompt: async ({ session, signal }, ctx) => {
      ctx.update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: MOCK_THOUGHT_TEXT } });
      await waitForAbort(signal);
      return { stopReason: "cancelled" };
    },
  },
  "slow-new": {
    description: "Waits `slow-new=<ms>` (default 300) before answering session/new.",
    methods: {
      async "session/new"(_req, ctx, next) {
        await sleep(numberParam(ctx, "slow-new", 300));
        await next();
      },
    },
  },
  "slow-config": {
    description: "Waits `slow-config=<ms>` (default 300) before answering session/set_config_option.",
    methods: {
      async "session/set_config_option"(_req, ctx, next) {
        await sleep(numberParam(ctx, "slow-config", 300));
        await next();
      },
    },
  },
  "stall-on": {
    description: "`stall-on=<text>`: a prompt whose text contains <text> sends nothing until session/cancel; other prompts run normally.",
    prompt: async (input, ctx, next) => {
      const match = ctx.args.scenarioParams["stall-on"] ?? "";
      if (!match || !input.text.includes(match)) return next();
      await waitForAbort(input.signal);
      return { stopReason: "cancelled" };
    },
  },
  echo: {
    description: "Replies `ECHO:<prompt text>`, so tests see what agy received.",
    prompt: async ({ session, text }, ctx) => {
      message(ctx, session, `ECHO:${text}`);
      return { stopReason: "end_turn", usage: USAGE };
    },
  },
  tools: {
    description:
      "`tools=<n>` (default 1) MCP calls one after another, each result streamed as `TOOL_RESULT:<text>`, then end_turn. Only the first prompt of a session calls tools; later ones (steering) run the scenarios before it.",
    prompt: async ({ session, signal }, ctx, next) => {
      if (toolSessions.has(session.id)) return next();
      toolSessions.add(session.id);
      thought(ctx, session);
      const rounds = numberParam(ctx, "tools", 1);
      for (let i = 0; i < rounds; i++) {
        const tool = await pickTool(ctx, session);
        const res = await callMcpTool(ctx, session, tool, { path: `file-${i}.ts` });
        if (signal.aborted) return { stopReason: "cancelled" };
        message(ctx, session, `${MOCK_TOOL_RESULT_PREFIX}${res.text}`);
      }
      if (ctx.args.scenarios.includes("hold")) {
        await waitForAbort(signal);
        return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn", usage: USAGE };
    },
  },
  hold: {
    description: "Parameter only: `tools` keeps its prompt running after the last result until it is cancelled or superseded (steering).",
  },
  "builtin-permission": {
    description:
      "Before the rest of the prompt, asks permission for the built-in `run_command` and records the chosen option as `builtin/permission`. Put it after the scenario it wraps (`tools,builtin-permission`).",
    prompt: async (input, ctx, next) => {
      const permission = await ctx.request("session/request_permission", {
        sessionId: input.session.id,
        toolCall: { toolCallId: `tc_${randomUUID().slice(0, 8)}`, name: "run_command", args: { CommandLine: "cat secret-canary.txt" } },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      const outcome = permission.ok ? asObject(asObject(permission.result).outcome) : {};
      ctx.record("builtin/permission", { optionId: asString(outcome.optionId) ?? null }, input.session.id);
      // N-8: a built-in tool without a name whose model arguments carry an injected MCP server and tool.
      const injected = await ctx.request("session/request_permission", {
        sessionId: input.session.id,
        toolCall: {
          toolCallId: `tc_${randomUUID().slice(0, 8)}`,
          kind: "execute",
          rawInput: { ServerName: "opencode", ToolName: "read", CommandLine: "rm -rf ~" },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      const injectedOutcome = injected.ok ? asObject(asObject(injected.result).outcome) : {};
      ctx.record("builtin/injected-permission", { optionId: asString(injectedOutcome.optionId) ?? null }, input.session.id);
      return next();
    },
  },
  "tool-name": {
    description: "Parameter only: `tool-name=<name>` makes the tool scenarios call that tool instead of the first one listed.",
  },
  parallel: {
    description: "Two MCP calls at once, then both results and end_turn.",
    prompt: async ({ session, signal }, ctx) => {
      thought(ctx, session);
      const tool = await pickTool(ctx, session);
      const results = await Promise.all([
        callMcpTool(ctx, session, tool, { path: "a.ts" }),
        callMcpTool(ctx, session, tool, { path: "b.ts" }),
      ]);
      if (signal.aborted) return { stopReason: "cancelled" };
      message(ctx, session, results.map((r) => `${MOCK_TOOL_RESULT_PREFIX}${r.text}`).join("|"));
      return { stopReason: "end_turn", usage: USAGE };
    },
  },
  "late-call": {
    description: "A second MCP call `late-call=<ms>` (default 400) after the first, after the settle window.",
    prompt: async ({ session, signal }, ctx) => {
      thought(ctx, session);
      const tool = await pickTool(ctx, session);
      const first = callMcpTool(ctx, session, tool, { path: "first.ts" });
      await sleep(numberParam(ctx, "late-call", 400));
      const second = callMcpTool(ctx, session, tool, { path: "second.ts" });
      const results = await Promise.all([first, second]);
      if (signal.aborted) return { stopReason: "cancelled" };
      message(ctx, session, results.map((r) => `${MOCK_TOOL_RESULT_PREFIX}${r.text}`).join("|"));
      return { stopReason: "end_turn", usage: USAGE };
    },
  },
  "mcp-drop": {
    description: "Aborts its parked tools/call HTTP request after `mcp-drop=<ms>` (default 200), then waits for session/cancel.",
    prompt: async ({ session, signal }, ctx) => {
      thought(ctx, session);
      const tool = await pickTool(ctx, session);
      await callMcpTool(ctx, session, tool, { path: "dropped.ts" }, { abortAfterMs: numberParam(ctx, "mcp-drop", 200) });
      await waitForAbort(signal);
      return { stopReason: "cancelled" };
    },
  },

  // Crashes.
  "crash-mid-stream": {
    description: "Exits 137 after the first message chunk.",
    prompt: async ({ session }, ctx) => {
      thought(ctx, session);
      message(ctx, session, "partial ");
      await sleep(50);
      ctx.record("crash", {}, session.id);
      return ctx.exit(137);
    },
  },
  "crash-parked": {
    description: "Exits 137 `crash-parked=<ms>` (default 200) after opening an MCP call.",
    prompt: async ({ session }, ctx) => {
      thought(ctx, session);
      const tool = await pickTool(ctx, session);
      void callMcpTool(ctx, session, tool, { path: "crash.ts" });
      await sleep(numberParam(ctx, "crash-parked", 200));
      ctx.record("crash", {}, session.id);
      return ctx.exit(137);
    },
  },
  "start-crash": {
    description: "Exits 1 before answering initialize.",
    onStart: (ctx) => {
      ctx.record("start-crash");
      ctx.exit(1);
    },
  },

  // Retries, error steps, refusal.
  "retry-log": {
    description:
      "Appends a real-format retry line for the session's model to --log-file, then stays silent until session/cancel (`retry-log=<ms>` replies normally after that many ms instead).",
    prompt: async (input, ctx, next) => {
      const { session, signal } = input;
      const before = numberParam(ctx, "retry-log-after", 0);
      if (before > 0) await sleep(before);
      if (ctx.args.logFile) {
        mkdirSync(path.dirname(ctx.args.logFile), { recursive: true });
        appendFileSync(ctx.args.logFile, `${mockRetryLine(3, `${session.model}-${session.thoughtLevel}`, "1m0.104941814s")}\n`);
      }
      ctx.record("retry-log", {}, session.id);
      const after = ctx.args.scenarioParams["retry-log"];
      if (after !== undefined) {
        await sleep(numberParam(ctx, "retry-log", 0));
        return next();
      }
      await waitForAbort(signal);
      return { stopReason: "cancelled" };
    },
  },
  "retry-log-after": {
    description: "Parameter only: `retry-log-after=<ms>` makes `retry-log` wait that long before it writes its line.",
  },
  "strict-models": {
    description: "session/set_config_option for a model the mock does not list answers agy's real `Unknown model ID: <id>` error.",
    methods: {
      async "session/set_config_option"(req, ctx, next) {
        const value = asString(req.params.value) ?? "";
        const known = [MOCK_DEFAULT_MODEL, "gemini-4-neon"];
        if (asString(req.params.configId) === "model" && !known.includes(value)) {
          ctx.replyError(req.id, -32603, `Unknown model ID: ${value}`);
          return;
        }
        await next();
      },
    },
  },
  "error-mcp-url": {
    description: "session/prompt fails with agy's MCP transport error, which quotes the session's MCP URL (and its token).",
    prompt: async ({ session }) => {
      throw new Error(`MCP server opencode failed: Post "${mcpUrlOf(session) ?? "http://127.0.0.1/mcp/none"}": dial tcp: connection refused`);
    },
  },
  "error-step": {
    description:
      "Writes a type 17 step `Error 429 ... RESOURCE_EXHAUSTED`, streams an error text, end_turn. `error-step=<n>` writes agy 1.5.15's format instead, `API error (attempt <n>): transport error (ResourceExhausted, HTTP 429): ...`.",
    prompt: async ({ session }, ctx) => {
      const attempt = ctx.args.scenarioParams["error-step"];
      await writeErrorStep(ctx, session, attempt ? agy15ErrorStep(Number(attempt)) : "Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED");
      message(ctx, session, "Error: Resource has been exhausted");
      return { stopReason: "end_turn", usage: USAGE };
    },
  },
  "quota-step": {
    description: "Like error-step with `reason:QUOTA_EXHAUSTED`.",
    prompt: async ({ session }, ctx) => {
      await writeErrorStep(ctx, session, "Error 429, Message: Quota exceeded reason:QUOTA_EXHAUSTED, Status: RESOURCE_EXHAUSTED");
      message(ctx, session, "Error: quota");
      return { stopReason: "end_turn", usage: USAGE };
    },
  },
  refusal: {
    description: "stopReason refusal without an error step.",
    prompt: async () => ({ stopReason: "refusal" }),
  },

  // Steering and cancel.
  "busy-steer": {
    description: "The first prompt sent while another runs on the session answers agy's `being cancelled` text once.",
    methods: {
      async "session/prompt"(req, ctx, next) {
        const session = ctx.sessions.get(asString(req.params.sessionId) ?? "");
        if (session?.running && !busySteerUsed) {
          busySteerUsed = true;
          ctx.replyError(req.id, -32603, STEER_BUSY_TEXT);
          return;
        }
        await next();
      },
    },
  },
  "cancel-hang": {
    description: "Ignores session/cancel; the running prompt never replies.",
    notifications: {
      "session/cancel"(params, ctx) {
        ctx.record("cancel-ignored", {}, asString(params.sessionId));
      },
    },
  },

  // Sign-in line (IA 15.3 item 3).
  "auth-url-line": {
    description: "Prints agy's sign-in line on stdout instead of answering authenticate.",
    methods: {
      authenticate(_req, ctx) {
        ctx.writeStdout(`${AUTH_URL_STDOUT_PREFIX}https://accounts.google.com/o/oauth2/auth?state=mock-state`);
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): MockArgs {
  let scenario = env.MOCK_AGY_SCENARIO ?? "text";
  let journal = env.MOCK_AGY_JOURNAL ?? null;
  let agyVersion = env.MOCK_AGY_VERSION ?? MOCK_AGY_DEFAULT_VERSION;
  const agyArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--scenario" && next !== undefined) {
      scenario = next;
      i++;
    } else if (arg === "--journal" && next !== undefined) {
      journal = next;
      i++;
    } else if (arg === "--agy-version" && next !== undefined) {
      agyVersion = next;
      i++;
    } else if (arg !== undefined) {
      agyArgv.push(arg);
    }
  }
  const valueOf = (flag: string): string | null => {
    const at = agyArgv.indexOf(flag);
    const inline = agyArgv.find((a) => a.startsWith(`${flag}=`));
    if (at >= 0) return agyArgv[at + 1] ?? null;
    return inline ? inline.slice(flag.length + 1) : null;
  };
  const scenarios: string[] = [];
  const scenarioParams: Record<string, string> = {};
  for (const item of scenario.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = item.indexOf("=");
    const name = eq >= 0 ? item.slice(0, eq) : item;
    scenarios.push(name);
    if (eq >= 0) scenarioParams[name] = item.slice(eq + 1);
  }
  return {
    scenarios,
    scenarioParams,
    journal,
    agyVersion,
    agyArgv,
    geminiDir: valueOf("--gemini-dir"),
    logFile: valueOf("--log-file"),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), process.env);

  if (args.agyArgv.includes("--version")) {
    process.stdout.write(`${args.agyVersion}\n`);
    process.exit(0);
  }
  if (args.agyArgv[0] !== "acp") {
    process.stderr.write("mock-agy: only `acp` is implemented\n");
    process.exit(2);
  }
  if (args.agyArgv.includes("--login")) {
    process.stderr.write("mock-agy: `--login` is not implemented here; see test/fixtures/mock-agy-login.ts\n");
    process.exit(2);
  }

  const scenarios: Scenario[] = [];
  for (const name of args.scenarios) {
    const scenario = ownEntry(SCENARIOS, name);
    if (!scenario) {
      process.stderr.write(`mock-agy: unknown scenario ${name}\n`);
      process.exit(2);
    }
    scenarios.push(scenario);
  }

  const send = (msg: JsonObject): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const writeJournal = (entry: JournalEntry): void => {
    if (!args.journal) return;
    try {
      appendFileSync(args.journal, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      process.stderr.write(`mock-agy: journal write failed: ${errorText(err)}\n`);
    }
  };
  const journalRpc = (method: string, id: JsonRpcId | null, params: JsonObject): void => {
    const blocks = method === "session/prompt" && Array.isArray(params.prompt) ? params.prompt : null;
    writeJournal({
      at: Date.now(),
      pid: process.pid,
      method,
      id,
      sessionId: asString(params.sessionId),
      promptText: blocks ? promptText(blocks) : null,
      params,
    });
  };

  const clientWaiters = new Map<JsonRpcId, { method: string; resolve: (r: ClientResponse) => void }>();
  let nextClientId = 9000;

  const ctx: MockContext = {
    args,
    sessions: new Map(),
    reply: (id, result) => send({ jsonrpc: "2.0", id, result }),
    replyError: (id, code, message, data) =>
      send({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } }),
    update: (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }),
    notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
    request: (method, params) => {
      const id = nextClientId++;
      return new Promise((resolve) => {
        clientWaiters.set(id, { method, resolve });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    record: (method, params = {}, sessionId = null) =>
      writeJournal({ at: Date.now(), pid: process.pid, method, id: null, sessionId, promptText: null, params }),
    writeStdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    writeStderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    exit: (code) => process.exit(code),
  };

  const base = baseMethods(scenarios, composePrompt(scenarios));
  const methodCache = new Map<string, BoundMethod>();
  const methodFor = (method: string): BoundMethod => {
    const cached = methodCache.get(method);
    if (cached) return cached;
    const composed = composeMethod(method, base.get(method) ?? methodNotFound, scenarios);
    methodCache.set(method, composed);
    return composed;
  };
  const notifications = baseNotifications();
  const notificationFor = (name: string): BoundNotification =>
    composeNotification(name, notifications.get(name) ?? (() => {}), scenarios);

  const handleLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      ctx.writeStderr("mock-agy: ignoring a non-JSON stdin line");
      return;
    }
    if (!isObject(parsed)) return;
    const method = asString(parsed.method);
    const id = isRpcId(parsed.id) ? parsed.id : null;
    if (method === null) {
      // A client response to one of our requests.
      const waiter = id === null ? undefined : clientWaiters.get(id);
      if (id === null || !waiter) return;
      clientWaiters.delete(id);
      const response: ClientResponse =
        parsed.error === undefined ? { ok: true, result: parsed.result } : { ok: false, error: parsed.error };
      journalRpc(JOURNAL_CLIENT_RESPONSE, id, { requestMethod: waiter.method, ...response });
      waiter.resolve(response);
      return;
    }
    const params = asObject(parsed.params);
    journalRpc(method, id, params);
    if (id === null) {
      try {
        notificationFor(method)(params, ctx);
      } catch (err) {
        ctx.writeStderr(`mock-agy: notification ${method} failed: ${errorText(err)}`);
      }
      return;
    }
    try {
      await methodFor(method)({ id, method, params }, ctx);
    } catch (err) {
      ctx.replyError(id, -32603, errorText(err));
    }
  };

  // Which agent file this process was started with, so tests can tell pools apart (review L-1).
  const agentAt = args.agyArgv.indexOf("--agent");
  ctx.record("process/start", { agent: agentAt >= 0 ? (args.agyArgv[agentAt + 1] ?? null) : null });
  for (const scenario of scenarios) scenario.onStart?.(ctx);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleLine(line);
  });
  // agy exits on its own when stdin closes (SR 3.4).
  rl.on("close", () => process.exit(0));
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export interface MockAgyWrapperOptions {
  scenario?: string | readonly string[];
  journal?: string;
  agyVersion?: string;
  /** File name of the wrapper, default `agy` (`agy.cmd` on Windows). */
  name?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Writes an executable into `dir` that runs this fixture with the given scenario and journal. Returns its path.
 *  Calling it again with the same `dir` and `name` replaces the wrapper, so a test can change the scenario
 *  between two spawns (crash once, then work). */
export function writeMockAgyWrapper(dir: string, opts: MockAgyWrapperOptions = {}): string {
  const flags: string[] = [];
  if (opts.scenario !== undefined) {
    flags.push("--scenario", typeof opts.scenario === "string" ? opts.scenario : opts.scenario.join(","));
  }
  if (opts.journal !== undefined) flags.push("--journal", opts.journal);
  if (opts.agyVersion !== undefined) flags.push("--agy-version", opts.agyVersion);

  if (process.platform === "win32") {
    const file = path.join(dir, opts.name ?? "agy.cmd");
    const quoted = [process.execPath, MOCK_AGY_PATH, ...flags].map((a) => `"${a}"`).join(" ");
    writeFileSync(file, `@echo off\r\n${quoted} %*\r\n`);
    return file;
  }
  const file = path.join(dir, opts.name ?? "agy");
  const quoted = [process.execPath, MOCK_AGY_PATH, ...flags].map(shellQuote).join(" ");
  writeFileSync(file, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/** Entries the fake appended to `file`, in order. A missing file is an empty journal. */
export function readJournal(file: string): JournalEntry[] {
  if (!existsSync(file)) return [];
  const entries: JournalEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = toJournalEntry(JSON.parse(line));
    if (entry) entries.push(entry);
  }
  return entries;
}

function toJournalEntry(value: unknown): JournalEntry | null {
  if (!isObject(value) || typeof value.method !== "string") return null;
  return {
    at: typeof value.at === "number" ? value.at : 0,
    pid: typeof value.pid === "number" ? value.pid : 0,
    method: value.method,
    id: isRpcId(value.id) ? value.id : null,
    sessionId: asString(value.sessionId),
    promptText: asString(value.promptText),
    params: asObject(value.params),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === MOCK_AGY_PATH;
}

if (isMainModule()) main();
