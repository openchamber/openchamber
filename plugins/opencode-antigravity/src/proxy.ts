// HTTP server and request dispatch (SR 8): route checks, the two-check `/v1` gate, `/mcp/<token>/<scope>`,
// `/health`, and the orchestration of one chat request: session mutex, classification (injected), turn
// registration, process lease, ACP session setup, prompt, binding update. Session logic (classify, store,
// prompt builders, profile) comes in through `ProxySessionModules`, so WP-B2's modules plug in unchanged.

import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { SIGNED_OUT_MESSAGE, SIGN_IN_GATE_MESSAGE } from "./auth/errors.ts";
import type { AcpClient, AcpConfigOption, AcpMcpServer } from "./acp-client.ts";
import { AgyLogTail, type RetryEvent } from "./agy-log-tail.ts";
import { AgyExitedError } from "./acp-client.ts";
import { AgyProcessManager, type ExitInfo, type Generation, type Spawner } from "./agy-process.ts";
import type { RuntimeConfig } from "./config.ts";
import {
  AGENT_NAME,
  DISCOVERY_DAILY_MS,
  HEADER_DIRECTORY,
  HEADER_KIND,
  HEADER_META,
  HEADER_PROXY_TOKEN,
  HEADER_SESSION,
  MARKER_ACCESS,
  MCP_SERVER_NAME,
  META_KINDS,
} from "./constants.ts";
import type {
  BindingLock,
  BindingRecord,
  ClassifyResult,
  CreateRunDir,
  EmittedToolCall,
  InstallAuthBridge,
  MediaPart,
  OpenAiContentPart,
  OpenAiFunctionTool,
  OpenAiMessage,
  OpenAiRole,
  OpenAiToolCall,
  ParkedTurnView,
  PermissionRequestParams,
  PersistedPlanKind,
  PromptBlock,
  ProviderFailure,
  ProxySessionModules,
  RequestPlan,
  RuntimeControl,
  SessionAppend,
  TaintReason,
  ToolGuardOutcome,
  ToolResult,
} from "./contracts.ts";
import { mapAcpError, toHttpError, type ErrorContext } from "./errors.ts";
import { McpBridge, POOL_SCOPE_ID, errorResult, type McpCallResult, type McpContent, type McpScope, type McpToolCall } from "./mcp-bridge.ts";
import { discoverAgyModels, inferLimits, loadCachedModels, saveCachedModels, type DiscoveredModel } from "./models.ts";
import type { PoolHandlers } from "./events.ts";
import { systemClock, noteText, type Clock } from "./stall-watchdog.ts";
import { createRunDir, OwnerRegistry, sweepStaleRunDirs } from "./tmp-sweeper.ts";
import { JsonResponder, SseResponder, Turn, toolCallsResponse, type EmittedCall, type TurnHooks, type TurnSink } from "./turn.ts";
import { lastStepIndex, readTurnErrorStep, type StepMark } from "./turn-outcome.ts";

/** The request named no model and no catalog is known: agy keeps the session's current model. */
export const AGY_DEFAULT_MODEL = "antigravity-default";

export interface AntigravityProxyOptions extends ProxySessionModules {
  bridge: InstallAuthBridge;
  config: RuntimeConfig;
  /** `resolveDataDir(env)`: child cwd, owner registry, model cache. */
  dataDir: string;
  /** `agyBaseArgs` from src/install/env.ts. */
  baseArgs: (geminiDir: string) => string[];
  /** Default: `createRunDir` of tmp-sweeper.ts under `runRoot`. */
  createRunDir?: CreateRunDir;
  /** Root of the private run dirs; default `<os.tmpdir()>/opencode-antigravity-<uid>` (see tmp-sweeper.ts). */
  runRoot?: string;
  /** An install/auth config issue such as an unsupported `authMethod`: chat requests answer 401 with it (SR 8.1). */
  configIssue?: string | null;
  /** `AuthState["kind"]` for /health. */
  authStatus?: () => string;
  /** Run model discovery after a spawn when the cached catalog is a day old (SR 3.3). Default true. */
  discoverAfterSpawn?: boolean;
  /** Called after a discovery changed the catalog, so the plugin can reload its provider. */
  onModelsChanged?: () => void;
  clock?: Clock;
  spawner?: Spawner;
  /** Debug log sink; default stderr. Only called when `config.debug`. */
  log?: (line: string) => void;
}

interface ChatRequest {
  messages: OpenAiMessage[];
  tools: OpenAiFunctionTool[];
  stream: boolean;
  model: string;
  effort: string | null;
  kind: string | null;
  sessionKey: string | null;
  cwd: string;
  signal: AbortSignal;
}

/** An ACP session alive in one generation. */
interface LiveAcp {
  generation: number;
  acpSessionId: string;
  scope: McpScope;
  model: string | null;
  thoughtLevel: string | null;
  canClose: boolean;
}

interface SessionEntry {
  key: string;
  record: BindingRecord | null;
  loaded: boolean;
  lock: BindingLock | null;
  live: LiveAcp | null;
  turn: Turn | null;
  lastUsedAt: number;
}

interface TurnState {
  /** Null for meta and ephemeral turns, which never touch a binding. */
  entry: SessionEntry | null;
  unsubscribe: () => void;
  stepMark: StepMark | null;
  /** The request's `toolsDescHashes`, written to the binding only when the turn ends `ok`, so a failed turn
   *  that carried a description reminder is redone with it (SR 7.5). Null when the turn does not move them. */
  descHashes: Record<string, string> | null;
}

/** What a resume does after its synchronous part under the session mutex. */
type ResumeStep =
  | { kind: "flush"; calls: EmittedCall[] }
  | { kind: "steer"; client: AcpClient; acpSessionId: string; blocks: PromptBlock[] }
  | { kind: "attach" }
  | { kind: "fallback" };

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
  const lower = (host ?? "").toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROLES: ReadonlySet<string> = new Set(["system", "developer", "user", "assistant", "tool"]);

function isRole(value: unknown): value is OpenAiRole {
  return typeof value === "string" && ROLES.has(value);
}

function parseContent(value: unknown): string | OpenAiContentPart[] | null | undefined {
  if (value === undefined || value === null || typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: OpenAiContentPart[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") continue;
    parts.push({ ...item, type: item.type });
  }
  return parts;
}

function parseToolCalls(value: unknown): OpenAiToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: OpenAiToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.function)) continue;
    const fn = item.function;
    if (typeof fn.name !== "string") continue;
    calls.push({ id: item.id, type: "function", function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "" } });
  }
  return calls;
}

export function parseMessages(value: unknown): OpenAiMessage[] {
  if (!Array.isArray(value)) return [];
  const out: OpenAiMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRole(item.role)) continue;
    const message: OpenAiMessage = { role: item.role };
    const content = parseContent(item.content);
    if (content !== undefined) message.content = content;
    const toolCalls = parseToolCalls(item.tool_calls);
    if (toolCalls) message.tool_calls = toolCalls;
    if (typeof item.tool_call_id === "string") message.tool_call_id = item.tool_call_id;
    if (typeof item.name === "string") message.name = item.name;
    if (typeof item.reasoning_content === "string") message.reasoning_content = item.reasoning_content;
    out.push(message);
  }
  return out;
}

export function parseTools(value: unknown): OpenAiFunctionTool[] {
  if (!Array.isArray(value)) return [];
  const out: OpenAiFunctionTool[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.type !== "function" || !isRecord(item.function)) continue;
    const fn = item.function;
    if (typeof fn.name !== "string" || !fn.name) continue;
    const tool: OpenAiFunctionTool = { type: "function", function: { name: fn.name } };
    if (typeof fn.description === "string") tool.function.description = fn.description;
    if (isRecord(fn.parameters)) tool.function.parameters = fn.parameters;
    out.push(tool);
  }
  return out;
}

function decodeMeta(raw: string | null): { modelId: string | null; effort: string | null } {
  if (!raw) return { modelId: null, effort: null };
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!isRecord(value)) return { modelId: null, effort: null };
    return {
      modelId: typeof value.modelId === "string" && value.modelId ? value.modelId : null,
      effort: typeof value.effort === "string" && value.effort ? value.effort : null,
    };
  } catch {
    return { modelId: null, effort: null };
  }
}

function isMediaPart(part: OpenAiContentPart): part is MediaPart {
  return part.type !== "text";
}

function textOf(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) if (part.type === "text" && typeof part.text === "string") text += part.text;
  return text;
}

function dataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m && m[1] && m[2] !== undefined ? { mimeType: m[1], data: m[2] } : null;
}

function stringField(part: MediaPart, outer: string, inner: string): string | null {
  const value: unknown = Reflect.get(part, outer);
  if (!isRecord(value)) return null;
  const field = value[inner];
  return typeof field === "string" ? field : null;
}

/** SR 4.4: tool-result media becomes MCP image or resource items; what cannot be forwarded becomes a line. */
export function mediaToMcp(media: readonly MediaPart[]): McpContent[] {
  const items: McpContent[] = [];
  const skipped: string[] = [];
  let n = 0;
  for (const part of media) {
    n++;
    if (part.type === "image_url") {
      const parsed = dataUrl(stringField(part, "image_url", "url") ?? "");
      if (parsed) {
        items.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
        continue;
      }
    } else if (part.type === "file") {
      const name = stringField(part, "file", "filename");
      const parsed = dataUrl(stringField(part, "file", "file_data") ?? "");
      if (parsed) {
        items.push({ type: "resource", resource: { uri: `opencode-attachment://${n}`, mimeType: parsed.mimeType, blob: parsed.data } });
        continue;
      }
      skipped.push(name ?? `attachment ${n}`);
      continue;
    }
    skipped.push(`attachment ${n}`);
  }
  if (skipped.length > 0) {
    items.push({ type: "text", text: `[The tool also returned ${skipped.length} attachment(s): ${skipped.join(", ")}. They could not be forwarded.]` });
  }
  return items;
}

function findConfigOption(options: readonly AcpConfigOption[], id: string): AcpConfigOption | undefined {
  return options.find((o) => o.category === id || o.id === id);
}

export class AntigravityProxy implements PoolHandlers {
  private readonly opts: AntigravityProxyOptions;
  private readonly config: RuntimeConfig;
  private readonly bridge: InstallAuthBridge;
  private readonly clock: Clock;
  private readonly poolId = randomBytes(8).toString("hex");
  /** Check 1 of the `/v1` gate (IA 13.3). */
  readonly proxyToken = randomBytes(32).toString("hex");
  private readonly mcpToken = randomBytes(24).toString("hex");
  private readonly mcp: McpBridge;
  private readonly manager: AgyProcessManager;
  private readonly owners: OwnerRegistry;
  private readonly runDirs: CreateRunDir;
  private readonly mutex = new KeyedMutex();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly turns = new Map<Turn, TurnState>();
  private readonly turnsByAcpSession = new Map<string, Turn>();
  private readonly turnsByToolCallId = new Map<string, Turn>();
  private readonly logTails = new Map<number, AgyLogTail>();
  private readonly deletedIds = new Map<string, number>();
  private readonly isolatedLive = new Map<Turn, LiveAcp>();
  /** Session keys a request holds the mutex for; onAuthChanged leaves their entries alone (O-2). */
  private readonly busyKeys = new Set<string>();
  private readonly hooks: TurnHooks;
  private server: Bun.Server | null = null;
  private models: DiscoveredModel[];
  private modelsUpdatedAt: number;
  private discovery: Promise<boolean> | null = null;
  private authFailure: ProviderFailure | null = null;
  private reaper: unknown = null;
  private guard: ToolGuardOutcome | null = null;
  private unsubscribeAuth: () => void = () => {};
  /** `<AGENT_NAME>-<poolId8>`: this pool's own agent file and `--agent` (review L-1). */
  private readonly agentName = `${AGENT_NAME}-${this.poolId.slice(0, 8)}`;
  private readonly exitCleanup = (): void => {
    this.manager.killSync();
    this.owners.unregisterSync();
    this.opts.store.releaseLocksSync();
    this.opts.profile.removeAgentFileSync(this.bridge.geminiDir, this.agentName);
  };

  constructor(opts: AntigravityProxyOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.bridge = opts.bridge;
    this.clock = opts.clock ?? systemClock;
    const cache = loadCachedModels(opts.dataDir);
    this.models = cache.models;
    this.modelsUpdatedAt = cache.updatedAt;
    this.owners = new OwnerRegistry(opts.dataDir, this.poolId);
    this.runDirs = opts.createRunDir ?? ((kind) => createRunDir(kind, { root: opts.runRoot, poolId: this.poolId }));
    this.mcp = new McpBridge((call, signal) => this.onMcpCall(call, signal), (m) => this.debug(m));
    this.manager = new AgyProcessManager({
      config: opts.config,
      install: opts.bridge,
      baseArgs: opts.baseArgs,
      createRunDir: this.runDirs,
      dataDir: opts.dataDir,
      allowPermission: (p, generation) => this.allowPermission(p, generation),
      onExit: (info) => this.onProcessExit(info),
      onReady: (gen) => this.onProcessReady(gen),
      sweep: async () => {
        await sweepStaleRunDirs({ root: opts.runRoot, geminiDir: opts.bridge.geminiDir, owners: this.owners });
        const tags = await this.owners.livePoolTags().catch(() => null);
        if (tags) await this.opts.profile.sweepAgentFiles(opts.bridge.geminiDir, tags, await this.owners.othersAlive().catch(() => true)).catch(() => {});
      },
      agentName: this.agentName,
      isAwaitingAgy: () => {
        for (const turn of this.turns.keys()) if (turn.waiting || turn.phase === "cancelling") return true;
        return false;
      },
      clock: this.clock,
      spawner: opts.spawner,
      log: (m) => this.debug(m),
    });
    this.hooks = this.turnHooks();
  }

  // --- public surface -------------------------------------------------------------------------

  get url(): string {
    if (!this.server) throw new Error("Proxy server is not started.");
    return `http://127.0.0.1:${this.server.port}/v1`;
  }

  get port(): number {
    if (!this.server) throw new Error("Proxy server is not started.");
    return this.server.port;
  }

  get catalog(): readonly DiscoveredModel[] {
    return this.models;
  }

  /** For `AuthManager.attachRuntime` (IA 15.2). */
  get runtimeControl(): RuntimeControl {
    return { stop: (reason) => this.manager.stop(reason), hold: (reason) => this.manager.hold(reason) };
  }

  get createRunDir(): CreateRunDir {
    return this.runDirs;
  }

  /** What `prepareProfileDir` did with the PreToolUse guard at start; null before `start()`. */
  get guardOutcome(): ToolGuardOutcome | null {
    return this.guard;
  }

  /** Exposed for tests and /health. */
  get process(): AgyProcessManager {
    return this.manager;
  }

  async start(): Promise<string> {
    if (this.server) return this.url;
    await this.owners.register().catch(() => {});
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: this.config.proxyPort,
      idleTimeout: 255,
      fetch: (req, server) => this.handleHttp(req, server),
    });
    // After the listener, so the agent file can name this pool's MCP URL. A failure closes the listener.
    try {
      const mcpPoolUrl = `http://127.0.0.1:${this.server.port}/mcp/${this.mcpToken}/${POOL_SCOPE_ID}`;
      this.guard = (
        await this.opts.profile.prepareProfileDir({ bridge: this.bridge, toolGuardHook: this.config.toolGuardHook, mcpPoolUrl, agentName: this.agentName })
      ).guard;
    } catch (err) {
      const server = this.server;
      this.server = null;
      await server.stop(true);
      throw err;
    }
    this.unsubscribeAuth = this.bridge.onAuthChanged((e) => this.onAuthChanged(e.epoch, e.reason));
    process.once("exit", this.exitCleanup);
    this.scheduleReaper();
    return this.url;
  }

  /** Pool shutdown (SR 8.4): stops agy (up to 8 s), closes the listener, releases locks and the owner file. */
  async stop(): Promise<void> {
    this.clock.clearTimeout(this.reaper);
    this.reaper = null;
    this.unsubscribeAuth();
    for (const turn of [...this.turns.keys()]) if (turn.generation < 0) await turn.cancel("cancelled");
    await this.manager.dispose();
    for (const tail of this.logTails.values()) tail.stop();
    this.logTails.clear();
    const server = this.server;
    this.server = null;
    await server?.stop(true);
    for (const entry of this.sessions.values()) await entry.lock?.release().catch(() => {});
    await this.opts.store.close().catch(() => {});
    // The file names this pool's port and token; nothing else may start with it (review L-1, L-2).
    await this.opts.profile.removeAgentFile(this.bridge.geminiDir, this.agentName).catch(() => {});
    await this.owners.unregister();
    process.off("exit", this.exitCleanup);
  }

  /** `session.execution.interrupted` / `failed` (SR 8.3): acts only on a live turn not already cancelling. */
  onSessionInterrupted(sessionKey: string): void {
    const turn = this.sessions.get(sessionKey)?.turn;
    if (!turn || turn.done || turn.phase === "cancelling") return;
    this.debug("session interrupted; cancelling its turn");
    void turn.cancel("cancelled");
  }

  /** `session.deleted` (SR 4.8, 8.3): handled once per id for 10 min. */
  onSessionDeleted(sessionKey: string): void {
    const now = this.clock.now();
    const seen = this.deletedIds.get(sessionKey);
    if (seen !== undefined && now - seen < this.config.timings.deletedIdsTtlMs) return;
    this.deletedIds.set(sessionKey, now);
    const entry = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    // The cancel below ends the turn, and the end would save the record again after the remove.
    if (entry) entry.record = null;
    void (async () => {
      if (entry?.turn && !entry.turn.done) await entry.turn.cancel("cancelled");
      if (entry) {
        this.closeLive(entry);
        await entry.lock?.release().catch(() => {});
      }
      if (this.config.sessionStore) await this.opts.store.remove(sessionKey).catch(() => null);
    })();
  }

  /** Model discovery on an already ready process; never spawns (SR 3.3). True when the catalog changed. */
  refreshModels(cwd: string): Promise<boolean> {
    if (this.discovery) return this.discovery;
    const acquired = this.manager.tryAcquire("discovery");
    if (!acquired) return Promise.resolve(false);
    this.discovery = (async () => {
      try {
        const { models, sessionId } = await discoverAgyModels(acquired.gen.client, cwd);
        void acquired.gen.client.closeSession(sessionId).catch(() => {});
        if (this.config.sessionStore) void this.opts.store.recordEphemeral(sessionId).catch(() => {});
        if (!models) return false;
        const changed = JSON.stringify(models) !== JSON.stringify(this.models);
        this.models = models;
        this.modelsUpdatedAt = this.clock.now();
        saveCachedModels(this.opts.dataDir, models, this.modelsUpdatedAt);
        if (changed) this.opts.onModelsChanged?.();
        return changed;
      } catch {
        return false;
      } finally {
        acquired.lease.release();
        this.discovery = null;
      }
    })();
    return this.discovery;
  }

  // --- logging --------------------------------------------------------------------------------

  /** Metadata only: ids, sizes, counts, timings, state transitions (SR, constraints). */
  private debug(message: string): void {
    if (!this.config.debug) return;
    (this.opts.log ?? ((line: string) => console.error(line)))(`[opencode-antigravity] ${message}`);
  }

  private errorContext(): ErrorContext {
    return { logDir: path.join(this.bridge.geminiDir, "antigravity-acp", "log") };
  }

  // --- HTTP -----------------------------------------------------------------------------------

  private async handleHttp(req: Request, server: Bun.Server): Promise<Response> {
    if (req.headers.get("origin") || !isLoopbackHost(req.headers.get("host"))) {
      return Response.json({ error: { message: "Forbidden" } }, { status: 403 });
    }
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname.startsWith("/mcp/")) {
      const [, , token = "", scopeId = "", ...rest] = pathname.split("/");
      if (rest.length > 0 || !constantTimeEquals(token, this.mcpToken)) return Response.json({ error: { message: "Not found" } }, { status: 404 });
      if (!this.mcp.servesScope(scopeId)) return Response.json({ error: { message: "Not found" } }, { status: 404 });
      // A parked tools/call sends no bytes until OpenCode answers (SR 3.3).
      server.timeout(req, 0);
      return this.mcp.handleRequest(req, scopeId);
    }
    if (pathname === "/health" && req.method === "GET") return Response.json(this.health());

    if (pathname.startsWith("/v1/")) {
      const token = req.headers.get(HEADER_PROXY_TOKEN);
      if (!token || !constantTimeEquals(token.trim(), this.proxyToken)) {
        return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
      }
      if (pathname === "/v1/models" && req.method === "GET") {
        return Response.json({
          object: "list",
          data: this.models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "antigravity" })),
        });
      }
      if (pathname === "/v1/chat/completions" && req.method === "POST") {
        if (this.opts.configIssue) return toHttpError({ kind: "config_issue", message: this.opts.configIssue });
        if (req.headers.get("authorization") !== `Bearer ${MARKER_ACCESS}`) {
          return toHttpError({ kind: "auth_required", message: SIGN_IN_GATE_MESSAGE });
        }
        return this.handleChatCompletions(req, server);
      }
    }
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  }

  private health(): Record<string, unknown> {
    const status = this.bridge.binaryStatus();
    return {
      ok: true,
      acp: this.manager.state,
      auth: this.opts.authStatus?.() ?? "unknown",
      binary: {
        source: status.phase === "ready" ? status.source : null,
        version: status.phase === "ready" ? status.version : null,
        phase: status.phase,
      },
    };
  }

  private async parseChat(req: Request): Promise<ChatRequest | null> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return null;
    }
    if (!isRecord(body)) return null;
    const meta = decodeMeta(req.headers.get(HEADER_META));
    const rawDir = req.headers.get(HEADER_DIRECTORY);
    let cwd = process.cwd();
    if (rawDir) {
      try {
        cwd = decodeURIComponent(rawDir);
      } catch {
        cwd = rawDir;
      }
    }
    const bodyModel = typeof body.model === "string" && body.model ? body.model : null;
    const effort = typeof body.reasoning_effort === "string" && body.reasoning_effort ? body.reasoning_effort : null;
    return {
      messages: parseMessages(body.messages),
      tools: parseTools(body.tools),
      stream: body.stream !== false,
      model: meta.modelId ?? bodyModel ?? this.defaultModel(),
      effort: meta.effort ?? effort,
      kind: req.headers.get(HEADER_KIND),
      sessionKey: req.headers.get(HEADER_SESSION) || null,
      cwd,
      signal: req.signal,
    };
  }

  private async handleChatCompletions(req: Request, server: Bun.Server): Promise<Response> {
    const chat = await this.parseChat(req);
    if (!chat) return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
    // Bun closes a connection idle for 255 s; a non-streaming request sends nothing until the end (SR 3.3).
    if (!chat.stream) server.timeout(req, 0);
    this.debug(
      `chat stream=${chat.stream} kind=${chat.kind ?? "none"} messages=${chat.messages.length} tools=${chat.tools.length} session=${chat.sessionKey ? "yes" : "no"}`,
    );
    const isMeta = (chat.kind !== null && META_KINDS.has(chat.kind)) || chat.tools.length === 0;
    if (chat.sessionKey === null) return this.handleEphemeral(chat);
    if (isMeta) return this.runIsolated(chat, "meta");
    return this.handleMain(chat, chat.sessionKey);
  }

  // --- main requests --------------------------------------------------------------------------

  private entryFor(key: string): SessionEntry {
    let entry = this.sessions.get(key);
    if (!entry) {
      entry = { key, record: null, loaded: false, lock: null, live: null, turn: null, lastUsedAt: this.clock.now() };
      this.sessions.set(key, entry);
    }
    return entry;
  }

  private parkedView(turn: Turn): ParkedTurnView {
    return {
      prefixCount: turn.prefix.count,
      prefixHash: turn.prefix.hash,
      emittedToolCalls: turn.responseCalls.map((c) => ({ id: c.id, name: c.name, argsHash: this.opts.hashes.toolArgsHash(c.argumentsJson) })),
      emittedTextHash: this.opts.hashes.emittedTextHash(turn.responseText),
      parkedToolCallIds: turn.emittedParkedIds,
    };
  }

  private async handleMain(chat: ChatRequest, key: string): Promise<Response> {
    type Decision =
      | { kind: "resume"; turn: Turn; step: Exclude<ResumeStep, { kind: "fallback" }>; entry: SessionEntry }
      | { kind: "turn"; turn: Turn; plan: RequestPlan; entry: SessionEntry; append: SessionAppend }
      | { kind: "elsewhere" };

    const decision = await this.mutex.run<Decision>(key, async () => {
      // Read the epoch first: AuthManager.authEpoch() may announce another window's change right here,
      // and that drops idle entries of the old epoch. Entries a mutex holder uses are skipped (O-2).
      const epoch = this.bridge.authEpoch();
      this.busyKeys.add(key);
      try {
        for (let pass = 0; ; pass++) {
          const entry = this.entryFor(key);
          let live = entry.turn && !entry.turn.done ? entry.turn : null;
          if (live && live.phase !== "parked") {
            // OpenCode gave up on the first response (abort, retry): cancel it, then classify against the tainted binding (SR 3.7).
            this.debug(`superseding a ${live.phase} turn`);
            await live.cancel("cancelled");
            live = null;
          }
          if (!entry.loaded && this.config.sessionStore) {
            entry.record = await this.opts.store.load(key, epoch).catch(() => null);
          }
          entry.loaded = true;
          if (entry.record && entry.record.authEpoch !== epoch) entry.record = null;

          const append = this.opts.buildAppend({ messages: chat.messages, tools: chat.tools, meta: false, config: this.config });
          const result = this.opts.classify({
            binding: entry.record,
            request: {
              kind: chat.kind,
              sessionKey: key,
              messages: chat.messages,
              tools: chat.tools,
              cwd: chat.cwd,
              authEpoch: epoch,
              append: { systemHash: append.systemHash, toolsSchemaHash: append.toolsSchemaHash, toolsDescHashes: append.toolsDescHashes },
            },
            parkedTurn: live && live.phase === "parked" ? this.parkedView(live) : null,
          });
          this.debug(`plan ${result.plan.kind}${result.plan.kind === "fresh" ? ` (${result.plan.reason})` : ""}`);

          if (result.plan.kind === "resume" && live) {
            // The resume transition runs under the mutex, so no second request sees the turn half resumed (N-3).
            const step = this.beginResume(live, entry, result.plan, result.prefix);
            if (step.kind !== "fallback") return { kind: "resume", turn: live, step, entry };
            // Steering cannot carry this input: cancel, then classify again against the tainted binding (N-2).
            this.debug("steering unavailable for this resume; replaying into a fresh session");
            await live.cancel("steer-failed");
            if (pass === 0) continue;
          }
          if (live) await live.cancel("cancelled"); // the request does not continue the parked turn

          if (this.config.sessionStore && !entry.lock) {
            entry.lock = await this.opts.store.lock(key).catch(() => null);
            if (!entry.lock) return { kind: "elsewhere" };
          }
          const plan: RequestPlan = result.plan.kind === "resume" ? { kind: "fresh", reason: "tail-mismatch" } : result.plan;
          const turn = this.newTurn(chat, key, plan.kind, true, entry);
          turn.prefix = result.prefix;
          // append and redo: the input is the request's last `input.length` messages. After a clean
          // no-output failure an append resends the failed input, so it starts before the old prefix,
          // and a redo answers that same range again (N-5, the sessions owner's N-1 change request).
          turn.input =
            plan.kind === "append" || plan.kind === "redo"
              ? { from: Math.max(0, result.prefix.count - plan.input.length), to: result.prefix.count }
              : { from: entry.record?.prefixCount ?? 0, to: result.prefix.count };
          entry.turn = turn;
          return { kind: "turn", turn, plan, entry, append };
        }
      } finally {
        this.busyKeys.delete(key);
      }
    });

    if (decision.kind === "elsewhere") {
      this.debug("binding locked by another process; serving an ephemeral session");
      return this.runIsolated(chat, "ephemeral");
    }
    if (decision.kind === "resume") return this.finishResume(chat, decision.entry, decision.turn, decision.step);
    const setup = this.setupMain(chat, decision.entry, decision.turn, decision.plan, decision.append);
    return this.respond(chat, decision.turn, setup);
  }

  private newTurn(chat: ChatRequest, key: string | null, plan: RequestPlan["kind"], allowTools: boolean, entry: SessionEntry | null): Turn {
    const turn = new Turn({
      sessionKey: key,
      plan,
      model: chat.model,
      allowTools,
      allowedToolNames: new Set(allowTools ? chat.tools.map((t) => t.function.name) : []),
      streaming: chat.stream,
      config: this.config,
      clock: this.clock,
      hooks: this.hooks,
    });
    this.turns.set(turn, { entry, unsubscribe: () => {}, stepMark: null, descHashes: null });
    return turn;
  }

  private mcpServers(scope: McpScope | null): AcpMcpServer[] {
    if (!scope || !this.server) return [];
    return [{ type: "http", name: MCP_SERVER_NAME, url: `http://127.0.0.1:${this.server.port}/mcp/${this.mcpToken}/${scope.id}`, headers: [] }];
  }

  private replayBudget(model: string): number {
    const known = this.models.find((m) => m.id === model);
    const contextLimit = known?.contextLimit ?? inferLimits(model).contextLimit;
    return Math.min(this.config.replayMaxChars, contextLimit * 2);
  }

  /** Model and thought level through `set_config_option` when they changed (SR 4.4). */
  /**
   * No model in the request: the first entry of a catalog agy reported, else `AGY_DEFAULT_MODEL`, which
   * leaves agy's own current model. Never a fallback id the account may not have.
   */
  private defaultModel(): string {
    return (this.modelsUpdatedAt > 0 ? this.models[0]?.id : undefined) ?? AGY_DEFAULT_MODEL;
  }

  private async applyConfig(client: AcpClient, live: LiveAcp, options: AcpConfigOption[], model: string, effort: string | null): Promise<void> {
    let current = options;
    if (model !== AGY_DEFAULT_MODEL && live.model !== model) {
      const modelId = findConfigOption(current, "model")?.id ?? "model";
      current = await client.setConfigOption(live.acpSessionId, modelId, model);
      live.model = model;
      live.thoughtLevel = null;
    }
    if (effort && live.thoughtLevel !== effort) {
      const thoughtId = findConfigOption(current, "thought_level")?.id ?? "thought_level";
      try {
        await client.setConfigOption(live.acpSessionId, thoughtId, effort);
        live.thoughtLevel = effort;
      } catch {
        // An unknown level for this model keeps agy's default.
      }
    }
  }

  /** `session/close` for a live ACP session, best effort (SR 3.3, 4.1). The scope closes at once. */
  private closeLive(entry: SessionEntry): void {
    const live = entry.live;
    entry.live = null;
    if (!live) return;
    this.mcp.closeScope(live.scope.id);
    if (!live.canClose) return;
    const acquired = this.manager.tryAcquire("close");
    if (!acquired || acquired.gen.generation !== live.generation) {
      acquired?.lease.release();
      return;
    }
    void acquired.gen.client.closeSession(live.acpSessionId).catch(() => {}).finally(() => acquired.lease.release());
  }

  private async openSession(
    gen: Generation,
    chat: ChatRequest,
    tools: readonly OpenAiFunctionTool[],
    appendText: string,
    resumeId: string | null,
  ): Promise<{ live: LiveAcp; options: AcpConfigOption[] }> {
    const scope = this.mcp.openScope(tools);
    const params = {
      cwd: chat.cwd,
      mcpServers: this.mcpServers(tools.length > 0 ? scope : null),
      append: gen.capabilities.appendsSystemPrompt ? appendText : null,
    };
    try {
      const result = resumeId ? await gen.client.resumeSession(resumeId, params) : await gen.client.newSession(params);
      scope.acpSessionId = result.sessionId;
      return {
        live: {
          generation: gen.generation,
          acpSessionId: result.sessionId,
          scope,
          model: null,
          thoughtLevel: null,
          canClose: gen.capabilities.canClose,
        },
        options: result.configOptions,
      };
    } catch (err) {
      this.mcp.closeScope(scope.id);
      throw err;
    }
  }

  /** `session/resume` with one retry after 500 ms (SR 4.5). Null: run fresh with `resume-failed`. */
  private async tryResume(gen: Generation, chat: ChatRequest, record: BindingRecord, appendText: string): Promise<{ live: LiveAcp; options: AcpConfigOption[] } | null> {
    if (!gen.capabilities.canResume || !this.config.resumeAfterRestart || record.appendInPrompt) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.openSession(gen, chat, chat.tools, appendText, record.acpSessionId);
      } catch (err) {
        if (this.bridge.isSignInRequired(err)) throw err;
        this.debug(`session/resume failed (${err instanceof Error && "code" in err ? String(err.code) : "error"})`);
        if (attempt === 0) await new Promise<void>((resolve) => this.clock.setTimeout(resolve, this.config.timings.resumeRetryMs));
      }
    }
    return null;
  }

  private newRecord(key: string, chat: ChatRequest, gen: Generation, live: LiveAcp, append: SessionAppend, prefix: ClassifyResult["prefix"]): BindingRecord {
    const now = this.clock.now();
    return {
      version: 1,
      sessionKey: key,
      acpSessionId: live.acpSessionId,
      authEpoch: this.bridge.authEpoch(),
      agyVersion: gen.capabilities.agentVersion ?? gen.binaryVersion,
      cwd: chat.cwd,
      model: chat.model,
      thoughtLevel: chat.effort,
      systemHash: append.systemHash,
      toolsSchemaHash: append.toolsSchemaHash,
      toolsDescHashes: append.toolsDescHashes,
      appendInPrompt: !gen.capabilities.appendsSystemPrompt,
      prefixCount: prefix.count,
      prefixHash: prefix.hash,
      state: "live",
      taintReason: null,
      lastTurn: null,
      createdAt: now,
      updatedAt: now,
      turns: 0,
    };
  }

  /** Lease, session setup and prompt for `fresh`, `append` and `redo` (SR 4.4, 8.2 step 4). Never rejects. */
  private async setupMain(chat: ChatRequest, entry: SessionEntry, turn: Turn, plan: RequestPlan, append: SessionAppend): Promise<void> {
    await this.withSetup(turn, async (gen) => {
      const record = entry.record;
      let blocks: PromptBlock[];
      const reusable = entry.live && entry.live.generation === gen.generation && record && record.state !== "tainted";
      if ((plan.kind === "append" || plan.kind === "redo") && record && record.state !== "tainted") {
        let options: AcpConfigOption[] = [];
        if (!reusable) {
          this.closeLive(entry);
          const resumed = await this.tryResume(gen, chat, record, append.text);
          if (resumed) {
            entry.live = resumed.live;
            options = resumed.options;
          }
        }
        if (entry.live && entry.live.generation === gen.generation) {
          const live = entry.live;
          if (turn.done) return null;
          await this.applyConfig(gen.client, live, options, chat.model, chat.effort);
          // Cancelled meanwhile: the binding must not claim input agy never received.
          if (turn.done) return null;
          blocks = this.opts.buildTurnPrompt(plan.input, plan.reminders);
          record.prefixCount = turn.prefix.count;
          record.prefixHash = turn.prefix.hash;
          record.model = chat.model;
          record.thoughtLevel = chat.effort;
          const state = this.turns.get(turn);
          if (state) state.descHashes = append.toolsDescHashes;
          record.state = "live";
          return { acpSessionId: live.acpSessionId, scope: live.scope, blocks };
        }
        turn.plan = "fresh"; // resume failed (SR 4.5)
      }

      // fresh
      this.closeLive(entry);
      const opened = await this.openSession(gen, chat, chat.tools, append.text, null);
      entry.live = opened.live;
      if (!turn.done) await this.applyConfig(gen.client, opened.live, opened.options, chat.model, chat.effort);
      if (turn.done) {
        // Cancelled during setup: the new session never got the replay, so it must not pair with the old record.
        this.closeLive(entry);
        return null;
      }
      blocks = this.opts.buildReplay(chat.messages, this.replayBudget(chat.model));
      if (!gen.capabilities.appendsSystemPrompt) blocks = [{ type: "text", text: append.text }, ...blocks];
      entry.record = this.newRecord(entry.key, chat, gen, opened.live, append, turn.prefix);
      turn.input = { from: 0, to: turn.prefix.count };
      return { acpSessionId: opened.live.acpSessionId, scope: opened.live.scope, blocks };
    });
  }

  /**
   * Shared setup: lease, the plan-specific session part, update subscription, error-step mark, prompt.
   * A failure before the prompt fails the turn (its end releases the lease).
   */
  private async withSetup(
    turn: Turn,
    setup: (gen: Generation) => Promise<{ acpSessionId: string; scope: McpScope; blocks: PromptBlock[] } | null>,
  ): Promise<void> {
    let afterAcquire = false;
    try {
      const { gen, lease } = await this.manager.acquire("turn");
      afterAcquire = true;
      turn.lease = lease;
      turn.generation = gen.generation;
      if (turn.done) {
        lease.release();
        return;
      }
      const ready = await setup(gen);
      if (!ready || turn.done) return;
      turn.acpSessionId = ready.acpSessionId;
      turn.scope = ready.scope;
      const state = this.turns.get(turn);
      this.turnsByAcpSession.set(ready.acpSessionId, turn);
      if (state) {
        state.unsubscribe = gen.client.onSessionUpdate(ready.acpSessionId, (u) => turn.onUpdate(u.kind, u.text));
        state.stepMark = await lastStepIndex(this.bridge.geminiDir, ready.acpSessionId);
      }
      if (turn.done) return;
      const client = gen.client;
      const acpSessionId = ready.acpSessionId;
      const blocks = ready.blocks;
      this.debug(`session/prompt blocks=${blocks.length}`);
      turn.startPrompt(() => client.prompt(acpSessionId, blocks));
    } catch (err) {
      let failure = mapAcpError(err, (e) => this.bridge.isSignInRequired(e));
      // A start stopped by an auth change fails the way that change says (SR 9).
      if (err instanceof AgyExitedError && this.authFailure) failure = this.authFailure;
      if (afterAcquire && failure.kind === "auth_required") this.bridge.reportSignInRequired(SIGNED_OUT_MESSAGE);
      this.debug(`turn setup failed (${failure.kind})`);
      turn.failSetup(failure);
    }
  }

  /**
   * Streaming: SSE starts when setup finished or after 2 s, whichever is first, with `: ping` from then
   * on and the start or download note (SR 3.2 step 8). A failure before the stream is an HTTP error.
   */
  private async respond(chat: ChatRequest, turn: Turn, setup: Promise<void>): Promise<Response> {
    const ctx = this.errorContext();
    if (!chat.stream) {
      const responder = new JsonResponder({ model: chat.model, errorContext: ctx });
      const onAbort = (): void => {
        void turn.cancel("cancelled");
      };
      chat.signal.addEventListener("abort", onAbort, { once: true });
      await setup;
      turn.attach(responder);
      const response = await responder.response;
      chat.signal.removeEventListener("abort", onAbort);
      return response;
    }

    // The client may go away before the stream exists; the stream's own cancel only covers later (N-10).
    const onAbort = (): void => {
      void turn.cancel("cancelled");
    };
    chat.signal.addEventListener("abort", onAbort, { once: true });
    if (chat.signal.aborted) onAbort();
    let early = false;
    let earlyTimer: unknown = null;
    await Promise.race([
      setup,
      new Promise<void>((resolve) => {
        earlyTimer = this.clock.setTimeout(() => {
          early = true;
          resolve();
        }, this.config.timings.earlySseMs);
      }),
    ]);
    this.clock.clearTimeout(earlyTimer);
    chat.signal.removeEventListener("abort", onAbort);
    if (chat.signal.aborted) return toHttpError({ kind: "client_aborted" }, ctx);
    // Nothing was streamed yet, so a failure is still an HTTP status with headers (SR 6.6).
    const end = turn.end;
    if (!early && end?.kind === "failed") return toHttpError(end.failure, ctx);
    const responder = new SseResponder({
      model: chat.model,
      clock: this.clock,
      heartbeatMs: this.config.timings.heartbeatMs,
      errorContext: ctx,
      onClientAbort: () => {
        this.debug("client aborted a streaming request");
        void turn.cancel("cancelled");
      },
    });
    turn.attach(responder);
    if (early) this.setupNotes(turn, responder, setup);
    return responder.response;
  }

  /** Start and download notes while setup runs (SR 6.3, IA 15.3 item 2). */
  private setupNotes(turn: Turn, sink: TurnSink, setup: Promise<void>): void {
    if (!this.config.statusNotes) return;
    let pending = true;
    void setup.finally(() => {
      pending = false;
    });
    let startNoteSent = false;
    const tick = (): void => {
      if (!pending || sink.closed || turn.done) return;
      const status = this.bridge.binaryStatus();
      if (status.phase === "downloading") {
        const mb = (n: number): string => (n / 1_048_576).toFixed(0);
        const of = status.total ? `${mb(status.bytes)} of ${mb(status.total)} MB` : `${mb(status.bytes)} MB`;
        turn.note(noteText(`Downloading Google's Antigravity CLI (${of}). This happens once.`));
      } else if (status.phase === "waiting_for_lock") {
        turn.note(noteText("Another OpenCode window is installing Antigravity. Waiting for it."));
      } else if (this.manager.state === "draining" && this.manager.drainDeadline !== null) {
        // After an update, a new request waits (at most drainWaitMs) for parked turns on the old agy (O-6).
        const seconds = Math.max(1, Math.ceil((this.manager.drainDeadline - this.clock.now()) / 1000));
        turn.note(noteText(`Antigravity CLI was updated. Waiting up to ${seconds} s for running tool calls on the old version to finish.`));
      } else if (!startNoteSent && this.manager.state === "starting") {
        startNoteSent = true;
        turn.note(noteText("Starting Antigravity CLI. The first start unpacks its runtime and can take a while."));
      }
      this.clock.setTimeout(tick, this.config.timings.downloadNoteMs);
    };
    tick();
  }

  // --- resume of a parked turn ------------------------------------------------------------------

  private toolResultMap(results: readonly ToolResult[], media: readonly MediaPart[]): Map<string, McpContent[]> {
    const map = new Map<string, McpContent[]>();
    for (const r of results) map.set(r.toolCallId, [{ type: "text", text: r.content }]);
    // OpenCode does not say which call produced which file: they go with the last result (SR 4.4).
    const last = results[results.length - 1];
    if (last && media.length > 0) map.get(last.toolCallId)?.push(...mediaToMcp(media));
    return map;
  }

  /**
   * The synchronous part of a resume (SR 3.7, 4.4, 4.6): prefix, parked results, the unemitted flush.
   * `fallback` when the request carries steering input that steering cannot deliver here: steering is
   * off or unsupported, or late calls must be flushed first (their response would drop the input, N-2).
   */
  private beginResume(turn: Turn, entry: SessionEntry | null, plan: Extract<RequestPlan, { kind: "resume" }>, prefix: ClassifyResult["prefix"]): ResumeStep {
    const gen = this.manager.live;
    const acpSessionId = turn.acpSessionId;
    const canSteer = this.config.steering && gen !== null && gen.generation === turn.generation && gen.capabilities.steers && acpSessionId !== null;
    if (plan.steer.length > 0 && (!canSteer || turn.hasUnemittedCalls)) return { kind: "fallback" };
    // Before resume(): a flush persists the parked snapshot through onParked with this prefix.
    turn.prefix = prefix;
    if (entry?.record) {
      entry.record.prefixCount = prefix.count;
      entry.record.prefixHash = prefix.hash;
    }
    const { flush } = turn.resume(this.toolResultMap(plan.results, plan.media));
    if (flush.length > 0) return { kind: "flush", calls: flush };
    if (plan.steer.length > 0 && gen && acpSessionId) {
      return { kind: "steer", client: gen.client, acpSessionId, blocks: this.opts.buildTurnPrompt(plan.steer, []) };
    }
    return { kind: "attach" };
  }

  private async finishResume(chat: ChatRequest, entry: SessionEntry | null, turn: Turn, step: Exclude<ResumeStep, { kind: "fallback" }>): Promise<Response> {
    if (step.kind === "flush") return toolCallsResponse(turn.model, step.calls, chat.stream);
    if (step.kind === "steer") {
      const accepted = await turn.steer(() => step.client.prompt(step.acpSessionId, step.blocks));
      if (!accepted) {
        // Aborted, or another request took the session over (N-3): never replay over it.
        if (chat.signal.aborted) return toHttpError({ kind: "client_aborted" }, this.errorContext());
        if (turn.done) return this.respond(chat, turn, Promise.resolve());
        this.debug("steering failed; replaying into a fresh session");
        await turn.cancel("steer-failed");
        if (!entry) return this.runIsolated(chat, "ephemeral");
        return this.handleMain(chat, entry.key);
      }
    }
    return this.respond(chat, turn, Promise.resolve());
  }

  // --- meta and ephemeral requests ------------------------------------------------------------

  /** No session header: never the store. Tool results resume a parked ephemeral turn in memory (SR 4.1). */
  private async handleEphemeral(chat: ChatRequest): Promise<Response> {
    const tail: OpenAiMessage[] = [];
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (!m || m.role === "assistant") break;
      tail.unshift(m);
    }
    const results: ToolResult[] = [];
    const media: MediaPart[] = [];
    let other = false;
    for (const m of tail) {
      if (m.role === "tool" && m.tool_call_id) results.push({ toolCallId: m.tool_call_id, content: textOf(m.content) });
      else if (m.role === "user" && Array.isArray(m.content) && m.content.every((p) => p.type !== "text") && results.length > 0) {
        for (const part of m.content) if (isMediaPart(part)) media.push(part);
      } else other = true;
    }
    const turn = results.length > 0 ? this.turnsByToolCallId.get(results[0]?.toolCallId ?? "") : undefined;
    if (turn && !other && turn.sessionKey === null && turn.phase === "parked" && results.every((r) => turn.emittedParkedIds.includes(r.toolCallId))) {
      const step = this.beginResume(turn, null, { kind: "resume", results, media, steer: [] }, turn.prefix);
      if (step.kind !== "fallback") return this.finishResume(chat, null, turn, step);
    }
    return this.runIsolated(chat, (chat.kind !== null && META_KINDS.has(chat.kind)) || chat.tools.length === 0 ? "meta" : "ephemeral");
  }

  /** meta and ephemeral sessions: `session/new`, replay of the whole request, `session/close` after (SR 4.4). */
  private runIsolated(chat: ChatRequest, kind: "meta" | "ephemeral"): Promise<Response> {
    const meta = kind === "meta";
    const tools = meta ? [] : chat.tools;
    const append = this.opts.buildAppend({ messages: chat.messages, tools, meta, config: this.config });
    const turn = this.newTurn(chat, null, kind, !meta, null);
    const setup = this.withSetup(turn, async (gen) => {
      const opened = await this.openSession(gen, chat, tools, append.text, null);
      if (turn.done) {
        // Cancelled while session/new ran: onTurnEnded already ran, so close it here (O-8).
        this.closeIsolated(opened.live, false);
        return null;
      }
      // The isolated session is closed with the turn (onTurnEnded).
      this.isolatedLive.set(turn, opened.live);
      await this.applyConfig(gen.client, opened.live, opened.options, chat.model, chat.effort);
      let blocks = this.opts.buildReplay(chat.messages, this.replayBudget(chat.model));
      if (!gen.capabilities.appendsSystemPrompt) blocks = [{ type: "text", text: append.text }, ...blocks];
      return { acpSessionId: opened.live.acpSessionId, scope: opened.live.scope, blocks };
    });
    return this.respond(chat, turn, setup);
  }

  // --- turn hooks -----------------------------------------------------------------------------

  private turnHooks(): TurnHooks {
    return {
      sendCancel: (turn) => {
        const gen = this.manager.live;
        if (gen && gen.generation === turn.generation && turn.acpSessionId) gen.client.cancel(turn.acpSessionId);
      },
      checkOutcome: async (turn) => {
        if (!turn.acpSessionId) return null;
        const step = await readTurnErrorStep(this.bridge.geminiDir, turn.acpSessionId, this.turns.get(turn)?.stepMark ?? null);
        // "agy already retried" only with a retry line seen for this turn (review L-3).
        const f = step?.failure;
        const stepShowsRetries = (step?.attempt ?? 0) > 1;
        if (step && f && (f.kind === "rate_limited" || f.kind === "capacity") && f.agyRetried && !turn.sawOwnRetry && !stepShowsRetries) {
          const { agyRetried: _dropped, ...retryable } = f;
          return { ...step, failure: retryable };
        }
        if (step?.failure.kind === "auth_required") this.bridge.reportSignInRequired(SIGNED_OUT_MESSAGE);
        return step;
      },
      mapError: (err) => {
        const failure = mapAcpError(err, (e) => this.bridge.isSignInRequired(e));
        if (failure.kind === "auth_required") this.bridge.reportSignInRequired(SIGNED_OUT_MESSAGE);
        return failure;
      },
      onToolCall: (turn, callId) => {
        this.turnsByToolCallId.set(callId, turn);
        this.debug(`mcp call parked (${turn.parkedIds.length} open)`);
      },
      onParked: (turn) => this.persistParked(turn),
      onMcpDropped: (turn) => {
        void turn.cancel("mcp-dropped", { kind: "provider_error", status: 502, message: "Antigravity dropped an OpenCode tool call." });
      },
      onEnded: (turn) => this.onTurnEnded(turn),
      onWaitingChanged: () => this.updateLogTail(),
      log: (m) => this.debug(m),
    };
  }

  private emittedCalls(turn: Turn): EmittedToolCall[] {
    return turn.responseCalls.map((c) => ({ id: c.id, name: c.name, argsHash: this.opts.hashes.toolArgsHash(c.argumentsJson) }));
  }

  private persistedPlan(turn: Turn): PersistedPlanKind {
    return turn.plan === "meta" || turn.plan === "ephemeral" ? "fresh" : turn.plan;
  }

  private save(entry: SessionEntry): void {
    if (!this.config.sessionStore || !entry.record || !entry.lock) return;
    void this.opts.store.save({ ...entry.record }).catch(() => {});
  }

  private persistParked(turn: Turn): void {
    const entry = this.turns.get(turn)?.entry;
    if (!entry?.record) return;
    entry.record.lastTurn = {
      outcome: "parked",
      plan: this.persistedPlan(turn),
      emittedToolCalls: this.emittedCalls(turn),
      emittedTextHash: this.opts.hashes.emittedTextHash(turn.responseText),
      inputFrom: turn.input.from,
      inputTo: turn.input.to,
    };
    entry.record.updatedAt = this.clock.now();
    this.save(entry);
  }

  private onTurnEnded(turn: Turn): void {
    // First, so nothing below (injected hashes, the store) can leak the lease.
    turn.lease?.release();
    turn.lease = null;
    const state = this.turns.get(turn);
    this.turns.delete(turn);
    state?.unsubscribe();
    if (turn.acpSessionId && this.turnsByAcpSession.get(turn.acpSessionId) === turn) this.turnsByAcpSession.delete(turn.acpSessionId);
    for (const [id, t] of this.turnsByToolCallId) if (t === turn) this.turnsByToolCallId.delete(id);
    if (turn.phase === "abandoned" && turn.generation >= 0) this.manager.reportAbandoned(turn.generation);

    const isolated = this.isolatedLive.get(turn);
    this.isolatedLive.delete(turn);
    if (isolated) this.closeIsolated(isolated, turn.phase === "abandoned");

    const entry = state?.entry ?? null;
    if (entry && entry.turn === turn) {
      entry.turn = null;
      entry.lastUsedAt = this.clock.now();
      const record = entry.record;
      if (record && turn.acpSessionId === record.acpSessionId) {
        const { outcome, taint } = turn.bindingOutcome();
        record.lastTurn = {
          outcome,
          plan: this.persistedPlan(turn),
          emittedToolCalls: this.emittedCalls(turn),
          emittedTextHash: this.opts.hashes.emittedTextHash(turn.responseText),
          inputFrom: turn.input.from,
          inputTo: turn.input.to,
        };
        record.updatedAt = this.clock.now();
        record.turns += 1;
        if (outcome === "ok" && state?.descHashes) record.toolsDescHashes = state.descHashes;
        if (taint) this.taint(entry, taint);
        else record.state = entry.live ? "live" : "dormant";
        this.save(entry);
      }
    }
    this.updateLogTail();
  }

  /** A meta or ephemeral session: scope closed, `session/close`, ledger entry. An abandoned one is never touched again. */
  private closeIsolated(live: LiveAcp, abandoned: boolean): void {
    this.mcp.closeScope(live.scope.id);
    const gen = this.manager.live;
    if (abandoned || !gen || gen.generation !== live.generation) return;
    if (live.canClose) void gen.client.closeSession(live.acpSessionId).catch(() => {});
    if (this.config.sessionStore) void this.opts.store.recordEphemeral(live.acpSessionId).catch(() => {});
  }

  private taint(entry: SessionEntry, reason: TaintReason): void {
    if (entry.record) {
      entry.record.state = "tainted";
      entry.record.taintReason = reason;
    }
    this.closeLive(entry);
  }

  // --- MCP and permissions --------------------------------------------------------------------

  private onMcpCall(call: McpToolCall, signal: AbortSignal): Promise<McpCallResult> {
    const sessionId = call.scope.acpSessionId;
    const turn = sessionId ? this.turnsByAcpSession.get(sessionId) : undefined;
    this.debug(`mcp tools/call args=${call.argumentsJson.length}b`);
    if (this.config.debugContent) this.debug(`mcp tools/call ${call.name} ${call.argumentsJson.slice(0, 200)}`);
    if (!turn || turn.done || turn.generation !== this.manager.generation) {
      return Promise.resolve(errorResult("No active OpenCode turn for this tool call."));
    }
    return turn.onMcpCall(call, signal);
  }

  private allowPermission(params: PermissionRequestParams, generation: number): boolean {
    const turn = this.turnsByAcpSession.get(params.sessionId);
    const view = turn && turn.generation === generation && generation === this.manager.generation ? turn : null;
    view?.onPermissionRequest();
    const allowed = this.opts.profile.matchMcpPermission(
      params,
      view ? { done: view.done || view.phase === "cancelling", allowTools: view.allowTools, allowedToolNames: view.allowedToolNames } : null,
    );
    // Metadata only: the tool name, ACP kind and the key names of its input, never their values.
    const call = params.toolCall;
    const keys = [...Object.keys(call?.args ?? {}).sort(), ...Object.keys(call?.rawInput ?? {}).sort().map((k) => `raw.${k}`)].join(",");
    this.debug(`permission ${allowed ? "allowed" : "rejected"} name=${call?.name ?? "-"} kind=${call?.kind ?? "-"} keys=${keys || "-"}`);
    return allowed;
  }

  // --- process events -------------------------------------------------------------------------

  private onProcessReady(gen: Generation): void {
    this.authFailure = null;
    const tail = new AgyLogTail({
      file: gen.logFile,
      clock: this.clock,
      pollMs: this.config.timings.logPollMs,
      onRetry: (e) => this.onRetry(gen.generation, e),
    });
    this.logTails.set(gen.generation, tail);
    if ((this.opts.discoverAfterSpawn ?? true) && this.clock.now() - this.modelsUpdatedAt > DISCOVERY_DAILY_MS) {
      void this.refreshModels(this.opts.dataDir);
    }
  }

  private updateLogTail(): void {
    const generation = this.manager.generation;
    const tail = this.logTails.get(generation);
    if (!tail) return;
    let waiting = false;
    for (const turn of this.turns.keys()) if (turn.generation === generation && turn.waiting) waiting = true;
    tail.setActive(waiting);
  }

  /** SR 6.2 attribution: model match (`model` or `model-<level>`), else every turn whose silence began before the line. */
  private onRetry(generation: number, e: RetryEvent): void {
    const waiting = [...this.turns.keys()].filter((t) => t.generation === generation && t.waiting);
    const model = e.model;
    const matched = model ? waiting.filter((t) => model === t.model || model.startsWith(`${t.model}-`)) : [];
    const targets = matched.length > 0 ? matched : waiting.filter((t) => t.silenceStartedAt() <= e.at);
    // Certain only by model, or when one turn was waiting; a guess must not make a stall final (review L-4).
    const attributed = matched.length > 0 || waiting.length === 1;
    this.debug(`retry line attempt=${e.attempt} kind=${e.kind} turns=${targets.length} attributed=${attributed}`);
    for (const t of targets) t.onRetry(e, attributed);
  }

  private onProcessExit(info: ExitInfo): void {
    const crash = !info.expected || info.reason === "wedged";
    const authChange = info.reason === "auth-changed";
    const failure: ProviderFailure = authChange
      ? (this.authFailure ?? { kind: "auth_required", message: SIGNED_OUT_MESSAGE })
      : { kind: "agy_exited", code: info.code, signal: info.signal };
    this.debug(`agy exit generation=${info.generation} expected=${info.expected} reason=${info.reason ?? "none"}`);
    for (const turn of [...this.turns.keys()]) {
      if (turn.generation === info.generation) turn.failFromExit(failure, crash ? "crash" : "failed");
    }
    for (const entry of [...this.sessions.values()]) {
      if (!entry.live || entry.live.generation !== info.generation) continue;
      this.mcp.closeScope(entry.live.scope.id);
      entry.live = null;
      if (!entry.record) continue;
      if (crash) {
        entry.record.state = "tainted";
        entry.record.taintReason = "crash";
      } else if (entry.record.state !== "tainted") {
        entry.record.state = "dormant";
      }
      this.save(entry);
    }
    this.logTails.get(info.generation)?.stop();
    this.logTails.delete(info.generation);
  }

  private onAuthChanged(epoch: string, reason: "login" | "logout" | "account-changed"): void {
    this.debug(`auth changed (${reason})`);
    // The catalog belongs to the old account: defaultModel() ignores it, and the next spawn rediscovers (review L-7).
    this.modelsUpdatedAt = 0;
    const running = this.manager.state !== "stopped" && this.manager.state !== "broken";
    if (reason === "logout") {
      // AuthManager awaits runtime.stop itself; turns stopped that way fail with 401 (SR 9).
      if (running) this.authFailure = { kind: "auth_required", message: SIGNED_OUT_MESSAGE };
    } else {
      if (running) this.authFailure = { kind: "auth_changed" };
      void this.manager.stop("auth-changed");
    }
    // Bindings of the old epoch are treated as missing.
    for (const entry of [...this.sessions.values()]) {
      if ((entry.turn && !entry.turn.done) || this.busyKeys.has(entry.key)) continue;
      if (entry.record && entry.record.authEpoch !== epoch) {
        this.closeLive(entry);
        void entry.lock?.release().catch(() => {});
        this.sessions.delete(entry.key);
      }
    }
  }

  // --- reaper ---------------------------------------------------------------------------------

  private scheduleReaper(): void {
    this.reaper = this.clock.setTimeout(() => {
      this.reap();
      if (this.server) this.scheduleReaper();
    }, this.config.timings.reaperIntervalMs);
  }

  /** Parked TTL (SR 3.3), idle session close, and the deleted-id memory. */
  private reap(): void {
    const now = this.clock.now();
    for (const turn of [...this.turns.keys()]) {
      if (turn.phase === "parked" && now - turn.parkedSince >= this.config.parkedToolTtlMs) {
        this.debug("parked turn expired");
        void turn.cancel("parked-expired");
      }
    }
    if (this.config.sessionIdleCloseMs > 0) {
      for (const entry of this.sessions.values()) {
        if (entry.turn || !entry.live || now - entry.lastUsedAt < this.config.sessionIdleCloseMs) continue;
        this.closeLive(entry);
        if (entry.record && entry.record.state === "live") {
          entry.record.state = "dormant";
          this.save(entry);
        }
      }
    }
    for (const [id, at] of this.deletedIds) if (now - at >= this.config.timings.deletedIdsTtlMs) this.deletedIds.delete(id);
  }
}
