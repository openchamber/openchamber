// A real AntigravityProxy over loopback HTTP against the fake agy, with stub session modules (WP-B1):
// every main request is `fresh` unless it resumes a parked turn, bindings live in memory. A test can
// queue a plan (`modules.nextPlans`) to drive `append`, `redo` and dormant resume paths.
// `realModules: true` injects WP-B2's modules instead, as index.ts does: classification, prompts,
// replay, the profile files and the file-backed SessionStore under the harness data dir. `restart()`
// stops the proxy and starts a new one on the same dirs, the way a new OpenCode process would.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRuntimeConfig, type RuntimeConfig } from "../../src/config.ts";
import { HEADER_KIND, HEADER_META, HEADER_PROXY_TOKEN, HEADER_SESSION, HEADER_DIRECTORY, MARKER_ACCESS, META_KINDS, type RuntimeTimings } from "../../src/constants.ts";
import type {
  BindingLock,
  BindingRecord,
  ClassifyInput,
  ClassifyResult,
  InstallAuthBridge,
  MediaPart,
  OpenAiFunctionTool,
  OpenAiMessage,
  PermissionRequestParams,
  PermissionTurnView,
  PromptBlock,
  ProxySessionModules,
  RequestPlan,
  SessionAppend,
  SessionAppendInput,
  SessionStoreApi,
  ToolResult,
} from "../../src/contracts.ts";
import { classifyRequest, emittedHashes } from "../../src/fingerprint.ts";
import { createProfileApi } from "../../src/profile.ts";
import { buildSessionAppend, buildTurnPrompt } from "../../src/prompt.ts";
import { AntigravityProxy, type AntigravityProxyOptions } from "../../src/proxy.ts";
import { buildReplayPrompt } from "../../src/replay.ts";
import { MemorySessionStore, SessionStore } from "../../src/session-store.ts";
import { FakeInstallAuthBridge, type FakeBridgeOptions } from "./fake-bridge.ts";
import { readJournal, writeMockAgyWrapper, type JournalEntry } from "./mock-agy.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function textOf(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) if (part.type === "text" && typeof part.text === "string") out += part.text;
  return out;
}

function isMedia(part: { type: string }): part is MediaPart {
  return part.type !== "text";
}

export class MemoryStore implements SessionStoreApi {
  readonly records = new Map<string, BindingRecord>();
  readonly lockedElsewhere = new Set<string>();
  readonly ephemeral: string[] = [];
  readonly calls = { load: 0, save: 0, remove: 0, lock: 0 };

  async load(sessionKey: string, authEpoch: string): Promise<BindingRecord | null> {
    this.calls.load++;
    const r = this.records.get(sessionKey);
    return r && r.authEpoch === authEpoch ? { ...r } : null;
  }
  async save(record: BindingRecord): Promise<void> {
    this.calls.save++;
    this.records.set(record.sessionKey, { ...record, state: record.state === "live" ? "dormant" : record.state });
  }
  async remove(sessionKey: string): Promise<BindingRecord | null> {
    this.calls.remove++;
    const r = this.records.get(sessionKey) ?? null;
    this.records.delete(sessionKey);
    return r;
  }
  async lock(sessionKey: string): Promise<BindingLock | null> {
    this.calls.lock++;
    if (this.lockedElsewhere.has(sessionKey)) return null;
    return { sessionKey, release: async () => {} };
  }
  async recordEphemeral(acpSessionId: string): Promise<void> {
    this.ephemeral.push(acpSessionId);
  }
  async prune(): Promise<void> {}
  async close(): Promise<void> {}
  releaseLocksSync(): void {}
}

export interface StubModules extends ProxySessionModules {
  store: MemoryStore;
  /** Plans used, in order, instead of the stub's own decision for main requests. */
  nextPlans: RequestPlan[];
  classified: RequestPlan[];
  profileCalls: number;
}

/** SR 7.4 layer 3 as the stub understands it (the real one is WP-B2's profile.ts). */
function stubPermission(params: PermissionRequestParams, turn: PermissionTurnView | null): boolean {
  if (!turn || turn.done || !turn.allowTools) return false;
  const tc = params.toolCall;
  const args = tc?.args ?? tc?.rawInput ?? {};
  const name = tc?.name;
  if (name !== undefined && name !== "call_mcp_tool" && name !== "mcp_tool") return false;
  const server = args.ServerName ?? args.serverName ?? args.server_name;
  const tool = args.ToolName ?? args.toolName ?? args.tool_name;
  return server === "opencode" && typeof tool === "string" && tool.length > 0 && turn.allowedToolNames.has(tool);
}

function stubAppend(input: SessionAppendInput): SessionAppend {
  const system: string[] = [];
  for (const m of input.messages) {
    if (m.role !== "system" && m.role !== "developer") break;
    system.push(textOf(m.content));
  }
  const toolLines = input.meta ? [] : input.tools.map((t) => JSON.stringify(t.function));
  const text = [
    `<opencode_system_prompt>\n${system.join("\n\n")}\n</opencode_system_prompt>`,
    input.meta ? "Do not call any tools. Respond with text only." : `## Tool execution protocol\n<opencode_tools>\n${toolLines.join("\n")}\n</opencode_tools>`,
  ].join("\n\n");
  const toolsDescHashes: Record<string, string> = {};
  for (const t of input.tools) toolsDescHashes[t.function.name] = sha(t.function.description ?? "").slice(0, 16);
  return {
    text,
    systemHash: sha(system.join("\n\n")),
    toolsSchemaHash: sha(input.tools.map((t) => `${t.function.name}\t${JSON.stringify(t.function.parameters ?? {})}`).sort().join("\n")),
    toolsDescHashes,
    stats: { systemMessages: system.length, systemBytes: 0, systemOmittedBytes: 0, toolCount: input.tools.length, toolsBytes: 0, toolsLevel: 0, toolsSchemaOmitted: 0, toolsDropped: 0 },
  };
}

function stubReplay(messages: readonly OpenAiMessage[]): PromptBlock[] {
  const turns: string[] = [];
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const endsWithTools = messages.length > 0 && messages[messages.length - 1]?.role === "tool";
  const history = endsWithTools ? messages : messages.slice(0, lastUser >= 0 ? lastUser : messages.length);
  history.forEach((m, i) => {
    if (m.role === "system" || m.role === "developer") return;
    turns.push(`<turn n="${i}" role="${m.role}">${textOf(m.content)}</turn>`);
  });
  const blocks: PromptBlock[] = [{ type: "text", text: `<conversation_history>\n${turns.join("\n")}\n</conversation_history>\n` }];
  if (endsWithTools) {
    const results = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
    blocks.push({ type: "text", text: `<tool_results>${results.join("\n")}</tool_results>\nContinue the task using these tool results.` });
  } else if (lastUser >= 0) {
    blocks.push({ type: "text", text: textOf(messages[lastUser]?.content) });
  }
  return blocks;
}

function stubTurnPrompt(input: readonly OpenAiMessage[], reminders: readonly string[]): PromptBlock[] {
  const blocks: PromptBlock[] = reminders.map((r) => ({ type: "text", text: `<system-update>${r}</system-update>` }));
  for (const m of input) {
    const text = textOf(m.content);
    if (m.role === "system" || m.role === "developer") blocks.push({ type: "text", text: `<system-update>${text}</system-update>` });
    else if (text) blocks.push({ type: "text", text });
  }
  return blocks;
}

/** Every main request is fresh unless it resumes the parked turn (tool messages answering its ids). */
function stubClassify(modules: StubModules, input: ClassifyInput): ClassifyResult {
  const { request, parkedTurn, binding } = input;
  const prefix = { count: request.messages.length, hash: sha(JSON.stringify(request.messages)) };
  const decide = (plan: RequestPlan): ClassifyResult => {
    modules.classified.push(plan);
    return { plan, prefix };
  };
  if ((request.kind !== null && META_KINDS.has(request.kind)) || request.tools.length === 0) return decide({ kind: "meta" });
  if (!request.sessionKey) return decide({ kind: "ephemeral" });
  const queued = modules.nextPlans.shift();
  if (queued) return decide(queued);
  if (parkedTurn) {
    let start = request.messages.length;
    while (start > 0 && request.messages[start - 1]?.role !== "assistant") start--;
    const tail = request.messages.slice(start);
    const results: ToolResult[] = [];
    const media: MediaPart[] = [];
    const steer: OpenAiMessage[] = [];
    for (const m of tail) {
      if (m.role === "tool" && m.tool_call_id) results.push({ toolCallId: m.tool_call_id, content: textOf(m.content) });
      else if (m.role === "user" && Array.isArray(m.content) && results.length > 0 && steer.length === 0 && m.content.every(isMedia)) {
        for (const p of m.content) if (isMedia(p)) media.push(p);
      } else steer.push(m);
    }
    if (results.length > 0 && results.every((r) => parkedTurn.parkedToolCallIds.includes(r.toolCallId))) {
      return decide({ kind: "resume", results, media, steer });
    }
  }
  return decide({ kind: "fresh", reason: binding ? (binding.state === "tainted" ? "tainted" : "tail-mismatch") : "no-binding" });
}

export function stubSessionModules(): StubModules {
  const modules: StubModules = {
    store: new MemoryStore(),
    nextPlans: [],
    classified: [],
    profileCalls: 0,
    classify: (input) => stubClassify(modules, input),
    buildAppend: stubAppend,
    buildReplay: (messages) => stubReplay(messages),
    buildTurnPrompt: stubTurnPrompt,
    hashes: {
      emittedTextHash: (text) => (text.trimEnd() ? sha(text.trimEnd()) : null),
      toolArgsHash: (json) => sha(json),
    },
    profile: {
      prepareProfileDir: async () => {
        modules.profileCalls++;
        return { guard: "installed" };
      },
      matchMcpPermission: stubPermission,
      removeAgentFile: async () => {},
      removeAgentFileSync: () => {},
      sweepAgentFiles: async () => {},
    },
  };
  return modules;
}

/** Short internal limits so 2 s, 15 s and 30 s constants run in milliseconds. */
export const TEST_TIMINGS: Partial<RuntimeTimings> = {
  earlySseMs: 150,
  heartbeatMs: 200,
  downloadNoteMs: 100,
  toolSettleMs: 60,
  stdinExitGraceMs: 400,
  termExitGraceMs: 300,
  logPollMs: 40,
  reaperIntervalMs: 50,
  steerRetryMs: 100,
  resumeRetryMs: 30,
  wedgedCheckMs: 50,
  noteMinGapMs: 0,
  noteRepeatMs: 300,
  watchdogSliceMs: 1000,
  hostSleepSlackMs: 5000,
};

export interface HarnessOptions {
  scenario?: string | readonly string[];
  agyVersion?: string;
  options?: Record<string, unknown>;
  timings?: Partial<RuntimeTimings>;
  bridge?: Partial<Omit<FakeBridgeOptions, "geminiDir" | "binaryPath">>;
  proxy?: Partial<Pick<AntigravityProxyOptions, "configIssue" | "authStatus">>;
  /** Skip the wrapper (missing binary tests). */
  noBinary?: boolean;
  /** Inject WP-B2's real session modules instead of the stubs. */
  realModules?: boolean;
}

/** WP-B2's modules wired the way index.ts wires them. A new call is a new store instance (a new process). */
export function realSessionModules(input: {
  dataDir: string;
  bridge: Pick<InstallAuthBridge, "geminiDir" | "authEpoch" | "isPluginOwnedProfile">;
  sessionStore: boolean;
  sessionTtlDays?: number;
  maxStoredSessions?: number;
}): ProxySessionModules & { store: SessionStoreApi } {
  const store: SessionStoreApi = input.sessionStore
    ? new SessionStore({
        dataDir: input.dataDir,
        geminiDir: input.bridge.geminiDir,
        poolId: randomBytes(8).toString("hex"),
        authEpoch: () => input.bridge.authEpoch(),
        isPluginOwnedProfile: () => input.bridge.isPluginOwnedProfile(),
        sessionTtlDays: input.sessionTtlDays ?? 14,
        maxStoredSessions: input.maxStoredSessions ?? 500,
      })
    : new MemorySessionStore();
  return {
    classify: classifyRequest,
    store,
    buildAppend: (i) => buildSessionAppend(i, "opencode"),
    buildReplay: buildReplayPrompt,
    buildTurnPrompt,
    hashes: emittedHashes,
    profile: createProfileApi({ agentName: "opencode-bridge", mcpServerName: "opencode" }),
  };
}

export interface ChatOptions {
  messages: OpenAiMessage[];
  tools?: OpenAiFunctionTool[];
  stream?: boolean;
  session?: string | null;
  kind?: string;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface SseEvent {
  data: Record<string, unknown> | null;
  raw: string;
}

export interface ChatResult {
  status: number;
  headers: Headers;
  events: SseEvent[];
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  error: { code: number; type: string; message: string } | null;
  body: Record<string, unknown> | null;
  pings: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSse(raw: string): { events: SseEvent[]; pings: number } {
  const events: SseEvent[] = [];
  let pings = 0;
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line) continue;
    if (line.startsWith(": ping")) {
      pings++;
      continue;
    }
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") {
      events.push({ data: null, raw: payload });
      continue;
    }
    const parsed: unknown = JSON.parse(payload);
    events.push({ data: isRecord(parsed) ? parsed : null, raw: payload });
  }
  return { events, pings };
}

export function summarize(status: number, headers: Headers, raw: string, isSse: boolean): ChatResult {
  const result: ChatResult = { status, headers, events: [], text: "", reasoning: "", toolCalls: [], finishReason: null, error: null, body: null, pings: 0 };
  if (!isSse) {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    result.body = isRecord(parsed) ? parsed : null;
    const err = result.body?.error;
    if (isRecord(err)) result.error = { code: status, type: String(err.type ?? ""), message: String(err.message ?? "") };
    const choice = Array.isArray(result.body?.choices) ? result.body?.choices[0] : undefined;
    if (isRecord(choice)) {
      result.finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
      const message = isRecord(choice.message) ? choice.message : {};
      result.text = typeof message.content === "string" ? message.content : "";
      result.reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
      for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (isRecord(tc) && isRecord(tc.function)) {
          result.toolCalls.push({ id: String(tc.id), name: String(tc.function.name), arguments: String(tc.function.arguments) });
        }
      }
    }
    return result;
  }
  const { events, pings } = parseSse(raw);
  result.events = events;
  result.pings = pings;
  for (const e of events) {
    const data = e.data;
    if (!data) continue;
    if (isRecord(data.error)) {
      result.error = { code: Number(data.error.code), type: String(data.error.type), message: String(data.error.message) };
      continue;
    }
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === "string") result.text += delta.content;
    if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content;
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (isRecord(tc) && isRecord(tc.function)) {
        result.toolCalls.push({ id: String(tc.id), name: String(tc.function.name), arguments: String(tc.function.arguments) });
      }
    }
    if (typeof choice.finish_reason === "string") result.finishReason = choice.finish_reason;
  }
  return result;
}

export const READ_TOOL: OpenAiFunctionTool = {
  type: "function",
  function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
};

export const SYSTEM: OpenAiMessage = { role: "system", content: "You are OpenCode." };

export function user(text: string): OpenAiMessage {
  return { role: "user", content: text };
}

/** The assistant message OpenCode echoes after a tool_calls response, plus one tool message per call. */
export function toolRound(result: ChatResult, contents: (id: string, i: number) => string = () => "file contents"): OpenAiMessage[] {
  return [
    {
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    },
    ...result.toolCalls.map((c, i): OpenAiMessage => ({ role: "tool", tool_call_id: c.id, content: contents(c.id, i) })),
  ];
}

export class Harness {
  readonly dir: string;
  readonly geminiDir: string;
  readonly dataDir: string;
  readonly runRoot: string;
  readonly journalFile: string;
  readonly binary: string;
  readonly bridge: FakeInstallAuthBridge;
  /** The stubs; unused when `realModules` is set. */
  readonly modules: StubModules;
  /** What the proxy was given: `modules`, or the real WP-B2 set. Replaced by `restart()`. */
  session: ProxySessionModules;
  proxy: AntigravityProxy;
  readonly logs: string[] = [];
  private readonly opts: HarnessOptions;
  private readonly config: RuntimeConfig;

  constructor(opts: HarnessOptions = {}) {
    this.opts = opts;
    this.dir = mkdtempSync(path.join(tmpdir(), "agy-e2e-"));
    this.geminiDir = path.join(this.dir, "gemini");
    this.dataDir = path.join(this.dir, "data");
    this.runRoot = path.join(this.dir, "run");
    this.journalFile = path.join(this.dir, "journal.jsonl");
    this.binary = writeMockAgyWrapper(this.dir, { scenario: opts.scenario ?? "text", journal: this.journalFile, agyVersion: opts.agyVersion });
    this.bridge = new FakeInstallAuthBridge({
      geminiDir: this.geminiDir,
      binaryPath: opts.noBinary ? undefined : this.binary,
      ...opts.bridge,
    });
    const { config } = resolveRuntimeConfig(
      {
        stallTimeoutMs: 800,
        retryStallTimeoutMs: 1200,
        statusNoteAfterMs: 200,
        cancelSettleMs: 600,
        idleShutdownMs: 0,
        breakerCooldownMs: 1000,
        debug: true,
        ...opts.options,
      },
      {},
      { ...TEST_TIMINGS, ...opts.timings },
    );
    this.config = config;
    this.modules = stubSessionModules();
    this.session = this.makeSession();
    this.proxy = this.makeProxy();
  }

  private makeSession(): ProxySessionModules {
    if (!this.opts.realModules) return this.modules;
    return realSessionModules({ dataDir: this.dataDir, bridge: this.bridge, sessionStore: this.config.sessionStore });
  }

  private makeProxy(): AntigravityProxy {
    const proxy = new AntigravityProxy({
      ...this.session,
      bridge: this.bridge,
      config: this.config,
      dataDir: this.dataDir,
      runRoot: this.runRoot,
      baseArgs: (g) => ["acp", "--gemini-dir", g, "--app-data-dir", "antigravity-acp"],
      discoverAfterSpawn: false,
      log: (line) => this.logs.push(line),
      ...this.opts.proxy,
    });
    this.bridge.attachRuntime(proxy.runtimeControl);
    return proxy;
  }

  /** Stops the proxy (and agy) and starts a new proxy, new modules and a new store on the same dirs. */
  async restart(): Promise<this> {
    await this.proxy.stop();
    this.session = this.makeSession();
    this.proxy = this.makeProxy();
    await this.proxy.start();
    return this;
  }

  async start(): Promise<this> {
    await this.proxy.start();
    return this;
  }

  /** Rewrites the wrapper: the next spawn runs another scenario. */
  setScenario(scenario: string | readonly string[], agyVersion?: string): void {
    writeMockAgyWrapper(this.dir, { scenario, journal: this.journalFile, agyVersion: agyVersion ?? this.opts.agyVersion });
  }

  journal(): JournalEntry[] {
    return readJournal(this.journalFile);
  }

  methods(): string[] {
    return this.journal().map((e) => e.method);
  }

  headers(opts: ChatOptions): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      [HEADER_PROXY_TOKEN]: this.proxy.proxyToken,
      authorization: `Bearer ${MARKER_ACCESS}`,
      [HEADER_DIRECTORY]: encodeURIComponent(this.dir),
      [HEADER_META]: Buffer.from(JSON.stringify({ modelId: opts.model ?? "gemini-3.8-flash", effort: opts.effort })).toString("base64url"),
    };
    if (opts.session !== null) h[HEADER_SESSION] = opts.session ?? "ses_test";
    if (opts.kind) h[HEADER_KIND] = opts.kind;
    return { ...h, ...opts.headers };
  }

  fetchChat(opts: ChatOptions): Promise<Response> {
    return fetch(`${this.proxy.url}/chat/completions`, {
      method: "POST",
      headers: this.headers(opts),
      body: JSON.stringify({ model: opts.model ?? "gemini-3.8-flash", messages: opts.messages, tools: opts.tools ?? [READ_TOOL], stream: opts.stream ?? true }),
      signal: opts.signal,
    });
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const res = await this.fetchChat(opts);
    const raw = await res.text();
    return summarize(res.status, res.headers, raw, (res.headers.get("content-type") ?? "").includes("text/event-stream"));
  }

  async close(): Promise<void> {
    await this.proxy.stop().catch(() => {});
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  return new Harness(opts).start();
}

export async function waitFor(check: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
