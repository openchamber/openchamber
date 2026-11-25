// JSON-RPC over stdio for one agy process generation (SR 3.2). Every RPC but `session/prompt` has a
// timeout; agy's interactive sign-in line on stdout or stderr fails the pending requests at once (IA 15.3
// item 3). Agent-to-client requests: `session/request_permission` goes to the injected layer 3 check and
// is answered `allow_once` or a reject, never `allow_always`; fs and terminal callbacks are refused.

import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { AUTH_URL_STDOUT_PREFIX, SignInUrlLineError } from "./auth/errors.ts";
import type { RuntimeTimings } from "./constants.ts";
import { ACP_PROTOCOL_VERSION, CLIENT_NAME, CLIENT_VERSION } from "./constants.ts";
import type { PermissionRequestParams, PromptBlock } from "./contracts.ts";
import type { Clock } from "./stall-watchdog.ts";

export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

export class AcpTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`Antigravity did not answer ${method} within ${timeoutMs} ms.`);
    this.name = "AcpTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AgyExitedError extends Error {
  readonly exitCode: number | null;
  readonly signal: string | null;

  constructor(exitCode: number | null, signal: string | null) {
    super(`Antigravity CLI exited (code ${exitCode ?? "none"}, signal ${signal ?? "none"}).`);
    this.name = "AgyExitedError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export interface AcpConfigOptionValue {
  value: string;
  name?: string;
}

export interface AcpConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  values: AcpConfigOptionValue[];
}

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
}

export interface AcpSessionUpdate {
  kind: string;
  /** Text of `content` when it is a text block. */
  text: string | null;
}

export interface AcpPromptResult {
  stopReason: string;
  usage: AcpUsage | null;
}

export interface AcpSessionResult {
  sessionId: string;
  configOptions: AcpConfigOption[];
}

export interface AcpCapabilities {
  agentName: string | null;
  agentVersion: string | null;
  canResume: boolean;
  canClose: boolean;
  appendsSystemPrompt: boolean;
  /** Steering by a second `session/prompt` exists since 1.5.0 (SR 1). */
  steers: boolean;
}

export interface AcpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface SessionSetupParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
  /** `_meta.antigravity.systemPrompt.append`; omitted when null. */
  append: string | null;
}

export interface AcpTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

export interface AcpClientOptions {
  transport: AcpTransport;
  generation: number;
  clock: Clock;
  timings: Pick<RuntimeTimings, "initializeTimeoutMs" | "authenticateTimeoutMs" | "rpcTimeoutMs">;
  /** Layer 3 (SR 7.4). */
  allowPermission: (params: PermissionRequestParams) => boolean;
  /** The sign-in line was seen; pending requests are already rejected. The manager kills this generation. */
  onSignInLine?: (stream: "stdout" | "stderr") => void;
  /** Any reply or notification from agy (`lastRpcSettledAt`, SR 3.5). */
  onActivity?: () => void;
  onRpcTimeout?: (method: string) => void;
  /** Metadata only. */
  log?: (message: string) => void;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseVersion(v: string): number[] {
  return v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
}

export function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = parseVersion(version);
  const b = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function parseCapabilities(result: unknown): AcpCapabilities {
  const r = obj(result);
  const info = obj(r.agentInfo);
  const caps = obj(r.agentCapabilities);
  const session = obj(caps.sessionCapabilities);
  const append = obj(obj(obj(caps._meta).antigravity).systemPrompt).append;
  const version = str(info.version);
  return {
    agentName: str(info.name),
    agentVersion: version,
    canResume: session.resume !== undefined && session.resume !== null,
    canClose: session.close !== undefined && session.close !== null,
    appendsSystemPrompt: append === true,
    steers: versionAtLeast(version, "1.5.0"),
  };
}

function parseConfigOptions(value: unknown): AcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  const out: AcpConfigOption[] = [];
  for (const item of value) {
    const o = obj(item);
    const id = str(o.id);
    if (!id) continue;
    const values: AcpConfigOptionValue[] = [];
    const push = (entry: unknown): void => {
      const e = obj(entry);
      const v = str(e.value);
      if (v) values.push(str(e.name) ? { value: v, name: str(e.name) ?? v } : { value: v });
    };
    for (const entry of Array.isArray(o.options) ? o.options : []) {
      const group = obj(entry);
      if (Array.isArray(group.options)) for (const inner of group.options) push(inner);
      else push(entry);
    }
    const option: AcpConfigOption = { id, values };
    const category = str(o.category);
    const current = str(o.currentValue);
    if (category) option.category = category;
    if (current) option.currentValue = current;
    out.push(option);
  }
  return out;
}

function parseUsage(value: unknown): AcpUsage | null {
  if (!isRecord(value)) return null;
  const usage: AcpUsage = {};
  for (const key of ["inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens", "totalTokens"] as const) {
    const n = num(value[key]);
    if (n !== undefined) usage[key] = n;
  }
  return usage;
}

function parseSessionResult(result: unknown, fallbackId: string | null): AcpSessionResult {
  const r = obj(result);
  const sessionId = str(r.sessionId) ?? fallbackId;
  if (!sessionId) throw new AcpError(-32603, "Antigravity answered session/new without a session id.");
  return { sessionId, configOptions: parseConfigOptions(r.configOptions) };
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function parsePermissionParams(value: unknown): PermissionRequestParams | null {
  const p = obj(value);
  const sessionId = str(p.sessionId);
  if (!sessionId) return null;
  const params: PermissionRequestParams = { sessionId };
  if (isRecord(p.toolCall)) {
    const tc = p.toolCall;
    const toolCall: NonNullable<PermissionRequestParams["toolCall"]> = {};
    const toolCallId = str(tc.toolCallId);
    const name = str(tc.name);
    const title = str(tc.title);
    // ACP's tool kind (`execute`, `edit`, ...); layer 3 rejects built-in kinds (N-8).
    const kind = str(tc.kind);
    const args = parseRecord(tc.args);
    const rawInput = parseRecord(tc.rawInput);
    if (toolCallId) toolCall.toolCallId = toolCallId;
    if (name) toolCall.name = name;
    if (title) toolCall.title = title;
    if (kind) toolCall.kind = kind;
    if (args) toolCall.args = args;
    if (rawInput) toolCall.rawInput = rawInput;
    params.toolCall = toolCall;
  }
  if (Array.isArray(p.options)) {
    const options: NonNullable<PermissionRequestParams["options"]> = [];
    for (const item of p.options) {
      const o = obj(item);
      const optionId = str(o.optionId);
      if (!optionId) continue;
      const kind = str(o.kind);
      const option: (typeof options)[number] = { optionId };
      const name = str(o.name);
      if (name) option.name = name;
      if (kind === "allow_once" || kind === "allow_always" || kind === "reject_once" || kind === "reject_always") option.kind = kind;
      options.push(option);
    }
    params.options = options;
  }
  return params;
}

/** `allow_once` when allowed, a reject otherwise; `allow_always` is never chosen, so agy's cache never fills (SR 7.4). */
export function choosePermissionOutcome(params: PermissionRequestParams, allowed: boolean): JsonObject {
  const options = params.options ?? [];
  const pick = allowed
    ? options.find((o) => o.kind === "allow_once")
    : (options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always"));
  return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

export class AcpClient {
  readonly generation: number;
  private readonly opts: AcpClientOptions;
  private nextId = 1;
  private stdoutBuf = "";
  private stderrBuf = "";
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(update: AcpSessionUpdate) => void>>();
  private closedWith: Error | null = null;
  private caps: AcpCapabilities | null = null;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
    this.generation = opts.generation;
    // One decoder per stream: a UTF-8 sequence cut by a chunk boundary would otherwise turn into U+FFFD (O-5).
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    opts.transport.stdout.on("data", (chunk: Buffer | string) => this.onStdout(typeof chunk === "string" ? chunk : out.write(chunk)));
    opts.transport.stderr.on("data", (chunk: Buffer | string) => this.onStderr(typeof chunk === "string" ? chunk : err.write(chunk)));
    // A write after the child died raises EPIPE on the stream; the exit path rejects the requests.
    opts.transport.stdin.on("error", () => {});
  }

  /** Set by `initialize`. */
  get capabilities(): AcpCapabilities | null {
    return this.caps;
  }

  get agentVersion(): string | null {
    return this.caps?.agentVersion ?? null;
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  /** Every pending and later request rejects with `err` (process exit, SR 3.4). */
  rejectAll(err: Error): void {
    if (!this.closedWith) this.closedWith = err;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      this.opts.clock.clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  request(method: string, params: JsonObject, timeoutMs: number | null): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject, timer: null };
      if (timeoutMs !== null) {
        entry.timer = this.opts.clock.setTimeout(() => {
          if (this.pending.get(id) !== entry) return;
          this.pending.delete(id);
          this.opts.onRpcTimeout?.(method);
          reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        this.opts.clock.clearTimeout(entry.timer);
        reject(this.closedWith ?? new AgyExitedError(null, null));
      }
    });
  }

  notify(method: string, params: JsonObject): void {
    if (this.closedWith) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  onSessionUpdate(sessionId: string, listener: (update: AcpSessionUpdate) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(sessionId);
    };
  }

  async initialize(): Promise<AcpCapabilities> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      this.opts.timings.initializeTimeoutMs,
    );
    this.caps = parseCapabilities(result);
    return this.caps;
  }

  async authenticate(methodId: string): Promise<void> {
    await this.request("authenticate", { methodId }, this.opts.timings.authenticateTimeoutMs);
  }

  private setupParams(p: SessionSetupParams): JsonObject {
    const params: JsonObject = { cwd: p.cwd, mcpServers: p.mcpServers };
    if (p.append !== null) params._meta = { antigravity: { systemPrompt: { append: p.append } } };
    return params;
  }

  async newSession(p: SessionSetupParams): Promise<AcpSessionResult> {
    const result = await this.request("session/new", this.setupParams(p), this.opts.timings.rpcTimeoutMs);
    return parseSessionResult(result, null);
  }

  async resumeSession(sessionId: string, p: SessionSetupParams): Promise<AcpSessionResult> {
    const result = await this.request("session/resume", { sessionId, ...this.setupParams(p) }, this.opts.timings.rpcTimeoutMs);
    return parseSessionResult(result, sessionId);
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpConfigOption[]> {
    const result = await this.request("session/set_config_option", { sessionId, configId, value }, this.opts.timings.rpcTimeoutMs);
    return parseConfigOptions(obj(result).configOptions);
  }

  /** No timeout: the stall watchdog covers prompts (SR 3.2 step 7). */
  async prompt(sessionId: string, blocks: readonly PromptBlock[]): Promise<AcpPromptResult> {
    const result = obj(await this.request("session/prompt", { sessionId, prompt: blocks }, null));
    return { stopReason: str(result.stopReason) ?? "end_turn", usage: parseUsage(result.usage) };
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId }, this.opts.timings.rpcTimeoutMs);
  }

  /** Ends stdin; agy saves and exits on its own (SR 3.3 step 2). */
  gracefulClose(): void {
    try {
      this.opts.transport.stdin.end();
    } catch {
      // Already closed.
    }
  }

  private write(message: JsonObject): boolean {
    const stdin = this.opts.transport.stdin;
    if (stdin.destroyed || stdin.writableEnded) return false;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private checkSignInLine(line: string, stream: "stdout" | "stderr"): boolean {
    if (!line.includes(AUTH_URL_STDOUT_PREFIX)) return false;
    // The URL carries the OAuth state and is never kept or logged.
    this.opts.log?.(`agy printed its sign-in line on ${stream}`);
    this.rejectAll(new SignInUrlLineError(stream));
    this.opts.onSignInLine?.(stream);
    return true;
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    let idx: number;
    while ((idx = this.stderrBuf.indexOf("\n")) !== -1) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      this.checkSignInLine(line, "stderr");
    }
    // A partial line can already be the sign-in line when agy waits after printing it without a newline.
    if (this.stderrBuf.includes(AUTH_URL_STDOUT_PREFIX)) {
      this.checkSignInLine(this.stderrBuf, "stderr");
      this.stderrBuf = "";
    }
    if (this.stderrBuf.length > 64 * 1024) this.stderrBuf = "";
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.checkSignInLine(line, "stdout");
      return;
    }
    if (!isRecord(msg)) return;
    this.opts.onActivity?.();
    const method = str(msg.method);
    const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : null;

    if (method === null) {
      if (typeof id !== "number") return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      this.opts.clock.clearTimeout(entry.timer);
      if (isRecord(msg.error)) {
        const code = num(msg.error.code) ?? -32603;
        entry.reject(new AcpError(code, str(msg.error.message) ?? "Antigravity ACP error", msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (method === "session/update" && id === null) {
      const params = obj(msg.params);
      const sessionId = str(params.sessionId);
      const update = obj(params.update);
      const kind = str(update.sessionUpdate);
      if (!sessionId || !kind) return;
      const content = obj(update.content);
      const text = content.type === "text" || content.type === undefined ? str(content.text) : null;
      for (const listener of [...(this.listeners.get(sessionId) ?? [])]) {
        try {
          listener({ kind, text });
        } catch {
          // One broken listener must not stop the stream for the other sessions.
        }
      }
      return;
    }

    if (id === null) return; // other notifications

    if (method === "session/request_permission") {
      const params = parsePermissionParams(msg.params);
      let allowed = false;
      try {
        allowed = params ? this.opts.allowPermission(params) : false;
      } catch {
        allowed = false;
      }
      const result = params ? choosePermissionOutcome(params, allowed) : { outcome: { outcome: "cancelled" } };
      this.write({ jsonrpc: "2.0", id, result });
      return;
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Client capability disabled: ${method}` } });
  }
}
