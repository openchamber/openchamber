// Shared contracts between the install/auth half (src/install, src/auth) and the
// sessions/runtime half (agy-process, proxy, fingerprint, session-store, prompt, ...).
// Types only. Sources: docs/architecture.md 2.1; docs/design-install-auth.md (IA) 15.1, 15.2;
// docs/design-sessions-runtime.md (SR) 3.1, 3.6, 4.3, 4.8, 6.6, 7.1, 7.4, 9.
// Names marked "WP-0 decision" are not spelled out in the docs; change them here, in one place.

// ---------------------------------------------------------------------------
// Install/auth bridge (IA 15.1, SR 9)
// ---------------------------------------------------------------------------

export type AuthChangeReason = "login" | "logout" | "account-changed";

export interface AuthChangedEvent {
  epoch: string;
  reason: AuthChangeReason;
}

export interface ResolvedBinary {
  path: string;
  version: string;
}

/** Where the active binary came from. `explicit` is `binaryPath`; the rest match `BinarySource` in IA 3. */
export type BinaryOrigin = "explicit" | "managed" | "path" | "t3code";

export type BinaryStatus =
  | { phase: "ready"; source: BinaryOrigin; version: string }
  | { phase: "downloading"; bytes: number; total: number | null }
  | { phase: "waiting_for_lock"; bytes: number | null; total: number | null }
  | { phase: "verifying" }
  | { phase: "missing"; message: string };

/**
 * Shape of the error `resolveBinary()` rejects with when no binary can be found or installed
 * (`BinaryNotFoundError` in src/install/binary-manager.ts). WP-0 decision: the runtime classifies it
 * by `code === "binary_not_found"`, not by `instanceof`, so it does not import the install package
 * and the fake bridge can produce the same failure.
 */
export interface BinaryNotFoundErrorShape extends Error {
  readonly code: "binary_not_found";
}

export interface InstallAuthBridge {
  /** IA 5. May download on the first call. Rejects with a `BinaryNotFoundErrorShape`. */
  resolveBinary(opts?: { waitMs?: number }): Promise<ResolvedBinary>;
  /** `buildAgyEnv({ kind: "runtime", tmpDir })`. The runtime uses it unmodified. */
  buildSpawnEnv(input: { tmpDir: string }): Record<string, string>;
  readonly geminiDir: string;
  readonly authMethod: string;
  authEpoch(): string;
  onAuthChanged(listener: (e: AuthChangedEvent) => void): () => void;
  onBinaryChanged(listener: (e: ResolvedBinary) => void): () => void;
  isSignInRequired(err: unknown): boolean;
  isPluginOwnedProfile(): boolean;
  /** Before every spawn. Waits while login_finalizing or logging_out. Then, if signed_out after a
   *  logout and the auth epoch is unchanged, rejects with SignInRequiredError; otherwise resolves. */
  beforeSpawn(): Promise<void>;
  /** After each successful `authenticate`. */
  reportAuthenticated(): void;
  /** After each classified sign-in error from `authenticate`, `session/new`, `session/resume`, `session/prompt`. */
  reportSignInRequired(message: string): void;
  /** Download and lock-wait progress for status notes (SR 6.3). */
  binaryStatus(): BinaryStatus;
  /** The one writer of antigravity-acp/settings.json (IA 9.3). */
  updateProfileSettings(patch: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// What the runtime gives the auth design (IA 15.2, SR 3.1, 3.6, 9)
// ---------------------------------------------------------------------------

export interface Lease {
  readonly generation: number;
  release(): void;
}

export interface RuntimeControl {
  /** `AgyProcessManager.stop`. Idempotent and joinable. */
  stop(reason: "auth-changed"): Promise<void>;
  /** `AgyProcessManager.hold`. Keeps the process from idling out; never spawns. */
  hold(reason: "login"): Lease;
}

export type RunDirKind = "runtime" | "login" | "probe" | "logout" | "verify";

/** Stays in the process's live set until `release()`, so a sweep never deletes it (SR 3.6). */
export interface RunDir {
  readonly path: string;
  /** Renames the dir to `trash-*` and deletes it in the background. */
  release(): Promise<void>;
}

export type CreateRunDir = (kind: RunDirKind) => Promise<RunDir>;

// ---------------------------------------------------------------------------
// OpenAI chat request shapes as OpenCode sends them (SR 1, 4.2)
// ---------------------------------------------------------------------------

export interface OpenAiTextPart {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface OpenAiImagePart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export interface OpenAiVideoPart {
  type: "video_url";
  video_url: { url: string };
}

export interface OpenAiFilePart {
  type: "file";
  file: { filename?: string; file_data?: string };
}

/** Any other part type. Kept for fingerprinting (`other:` + type + hash of the part JSON, SR 4.2).
 *  Narrow with a type guard on `type`; this member keeps `type: string`. */
export interface OpenAiUnknownPart {
  type: string;
  [key: string]: unknown;
}

export type OpenAiContentPart =
  | OpenAiTextPart
  | OpenAiImagePart
  | OpenAiVideoPart
  | OpenAiFilePart
  | OpenAiUnknownPart;

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAiRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface OpenAiMessage {
  role: OpenAiRole;
  content?: string | OpenAiContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Echoed back by OpenCode; ignored by fingerprinting and never sent to agy (SR 4.2, 6.3). */
  reasoning_content?: string;
}

export interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// ACP prompt blocks (SR 4.4, 4.7)
// ---------------------------------------------------------------------------

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; blob: string } }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text: string } };

// ---------------------------------------------------------------------------
// Classification (SR 4.3)
// ---------------------------------------------------------------------------

/** One tool message of `R`, answering a parked MCP call. */
export interface ToolResult {
  toolCallId: string;
  name?: string;
  content: string;
}

/** A non-text part of a tool-result media message (SR 4.2, 4.4). */
export type MediaPart = Exclude<OpenAiContentPart, OpenAiTextPart>;

export type RequestPlan =
  | { kind: "meta" } // title, compaction, generate, or no tools
  | { kind: "ephemeral" } // no session header
  | { kind: "resume"; results: ToolResult[]; media: MediaPart[]; steer: OpenAiMessage[] }
  | { kind: "append"; input: OpenAiMessage[]; reminders: string[] }
  /** Same input again after a clean no-output failure. `reminders` as for `append`: the failed turn did not
   *  move `toolsDescHashes`, so a description reminder it carried is sent again. */
  | { kind: "redo"; input: OpenAiMessage[]; reminders: string[] }
  | { kind: "fresh"; reason: FreshReason };

export type RequestPlanKind = RequestPlan["kind"];

export type FreshReason =
  | "no-binding"
  | "prefix-mismatch"
  | "tail-mismatch"
  | "system-changed"
  | "tools-changed"
  | "cwd-changed"
  | "auth-changed"
  | "tainted"
  | "resume-failed"
  | "locked-elsewhere"
  | "store-disabled"
  | "superseded"
  | "steer-failed";

/** A tool call the proxy sent to OpenCode (SR 4.2, `lastTurn.emittedToolCalls`). */
export interface EmittedToolCall {
  id: string;
  name: string;
  argsHash: string;
}

/** The hashes `buildSessionAppend` computes for a request; classification compares them to the binding. */
export interface SessionAppendHashes {
  systemHash: string;
  toolsSchemaHash: string;
  toolsDescHashes: Record<string, string>;
}

/** The request as classification sees it. WP-0 decision: the proxy builds the append first and passes its hashes. */
export interface ClassifiableRequest {
  /** `x-antigravity-kind` header; `title`, `compaction` and `generate` are meta. Null when absent. */
  kind: string | null;
  /** `x-antigravity-session`; null gives `ephemeral`. */
  sessionKey: string | null;
  messages: readonly OpenAiMessage[];
  tools: readonly OpenAiFunctionTool[];
  cwd: string;
  authEpoch: string;
  append: SessionAppendHashes;
}

/** What classification needs from a live turn in phase `parked` (SR 4.3 step 5). WP-0 decision. */
export interface ParkedTurnView {
  /** Prefix the binding moved to with the latest request of this turn (turn start, then each resume). */
  prefixCount: number;
  prefixHash: string;
  /** Tool calls of the latest OpenAI response, in order: the one assistant message the next request echoes. */
  emittedToolCalls: readonly EmittedToolCall[];
  emittedTextHash: string | null;
  /** Ids of parked calls with `emitted: true`. */
  parkedToolCallIds: readonly string[];
}

export interface ClassifyInput {
  binding: BindingRecord | null;
  request: ClassifiableRequest;
  /** Null unless the session's live turn is `parked`; other live phases are handled before (SR 3.7). */
  parkedTurn: ParkedTurnView | null;
}

/** WP-0 decision: classification also returns the prefix of the whole request (`prefixCount = F.length`,
 *  `prefixHash = chainHash(F, F.length)`), so the proxy can move the binding without importing fingerprint.ts. */
export interface ClassifyResult {
  plan: RequestPlan;
  prefix: { count: number; hash: string };
}

export type ClassifyRequest = (input: ClassifyInput) => ClassifyResult;

/** Hashes of the proxy's own output, stored in `lastTurn` and checked on the echo (SR 4.2). WP-0 decision. */
export interface EmittedHashes {
  /** sha256 of assistant text canonicalized like `t`; null when the text is empty. */
  emittedTextHash(text: string): string | null;
  /** Hash of `arguments` re-serialized with sorted keys (raw string when it does not parse). */
  toolArgsHash(argumentsJson: string): string;
}

// ---------------------------------------------------------------------------
// Bindings and the session store (SR 4.1, 4.8)
// ---------------------------------------------------------------------------

/** `live` exists only in memory and is written as `dormant`. */
export type BindingState = "live" | "dormant" | "tainted";

export type TurnOutcomeKind = "ok" | "parked" | "failed_no_output" | "failed_with_output" | "cancelled";

/** Plans that write a binding; `meta` and `ephemeral` never do. */
export type PersistedPlanKind = Exclude<RequestPlanKind, "meta" | "ephemeral">;

/** WP-0 decision: the docs name `crash` (SR 3.4) and `broken-history` (SR 6.5); the rest are the other
 *  taint causes of SR 3.3, 3.5, 4.1 and 4.6. */
export type TaintReason =
  | "crash"
  | "broken-history"
  | "cancelled"
  | "abandoned"
  | "failed"
  | "mcp-dropped"
  | "parked-expired"
  | "steer-failed";

export interface LastTurnRecord {
  outcome: TurnOutcomeKind;
  plan: PersistedPlanKind;
  /** Tool calls of the latest OpenAI response, in order: the one assistant message the next request echoes. */
  emittedToolCalls: EmittedToolCall[];
  emittedTextHash: string | null;
  /** Message range `[inputFrom, inputTo)` of the request that was this turn's input; `redo` rebuilds from it. */
  inputFrom: number;
  inputTo: number;
}

/** `<dataDir>/sessions/v1/<profileId>/<bindingId>.json` (SR 4.8). */
export interface BindingRecord {
  version: 1;
  sessionKey: string;
  acpSessionId: string;
  authEpoch: string;
  agyVersion: string;
  cwd: string;
  model: string;
  thoughtLevel: string | null;
  systemHash: string;
  toolsSchemaHash: string;
  toolsDescHashes: Record<string, string>;
  /** True when agy lacks `systemPrompt.append` and the append went into the first prompt; disables resume. */
  appendInPrompt: boolean;
  prefixCount: number;
  prefixHash: string;
  state: BindingState;
  taintReason: TaintReason | null;
  lastTurn: LastTurnRecord | null;
  createdAt: number;
  updatedAt: number;
  turns: number;
}

/** Cross-process lock on one binding (`<bindingId>.lock`, SR 4.8). The store touches it every 60 s. */
export interface BindingLock {
  readonly sessionKey: string;
  /** Unlinks the lock only when `poolId` and `token` are still ours. */
  release(): Promise<void>;
}

/** WP-0 decision: SR 4.8 describes the store's behavior but not its method list; this is it. */
export interface SessionStoreApi {
  /** Missing, corrupt (renamed to `.corrupt-<ms>`), unknown version or another auth epoch: null. */
  load(sessionKey: string, authEpoch: string): Promise<BindingRecord | null>;
  /** Atomic write (temp file plus rename), mode 0600. A `live` state is written as `dormant`. */
  save(record: BindingRecord): Promise<void>;
  /** `session.deleted`: deletes the record and, under the 4.8 rule, its conversation files. Returns the removed record. */
  remove(sessionKey: string): Promise<BindingRecord | null>;
  /** Null when another live process holds the lock (plan `fresh`, reason `locked-elsewhere`). */
  lock(sessionKey: string): Promise<BindingLock | null>;
  /** Appends an ephemeral ACP session id to `ephemeral.jsonl` for later cleanup. */
  recordEphemeral(acpSessionId: string): Promise<void>;
  /** TTL and count pruning (SR 4.8 steps 1 to 4). Never throws. */
  prune(): Promise<void>;
  /** Pool stop: releases every lock this pool holds. */
  close(): Promise<void>;
  /** `process.once("exit")`: synchronous unlink of this pool's own locks. */
  releaseLocksSync(): void;
}

// ---------------------------------------------------------------------------
// System prompt append and per-turn prompts (SR 7.1 to 7.3, 4.4, 4.7)
// ---------------------------------------------------------------------------

/** `RuntimeConfig` satisfies this structurally. */
export interface PromptBudgets {
  maxSystemPromptBytes: number;
  maxToolsPromptBytes: number;
}

export interface SessionAppendInput {
  messages: readonly OpenAiMessage[];
  tools: readonly OpenAiFunctionTool[];
  /** Meta sessions get the system section and the no-tools line only. */
  meta: boolean;
  config: PromptBudgets;
}

/** L0 to L6 of the tool truncation ladder (SR 7.3). */
export type ToolsCompactionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Metadata only, safe for debug logs. WP-0 decision on the field list. */
export interface SessionAppendStats {
  systemMessages: number;
  systemBytes: number;
  systemOmittedBytes: number;
  toolCount: number;
  toolsBytes: number;
  toolsLevel: ToolsCompactionLevel;
  /** Tools whose `parameters` were replaced at L5. */
  toolsSchemaOmitted: number;
  /** Tools dropped from the prompt at L6 (still callable through MCP). */
  toolsDropped: number;
}

export interface SessionAppend extends SessionAppendHashes {
  text: string;
  stats: SessionAppendStats;
}

export type BuildSessionAppend = (input: SessionAppendInput) => SessionAppend;

/** SR 4.7: `budgetChars = min(replayMaxChars, contextLimit * 2)`. */
export type BuildReplayPrompt = (messages: readonly OpenAiMessage[], budgetChars: number) => PromptBlock[];

/** SR 4.4 `append` and steering: system messages become `<system-update>` blocks, reminders first. */
export type BuildTurnPrompt = (input: readonly OpenAiMessage[], reminders: readonly string[]) => PromptBlock[];

// ---------------------------------------------------------------------------
// Failures (SR 6.6). src/errors.ts maps each to an HTTP response or a mid-stream error.
// ---------------------------------------------------------------------------

export type ProviderFailure =
  /** 504, retried. */
  | { kind: "stalled"; silenceMs: number }
  /** 429 with `retry-after`, retried. With `agyRetried` agy already ran its own retries (an error step
   *  after end_turn, or a stall after retry lines): 429, not retried, "try later or pick another model". */
  | { kind: "rate_limited"; retryAfterMs: number | null; agyRetried?: boolean }
  /** 503 with `retry-after`, retried. `agyRetried` as for `rate_limited`. */
  | { kind: "capacity"; model: string | null; retryAfterMs: number | null; agyRetried?: boolean }
  /** 429 with `x-should-retry: false`, not retried. */
  | { kind: "quota_exhausted" }
  /** 503, retried. Also the crash path of a wedged stop. */
  | { kind: "agy_exited"; code: number | null; signal: string | null }
  /** 503 with `retry-after: 30`, retried. */
  | { kind: "breaker_open"; retryAfterMs: number }
  /** 401, not retried. */
  | { kind: "auth_required"; message: string }
  /** WP-0 decision: SR 9 gives login and account change a retryable 503
   *  (`Antigravity sign-in changed. Retrying with the new account.`) that the 6.6 table has no row for. */
  | { kind: "auth_changed" }
  /** 503 with `x-should-retry: false` before the stream, code 400 `invalid_request_error` after. Also
   *  unsupported platform and a bad `binaryPath`; `message` is the install design's text. */
  | { kind: "binary_not_found"; message: string }
  /** 401, not retried. Unsupported `authMethod`; `message` is the issue text. */
  | { kind: "config_issue"; message: string }
  /** Status from agy (an error step), or 502. */
  | { kind: "provider_error"; status: number; message: string | null }
  /** 499, nothing written. */
  | { kind: "client_aborted" };

export type ProviderFailureKind = ProviderFailure["kind"];

// ---------------------------------------------------------------------------
// Profile and the layer 3 permission check (SR 7.4)
// ---------------------------------------------------------------------------

/** `session/request_permission` params as far as layer 3 reads them. ACP marks `toolCall.name` optional. */
export interface PermissionRequestParams {
  sessionId: string;
  toolCall?: {
    toolCallId?: string;
    name?: string;
    title?: string;
    /** ACP `ToolKind` (`read`, `edit`, `execute`, ... or `other`). Layer 3 rejects the built-in kinds. */
    kind?: string;
    args?: Record<string, unknown>;
    rawInput?: Record<string, unknown>;
  };
  options?: Array<{
    optionId: string;
    name?: string;
    kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
}

/** What layer 3 needs from the turn `sessionId` maps to. The caller checks the generation first. */
export interface PermissionTurnView {
  done: boolean;
  allowTools: boolean;
  allowedToolNames: ReadonlySet<string>;
}

export interface ProfilePrepareInput {
  bridge: Pick<InstallAuthBridge, "geminiDir" | "isPluginOwnedProfile" | "updateProfileSettings">;
  toolGuardHook: boolean;
  /**
   * The pool-level MCP URL (`http://127.0.0.1:<port>/mcp/<token>/pool`) the agent file declares. agy
   * 1.5.15 offers a custom agent `call_mcp_tool` only for servers its own file names (live smoke test).
   * It carries the MCP token: the file is 0600 and rewritten at every pool start.
   */
  mcpPoolUrl: string;
  /**
   * This pool's agent name, `<AGENT_NAME>-<poolId8>`, passed to `--agent`. One file per pool, so two
   * OpenCode processes on one profile never overwrite each other's URL and token (review L-1); it is
   * deleted at pool stop and swept once its owner is gone.
   */
  agentName: string;
}

/** WP-0 decision: what `prepareProfileDir` did with the guard, so the caller can warn once. */
export type ToolGuardOutcome = "installed" | "removed" | "skipped-foreign-profile" | "skipped-probe-failed";

export interface ProfileApi {
  prepareProfileDir(input: ProfilePrepareInput): Promise<{ guard: ToolGuardOutcome }>;
  /** Layer 3 rules 1 to 4; a null turn is a rejection. */
  matchMcpPermission(params: PermissionRequestParams, turn: PermissionTurnView | null): boolean;
  /** Pool stop: deletes this pool's agent file. Never throws. */
  removeAgentFile(geminiDir: string, agentName: string): Promise<void>;
  /** `process.once("exit")`: the same, synchronously. */
  removeAgentFileSync(geminiDir: string, agentName: string): void;
  /**
   * Before a spawn: deletes per-pool agent files whose pool tag is not in `livePoolTags`, and the shared
   * agent file of earlier versions when `othersAlive` is false. Never throws.
   */
  sweepAgentFiles(geminiDir: string, livePoolTags: ReadonlySet<string>, othersAlive: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session logic injected into AntigravityProxy (architecture.md 5, WP-B1)
// ---------------------------------------------------------------------------

/**
 * `new AntigravityProxy({ bridge, config, ...modules })`. WP-B1 tests pass stubs, index.ts passes
 * WP-B2's real modules. WP-0 decision: besides the five the architecture names, SR 4.4 needs
 * `buildTurnPrompt` for `append` and steering, and SR 4.2 needs `hashes` for `lastTurn`.
 */
export interface ProxySessionModules {
  classify: ClassifyRequest;
  store: SessionStoreApi;
  buildAppend: BuildSessionAppend;
  buildReplay: BuildReplayPrompt;
  buildTurnPrompt: BuildTurnPrompt;
  hashes: EmittedHashes;
  profile: ProfileApi;
}
