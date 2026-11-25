// Runtime constants and ids (SR 10). Durations in milliseconds.

export const PLUGIN_ID = "openchamber.antigravity";
export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const INTEGRATION_ID = "antigravity";
export const MCP_SERVER_NAME = "opencode";
export const AGENT_NAME = "opencode-bridge";
export const CLIENT_NAME = "opencode-antigravity";
export const CLIENT_VERSION = "0.1.0";

export const HEADER_META = "x-antigravity-meta";
export const HEADER_KIND = "x-antigravity-kind";
export const HEADER_DIRECTORY = "x-antigravity-directory";
export const HEADER_SESSION = "x-antigravity-session";
export const HEADER_PROXY_TOKEN = "x-antigravity-proxy-token";

/** The marker credential OpenCode sends as `Authorization: Bearer <marker>` (proxy check 2, IA 13.3). */
export { MARKER_ACCESS } from "./auth/constants.ts";

/** `x-antigravity-kind` values that run as meta sessions (SR 4.3 step 1). */
export const META_KINDS: ReadonlySet<string> = new Set(["title", "compaction", "generate"]);

/** Pools of this plugin version, keyed per profile config (SR 8.4). v2: the prototype's v1 entry had another shape. */
export const POOL_GLOBAL_KEY = Symbol.for("openchamber.opencode-antigravity.pool.v2");
export const RUN_DIRS_GLOBAL_KEY = Symbol.for("openchamber.opencode-antigravity.rundirs.v1");

/** A pool whose last setup was cleaned up waits this long for a plugin reload before it stops (SR 8.4). */
export const RELOAD_GRACE_MS = 10_000;
/** Setup-time model discovery on a ready process runs at most this often per pool. */
export const DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
/** Session store pruning: first run after pool start, then the interval (SR 4.8). */
export const PRUNE_FIRST_DELAY_MS = 30_000;
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A spawn runs model discovery when the cached catalog is older than this (SR 3.3, "once a day"). */
export const DISCOVERY_DAILY_MS = 24 * 60 * 60 * 1000;

/** ACP protocol version sent in `initialize` (SR 9: agy answers 1 when asked for 2). */
export const ACP_PROTOCOL_VERSION = 1;

/** Prefix of every status note (SR 6.3). */
export const NOTE_PREFIX = "[Antigravity]";

/** MCP tool result texts (SR 3.5, 3.7). */
export const TOOL_CANCELLED_TEXT = "The OpenCode tool call was cancelled.";
export const TOOL_MISSING_RESULT_TEXT = "OpenCode returned no result for this tool call.";

/** agy 1.5.15's two transient answers to a steering prompt (SR 4.6). */
export const STEER_BUSY_MESSAGES: readonly string[] = [
  "the running prompt is waiting for a permission or question answer",
  "the running prompt is being cancelled",
];

/** Fixed internal limits (SR 10, "constants, not options"). Tests override them through `resolveRuntimeConfig`. */
export interface RuntimeTimings {
  initializeTimeoutMs: number;
  authenticateTimeoutMs: number;
  /** `session/new`, `session/resume`, `session/set_config_option`, `session/close`. */
  rpcTimeoutMs: number;
  toolSettleMs: number;
  heartbeatMs: number;
  earlySseMs: number;
  /** Download note refresh (SR 6.3). */
  downloadNoteMs: number;
  wedgedCheckMs: number;
  /** abandonedTurns >= 3 within this window is wedged (SR 3.5). */
  wedgedWindowMs: number;
  steerRetries: number;
  steerRetryMs: number;
  resumeRetryMs: number;
  /** Stop: wait for exit after stdin ends, then after SIGTERM (SR 3.3). */
  stdinExitGraceMs: number;
  termExitGraceMs: number;
  /** Breaker: an exit within this of spawn is early; three inside this window open it (SR 3.4). */
  earlyExitWindowMs: number;
  /** Watchdog: notes repeat every this long, the check slice, and the slack that counts as host sleep (SR 6.3, 6.4). */
  noteRepeatMs: number;
  noteMinGapMs: number;
  watchdogSliceMs: number;
  hostSleepSlackMs: number;
  logPollMs: number;
  /** Parked reaper and idle-session close check. */
  reaperIntervalMs: number;
  /** After a binary update, a new request waits at most this long for the old child's leases (O-6). */
  drainWaitMs: number;
  /** `session.deleted` ids are remembered this long (SR 8.3). */
  deletedIdsTtlMs: number;
}

export const DEFAULT_TIMINGS: Readonly<RuntimeTimings> = {
  initializeTimeoutMs: 30_000,
  authenticateTimeoutMs: 60_000,
  rpcTimeoutMs: 30_000,
  toolSettleMs: 250,
  heartbeatMs: 15_000,
  earlySseMs: 2_000,
  downloadNoteMs: 15_000,
  wedgedCheckMs: 30_000,
  wedgedWindowMs: 10 * 60 * 1000,
  steerRetries: 10,
  steerRetryMs: 1_000,
  resumeRetryMs: 500,
  stdinExitGraceMs: 5_000,
  termExitGraceMs: 3_000,
  earlyExitWindowMs: 120_000,
  noteRepeatMs: 60_000,
  noteMinGapMs: 15_000,
  watchdogSliceMs: 60_000,
  hostSleepSlackMs: 10_000,
  logPollMs: 1_000,
  reaperIntervalMs: 60_000,
  drainWaitMs: 30_000,
  deletedIdsTtlMs: 10 * 60 * 1000,
};
