// One ACP prompt across one or more HTTP requests (SR 3.5, 3.7, 8.2): phases, the attached response
// (sink), parked MCP calls with the settle window, cancel and abandon, steering, and the outcome the
// binding records (SR 4.1). The proxy does the session setup and the ACP calls before the prompt; from
// the prompt on, this class owns the turn until it is done.

import { randomBytes, randomUUID } from "node:crypto";
import type { AcpPromptResult, AcpUsage } from "./acp-client.ts";
import type { RuntimeConfig } from "./config.ts";
import { STEER_BUSY_MESSAGES, TOOL_CANCELLED_TEXT, TOOL_MISSING_RESULT_TEXT } from "./constants.ts";
import type { Lease, ProviderFailure, RequestPlanKind, TaintReason, TurnOutcomeKind } from "./contracts.ts";
import { toHttpError, toStreamError, type ErrorContext } from "./errors.ts";
import { errorResult, type McpCallResult, type McpContent, type McpScope, type McpToolCall } from "./mcp-bridge.ts";
import type { RetryEvent } from "./agy-log-tail.ts";
import { StallWatchdog, type Clock } from "./stall-watchdog.ts";
import type { TurnErrorStep } from "./turn-outcome.ts";

export type TurnPhase = "dispatching" | "awaiting_model" | "streaming" | "parked" | "cancelling" | "done" | "abandoned";

/** What the binding records for a finished turn (SR 4.1, 8.2). */
export type TurnOutcome = Exclude<TurnOutcomeKind, "parked">;

export interface EmittedCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/** The HTTP response attached to the turn. Every method after a terminal one is a no-op. */
export interface TurnSink {
  readonly closed: boolean;
  thought(text: string): void;
  text(text: string): void;
  /** A status note (`reasoning_content`, SR 6.3). Non-streaming sinks drop it. */
  note(text: string): void;
  /** Ends the response with `finish_reason: "tool_calls"`. */
  toolCalls(calls: readonly EmittedCall[]): void;
  finish(usage: AcpUsage | null): void;
  fail(failure: ProviderFailure): void;
}

export type TurnEnd =
  | { kind: "ok"; usage: AcpUsage | null }
  | { kind: "failed"; failure: ProviderFailure }
  | { kind: "cancelled" }
  | { kind: "abandoned" };

export interface TurnHooks {
  sendCancel(turn: Turn): void;
  /** Error step after `end_turn` (SR 6.5). */
  checkOutcome(turn: Turn): Promise<TurnErrorStep | null>;
  /** Maps a `session/prompt` error; reports a classified sign-in error to the bridge (SR 9). */
  mapError(err: unknown): ProviderFailure;
  onToolCall(turn: Turn, callId: string): void;
  onParked(turn: Turn): void;
  /** agy dropped a parked `tools/call` request (SR 3.3). */
  onMcpDropped(turn: Turn): void;
  /** Phase `done` or `abandoned`; called once. The proxy updates the binding and releases the lease. */
  onEnded(turn: Turn): void;
  onWaitingChanged(): void;
  log(message: string): void;
}

export interface TurnInit {
  sessionKey: string | null;
  plan: RequestPlanKind;
  model: string;
  allowTools: boolean;
  allowedToolNames: ReadonlySet<string>;
  /** Streaming requests get status notes; non-streaming ones only the stall decision. */
  streaming: boolean;
  config: RuntimeConfig;
  clock: Clock;
  hooks: TurnHooks;
}

interface ParkedCall extends EmittedCall {
  emitted: boolean;
  resolve(result: McpCallResult): void;
}

type BufferedEvent = { kind: "thought" | "text"; text: string };

/** OpenCode rewrites ids with other characters for Claude-family models (SR 8.2). */
export function newToolCallId(): string {
  return `call_${randomBytes(10).toString("hex")}`;
}

function addUsage(a: AcpUsage | null, b: AcpUsage | null): AcpUsage | null {
  if (!a) return b;
  if (!b) return a;
  const out: AcpUsage = { ...a };
  for (const key of ["inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens", "totalTokens"] as const) {
    const sum = (a[key] ?? 0) + (b[key] ?? 0);
    if (a[key] !== undefined || b[key] !== undefined) out[key] = sum;
  }
  return out;
}

function isSteerBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return STEER_BUSY_MESSAGES.some((m) => message.includes(m));
}

export class Turn {
  readonly id = randomUUID();
  readonly sessionKey: string | null;
  /** Mutable: a dormant `append` whose resume fails runs as `fresh` (SR 4.5). */
  plan: RequestPlanKind;
  readonly model: string;
  readonly allowTools: boolean;
  readonly allowedToolNames: ReadonlySet<string>;

  generation = -1;
  acpSessionId: string | null = null;
  scope: McpScope | null = null;
  lease: Lease | null = null;
  /** Prefix of the request this turn last answered; the parked check compares against it (SR 4.3 step 5a). */
  prefix: { count: number; hash: string } = { count: 0, hash: "" };
  /** Message range of the request that was this turn's input (`lastTurn.inputFrom/inputTo`). */
  input: { from: number; to: number } = { from: 0, to: 0 };
  /** Why the binding is tainted when the turn does not end cleanly. */
  taintReason: TaintReason | null = null;

  private phaseValue: TurnPhase = "dispatching";
  private readonly config: RuntimeConfig;
  private readonly clock: Clock;
  private readonly hooks: TurnHooks;
  private readonly streaming: boolean;
  private readonly watchdog: StallWatchdog;
  private sink: TurnSink | null = null;
  private buffer: BufferedEvent[] = [];
  private readonly parked = new Map<string, ParkedCall>();
  private settleTimer: unknown = null;
  private cancelTimer: unknown = null;
  private cancelPromise: Promise<void> | null = null;
  private resolveCancel: (() => void) | null = null;
  private endValue: TurnEnd | null = null;
  private endDelivered = false;
  private producedOutputValue = false;
  private cancelSettled = false;
  private promptFailedOnOwn = false;
  private usage: AcpUsage | null = null;
  private liveSeqs = new Set<number>();
  private nextSeq = 1;
  private steerAttempt: { seq: number; settle: (outcome: "accepted" | "busy" | "failed") => void } | null = null;
  private steerTimer: unknown = null;
  private brokenHistoryValue = false;
  private parkedAt = 0;
  private responseTextValue = "";
  private ownRetrySeen = false;
  private responseCallsValue: EmittedCall[] = [];

  constructor(init: TurnInit) {
    this.sessionKey = init.sessionKey;
    this.plan = init.plan;
    this.model = init.model;
    this.allowTools = init.allowTools;
    this.allowedToolNames = init.allowedToolNames;
    this.streaming = init.streaming;
    this.config = init.config;
    this.clock = init.clock;
    this.hooks = init.hooks;
    this.watchdog = new StallWatchdog({
      config: init.config,
      clock: init.clock,
      model: init.model,
      onNote: (text) => {
        if (this.streaming) this.sink?.note(text);
      },
      onStall: (failure) => {
        this.hooks.log(`turn stalled (${failure.kind})`);
        void this.cancel("failed", failure);
      },
    });
  }

  get phase(): TurnPhase {
    return this.phaseValue;
  }

  get done(): boolean {
    return this.phaseValue === "done" || this.phaseValue === "abandoned";
  }

  /** Waiting on the model: the watchdog and the log tail run (SR 6.2). */
  get waiting(): boolean {
    return this.phaseValue === "awaiting_model" || this.phaseValue === "streaming";
  }

  get end(): TurnEnd | null {
    return this.endValue;
  }

  get producedOutput(): boolean {
    return this.producedOutputValue;
  }

  get brokenHistory(): boolean {
    return this.brokenHistoryValue;
  }

  get parkedSince(): number {
    return this.parkedAt;
  }

  /** Text streamed in the current OpenAI response, for `emittedTextHash` (SR 4.2). */
  get responseText(): string {
    return this.responseTextValue;
  }

  /** Tool calls sent to OpenCode in the current response. */
  get responseCalls(): readonly EmittedCall[] {
    return this.responseCallsValue;
  }

  /** Emitted parked ids (only these count for resume, SR 3.7). */
  get emittedParkedIds(): string[] {
    return [...this.parked.values()].filter((c) => c.emitted).map((c) => c.id);
  }

  get parkedIds(): string[] {
    return [...this.parked.keys()];
  }

  get hasUnemittedCalls(): boolean {
    for (const c of this.parked.values()) if (!c.emitted) return true;
    return false;
  }

  /** When the current silence started; for retry attribution without a model (SR 6.2). */
  silenceStartedAt(): number {
    return this.clock.now() - this.watchdog.silenceMs();
  }

  private setPhase(next: TurnPhase): void {
    if (this.phaseValue === next) return;
    const wasWaiting = this.waiting;
    this.phaseValue = next;
    if (wasWaiting !== this.waiting) this.hooks.onWaitingChanged();
  }

  // --- the attached response --------------------------------------------------------------

  /** Attaches the response of an HTTP request. A turn that already ended delivers its end at once. */
  attach(sink: TurnSink): void {
    if (this.sink && this.sink !== sink && !this.sink.closed) this.sink.fail({ kind: "client_aborted" });
    this.sink = sink;
    for (const event of this.buffer.splice(0)) {
      if (event.kind === "thought") sink.thought(event.text);
      else {
        // Buffered text belongs to the response that finally carries it (N-4).
        this.responseTextValue += event.text;
        sink.text(event.text);
      }
    }
    if (this.endValue) {
      this.deliverEnd();
      return;
    }
    if (this.hasUnemittedCalls && this.phaseValue !== "parked") this.scheduleSettle();
  }

  /** A status note before the prompt (start and download notes, SR 6.3). */
  note(text: string): void {
    if (this.streaming) this.sink?.note(text);
  }

  private deliverEnd(): void {
    const end = this.endValue;
    const sink = this.sink;
    if (!end || !sink || this.endDelivered) return;
    this.endDelivered = true;
    this.sink = null;
    if (end.kind === "ok") sink.finish(end.usage);
    else if (end.kind === "failed") sink.fail(end.failure);
    else sink.fail({ kind: "client_aborted" });
  }

  // --- updates from agy -------------------------------------------------------------------

  /** `session/update` for this turn's session (SR 6.1). */
  onUpdate(kind: string, text: string | null): void {
    if (this.done || this.phaseValue === "cancelling") return;
    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        this.watchdog.activity();
        if (this.phaseValue === "awaiting_model") this.setPhase("streaming");
        if (!text) return;
        this.producedOutputValue = true;
        const event: BufferedEvent = { kind: kind === "agent_message_chunk" ? "text" : "thought", text };
        // responseText is what the current response carried; buffered text is counted on attach (N-4).
        if (!this.sink) this.buffer.push(event);
        else if (event.kind === "text") {
          this.responseTextValue += text;
          this.sink.text(text);
        } else this.sink.thought(text);
        return;
      }
      case "tool_call":
      case "tool_call_update":
      case "plan":
        this.watchdog.activity();
        return;
      default:
        // usage_update, available_commands_update and the rest are not progress.
        return;
    }
  }

  /** `session/request_permission` for this turn counts as activity (SR 6.1). */
  onPermissionRequest(): void {
    if (this.waiting) this.watchdog.activity();
  }

  /** `attributed` as for `StallWatchdog.retry`. */
  onRetry(event: RetryEvent, attributed = true): void {
    if (!this.waiting) return;
    if (attributed) this.ownRetrySeen = true;
    this.watchdog.retry(event, attributed);
  }

  /** agy logged a retry line attributed to this turn at some point during it (review L-3). */
  get sawOwnRetry(): boolean {
    return this.ownRetrySeen;
  }

  /** agy's `tools/call` for this turn's scope: park until OpenCode answers (SR 3.5). */
  onMcpCall(call: McpToolCall, signal: AbortSignal): Promise<McpCallResult> {
    if (this.done || this.phaseValue === "cancelling") return Promise.resolve(errorResult(TOOL_CANCELLED_TEXT));
    if (!this.allowTools) return Promise.resolve(errorResult("No active OpenCode turn for this tool call."));
    if (!this.allowedToolNames.has(call.name)) return Promise.resolve(errorResult(`Tool "${call.name}" is not enabled for this turn.`));
    this.watchdog.activity();
    this.producedOutputValue = true;
    return new Promise<McpCallResult>((resolve) => {
      const id = newToolCallId();
      let settled = false;
      const parked: ParkedCall = {
        id,
        name: call.name,
        argumentsJson: call.argumentsJson,
        emitted: false,
        resolve: (result) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      };
      const onAbort = (): void => {
        if (!this.parked.has(id)) return;
        this.parked.delete(id);
        parked.resolve(errorResult(TOOL_CANCELLED_TEXT));
        this.hooks.log("agy dropped a parked tools/call");
        this.hooks.onMcpDropped(this);
      };
      this.parked.set(id, parked);
      this.hooks.onToolCall(this, id);
      // The request may have been dropped while the bridge read its body.
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.sink) this.scheduleSettle();
    });
  }

  private scheduleSettle(): void {
    if (this.settleTimer !== null) this.clock.clearTimeout(this.settleTimer);
    this.settleTimer = this.clock.setTimeout(() => {
      this.settleTimer = null;
      this.flushParked();
    }, this.config.timings.toolSettleMs);
  }

  /** End of the settle window: unemitted calls go out as `tool_calls` and the turn parks. */
  private flushParked(): void {
    const sink = this.sink;
    if (!sink || this.done || this.phaseValue === "cancelling") return;
    const calls = [...this.parked.values()].filter((c) => !c.emitted);
    if (calls.length === 0) return;
    for (const c of calls) c.emitted = true;
    const emitted = calls.map(({ id, name, argumentsJson }) => ({ id, name, argumentsJson }));
    this.responseCallsValue = [...this.responseCallsValue, ...emitted];
    this.sink = null;
    this.watchdog.pause();
    this.parkedAt = this.clock.now();
    this.setPhase("parked");
    sink.toolCalls(emitted);
    this.hooks.onParked(this);
  }

  // --- resume -----------------------------------------------------------------------------

  /**
   * Tool results for the parked calls (SR 3.7, 4.4). Only emitted calls count; an emitted call without
   * a result resolves with an error. Unemitted calls (agy called them after the settle window) are
   * returned to go out as a new `tool_calls` response, and the turn stays parked.
   */
  resume(results: ReadonlyMap<string, McpContent[]>): { flush: EmittedCall[] } {
    if (this.phaseValue !== "parked") return { flush: [] };
    for (const call of [...this.parked.values()]) {
      if (!call.emitted) continue;
      this.parked.delete(call.id);
      const content = results.get(call.id);
      call.resolve(content ? { content } : errorResult(TOOL_MISSING_RESULT_TEXT));
    }
    this.responseTextValue = "";
    const unemitted = [...this.parked.values()].filter((c) => !c.emitted);
    if (unemitted.length > 0) {
      for (const c of unemitted) c.emitted = true;
      this.responseCallsValue = unemitted.map(({ id, name, argumentsJson }) => ({ id, name, argumentsJson }));
      this.parkedAt = this.clock.now();
      this.hooks.onParked(this);
      return { flush: this.responseCallsValue };
    }
    this.responseCallsValue = [];
    this.setPhase("awaiting_model");
    this.watchdog.resume();
    return { flush: [] };
  }

  // --- the prompt -------------------------------------------------------------------------

  /** Sends `session/prompt` and starts the watchdog (phase `awaiting_model`). */
  startPrompt(send: () => Promise<AcpPromptResult>): void {
    if (this.done) return;
    this.setPhase("awaiting_model");
    this.watchdog.start();
    this.sendPrompt(send);
  }

  private sendPrompt(send: () => Promise<AcpPromptResult>): number {
    const seq = this.nextSeq++;
    this.liveSeqs.add(seq);
    send().then(
      (result) => this.onPromptReply(seq, result),
      (err: unknown) => this.onPromptError(seq, err),
    );
    return seq;
  }

  private latestSeq(): number {
    let max = 0;
    for (const s of this.liveSeqs) if (s > max) max = s;
    return max;
  }

  /**
   * Steering: a second `session/prompt` while the first runs (SR 4.6). agy has no acknowledgement, so
   * an attempt counts as accepted when the superseded prompt replies, the steer prompt itself replies,
   * or agy has not rejected it within `steerRetryMs`; it is busy when agy answers with one of its two
   * transient texts. Session updates prove nothing here: the old prompt may still be streaming. Retries
   * every second, ten at most.
   */
  async steer(send: () => Promise<AcpPromptResult>): Promise<boolean> {
    const { steerRetries, steerRetryMs } = this.config.timings;
    for (let attempt = 0; attempt <= steerRetries; attempt++) {
      if (this.done || this.phaseValue === "cancelling") return false;
      const outcome = await new Promise<"accepted" | "busy" | "failed">((resolve) => {
        let finished = false;
        const settle = (o: "accepted" | "busy" | "failed"): void => {
          if (finished) return;
          finished = true;
          if (this.steerAttempt?.settle === settle) this.steerAttempt = null;
          resolve(o);
        };
        const seq = this.nextSeq;
        this.steerAttempt = { seq, settle };
        this.sendPrompt(send);
        const timer = this.clock.setTimeout(() => settle("accepted"), steerRetryMs);
        this.steerTimer = timer;
      });
      this.clock.clearTimeout(this.steerTimer);
      this.steerTimer = null;
      if (outcome === "accepted") return true;
      if (outcome === "failed") return false;
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, steerRetryMs));
    }
    return false;
  }

  private onPromptReply(seq: number, result: AcpPromptResult): void {
    this.usage = addUsage(this.usage, result.usage);
    const latest = this.latestSeq();
    this.liveSeqs.delete(seq);
    if (this.steerAttempt && this.steerAttempt.seq === seq) {
      // The steer prompt itself replied: it ran, so it was accepted, and this reply ends the turn.
      this.steerAttempt.settle("accepted");
    } else if (seq !== latest) {
      // A superseded prompt (SR 4.6 step 3): only its usage counts.
      this.steerAttempt?.settle("accepted");
      return;
    }
    if (this.done) return;
    if (this.phaseValue === "cancelling") {
      this.cancelSettled = true;
      this.finishCancel();
      return;
    }
    void this.completeFromReply(result);
  }

  private async completeFromReply(result: AcpPromptResult): Promise<void> {
    if (result.stopReason === "cancelled") {
      this.endWith({ kind: "failed", failure: { kind: "provider_error", status: 502, message: "Antigravity cancelled the turn on its own." } });
      return;
    }
    if (result.stopReason === "end_turn" || result.stopReason === "refusal") {
      const step = await this.hooks.checkOutcome(this).catch(() => null);
      if (this.done) return;
      if (step) {
        if (step.brokenHistory) {
          this.brokenHistoryValue = true;
          this.taintReason = "broken-history";
        }
        this.endWith({ kind: "failed", failure: step.failure });
        return;
      }
      if (result.stopReason === "refusal") {
        this.endWith({ kind: "failed", failure: { kind: "quota_exhausted" } });
        return;
      }
    }
    // Parked calls agy never waited for are answered so nothing hangs.
    for (const call of [...this.parked.values()]) {
      this.parked.delete(call.id);
      call.resolve(errorResult(TOOL_CANCELLED_TEXT));
    }
    this.endWith({ kind: "ok", usage: this.usage });
  }

  private onPromptError(seq: number, err: unknown): void {
    const latest = this.latestSeq();
    this.liveSeqs.delete(seq);
    if (this.steerAttempt && this.steerAttempt.seq === seq) {
      this.steerAttempt.settle(isSteerBusy(err) ? "busy" : "failed");
      return;
    }
    if (seq !== latest) return;
    // A late busy answer to an accepted steer: the earlier prompt is still running (SR 4.6).
    if (isSteerBusy(err) && this.liveSeqs.size > 0) return;
    if (this.done) return;
    if (this.phaseValue === "cancelling") {
      this.cancelSettled = true;
      this.finishCancel();
      return;
    }
    this.promptFailedOnOwn = true;
    this.endWith({ kind: "failed", failure: this.hooks.mapError(err) });
  }

  // --- ends -------------------------------------------------------------------------------

  private clearTimers(): void {
    if (this.settleTimer !== null) this.clock.clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.cancelTimer !== null) this.clock.clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
  }

  private endWith(end: TurnEnd): void {
    if (this.done) return;
    this.endValue = this.endValue?.kind === "failed" && end.kind === "cancelled" ? this.endValue : end;
    this.watchdog.stop();
    this.clearTimers();
    for (const call of [...this.parked.values()]) {
      this.parked.delete(call.id);
      call.resolve(errorResult(TOOL_CANCELLED_TEXT));
    }
    this.setPhase(end.kind === "abandoned" ? "abandoned" : "done");
    this.deliverEnd();
    this.steerAttempt?.settle("failed");
    this.resolveCancel?.();
    this.hooks.onEnded(this);
  }

  /** Setup failed before the prompt (SR 8.2 step 4). */
  failSetup(failure: ProviderFailure): void {
    this.endWith({ kind: "failed", failure });
  }

  /** The process of this turn's generation exited (SR 3.4); `taint` is the binding's reason. */
  failFromExit(failure: ProviderFailure, taint: TaintReason): void {
    if (this.done) return;
    // A dying child also drops its MCP requests first; the exit is the authoritative cause.
    this.taintReason = taint === "crash" ? taint : (this.taintReason ?? taint);
    this.endWith({ kind: "failed", failure });
  }

  /**
   * SR 3.5: phase `cancelling`, `session/cancel`, parked calls answered as cancelled, then up to
   * `cancelSettleMs` for the prompt's reply. A failure goes to the attached response at once (a stall);
   * without one the response is closed quietly. Joinable.
   */
  cancel(taint: TaintReason, failure?: ProviderFailure): Promise<void> {
    if (this.done) return Promise.resolve();
    if (this.cancelPromise) return this.cancelPromise;
    this.taintReason ??= taint;
    const promptInFlight = this.liveSeqs.size > 0;
    if (failure) this.endValue = { kind: "failed", failure };
    this.watchdog.stop();
    if (this.settleTimer !== null) this.clock.clearTimeout(this.settleTimer);
    this.settleTimer = null;
    const sink = this.sink;
    this.sink = null;
    if (sink) {
      this.endDelivered = failure !== undefined;
      sink.fail(failure ?? { kind: "client_aborted" });
    }
    if (!promptInFlight) {
      // Still dispatching: nothing reached agy; the setup code sees `done` and stops.
      this.cancelSettled = true;
      this.endWith(failure ? { kind: "failed", failure } : { kind: "cancelled" });
      return Promise.resolve();
    }
    this.setPhase("cancelling");
    this.cancelPromise = new Promise<void>((resolve) => {
      this.resolveCancel = resolve;
    });
    this.hooks.sendCancel(this);
    for (const call of [...this.parked.values()]) {
      this.parked.delete(call.id);
      call.resolve(errorResult(TOOL_CANCELLED_TEXT));
    }
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = null;
      if (this.done) return;
      this.hooks.log("cancelled prompt never replied; turn abandoned");
      this.taintReason = "abandoned";
      this.endWith({ kind: "abandoned" });
    }, this.config.cancelSettleMs);
    return this.cancelPromise;
  }

  private finishCancel(): void {
    const failed = this.endValue?.kind === "failed" ? this.endValue : null;
    this.endWith(failed ?? { kind: "cancelled" });
  }

  /**
   * The binding's view of how the turn ended (SR 4.1). A clean no-output failure of an `append` or
   * `redo` turn leaves the binding untainted; everything else taints it.
   */
  bindingOutcome(): { outcome: TurnOutcome; taint: TaintReason | null } {
    const end = this.endValue;
    if (!end || end.kind === "ok") return { outcome: "ok", taint: this.brokenHistoryValue ? "broken-history" : null };
    if (end.kind === "abandoned") return { outcome: this.producedOutputValue ? "failed_with_output" : "cancelled", taint: "abandoned" };
    const clean =
      (this.plan === "append" || this.plan === "redo") &&
      !this.producedOutputValue &&
      (this.cancelSettled || this.promptFailedOnOwn) &&
      !this.brokenHistoryValue &&
      this.taintReason !== "crash";
    if (end.kind === "failed" && clean) return { outcome: "failed_no_output", taint: null };
    const outcome: TurnOutcome = end.kind === "cancelled" ? "cancelled" : this.producedOutputValue ? "failed_with_output" : "failed_no_output";
    return { outcome, taint: this.taintReason ?? (end.kind === "cancelled" ? "cancelled" : "failed") };
  }
}

// --- HTTP responses ----------------------------------------------------------------------------

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
  completion_tokens_details: { reasoning_tokens: number };
}

export function formatOpenAiUsage(usage: AcpUsage | null): OpenAiUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = (usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0);
  const completionTokens = usage.outputTokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedReadTokens ?? 0,
      ...(usage.cachedWriteTokens ? { cache_write_tokens: usage.cachedWriteTokens } : {}),
    },
    completion_tokens_details: { reasoning_tokens: usage.thoughtTokens ?? 0 },
  };
}

function completionId(): string {
  return `chatcmpl_${randomBytes(10).toString("hex")}`;
}

function toolCallsJson(calls: readonly EmittedCall[]): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  return calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argumentsJson } }));
}

const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };

export interface SseResponderOptions {
  model: string;
  clock: Clock;
  heartbeatMs: number;
  errorContext: ErrorContext;
  /** The client went away (stream cancelled). Not called after a terminal write. */
  onClientAbort: () => void;
}

/** A streaming chat completion. `: ping` every `heartbeatMs` keeps Bun and OpenCode's chunk timeout out of play. */
export class SseResponder implements TurnSink {
  readonly response: Response;
  private readonly opts: SseResponderOptions;
  private readonly id = completionId();
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly encoder = new TextEncoder();
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closedValue = false;
  private roleSent = false;
  private heartbeat: unknown = null;

  constructor(opts: SseResponderOptions) {
    this.opts = opts;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        this.armHeartbeat();
      },
      cancel: () => {
        if (this.closedValue) return;
        this.closedValue = true;
        this.stopHeartbeat();
        this.opts.onClientAbort();
      },
    });
    this.response = new Response(stream, { headers: SSE_HEADERS });
  }

  get closed(): boolean {
    return this.closedValue;
  }

  private armHeartbeat(): void {
    this.heartbeat = this.opts.clock.setTimeout(() => {
      this.heartbeat = null;
      if (this.closedValue) return;
      this.enqueue(": ping\n\n");
      this.armHeartbeat();
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.opts.clock.clearTimeout(this.heartbeat);
    this.heartbeat = null;
  }

  private enqueue(text: string): void {
    try {
      this.controller?.enqueue(this.encoder.encode(text));
    } catch {
      // The client is gone.
    }
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null, usage?: OpenAiUsage): void {
    if (this.closedValue) return;
    if (!this.roleSent && Object.keys(delta).length > 0) {
      this.roleSent = true;
      delta = { role: "assistant", ...delta };
    }
    const payload: Record<string, unknown> = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.opts.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) payload.usage = usage;
    this.enqueue(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private close(): void {
    if (this.closedValue) return;
    this.closedValue = true;
    this.stopHeartbeat();
    this.enqueue("data: [DONE]\n\n");
    try {
      this.controller?.close();
    } catch {
      // Already closed.
    }
  }

  thought(text: string): void {
    this.chunk({ reasoning_content: text });
  }

  text(text: string): void {
    this.chunk({ content: text });
  }

  note(text: string): void {
    this.chunk({ reasoning_content: text });
  }

  toolCalls(calls: readonly EmittedCall[]): void {
    this.chunk({ tool_calls: toolCallsJson(calls).map((c, index) => ({ index, ...c })) });
    this.chunk({}, "tool_calls");
    this.close();
  }

  finish(usage: AcpUsage | null): void {
    this.chunk({}, "stop", formatOpenAiUsage(usage));
    this.close();
  }

  fail(failure: ProviderFailure): void {
    if (this.closedValue) return;
    const event = toStreamError(failure, this.opts.errorContext);
    if (event) this.enqueue(`data: ${JSON.stringify(event)}\n\n`);
    this.close();
  }
}

export interface JsonResponderOptions {
  model: string;
  errorContext: ErrorContext;
}

/** A non-streaming chat completion; `response` settles at the first terminal call. */
export class JsonResponder implements TurnSink {
  readonly response: Promise<Response>;
  private readonly opts: JsonResponderOptions;
  private resolve: (r: Response) => void = () => {};
  private closedValue = false;
  private readonly texts: string[] = [];
  private readonly thoughts: string[] = [];

  constructor(opts: JsonResponderOptions) {
    this.opts = opts;
    this.response = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  get closed(): boolean {
    return this.closedValue;
  }

  private settle(response: Response): void {
    if (this.closedValue) return;
    this.closedValue = true;
    this.resolve(response);
  }

  thought(text: string): void {
    if (!this.closedValue) this.thoughts.push(text);
  }

  text(text: string): void {
    if (!this.closedValue) this.texts.push(text);
  }

  note(_text: string): void {
    // Non-streaming requests get no notes (SR 6.3).
  }

  toolCalls(calls: readonly EmittedCall[]): void {
    // The text and reasoning before the calls stay in the message (O-9).
    this.settle(toolCallsResponse(this.opts.model, calls, false, this.texts.join(""), this.thoughts.join("")));
  }

  finish(usage: AcpUsage | null): void {
    this.settle(
      Response.json({
        id: completionId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: this.opts.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: this.texts.join(""),
              ...(this.thoughts.length > 0 ? { reasoning_content: this.thoughts.join("") } : {}),
            },
            finish_reason: "stop",
          },
        ],
        usage: formatOpenAiUsage(usage),
      }),
    );
  }

  fail(failure: ProviderFailure): void {
    this.settle(toHttpError(failure, this.opts.errorContext));
  }
}

/** A response that only carries tool calls (the unemitted-call flush, SR 3.7). */
export function toolCallsResponse(model: string, calls: readonly EmittedCall[], stream: boolean, text = "", reasoning = ""): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    const message = {
      role: "assistant",
      content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: toolCallsJson(calls),
    };
    return Response.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: "tool_calls" }] });
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const body =
    chunk({ role: "assistant", tool_calls: toolCallsJson(calls).map((c, index) => ({ index, ...c })) }, null) +
    chunk({}, "tool_calls") +
    "data: [DONE]\n\n";
  return new Response(body, { headers: SSE_HEADERS });
}
